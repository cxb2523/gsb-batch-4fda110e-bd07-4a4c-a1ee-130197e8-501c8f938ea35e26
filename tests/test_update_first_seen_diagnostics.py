"""Observable, restart-safe persistence of the update first-seen windows.

The Store merge validates every entry on load: entity id must start with
``update.``, ``since`` must parse as a timezone-aware timestamp that is not in
the future, and ``version`` must be a string or null. Invalid entries are
skipped and counted, entries already in this run's memory win, and the window
clean-up (ignore / completed / vanished) is visible in the diagnostics while
"registered without state" and unavailable/unknown entities keep their window.
"""

from __future__ import annotations

from datetime import timedelta

from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant.common import MockConfigEntry

from custom_components.haghs.const import (
    CONF_IGNORE_PATTERNS,
    DATA_UPDATE_FIRST_SEEN_DIAG,
    DATA_UPDATE_FIRST_SEEN_LOADED,
    DOMAIN,
)
from custom_components.haghs.coordinator import HaghsDataUpdateCoordinator
from tests.factories import make_coordinator

KEY = "haghs.update_first_seen"


def _stored(data: dict) -> dict:
    """Wrap raw first-seen data in the hass_storage envelope."""
    return {"version": 1, "minor_version": 1, "key": KEY, "data": data}


async def test_invalid_store_entries_are_skipped_and_counted(hass, hass_storage) -> None:
    """Illegal time, future time and a non-update prefix each fail validation."""
    now = dt_util.utcnow()
    hass_storage[KEY] = _stored(
        {
            "update.good": {"since": (now - timedelta(days=2)).isoformat(), "version": None},
            "update.with_version": {
                "since": (now - timedelta(days=1)).isoformat(),
                "version": "2026.11.0",
            },
            "update.bad_time": {"since": "not a time", "version": None},
            "update.naive_time": {
                "since": now.replace(tzinfo=None).isoformat(),
                "version": None,
            },
            "update.future_time": {
                "since": (now + timedelta(days=3)).isoformat(),
                "version": None,
            },
            "sensor.wrong_prefix": {
                "since": (now - timedelta(days=2)).isoformat(),
                "version": None,
            },
            "update.bad_version": {
                "since": (now - timedelta(days=2)).isoformat(),
                "version": 7,
            },
        }
    )
    hass.states.async_set("update.good", "on")
    hass.states.async_set("update.with_version", "on", {"latest_version": "2026.11.0"})

    coordinator = make_coordinator(hass)
    result = await coordinator._async_update_data()

    assert result["diagnostic_first_seen_status"] == "success"
    assert result["diagnostic_first_seen_reason"] is None
    assert result["diagnostic_first_seen_loaded"] == 2
    assert result["diagnostic_first_seen_invalid"] == 5
    stage = next(
        entry for entry in result["diagnostic_stages"] if entry["stage"] == "update_first_seen"
    )
    assert stage["status"] == "success"
    # Only the valid entries made it into the shared window memory.
    assert set(coordinator._update_first_seen) == {"update.good", "update.with_version"}
    assert coordinator._update_seen_version["update.with_version"] == "2026.11.0"
    # Their stored windows survived instead of restarting at now.
    assert coordinator._update_first_seen["update.good"] < now - timedelta(days=1)


async def test_a_malformed_store_payload_is_reported_as_an_error(hass, hass_storage) -> None:
    hass_storage[KEY] = _stored(["update.esphome"])  # type: ignore[arg-type]
    coordinator = make_coordinator(hass)
    result = await coordinator._async_update_data()
    assert result["diagnostic_first_seen_status"] == "error"
    assert result["diagnostic_first_seen_reason"] == "not_a_mapping"
    assert result["diagnostic_first_seen_loaded"] == 0
    assert result["diagnostic_first_seen_invalid"] == 0


async def test_memory_entries_win_over_the_store_and_legal_windows_survive_restart(
    hass, hass_storage
) -> None:
    """After a simulated restart, valid windows are kept and this run's entry wins."""
    now = dt_util.utcnow()
    hass_storage[KEY] = _stored(
        {
            "update.esphome": {
                "since": (now - timedelta(days=8)).isoformat(),
                "version": None,
            },
            "update.router": {"since": (now - timedelta(days=5)).isoformat(), "version": None},
        }
    )
    hass.states.async_set("update.esphome", "on")
    # Registered but without a state yet (common right after a restart): its
    # stored window must be merged and then retained.
    er.async_get(hass).async_get_or_create(
        "update", "router_integration", "uid_router", suggested_object_id="router"
    )
    coordinator = make_coordinator(hass)
    # This run already saw update.esphome a minute ago; the stored 8 days must not overwrite it.
    memory_time = now - timedelta(minutes=1)
    coordinator._update_first_seen["update.esphome"] = memory_time

    result = await coordinator._async_update_data()

    assert result["diagnostic_first_seen_loaded"] == 1  # only update.router came from the store
    assert result["diagnostic_first_seen_invalid"] == 0
    assert result["diagnostic_update_pruned"] == 0
    assert coordinator._update_first_seen["update.esphome"] == memory_time
    assert coordinator._update_first_seen["update.router"] == dt_util.parse_datetime(
        hass_storage[KEY]["data"]["update.router"]["since"]
    )


