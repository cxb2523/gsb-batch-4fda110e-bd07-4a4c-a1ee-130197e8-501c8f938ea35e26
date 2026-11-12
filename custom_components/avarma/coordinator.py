"""Abfrage der Wärmepumpe, Zähler, Fehlerüberwachung und Code-Freigabe."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
import logging
import time
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import (
    CONF_NOTIFY, CONF_TECH_CODE, CONF_TECH_SWITCH, DOMAIN, DRV, ERR, FAULT_BITS, REG_DRV, REG_FAULTS, REG_FREQ,
    REG_HIST, REG_R290_ALARM, REG_R290_KONZ, REG_STARTS, UNLOCK_MINUTES, USER_CODE,
)
from .modbus import AvarmaModbus, ModbusError

_LOGGER = logging.getLogger(__name__)

FAST_BLOCKS = [(4096, 12), (4352, 50), (4608, 28)]
SLOW_BLOCKS = [  # (Intervall s, Blöcke)
    (900, [(8192, 60), (8252, 60), (8312, 29), (4864, 8)]),   # Parameter P00..P150, SG-Ready
    (300, [(5120, 60), (5180, 60), (5240, 60), (5300, 22)]),  # Energiezähler
    (600, [(6666, 1)]),                                       # Abtauung gesperrt
]
STORE_VERSION = 1
KOMP_DELAY_OFF = 45  # s, wie früher delay_off der Template-Binärsensors

# Zähler, die beim ersten Start aus dem Recorder (alte Utility-Meter) übernommen werden
STARTS_PERIODS = {"heute": "day", "woche": "week", "monat": "month", "jahr": "year"}
ENERGY_ACC = {f"{src}_{p}": (src, p) for src in ("waerme", "strom") for p in ("week", "month", "year")}


def period_key(kind: str, now: datetime) -> str:
    if kind == "day":
        return now.date().isoformat()
    if kind == "week":
        y, w, _ = now.isocalendar()
        return f"{y}-W{w}"
    if kind == "month":
        return f"{now.year}-{now.month:02d}"
    return str(now.year)


def s16(v: int | None) -> int | None:
    if v is None:
        return None
    return v - 0x10000 if v & 0x8000 else v


class AvarmaCoordinator(DataUpdateCoordinator[dict[int, int]]):
    """Liest alle Register und hält abgeleitete Zustände."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: AvarmaModbus, scan: int) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=timedelta(seconds=scan), config_entry=entry)
        self.entry = entry
        self.client = client
        self.regs: dict[int, int] = {}
        self._slow_due = [0.0] * len(SLOW_BLOCKS)
        self._store = Store(hass, STORE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self.acc: dict[str, Any] = {}
        self._last_ts: float | None = None
        self._last_nonzero = 0.0
        self.faults: list[str] | None = None
        self._r290_was = False
        self.unlock_user_until = 0.0
        self.unlock_tech_until = 0.0
        self._unlock_cb = None

    # ------------------------------------------------------------ Register
    def u(self, addr: int) -> int | None:
        return self.regs.get(addr)

    def s(self, addr: int) -> int | None:
        return s16(self.regs.get(addr))

    async def _read_blocks(self, blocks) -> None:
        for start, count in blocks:
            vals = await self.client.read_holding(start, count)
            for i, v in enumerate(vals):
                self.regs[start + i] = v

    async def _async_update_data(self) -> dict[int, int]:
        try:
            try:
                await self._read_blocks(FAST_BLOCKS)
            except ModbusError:
                await self._read_blocks(FAST_BLOCKS)  # ein zweiter Versuch
        except ModbusError as err:
            raise UpdateFailed(str(err)) from err
        mono = time.monotonic()
        for i, (interval, blocks) in enumerate(SLOW_BLOCKS):
            if mono >= self._slow_due[i]:
                try:
                    await self._read_blocks(blocks)
                    self._slow_due[i] = mono + interval
                except ModbusError as err:
                    _LOGGER.debug("Langsamer Block %s: %s", blocks[0], err)
                    self._slow_due[i] = mono + 30
        self._update_derived()
        return self.regs

    async def async_write(self, addr: int, value: int, reread: tuple[int, int] | None = None) -> None:
        try:
            await self.client.write_register(addr, value)
            start, count = reread or (addr, 1)
            await asyncio.sleep(1)
            vals = await self.client.read_holding(start, count)
            for i, v in enumerate(vals):
                self.regs[start + i] = v
        except ModbusError as err:
            raise HomeAssistantError(f"Wärmepumpe: Schreiben fehlgeschlagen ({err})") from err
        self.async_update_listeners()

    # ------------------------------------------------------------ Kompressor
    @property
    def compressor_running(self) -> bool | None:
        f = self.u(REG_FREQ)
        if f is None:
            return None
        return f > 0 or (time.monotonic() - self._last_nonzero) < KOMP_DELAY_OFF

    # ------------------------------------------------------------ Energie
    def _esum(self, start: int, count: int) -> float | None:
        vals = [self.regs.get(start + i) for i in range(count)]
        if any(v is None for v in vals):
            return None
        return round(sum(s16(v) for v in vals) / 10, 1)

    def energy_today(self, kind: str) -> float | None:
        return self._esum(5120 if kind == "waerme" else 5254 if kind == "strom" else 5187, 24)

    def energy_month_display(self, kind: str) -> float | None:
        # Die Tageswerte der WP enthalten nur abgeschlossene Tage -> heute (Stundenwerte) addieren
        days, today = self._esum({"waerme": 5144, "strom": 5278, "ren": 5211}[kind], 31), self.energy_today(kind)
        return None if days is None or today is None else round(days + today, 1)

    def _week_from_days(self, d0: int, now: datetime) -> float:
        """Summe der Tageswerte dieser Woche (nur Tage im laufenden Monat)."""
        first = max(1, now.day - now.weekday())
        done = sum(s16(self.regs.get(d0 + d - 1) or 0) for d in range(first, now.day)) / 10
        return round(done + (self.energy_today("ren") or 0), 1)

    def energy_year(self, kind: str) -> float | None:
        m0, d0 = {"waerme": (5175, 5144), "strom": (5309, 5278), "ren": (5242, 5211)}[kind]
        months = [self.regs.get(m0 + i) for i in range(12)]
        days = self._esum(d0, 31)
        if any(v is None for v in months) or days is None:
            return None
        months = [s16(v) / 10 for v in months]
        cur = months[dt_util.now().month - 1]
        return round(sum(months) - cur + max(cur, days) + (self.energy_today(kind) or 0), 1)

    # ------------------------------------------------------------ Fehler
    def fault_list(self) -> list[str] | None:
        if any(self.regs.get(a) is None for a in REG_FAULTS + REG_DRV[:1]):
            return None
        out = []
        for reg, bits in zip(REG_FAULTS, FAULT_BITS):
            r = self.regs[reg]
            for b, code in bits.items():
                if code is not None and r & (1 << b):
                    out.append(f"E{code:02d} {ERR.get(code, '')}".strip())
        r = self.regs[REG_DRV[0]]
        for b, t in DRV.items():
            if r & (1 << b):
                out.append(f"E20 Treiber: {t}")
        return out

    def fault_history(self) -> list[str]:
        out = []
        for i in range(8):
            c = self.regs.get(REG_HIST + i) or 0
            if c > 0:
                out.append(f"E{c:02d} {ERR.get(c, 'unbekannt')}")
        return out

    # ------------------------------------------------------------ Speicher/Zähler
    async def async_load_store(self) -> None:
        data = await self._store.async_load()
        self.acc = data or {}

    def _save(self) -> None:
        self._store.async_delay_save(lambda: self.acc, 60)

    async def async_init_from_recorder(self, old: dict[str, float | None], starts_24h_ago: float | None) -> None:
        """Erster Start: Werte der bisherigen Utility-Meter/History-Stats übernehmen."""
        self.acc.setdefault("init_old", old)
        if starts_24h_ago is not None:
            self.acc.setdefault("samples", [[time.time() - 86400, starts_24h_ago]])

    def _update_derived(self) -> None:
        now = dt_util.now()
        ts = time.time()
        mono = time.monotonic()
        f = self.u(REG_FREQ) or 0
        if f > 0:
            self._last_nonzero = mono
        running = self.compressor_running
        acc = self.acc
        old = acc.get("init_old") or {}

        # Laufzeit heute (Sekunden)
        day = period_key("day", now)
        if acc.get("run_day") != day:
            acc["run_day"], acc["run_s"] = day, 0.0
            if "run_init" not in acc and old.get("laufzeit_heute") is not None:
                acc["run_s"] = float(old["laufzeit_heute"]) * 3600
            acc["run_init"] = True
        if running and self._last_ts is not None:
            acc["run_s"] += min(ts - self._last_ts, 120)
        self._last_ts = ts

        # Kompressor-Starts je Periode (Basis = Zählerstand zu Periodenbeginn)
        total = self.u(REG_STARTS)
        if total is not None:
            for name, kind in STARTS_PERIODS.items():
                key = period_key(kind, now)
                if acc.get(f"st_{name}_key") != key or total < acc.get(f"st_{name}_base", 0):
                    base = total
                    if f"st_{name}_key" not in acc and old.get(f"starts_{name}") is not None:
                        base = total - int(float(old[f"starts_{name}"]))
                    acc[f"st_{name}_key"], acc[f"st_{name}_base"] = key, base
            samples = acc.setdefault("samples", [])
            if not samples or ts - samples[-1][0] >= 300:
                samples.append([ts, total])
            while len(samples) > 2 and samples[1][0] <= ts - 86400:
                samples.pop(0)

        # Wärme/Strom Woche, Monat, Jahr (aus "heute", das täglich auf 0 springt)
        for kind in ("waerme", "strom", "ren"):
            src = self.energy_today(kind)
            if src is None:
                continue
            last = acc.get(f"e_{kind}_last")
            delta = 0.0 if last is None else (src - last if src >= last else src)
            acc[f"e_{kind}_last"] = src
            for p in ("week", "month", "year"):
                k = f"{kind}_{p}"
                key = period_key(p, now)
                if acc.get(f"e_{k}_key") != key:
                    start = 0.0
                    if f"e_{k}_key" not in acc and old.get(k) is not None:
                        start = float(old[k])
                    elif f"e_{k}_key" not in acc and kind == "ren" and p == "week":
                        start = self._week_from_days(5211, now)
                    acc[f"e_{k}_key"], acc[f"e_{k}"] = key, start
                else:
                    acc[f"e_{k}"] = round(acc[f"e_{k}"] + delta, 2)
        self._save()
        self._check_faults()

    def starts(self, name: str) -> int | None:
        total = self.u(REG_STARTS)
        if total is None or f"st_{name}_base" not in self.acc:
            return None
        return max(total - self.acc[f"st_{name}_base"], 0)

    def starts_24h(self) -> int | None:
        total = self.u(REG_STARTS)
        samples = self.acc.get("samples") or []
        if total is None or not samples:
            return None
        return max(total - samples[0][1], 0)

    def runtime_today_h(self) -> float:
        return round(self.acc.get("run_s", 0.0) / 3600, 2)

    # ------------------------------------------------------------ Meldungen
    def _notify(self, title: str, message: str, data: dict | None = None) -> None:
        svc = (self.entry.options.get(CONF_NOTIFY) or "").strip()
        if not svc or "." not in svc:
            return
        domain, service = svc.split(".", 1)
        payload = {"title": title, "message": message}
        if data:
            payload["data"] = data
        self.hass.async_create_task(
            self.hass.services.async_call(domain, service, payload, blocking=False)
        )

    def _check_faults(self) -> None:
        cur = self.fault_list()
        if cur is None:
            return
        prev, self.faults = self.faults, cur
        if prev is not None:
            new = [f for f in cur if f not in prev]
            if new:
                stamp = dt_util.now().strftime("%d.%m.%Y %H:%M")
                self.hass.bus.async_fire(f"{DOMAIN}_stoerung", {"fehler": new, "alle": cur})
                persistent_notification.async_create(
                    self.hass, f"Aktive Fehler: {', '.join(cur)} ({stamp})", "Wärmepumpe: Störung", "avarma_fehler")
                self._notify("⚠️ Wärmepumpe: Störung", ", ".join(cur),
                             {"push": {"interruption-level": "time-sensitive"}, "url": "/waermepumpe/fehler"})
        konz = self.u(REG_R290_KONZ) or 0
        r290 = bool(self.u(REG_R290_ALARM)) or konz > 0 or any(f.startswith("E51") for f in cur)
        if r290 and not self._r290_was:
            k = f"{konz / 10:.1f}"
            persistent_notification.async_create(
                self.hass,
                f"Die Wärmepumpe meldet Kältemittel (R290/Propan) – Konzentration {k} %, Fehler: {', '.join(cur) or 'keine'}. "
                "Keine Zündquellen, Bereich lüften, WP stromlos schalten, Fachbetrieb rufen.",
                "⚠️ WÄRMEPUMPE: KÄLTEMITTEL-ALARM", "avarma_r290")
            self._notify("⚠️ Wärmepumpe: Kältemittel-ALARM",
                         f"R290-Leck gemeldet ({k} %). Keine Zündquellen, lüften, WP stromlos, Fachbetrieb rufen.",
                         {"push": {"sound": {"name": "default", "critical": 1, "volume": 1.0}, "interruption-level": "critical"}})
        self._r290_was = r290

    # ------------------------------------------------------------ Code-Freigabe
    @property
    def user_unlocked(self) -> bool:
        return time.monotonic() < self.unlock_user_until

    @property
    def tech_unlocked(self) -> bool:
        return time.monotonic() < self.unlock_tech_until

    def enter_code(self, code: str) -> str:
        code = (code or "").strip()
        tech = (self.entry.options.get(CONF_TECH_CODE) or "").strip()
        until = time.monotonic() + UNLOCK_MINUTES * 60
        if tech and code == tech:
            self.unlock_tech_until = self.unlock_user_until = until
            level = "techniker"
        elif code == USER_CODE:
            self.unlock_user_until = until
            level = "benutzer"
        else:
            raise HomeAssistantError("Wärmepumpe: Falscher Code.")
        self._schedule_relock()
        self.async_update_listeners()
        return level

    def unlock_user(self) -> None:
        """Benutzer-Freigabe per Schalter (Code 99 steht ohnehin in der Anleitung)."""
        self.unlock_user_until = time.monotonic() + UNLOCK_MINUTES * 60
        self._schedule_relock()
        self.async_update_listeners()

    def unlock_tech_switch(self) -> None:
        """Techniker-Freigabe per Schalter – nur wenn in den Optionen erlaubt und ein Code hinterlegt ist."""
        o = self.entry.options
        if not (o.get(CONF_TECH_SWITCH) and (o.get(CONF_TECH_CODE) or "").strip()):
            raise HomeAssistantError("Techniker-Freigabe nur über „WP Code eingeben“ mit dem Techniker-Code "
                                     "(oder in den Optionen der Integration „per Schalter erlauben“ aktivieren).")
        self.unlock_tech_until = self.unlock_user_until = time.monotonic() + UNLOCK_MINUTES * 60
        self._schedule_relock()
        self.async_update_listeners()

    def lock(self, tech_only: bool = False) -> None:
        self.unlock_tech_until = 0.0
        if not tech_only:
            self.unlock_user_until = 0.0
        self.async_update_listeners()

    def _schedule_relock(self) -> None:
        if self._unlock_cb:
            self._unlock_cb()

        @callback
        def _relock(_now) -> None:
            self._unlock_cb = None
            self.async_update_listeners()

        self._unlock_cb = async_call_later(self.hass, UNLOCK_MINUTES * 60 + 1, _relock)

    def check_unlocked(self, level: str, what: str) -> None:
        if level == "T" and not self.tech_unlocked:
            raise HomeAssistantError(f"{what} wurde NICHT geändert. Zuerst den Techniker-Code eingeben.")
        if level == "U" and not self.user_unlocked:
            raise HomeAssistantError(f"{what} wurde NICHT geändert. Zuerst den Benutzer-Code (99) oder Techniker-Code eingeben.")

    async def async_shutdown_store(self) -> None:
        if self._unlock_cb:
            self._unlock_cb()
        await self._store.async_save(self.acc)
