"""Tests für die Zustandsmeldung der langsam abgefragten Modbus-Registerblöcke."""

from __future__ import annotations

from datetime import timedelta
import logging

import pytest
from freezegun import freeze_time

from homeassistant.const import CONF_HOST, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import EntityPlatform
from homeassistant.helpers.update_coordinator import UpdateFailed
from homeassistant.util import dt as dt_util

from custom_components.avarma.blocks import (
    BLOCK_FAILED, BLOCK_NOT_READY, BLOCK_OK, BLOCK_STALE,
)
from custom_components.avarma.const import CONF_PROTOCOL, CONF_SCAN_INTERVAL, CONF_SLAVE, DOMAIN
from custom_components.avarma.coordinator import FAST_BLOCKS, SLOW_BLOCKS, AvarmaCoordinator
from custom_components.avarma.modbus import ModbusError, PROTO_RTU_OVER_TCP
from custom_components.avarma.sensor import BlockStatusSensor

from pytest_homeassistant_custom_component.common import MockConfigEntry


START = "2026-01-01 12:00:00"
PARAMS_START = SLOW_BLOCKS[0][3][0][0]
ENERGY_START = SLOW_BLOCKS[1][3][0][0]
SCAN = 10


class FakeModbus:
    """Ersatz-Client: liefert feste Registerwerte, kann gezielt Fehler werfen.

    failure_mode:
      None     – alles lesbar
      "params" – Lesen im Parameterblock (Adressen ab 8192) schlägt fehl
      "slow"   – jeder langsame Block (alle Adressen außerhalb FAST_BLOCKS) schlägt fehl
      "fast"   – jeder schnelle Block schlägt fehl
    """

    def __init__(self, failure_mode: str | None = None) -> None:
        self.failure_mode = failure_mode
        self.reads: list[tuple[int, int]] = []
        self.closed = False
        self.connections = 1  # Erstverbindung beim Start
        self.reconnects = 0

    @staticmethod
    def _is_fast(address: int) -> bool:
        return any(start <= address < start + count for start, count in FAST_BLOCKS)

    async def read_holding(self, address: int, count: int) -> list[int]:
        self.reads.append((address, count))
        mode = self.failure_mode
        err = None
        if mode == "fast" and self._is_fast(address):
            err = "Zeitüberschreitung (fast)"
        elif mode == "params" and address >= PARAMS_START:
            err = "Modbus-Exception 2"
        elif mode == "slow" and not self._is_fast(address):
            err = "Zeitüberschreitung (slow)"
        if err is not None:
            self.closed = True  # wie der echte Client: ModbusError -> Verbindung zu
            raise ModbusError(f"Lesen {address}+{count}: {err}")
        if self.closed:  # nächste Transaktion verbindet automatisch neu
            self.closed = False
            self.connections += 1
            self.reconnects += 1
        return [0] * count

    async def write_register(self, address: int, value: int) -> None:
        pass

    async def write_registers(self, address: int, values: list[int]) -> None:
        pass

    async def close(self) -> None:
        self.closed = True


def _cleanup(c: AvarmaCoordinator) -> None:
    """Aufräumen: verzögertes Speichern (Store, 60 s) und Refresh-Timer abbrechen."""
    store = getattr(c, "_store", None)
    if store is not None:
        store._async_cleanup_delay_listener()
    c._async_unsub_refresh()


@pytest.fixture
async def coord(hass: HomeAssistant):
    """Koordinator mit Ersatz-Client."""
    client = FakeModbus()
    entry = MockConfigEntry(domain=DOMAIN, data={
        CONF_HOST: "127.0.0.1", CONF_PORT: 502, CONF_SLAVE: 1,
        CONF_PROTOCOL: PROTO_RTU_OVER_TCP, CONF_SCAN_INTERVAL: SCAN,
    })
    entry.add_to_hass(hass)
    c = AvarmaCoordinator(hass, entry, client, SCAN)
    yield c
    _cleanup(c)


def _block(coord: AvarmaCoordinator, key: str):
    return next(b for b in coord.slow if b.key == key)


async def _refresh(coord: AvarmaCoordinator) -> None:
    """Ein regulärer Abfragezyklus (Fehler landen in last_update_success, nicht als Exception)."""
    await coord.async_refresh()


