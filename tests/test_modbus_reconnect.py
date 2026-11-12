"""Tests mit einem echten lokalen Modbus-Ersatz-From (RTU over TCP).

Prüft den Weg, den ein echter Bus nimmt: Lesefehler -> Client schließt die
Verbindung -> nächste Transaktion verbindet neu -> erfolgreicher Lesevorgang
setzt Fehlerzähler und Status des langsamen Blocks zurück.

Hier wird bewusst keine eingefrorene Uhr verwendet (freezegun stört den
Ereignisschleifen-Takt); die Fälligkeit des langsamen Blocks wird direkt
über ``SlowBlock.due`` gesteuert.
"""

from __future__ import annotations

import pytest

from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from custom_components.avarma.blocks import BLOCK_NOT_READY, BLOCK_OK
from custom_components.avarma.const import CONF_PROTOCOL, CONF_SCAN_INTERVAL, CONF_SLAVE, DOMAIN
from custom_components.avarma.coordinator import AvarmaCoordinator
from custom_components.avarma.modbus import PROTO_RTU_OVER_TCP, AvarmaModbus

from pytest_homeassistant_custom_component.common import MockConfigEntry

from .fake_modbus import FakeSlave


@pytest.fixture
async def slave(socket_enabled):
    s = FakeSlave()
    await s.start()
    yield s
    await s.stop()


@pytest.fixture
async def coord(hass: HomeAssistant, slave: FakeSlave):
    client = AvarmaModbus("127.0.0.1", slave.port, 1, PROTO_RTU_OVER_TCP, timeout=2.0)
    entry = MockConfigEntry(domain=DOMAIN, data={
        CONF_HOST: "127.0.0.1", CONF_PORT: slave.port, CONF_SLAVE: 1,
        CONF_PROTOCOL: PROTO_RTU_OVER_TCP, CONF_SCAN_INTERVAL: 10,
    })
    entry.add_to_hass(hass)
    c = AvarmaCoordinator(hass, entry, client, 10)
    yield c
    c._store._async_cleanup_delay_listener()  # verzögertes Speichern (60 s) nicht im Test hängen lassen
    c._async_unsub_refresh()
    await client.close()


def _params(coord: AvarmaCoordinator):
    return next(b for b in coord.slow if b.key == "params")


@pytest.mark.asyncio
async def test_bus_error_closes_connection_and_recovery_resets_block(
    hass: HomeAssistant, slave: FakeSlave, coord: AvarmaCoordinator
) -> None:
    """Lesefehler -> Verbindung zu, automatischer Neuaufbau -> Block wieder normal, Zähler 0."""
    slave.mode = "exception"
    await coord.async_refresh()
    blk = _params(coord)
    assert blk.status(dt_util.now()) == BLOCK_NOT_READY
    assert blk.consecutive_failures == 1
    assert "Modbus-Exception 2" in (blk.last_failure_reason or "")
    assert coord.client._writer is None, "Client muss die Verbindung nach dem Fehler schließen"

    # Slave wieder erreichbar -> nächste Transaktion verbindet neu und liest Daten
    slave.mode = None
    blk.due = 0.0  # retry sofort statt nach 30 s
    await coord.async_refresh()

    assert coord.client._writer is not None, "Client muss sich automatisch neu verbinden"
    assert slave.connections >= 2, "Neuverbindung muss stattgefunden haben"
    assert blk.consecutive_failures == 0
    assert blk.status(dt_util.now()) == BLOCK_OK
    assert blk.last_success is not None
    assert blk.last_success <= dt_util.now()
    assert "Modbus-Exception 2" in (blk.last_failure_reason or "")  # letzter Fehler bleibt dokumentiert


@pytest.mark.asyncio
async def test_bus_disconnect_reconnects_and_recovers(
    hass: HomeAssistant, slave: FakeSlave, coord: AvarmaCoordinator
) -> None:
    """Abgerissene Verbindung (keine Antwort) -> Neustart der Verbindung -> Block normal."""
    slave.mode = "close"
    await coord.async_refresh()
    blk = _params(coord)
    # Der schnelle Block schlägt fehl -> UpdateFailed, der langsame Block bekommt
    # gar keinen Versuch und bleibt „nicht bereit“ ohne Fehlversuch.
    assert coord.last_update_success is False
    assert blk.status(dt_util.now()) == BLOCK_NOT_READY
    assert blk.consecutive_failures == 0
    assert coord.client._writer is None

    slave.mode = None
    await coord.async_refresh()
    assert coord.last_update_success is True
    assert blk.status(dt_util.now()) == BLOCK_OK
    assert blk.last_success is not None
    assert slave.connections >= 2
