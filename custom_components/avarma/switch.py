"""Ein/Aus, Nachtmodus und Code-Freigaben."""

from __future__ import annotations

from homeassistant.components import logbook
from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, REG_ON
from .entity import AvarmaEntity
from .params import addr


class RegSwitch(AvarmaEntity, SwitchEntity):
    def __init__(self, c, key, name, reg, icon=None) -> None:
        super().__init__(c, key, name)
        self.reg = reg
        if icon:
            self._attr_icon = icon

    @property
    def is_on(self):
        v = self.coordinator.u(self.reg)
        return None if v is None else v == 1

    async def _set(self, v: int) -> None:
        await self.coordinator.async_write(self.reg, v)
        logbook.async_log_entry(self.hass, "Wärmepumpe", f"{self.name} {'ein' if v else 'aus'}geschaltet", DOMAIN, self.entity_id)

    async def async_turn_on(self, **kwargs) -> None:
        await self._set(1)

    async def async_turn_off(self, **kwargs) -> None:
        await self._set(0)


class UnlockSwitch(AvarmaEntity, SwitchEntity):
    """Benutzer-Freigabe: per Schalter (15 min). Techniker-Freigabe: nur per Code. Ausschalten sperrt sofort."""

    def __init__(self, c, key, name, tech: bool) -> None:
        super().__init__(c, key, name)
        self.tech = tech
        self._attr_icon = "mdi:account-hard-hat" if tech else "mdi:lock-open-variant"

    @property
    def available(self) -> bool:
        return True

    @property
    def is_on(self) -> bool:
        return self.coordinator.tech_unlocked if self.tech else self.coordinator.user_unlocked

    async def async_turn_on(self, **kwargs) -> None:
        if self.tech:
            self.coordinator.unlock_tech_switch()
        else:
            self.coordinator.unlock_user()

    async def async_turn_off(self, **kwargs) -> None:
        self.coordinator.lock(tech_only=self.tech)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([
        RegSwitch(c, "switch_ein", "Ein/Aus", REG_ON, "mdi:power"),
        RegSwitch(c, "nachtmodus", "Nachtmodus", addr(17), "mdi:weather-night"),
        UnlockSwitch(c, "benutzer_freigabe", "Benutzer-Freigabe", False),
        UnlockSwitch(c, "techniker_freigabe", "Techniker-Freigabe", True),
    ])
