"""Schlanker asynchroner Modbus-Client (RTU over TCP oder Modbus TCP).

Bewusst ohne pymodbus: keine Versionskonflikte mit der Modbus-Integration von
Home Assistant. Alle Zugriffe laufen über ein Lock, damit sich Anfragen auf dem
RS485-Bus nie überschneiden.
"""

from __future__ import annotations

import asyncio
import logging
import struct

_LOGGER = logging.getLogger(__name__)

PROTO_RTU_OVER_TCP = "rtuovertcp"
PROTO_TCP = "tcp"


class ModbusError(Exception):
    """Fehler bei der Kommunikation."""


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


class AvarmaModbus:
    """Modbus-Master für genau eine Wärmepumpe."""

    def __init__(self, host: str, port: int, slave: int, protocol: str, timeout: float = 3.0) -> None:
        self.host, self.port, self.slave, self.protocol = host, port, slave, protocol
        self.timeout = timeout
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._lock = asyncio.Lock()
        self._tid = 0

    async def _connect(self) -> None:
        if self._writer is not None and not self._writer.is_closing():
            return
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), self.timeout
        )

    async def close(self) -> None:
        if self._writer is not None:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass
        self._reader = self._writer = None

    async def _drain_input(self) -> None:
        """Verwirft übrig gebliebene Bytes (z. B. verspätete Antworten)."""
        assert self._reader is not None
        while True:
            try:
                data = await asyncio.wait_for(self._reader.read(256), 0.02)
            except asyncio.TimeoutError:
                return
            if not data:
                raise ModbusError("Verbindung geschlossen")

    async def _transact(self, pdu: bytes) -> bytes:
        """Sendet eine PDU und liefert die Antwort-PDU (ohne Adresse/CRC)."""
        await self._connect()
        assert self._reader is not None and self._writer is not None
        await self._drain_input()
        if self.protocol == PROTO_TCP:
            self._tid = (self._tid + 1) & 0xFFFF
            self._writer.write(struct.pack(">HHHB", self._tid, 0, len(pdu) + 1, self.slave) + pdu)
            await self._writer.drain()
            head = await asyncio.wait_for(self._reader.readexactly(7), self.timeout)
            tid, _pid, length, unit = struct.unpack(">HHHB", head)
            body = await asyncio.wait_for(self._reader.readexactly(length - 1), self.timeout)
            if tid != self._tid or unit != self.slave:
                raise ModbusError("Antwort passt nicht zur Anfrage")
            resp = body
        else:
            frame = bytes([self.slave]) + pdu
            frame += struct.pack("<H", crc16(frame))
            self._writer.write(frame)
            await self._writer.drain()
            head = await asyncio.wait_for(self._reader.readexactly(3), self.timeout)
            if head[0] != self.slave:
                raise ModbusError(f"Falsche Slave-Adresse in Antwort: {head[0]}")
            fc = head[1]
            if fc & 0x80:
                rest = await asyncio.wait_for(self._reader.readexactly(2), self.timeout)
                frame_in = head + rest
            elif fc == 0x03:
                rest = await asyncio.wait_for(self._reader.readexactly(head[2] + 2), self.timeout)
                frame_in = head + rest
            else:  # 0x06 (Echo) bzw. 0x10 (Adresse + Anzahl): 8 Byte
                rest = await asyncio.wait_for(self._reader.readexactly(5), self.timeout)
                frame_in = head + rest
            if crc16(frame_in[:-2]) != struct.unpack("<H", frame_in[-2:])[0]:
                raise ModbusError("CRC-Fehler")
            resp = frame_in[1:-2]
        if resp[0] & 0x80:
            raise ModbusError(f"Modbus-Exception {resp[1]} (Funktion {resp[0] & 0x7F})")
        if resp[0] != pdu[0]:
            raise ModbusError("Falscher Funktionscode in Antwort")
        return resp

    async def read_holding(self, address: int, count: int) -> list[int]:
        async with self._lock:
            try:
                resp = await self._transact(struct.pack(">BHH", 0x03, address, count))
                if resp[1] != 2 * count:
                    raise ModbusError("Falsche Anzahl Bytes")
                return list(struct.unpack(f">{count}H", resp[2:2 + 2 * count]))
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ModbusError) as err:
                await self.close()
                raise ModbusError(f"Lesen {address}+{count}: {err!r}") from err
            finally:
                await asyncio.sleep(0.04)

    async def write_registers(self, address: int, values: list[int]) -> None:
        """Mehrere Register mit Funktion 0x10 schreiben (z. B. Uhrzeit: Datum + Zeit in einem Rutsch)."""
        vals = [v & 0xFFFF for v in values]
        pdu = struct.pack(f">BHHB{len(vals)}H", 0x10, address, len(vals), 2 * len(vals), *vals)
        async with self._lock:
            try:
                resp = await self._transact(pdu)
                if struct.unpack(">HH", resp[1:5]) != (address, len(vals)):
                    raise ModbusError("Antwort auf 0x10 passt nicht")
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ModbusError) as err:
                await self.close()
                raise ModbusError(f"Schreiben {address}+{len(vals)}: {err!r}") from err
            finally:
                await asyncio.sleep(0.04)

    async def write_register(self, address: int, value: int) -> None:
        value &= 0xFFFF
        async with self._lock:
            try:
                resp = await self._transact(struct.pack(">BHH", 0x06, address, value))
                if struct.unpack(">HH", resp[1:5]) != (address, value):
                    raise ModbusError("Schreib-Echo passt nicht")
            except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ModbusError) as err:
                await self.close()
                raise ModbusError(f"Schreiben {address}={value}: {err!r}") from err
            finally:
                await asyncio.sleep(0.04)