async def _add_block_entities(hass: HomeAssistant, coord: AvarmaCoordinator):
    """Block-Sensoren über eine echte Entitätsplattform anlegen (erzeugt Entity-IDs wie im Betrieb)."""
    platform = EntityPlatform(
        hass=hass, logger=logging.getLogger(__name__), domain="sensor",
        platform_name=DOMAIN, platform=None, scan_interval=timedelta(seconds=SCAN),
        entity_namespace=None,
    )
    platform.config_entry = coord.entry
    entities = [BlockStatusSensor(coord, b) for b in coord.slow]
    await platform.async_add_entities(entities)
    return platform, entities


# ----------------------------------------------------------------- Normal-, Fehler- und Grenzfälle


@pytest.mark.asyncio
async def test_fast_block_failure_twice_raises_update_failed(hass: HomeAssistant, coord) -> None:
    """Der schnelle Block wird zweimal versucht; danach wirft der Koordinator UpdateFailed."""
    client = coord.client
    client.failure_mode = "fast"
    with pytest.raises(UpdateFailed):
        await coord._async_update_data()
    # Der erste schnelle Teilblock scheitert bereits -> genau zwei Versuche, keine langsamen Blöcke
    assert len(client.reads) == 2
    assert all(FakeModbus._is_fast(a) for a, _ in client.reads)


@pytest.mark.asyncio
async def test_first_read_failure_is_not_ready_with_reason(hass: HomeAssistant, coord) -> None:
    """Erster Leseversuch wirft ModbusError -> „nicht bereit“, Fehlergrund sichtbar."""
    coord.client.failure_mode = "params"
    with freeze_time(START):
        await _refresh(coord)
        blk = _block(coord, "params")
        assert blk.status(dt_util.now()) == BLOCK_NOT_READY
        assert blk.consecutive_failures == 1
        assert blk.last_success is None
        assert "Modbus-Exception 2" in (blk.last_failure_reason or "")
        assert "Lesen 8192+60" in (blk.last_failure_reason or "")
        # nicht betroffene Blöcke bleiben normal
        assert _block(coord, "energy").status(dt_util.now()) == BLOCK_OK
        assert _block(coord, "defrost").status(dt_util.now()) == BLOCK_OK


@pytest.mark.asyncio
async def test_recovery_resets_failures_and_refreshes_success_time(hass: HomeAssistant, coord) -> None:
    """Erholung -> „normal“, Fehlerzähler 0, letzter Erfolg aktualisiert."""
    coord.client.failure_mode = "params"
    with freeze_time(START) as frozen:
        await _refresh(coord)
        blk = _block(coord, "params")
        assert blk.consecutive_failures == 1
        assert blk.status(dt_util.now()) == BLOCK_NOT_READY
        assert coord.client.reconnects >= 1, "nach dem Busfehler verbindet der Client neu"

        coord.client.failure_mode = None
        frozen.tick(timedelta(seconds=31))  # nach dem 30-s-Retry wieder fällig
        await _refresh(coord)

        assert blk.consecutive_failures == 0
        assert blk.status(dt_util.now()) == BLOCK_OK
        assert blk.last_success == dt_util.now()
        assert not coord.client.closed, "nächste Transaktion verbindet automatisch neu"
        # der Grund des letzten Fehlschlags bleibt dokumentiert
        assert "Modbus-Exception 2" in (blk.last_failure_reason or "")


@pytest.mark.asyncio
async def test_single_failure_within_period_is_fehler_not_stale(hass: HomeAssistant, coord) -> None:
    """Grenzfall: Fehler, aber noch keine zwei Perioden alt -> „fehler“, nicht „veraltet“."""
    with freeze_time(START) as frozen:
        await _refresh(coord)  # Erstlauf: alles erfolgreich
        blk = _block(coord, "params")
        success = blk.last_success

        coord.client.failure_mode = "params"
        frozen.tick(timedelta(seconds=900))  # Block ist wieder fällig (eine Periode nach Erfolg)
        await _refresh(coord)

        assert blk.status(dt_util.now()) == BLOCK_FAILED
        assert blk.last_success == success
        assert blk.consecutive_failures > 0


