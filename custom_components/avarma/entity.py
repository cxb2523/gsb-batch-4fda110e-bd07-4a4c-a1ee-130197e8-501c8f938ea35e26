"""Gemeinsame Basis der Entitäten."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, MANUFACTURER
from .coordinator import AvarmaCoordinator


class AvarmaEntity(CoordinatorEntity[AvarmaCoordinator]):
    """Entitätsname = 'WP <Name>' (Gerätename 'WP'), dadurch bleiben die
    Entity-IDs identisch zur früheren YAML-Version (z. B. sensor.wp_vorlauf_tout)."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: AvarmaCoordinator, key: str, name: str) -> None:
        super().__init__(coordinator)
        self.key = key
        self._attr_name = name
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name="WP",
            manufacturer=MANUFACTURER,
            model="R290 Monoblock (Modbus)",
            sw_version=str(coordinator.u(4615) or ""),
            configuration_url="https://github.com/KaHu85/HA-Hofman-Energy-Dashboard-avarma-heatpump",
        )
