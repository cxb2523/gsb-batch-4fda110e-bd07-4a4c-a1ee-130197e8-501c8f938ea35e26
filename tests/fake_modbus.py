"""Lokaler Modbus-Ersatz-From (RTU over TCP) für die Tests.

Beantwortet Funktionscode 0x03 mit festen Werten und kann gezielt Fehler liefern,
damit sich Busfehler, Verbindungsabbrüche und die automatische Neuverbindung
des eigenen Clients ohne echte Anlage prüfen lassen.
"""

from __future__ import annotations

import asyncio

from custom_components.avarma.coordinator import FAST_BLOCKS
from custom_components.avarma.modbus import crc16

PARAMS_START = 8192


def _is_fast(address: int) -> bool:
    return any(start <= address < start + count for start, count in FAST_BLOCKS)


class FakeSlave:
    """Mini-Modbus-RTU-Slave.

    mode = "params"    beantwortet nur den Parameterblock (ab 8192) mit einer Exception,
    mode = "exception" beantwortet alle langsamen Register mit einer Exception,
    mode = "close"     schließt die Verbindung ohne Antwort,
    mode = None        antwortet normal.
    """

    def __init__(self) -> None:
        self.mode: str | None = None
        self.server: asyncio.AbstractServer | None = None
        self.connections = 0
        self.requests = 0
        self.port = 0

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        try:
            while True:
                frame = await reader.read(8)
                if not frame:
                    return
                self.requests += 1
                slave, addr, count = frame[0], (frame[2] << 8) | frame[3], (frame[4] << 8) | frame[5]
                if self.mode == "close":
                    return
                fails = (
                    self.mode == "exception" and not _is_fast(addr)
                    or self.mode == "params" and addr >= PARAMS_START
                )
                if fails:
                    body = bytes([slave, 0x83, 0x02])
                else:
                    body = bytes([slave, 0x03, 2 * count]) + bytes([0] * (2 * count))
                writer.write(body + bytes([crc16(body) & 0xFF, crc16(body) >> 8]))
                await writer.drain()
        except (ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()