@pytest.mark.asyncio
async def test_stale_after_two_periods_keeps_last_success(hass: HomeAssistant, coord) -> None:
    """Länger als zwei Perioden ohne Erfolg -> „veraltet“, letzter Erfolg bleibt stehen."""
    with freeze_time(START) as frozen:
        await _refresh(coord)
        blk = _block(coord, "params")
        assert blk.status(dt_util.now()) == BLOCK_OK
        success = blk.last_success

        coord.client.failure_mode = "params"
        for _ in range(30):  # 30 x 30 s = 900 s Fehlversuche mit Retry-Takt
            frozen.tick(timedelta(seconds=30))
            await _refresh(coord)
        # 900 s nach Erfolg: noch „fehler“ (Grenze genau zwei Perioden = 1800 s)
        assert blk.status(dt_util.now()) == BLOCK_FAILED

        for _ in range(31):  # weitere 930 s -> insgesamt über 1800 s
            frozen.tick(timedelta(seconds=30))
            await _refresh(coord)
        assert blk.status(dt_util.now()) == BLOCK_STALE
        assert blk.last_success == success
        assert blk.consecutive_failures >= 2

        # Erholung: Zustand normal, Erfolgszeit neu
        coord.client.failure_mode = None
        frozen.tick(timedelta(seconds=31))
        await _refresh(coord)
        assert blk.status(dt_util.now()) == BLOCK_OK
        assert blk.consecutive_failures == 0
        assert blk.last_success > success


@pytest.mark.asyncio
async def test_fast_failure_keeps_slow_status(hass: HomeAssistant, coord) -> None:
    """Scheitert der schnelle Block und damit das Gesamt-Update, bleibt der langsame Blockstatus erhalten."""
    with freeze_time(START) as frozen:
        await _refresh(coord)
        blk = _block(coord, "params")
        success = blk.last_success

        # erst ein paar langsame Fehler, damit Fehlerzähler und Grund gesetzt sind
        coord.client.failure_mode = "params"
        frozen.tick(timedelta(seconds=900))
        await _refresh(coord)
        count, reason = blk.consecutive_failures, blk.last_failure_reason

        assert blk.status(dt_util.now()) == BLOCK_FAILED

        # jetzt fällt der schnelle Block aus -> jeder Zyklus endet mit UpdateFailed
        coord.client.failure_mode = "fast"
        for _ in range(3):
            frozen.tick(timedelta(seconds=SCAN))
            await _refresh(coord)
            assert coord.last_update_success is False
            assert isinstance(coord.last_exception, UpdateFailed)

        assert blk.last_success == success, "letzter Erfolg darf nicht gelöscht werden"
        assert blk.consecutive_failures == count, "kein Fehlversuch hochzählen ohne Leseversuch"
        assert blk.last_failure_reason == reason
        assert blk.status(dt_util.now()) == BLOCK_FAILED


@pytest.mark.asyncio
async def test_stale_even_when_only_fast_block_fails(hass: HomeAssistant, coord) -> None:
    """Ohne jede langsame Abfrage wird ein Block nach zwei Perioden trotzdem „veraltet“."""
    with freeze_time(START) as frozen:
        await _refresh(coord)
        blk = _block(coord, "energy")
        success = blk.last_success

        coord.client.failure_mode = "fast"
        frozen.tick(timedelta(seconds=2 * blk.interval + 31))
        await _refresh(coord)
        assert blk.status(dt_util.now()) == BLOCK_STALE
        assert blk.last_success == success


# ----------------------------------------------------------------- Entitäten


