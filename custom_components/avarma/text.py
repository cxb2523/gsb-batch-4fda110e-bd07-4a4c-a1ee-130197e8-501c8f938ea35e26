"""Code-Eingabe wie am Display (Benutzer 99 / Techniker-Code aus den Optionen)."""

from __future__ import annotations

from homeassistant.components import persistent_notification
from homeassistant.components.text import TextEntity, TextMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, UNLOCK_MINUTES
from .entity import AvarmaEntity


class CodeText(AvarmaEntity, TextEntity):
    _attr_mode = TextMode.PASSWORD
    _attr_native_max = 8
    _attr_icon = "mdi:lock"
    _attr_native_value = ""

    @property
    def available(self) -> bool:
        return True

    async def async_set_value(self, value: str) -> None:
        if not value:
            return
        try:
            level = self.coordinator.enter_code(value)
        finally:
            self._attr_native_value = ""
            self.async_write_ha_state()
        persistent_notification.async_dismiss(self.hass, "avarma_lock")
        persistent_notification.async_create(
            self.hass, f"{'Techniker' if level == 'techniker' else 'Benutzer'}-Parameter für {UNLOCK_MINUTES} Minuten freigegeben.",
            "Wärmepumpe", "avarma_lock")


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    add([CodeText(hass.data[DOMAIN][entry.entry_id], "code", "Code eingeben")])
