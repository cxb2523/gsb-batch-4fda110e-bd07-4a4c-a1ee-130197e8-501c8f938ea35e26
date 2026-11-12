"""Betriebsart."""

from __future__ import annotations

from homeassistant.components import logbook
from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, MODES, REG_MODE
from .entity import AvarmaEntity


class ModeSelect(AvarmaEntity, SelectEntity):
    _attr_icon = "mdi:hvac"
    _attr_options = list(MODES.values())

    @property
    def current_option(self):
        return MODES.get(self.coordinator.u(REG_MODE))

    async def async_select_option(self, option: str) -> None:
        self.coordinator.check_unlocked("U", "Die Betriebsart")
        value = next(k for k, v in MODES.items() if v == option)
        await self.coordinator.async_write(REG_MODE, value)
        logbook.async_log_entry(self.hass, "Wärmepumpe", f"Betriebsart auf {option} gesetzt", DOMAIN, self.entity_id)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([ModeSelect(hass.data[DOMAIN][entry.entry_id], "betriebsart", "Betriebsart")])