@pytest.mark.asyncio
async def test_entities_expose_status_and_attributes(hass: HomeAssistant, coord) -> None:
    """Diagnose-Entitäten: Zustand und Attribute sichtbar, danach Übergang nach „normal“."""
    _platform, entities = await _add_block_entities(hass, coord)

    params_id = device_id = None
    for entity in entities:
        if entity.unique_id.endswith("_block_params"):
            params_id = entity.entity_id
        if entity.unique_id.endswith("_block_energy"):
            device_id = entity.entity_id
    # Entity-ID wie die übrigen Entitäten: Gerätename „WP“ + Entitätsname
    assert params_id == "sensor.wp_parameterblock_status"
    assert device_id == "sensor.wp_energieblock_status"

    with freeze_time(START) as frozen:
        coord.client.failure_mode = "params"
        await _refresh(coord)

        state = hass.states.get(params_id)
        attrs = state.attributes
        assert state.state == BLOCK_NOT_READY
        assert attrs["start_adresse"] == PARAMS_START
        assert attrs["letzter_erfolg"] is None
        assert attrs["fehlversuche"] == 1
        assert "Modbus-Exception 2" in attrs["letzter_fehler"]
        assert attrs["letzter_fehler_zeit"] is not None
        assert attrs["block"] == "Parameterblock"

        assert hass.states.get(device_id).state == BLOCK_OK
        assert hass.states.get(device_id).attributes["start_adresse"] == ENERGY_START

        coord.client.failure_mode = None
        frozen.tick(timedelta(seconds=31))
        await _refresh(coord)
        state = hass.states.get(params_id)
        assert state.state == BLOCK_OK
        assert state.attributes["fehlversuche"] == 0
        assert state.attributes["letzter_erfolg"] == dt_util.now().isoformat()
        success = state.attributes["letzter_erfolg"]

        # Fehlerzähler steigt wieder; nach einer Periode noch „fehler“, nach über
        # zwei Perioden ohne Erfolg „veraltet“ – der Zustand bleibt bei Updates sichtbar
        coord.client.failure_mode = "params"
        frozen.tick(timedelta(seconds=900))
        await _refresh(coord)
        assert hass.states.get(params_id).state == BLOCK_FAILED

        frozen.tick(timedelta(seconds=901))
        await _refresh(coord)
        assert hass.states.get(params_id).state == BLOCK_STALE
        # letzter Erfolg bleibt der Zeitpunkt der letzten erfolgreichen Lesung
        assert hass.states.get(params_id).attributes["letzter_erfolg"] == success


@pytest.mark.asyncio
async def test_block_entity_stays_available_when_overall_update_fails(hass: HomeAssistant, coord) -> None:
    """Auch bei fehlgeschlagenem Gesamt-Update bleiben die Block-Sensoren verfügbar."""
    _platform, entities = await _add_block_entities(hass, coord)
    params_id = next(e.entity_id for e in entities if e.unique_id.endswith("_block_params"))

    with freeze_time(START) as frozen:
        await _refresh(coord)
        coord.client.failure_mode = "fast"
        frozen.tick(timedelta(seconds=10))
        await _refresh(coord)
        state = hass.states.get(params_id)
        assert state is not None
        assert state.state != "unavailable"
        assert state.state == BLOCK_OK  # letzter Erfolg bleibt gültig

        # Auch wenn der Koordinator nur noch Fehlschläge liefert, wird der Block
        # nach zwei Perioden „veraltet“ und das bleibt in der Entität sichtbar.
        frozen.tick(timedelta(seconds=2 * 900 + 31))
        await _refresh(coord)
        assert coord.last_update_success is False
        state = hass.states.get(params_id)
        assert state.state == BLOCK_STALE
        assert state.attributes["letzter_erfolg"] is not None


# ----------------------------------------------------------------- Attribute der Blockdaten


@pytest.mark.asyncio
async def test_block_attributes_expose_diagnostics(hass: HomeAssistant, coord) -> None:
    """Attribute enthalten Blockstart, letzten Erfolg, Fehlergrund und Fehlversuchszähler."""
    with freeze_time(START) as frozen:
        await _refresh(coord)
        attrs = _block(coord, "params").attributes(dt_util.now())
        assert attrs["start_adresse"] == PARAMS_START
        assert attrs["letzter_erfolg"] == dt_util.now().isoformat()
        assert attrs["letzter_fehler"] is None
        assert attrs["fehlversuche"] == 0
        assert attrs["status"] == BLOCK_OK

        coord.client.failure_mode = "params"
        frozen.tick(timedelta(seconds=900))
        await _refresh(coord)
        attrs = _block(coord, "params").attributes(dt_util.now())
        assert "Modbus-Exception 2" in attrs["letzter_fehler"]
        assert attrs["fehlversuche"] == 1
        assert attrs["letzter_erfolg"] is not None, "letzter Erfolg bleibt stehen"
        assert attrs["registerbloecke"][0] == f"{PARAMS_START}+60"
