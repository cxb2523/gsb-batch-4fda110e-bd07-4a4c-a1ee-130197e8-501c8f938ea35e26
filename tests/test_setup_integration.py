"""Abnahmetest: Integration über den echten Setup-Weg mit lokalem Modbus-Ersatz-From.

Damit ist belegt, dass die Diagnose-Entitäten wirklich in Home Assistant ankommen
(Entity-IDs wie im Betrieb, Zustand und Attribute) und dass ein anfänglicher
Lesefehler im langsamen Block sichtbar wird.
"""

from __future__ import annotations

import pytest

from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from custom_components.avarma.const import (
    CONF_CLOCK_SYNC, CONF_DASHBOARD, CONF_PROTOCOL, CONF_SCAN_INTERVAL, CONF_SLAVE, DOMAIN,
)

from pytest_homeassistant_custom_component.common import MockConfigEntry

from .fake_modbus import FakeSlave

PARAMS_ENTITY = "sensor.wp_parameterblock_status"
ENERGY_ENTITY = "sensor.wp_energieblock_status"


@pytest.fixture
async def slave(socket_enabled):
    s = FakeSlave()
    s.mode = "params"  # nur der Parameterblock schlägt zunächst fehl, Live-Werte gehen
    await s.start()
    yield s
    await s.stop()


@pytest.mark.asyncio
async def test_setup_creates_block_diagnostics_with_error_state(
    hass: HomeAssistant, slave: FakeSlave, monkeypatch
) -> None:
    """Setup läuft, Parameterblock ist „nicht bereit“ mit Grund, Energieblock normal."""
    # ``LOVELACE_DATA`` gibt es erst in neueren Core-Versionen; im Test-Core (2025.1)
    # liegt der Lovelace-Zustand unter ``hass.data["lovelace"]``. Dashboard ist ohnehin aus.
    from homeassistant.components.lovelace import const as ll_const

    monkeypatch.setattr(ll_const, "LOVELACE_DATA", "lovelace", raising=False)
    entry = MockConfigEntry(domain=DOMAIN, data={
        CONF_HOST: "127.0.0.1", CONF_PORT: slave.port, CONF_SLAVE: 1,
        CONF_PROTOCOL: "rtuovertcp", CONF_SCAN_INTERVAL: 10,
    }, options={CONF_CLOCK_SYNC: False, CONF_DASHBOARD: False})
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    params = hass.states.get(PARAMS_ENTITY)
    assert params is not None, "Parameterblock-Sensor muss angelegt sein"
    assert params.state == "nicht bereit"
    assert params.attributes["start_adresse"] == 8192
    assert params.attributes["letzter_erfolg"] is None
    assert params.attributes["fehlversuche"] == 1
    assert "Modbus-Exception 2" in params.attributes["letzter_fehler"]
    assert params.attributes["letzter_fehler_zeit"] is not None

    energy = hass.states.get(ENERGY_ENTITY)
    assert energy is not None
    assert energy.state == "normal"
    assert energy.attributes["start_adresse"] == 5120
    assert energy.attributes["fehlversuche"] == 0
    assert energy.attributes["letzter_erfolg"] is not None

    # Erholung: nächster regulärer Zyklus liest wieder -> normal, Zähler zurückgesetzt
    slave.mode = None
    coord = hass.data[DOMAIN][entry.entry_id]
    next(b for b in coord.slow if b.key == "params").due = 0.0
    await coord.async_refresh()
    await hass.async_block_till_done()

    params = hass.states.get(PARAMS_ENTITY)
    assert params.state == "normal"
    assert params.attributes["fehlversuche"] == 0
    assert params.attributes["letzter_erfolg"] is not None
    assert params.attributes["letzter_erfolg"] <= dt_util.now().isoformat()

    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
