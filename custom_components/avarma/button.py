"""Fehler quittieren und Uhr stellen."""

from __future__ import annotations

import asyncio
import logging

from homeassistant.components import logbook, persistent_notification
from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN, REG_CLOCK_DATE, REG_CLOCK_TIME, REG_FAULT_RESET
from .entity import AvarmaEntity
from .modbus import ModbusError

_LOGGER = logging.getLogger(__name__)


async def set_clock(c) -> None:
    """Uhr der Wärmepumpe auf die Home-Assistant-Zeit stellen.

    Datum und Zeit werden gemeinsam mit Funktion 0x10 geschrieben. Einzelnes Schreiben
    mit 0x06 wurde von der Steuerung bestätigt, aber offenbar nicht übernommen.
    """
    now = dt_util.now()
    want = [now.month * 256 + now.day, now.hour * 256 + now.minute]
    try:
        await c.client.write_registers(REG_CLOCK_DATE, want)
        how = "0x10"
    except ModbusError as err:
        _LOGGER.warning("Uhr stellen mit 0x10 nicht möglich (%s) – versuche 0x06", err)
        await c.client.write_register(REG_CLOCK_DATE, want[0])
        await c.client.write_register(REG_CLOCK_TIME, want[1])
        how = "0x06"
    await asyncio.sleep(2)
    vals = await c.client.read_holding(REG_CLOCK_DATE, 2)
    c.regs[REG_CLOCK_DATE], c.regs[REG_CLOCK_TIME] = vals
    c.async_update_listeners()
    got = f"{vals[0] % 256:02d}.{vals[0] // 256:02d}. {vals[1] // 256:02d}:{vals[1] % 256:02d}"
    off = clock_offset_minutes(c)
    if off is not None and abs(off) > 10:
        # Bei manchen Anlagen gibt das Original-Display seine eigene Uhr vor und überschreibt den Wert.
        _LOGGER.info("Uhr nicht übernommen: geschrieben %s (%s), gelesen %s", now.strftime("%d.%m. %H:%M"), how, got)
        persistent_notification.async_create(
            c.hass,
            f"Die Uhr der Wärmepumpe zeigt {got}, in Home Assistant ist es {now.strftime('%d.%m. %H:%M')} "
            f"(Abweichung {off:+.0f} min). Die Wärmepumpe übernimmt die Uhrzeit über Modbus nicht – das Original-Display "
            "gibt sie vor. Bitte die Uhr direkt am Display stellen. Solange sie falsch geht, beginnen die Tageszähler "
            "(Wärme/Strom heute, COP heute) zur falschen Zeit.",
            "Wärmepumpe: Uhr am Display stellen", "avarma_uhr")
    else:
        persistent_notification.async_dismiss(c.hass, "avarma_uhr")
        _LOGGER.info("Uhr der Wärmepumpe gestellt auf %s (%s)", got, how)

def clock_offset_minutes(c) -> float | None:
    """Abweichung der WP-Uhr von der HA-Zeit in Minuten (None, wenn unbekannt)."""
    d, t = c.u(REG_CLOCK_DATE), c.u(REG_CLOCK_TIME)
    if not d or t is None:
        return None
    now = dt_util.now()
    try:
        wp = now.replace(month=d // 256, day=d % 256, hour=t // 256, minute=t % 256, second=0, microsecond=0)
    except ValueError:
        return None
    return (wp - now).total_seconds() / 60


class FaultReset(AvarmaEntity, ButtonEntity):
    _attr_icon = "mdi:alert-remove"

    async def async_press(self) -> None:
        await self.coordinator.async_write(REG_FAULT_RESET, 1, reread=(4390, 7))
        logbook.async_log_entry(self.hass, "Wärmepumpe", "Fehler quittiert", DOMAIN, self.entity_id)


class ClockSet(AvarmaEntity, ButtonEntity):
    _attr_icon = "mdi:clock-edit"

    async def async_press(self) -> None:
        await set_clock(self.coordinator)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([FaultReset(c, "fehler_reset", "Fehler quittieren"), ClockSet(c, "uhr_stellen", "Uhr stellen")])
