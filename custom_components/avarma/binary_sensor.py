"""Binärsensoren (Status, Ausgänge, Störung)."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, REG_FREQLIMIT, REG_OIL, REG_ON, REG_OUTPUTS, REG_R290_ALARM, REG_STATUS
from .entity import AvarmaEntity


class Bit(AvarmaEntity, BinarySensorEntity):
    def __init__(self, c, key, name, reg, mask, dclass=None) -> None:
        super().__init__(c, key, name)
        self.reg, self.mask = reg, mask
        self._attr_device_class = dclass

    @property
    def is_on(self):
        v = self.coordinator.u(self.reg)
        return None if v is None else bool(v & self.mask)


class Fn(AvarmaEntity, BinarySensorEntity):
    def __init__(self, c, key, name, fn, dclass=None, always=False) -> None:
        super().__init__(c, key, name)
        self.fn, self.always = fn, always
        self._attr_device_class = dclass

    @property
    def available(self) -> bool:
        return True if self.always else super().available

    @property
    def is_on(self):
        return self.fn(self.coordinator)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    D = BinarySensorDeviceClass
    ents = [
        Fn(c, "ein", "Ein", lambda c: None if c.u(REG_ON) is None else c.u(REG_ON) == 1),
        Fn(c, "kompressor_laeuft", "Kompressor läuft", lambda c: c.compressor_running, D.RUNNING),
        Fn(c, "stoerung", "Störung", lambda c: None if c.fault_list() is None else bool(c.fault_list()), D.PROBLEM),
        Bit(c, "oelrueck", "Ölrückführung", REG_OIL, 1),
        Fn(c, "modbus_online", "Modbus online", lambda c: c.last_update_success, D.CONNECTIVITY, always=True),
        Fn(c, "r290_alarm", "Kältemittel-Alarm", lambda c: (c.u(REG_R290_ALARM) or 0) > 0, D.GAS),
    ]
    for i, n in enumerate(["T3 Lamelle", "Hochdruck", "AC-Spannung", "Heißgas", "AC-Strom"]):
        ents.append(Bit(c, f"flimit_{i}", f"Frequenzbegrenzung {n}", REG_FREQLIMIT, 1 << i))
    for b, n in [(0, "4-Wege-Ventil"), (1, "Öl-Heizung"), (3, "Pumpe C1"), (4, "Pumpe C2"), (5, "Pumpe C3"),
                 (6, "E-Heizung E1"), (7, "E-Heizung E2"), (8, "Ventil G1"), (9, "Ventil G2")]:
        ents.append(Bit(c, f"out_{b}", f"Ausgang {n}", REG_OUTPUTS, 1 << b))
    for b, n in [(3, "Alarm"), (4, "Abtauung"), (8, "Legionellenschaltung"), (9, "Frostschutz"),
                 (10, "Estrichtrocknung"), (11, "PV-Modus")]:
        ents.append(Bit(c, f"stat_{b}", f"{n} aktiv", REG_STATUS, 1 << b))
    add(ents)