async def test_unregistered_not_ready_and_unavailable_entities_keep_their_window(
    hass, hass_storage
) -> None:
    """Registered-without-state and unavailable/unknown entities are retained, not pruned."""
    now = dt_util.utcnow()
    eight_days = (now - timedelta(days=8)).isoformat()
    hass_storage[KEY] = _stored(
        {
            "update.registered": {"since": eight_days, "version": None},
            "update.unavailable": {"since": eight_days, "version": None},
            "update.unknown": {"since": eight_days, "version": None},
        }
    )
    er.async_get(hass).async_get_or_create(
        "update", "esphome", "uid_registered", suggested_object_id="registered"
    )
    hass.states.async_set("update.unavailable", "unavailable")
    hass.states.async_set("update.unknown", "unknown")

    coordinator = make_coordinator(hass)
    result = await coordinator._async_update_data()

    assert result["diagnostic_update_pruned"] == 0
    assert set(coordinator._update_first_seen) == {
        "update.registered",
        "update.unavailable",
        "update.unknown",
    }


async def test_completed_ignored_and_vanished_entities_are_pruned_and_counted(
    hass, hass_storage
) -> None:
    now = dt_util.utcnow()
    two_days = (now - timedelta(days=2)).isoformat()
    hass_storage[KEY] = _stored(
        {
            "update.done": {"since": two_days, "version": None},
            "update.gone": {"since": two_days, "version": None},
            "update.kept": {"since": two_days, "version": None},
        }
    )
    hass.states.async_set("update.done", "off")  # installed/completed
    hass.states.async_set("update.kept", "on")
    # update.gone has neither a state nor a registry entry: vanished.

    coordinator = make_coordinator(hass)
    result = await coordinator._async_update_data()

    assert result["diagnostic_update_pruned"] == 2
    assert set(coordinator._update_first_seen) == {"update.kept"}


async def test_ignored_pending_updates_are_skipped_and_their_old_record_pruned(
    hass, hass_storage
) -> None:
    now = dt_util.utcnow()
    hass_storage[KEY] = _stored(
        {"update.iot_bulb": {"since": (now - timedelta(days=3)).isoformat(), "version": None}}
    )
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_IGNORE_PATTERNS: ["update.iot_*"]})
    entry.add_to_hass(hass)
    hass.states.async_set("update.iot_bulb", "on")

    coordinator = HaghsDataUpdateCoordinator(hass, entry)
    result = await coordinator._async_update_data()

    assert result["diagnostic_update_pending_skipped"] == 1
    assert result["diagnostic_update_pruned"] == 1
    assert "update.iot_bulb" not in coordinator._update_first_seen


async def test_counts_remain_available_with_many_entries(hass, hass_storage) -> None:
    """The diagnostic counters must not get lost behind long capped lists."""
    now = dt_util.utcnow()
    # A long list of valid stored entries plus one invalid one.
    data = {
        f"update.dev_{index:03d}": {
            "since": (now - timedelta(days=2)).isoformat(),
            "version": None,
        }
        for index in range(120)
    }
    data["sensor.illegal"] = {"since": (now - timedelta(days=2)).isoformat(), "version": None}
    hass_storage[KEY] = _stored(data)

    coordinator = make_coordinator(hass)
    result = await coordinator._async_update_data()

    assert result["diagnostic_first_seen_loaded"] == 120
    assert result["diagnostic_first_seen_invalid"] == 1
    # Integer counters survive regardless of the long (capped) entity lists.
    assert isinstance(result["diagnostic_first_seen_loaded"], int)
    assert isinstance(result["diagnostic_first_seen_invalid"], int)


async def test_missing_diag_payload_falls_back_to_neutral_stage_status(hass, hass_storage) -> None:
    """A corrupt hass.data entry must not break the load: the stage stays neutral, not stale."""
    now = dt_util.utcnow()
    hass_storage[KEY] = _stored(
        {"update.esphome": {"since": (now - timedelta(days=2)).isoformat(), "version": None}}
    )
    coordinator = make_coordinator(hass)

    async def _noop() -> None:
        return None

    # A completed shared-load task plus a non-mapping diagnostic payload
    # simulates corrupted hass.data: the merge must not run again, and the
    # coordinator must fall back to neutral diagnostics instead of failing.
    load_task = hass.async_create_task(_noop())
    await hass.async_block_till_done()
    hass.data[DOMAIN][DATA_UPDATE_FIRST_SEEN_LOADED] = load_task
    hass.data[DOMAIN][DATA_UPDATE_FIRST_SEEN_DIAG] = "corrupt"

    result = await coordinator._async_update_data()

    stage = next(
        entry for entry in result["diagnostic_stages"] if entry["stage"] == "update_first_seen"
    )
    assert stage["status"] == "success"
    assert result["diagnostic_first_seen_status"] is None
    assert result["diagnostic_first_seen_loaded"] == 0
    assert result["diagnostic_first_seen_invalid"] == 0


async def test_store_counts_are_republished_on_every_cycle_without_reloading(
    hass, hass_storage
) -> None:
    """The shared per-run merge result stays visible even on later cycles."""
    now = dt_util.utcnow()
    hass_storage[KEY] = _stored(
        {
            "update.esphome": {
                "since": (now - timedelta(days=8)).isoformat(),
                "version": None,
            },
            "sensor.bad": {"since": (now - timedelta(days=8)).isoformat(), "version": None},
        }
    )
    hass.states.async_set("update.esphome", "on")
    coordinator = make_coordinator(hass)
    first = await coordinator._async_update_data()
    second = await coordinator._async_update_data()

    for result in (first, second):
        assert result["diagnostic_first_seen_loaded"] == 1
        assert result["diagnostic_first_seen_invalid"] == 1
        assert result["diagnostic_first_seen_status"] == "success"
