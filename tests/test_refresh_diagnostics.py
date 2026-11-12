"""Per-cycle refresh diagnostics: stages, outcomes, reasons and no carry-over.

A refresh records every stage (update first-seen merge, recorder info, the
hardware and application pillars, translations) with one of four statuses:
success, timeout, error or skipped. The attributes describe only the current
attempt; even a completely failed refresh returns readable diagnostics.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from homeassistant.core import HomeAssistant

from custom_components.haghs import coordinator as coordinator_module
from custom_components.haghs.coordinator import (
    STAGE_APPLICATION,
    STAGE_HARDWARE,
    STAGE_RECORDER_INFO,
    STAGE_RESULT,
    STAGE_TRANSLATIONS,
    STAGE_UPDATE_FIRST_SEEN,
    _HardwareResult,
)
from custom_components.haghs.sensor import HaghsSensor
from tests.factories import make_coordinator


def _stages(result: dict) -> dict[str, dict]:
    """Index the per-cycle stage list by stage name."""
    return {entry["stage"]: entry for entry in result["diagnostic_stages"]}


async def test_successful_cycle_records_every_stage_in_order(hass: HomeAssistant) -> None:
    coord = make_coordinator(hass)
    result = await coord._async_update_data()

    names = [entry["stage"] for entry in result["diagnostic_stages"]]
    assert names == [
        STAGE_UPDATE_FIRST_SEEN,
        STAGE_RECORDER_INFO,
        STAGE_HARDWARE,
        STAGE_APPLICATION,
        STAGE_TRANSLATIONS,
    ]
    # A fresh environment has no Store yet: the merge stage is skipped, the
    # remaining stages all succeed.
    assert _stages(result)[STAGE_UPDATE_FIRST_SEEN]["status"] == "skipped"
    assert all(
        entry["status"] == "success"
        for entry in result["diagnostic_stages"]
        if entry["stage"] != STAGE_UPDATE_FIRST_SEEN
    )
    # Successful stages carry no reason; the counts are plain integers, never None.
    assert all(
        "reason" not in entry
        for entry in result["diagnostic_stages"]
        if entry["status"] == "success"
    )
    for key in (
        "diagnostic_first_seen_loaded",
        "diagnostic_first_seen_invalid",
        "diagnostic_update_added",
        "diagnostic_update_pruned",
        "diagnostic_update_pending_skipped",
    ):
        assert isinstance(result[key], int)
        assert result[key] == 0


async def test_first_seen_stage_is_skipped_without_a_store(hass: HomeAssistant) -> None:
    coord = make_coordinator(hass)
    result = await coord._async_update_data()
    stage = _stages(result)[STAGE_UPDATE_FIRST_SEEN]
    assert stage == {
        "stage": STAGE_UPDATE_FIRST_SEEN,
        "status": "skipped",
        "reason": "no_stored_data",
    }
    assert result["diagnostic_first_seen_status"] == "skipped"
    assert result["diagnostic_first_seen_reason"] == "no_stored_data"


async def test_timeout_and_exception_stages_are_named_with_reasons(
    hass: HomeAssistant, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One timeout stage and one exception stage in the same cycle."""
    coord = make_coordinator(hass)
    monkeypatch.setattr(coordinator_module, "PILLAR_TIMEOUT", 0.01)

    async def _hangs() -> _HardwareResult:
        await asyncio.Event().wait()  # never set: forces the wait_for timeout
        return _HardwareResult()  # pragma: no cover

    monkeypatch.setattr(coord, "_async_calc_hardware", _hangs)
    monkeypatch.setattr(
        coord,
        "_async_calc_application",
        AsyncMock(side_effect=RuntimeError("boom")),
    )

    result = await coord._async_update_data()
    stages = _stages(result)

    assert stages[STAGE_HARDWARE]["status"] == "timeout"
    assert stages[STAGE_HARDWARE]["reason"] == "timeout_after_0.01s"
    assert stages[STAGE_APPLICATION]["status"] == "error"
    assert stages[STAGE_APPLICATION]["reason"] == "RuntimeError"
    # The other stages still report their own real outcomes.
    assert stages[STAGE_RECORDER_INFO]["status"] == "success"
    assert stages[STAGE_TRANSLATIONS]["status"] == "success"
    # Pillar fallback indicators agree with the detailed diagnostics.
    assert result["pillar_fallbacks"] == [STAGE_HARDWARE, STAGE_APPLICATION]
    assert result["pillar_fallback_count"] == 2


async def test_a_recovered_cycle_keeps_no_trace_of_the_previous_failure(
    hass: HomeAssistant, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Diagnostics describe only this round; a later clean round starts from zero."""
    coord = make_coordinator(hass)
    monkeypatch.setattr(coord, "_async_calc_hardware", AsyncMock(side_effect=ValueError("boom")))
    failed = await coord._async_update_data()
    assert _stages(failed)[STAGE_HARDWARE]["status"] == "error"

    monkeypatch.undo()
    recovered = await coord._async_update_data()
    stages = _stages(recovered)
    assert stages[STAGE_HARDWARE]["status"] == "success"
    assert "reason" not in stages[STAGE_HARDWARE]
    assert stages[STAGE_APPLICATION]["status"] == "success"
    assert stages[STAGE_RECORDER_INFO]["status"] == "success"
    assert stages[STAGE_TRANSLATIONS]["status"] == "success"
    assert recovered["pillar_fallbacks"] == []
    assert recovered["pillar_fallback_count"] == 0
    assert recovered["update_cycle_failed"] is False


async def test_a_guarded_stage_failure_does_not_abort_the_cycle(
    hass: HomeAssistant, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The recorder stage fails on its own; pillars and the result still complete."""
    coord = make_coordinator(hass)

    def _broken_recorder() -> None:
        raise RuntimeError("recorder down")

    monkeypatch.setattr(coord, "_read_recorder_info", _broken_recorder)
    result = await coord._async_update_data()

    stages = _stages(result)
    assert stages[STAGE_RECORDER_INFO] == {
        "stage": STAGE_RECORDER_INFO,
        "status": "error",
        "reason": "RuntimeError",
    }
    assert stages[STAGE_HARDWARE]["status"] == "success"
    assert stages[STAGE_APPLICATION]["status"] == "success"
    assert result["update_cycle_failed"] is False
    # Neutral recorder info, as before the diagnostics existed.
    assert result["recorder_keep_days"] is None
    assert result["recorder_filter_active"] is False


async def test_an_outer_failure_still_returns_readable_diagnostics(
    hass: HomeAssistant, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When result assembly fails, diagnostics are present and name the failing point."""

    def _raise(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("result builder failed")

    coord = make_coordinator(hass)
    monkeypatch.setattr(coord, "_build_result", _raise)

    result = await coord._async_update_data()
    assert result["update_cycle_failed"] is True
    stages = _stages(result)
    assert stages[STAGE_RESULT] == {
        "stage": STAGE_RESULT,
        "status": "error",
        "reason": "RuntimeError",
    }
    # Every diagnostic key is present and readable; nothing is null or missing.
    for key in (
        "diagnostic_stages",
        "diagnostic_first_seen_loaded",
        "diagnostic_first_seen_invalid",
        "diagnostic_first_seen_status",
        "diagnostic_first_seen_reason",
        "diagnostic_update_added",
        "diagnostic_update_pruned",
        "diagnostic_update_pending_skipped",
    ):
        assert key in result
    assert "update cycle failed" in result["recommendations"]


async def test_an_outer_failure_keeps_the_window_counts_of_this_cycle(
    hass: HomeAssistant, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Counts gathered before the aborting stage are not lost in the failure result."""

    def _raise(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("result builder failed")

    hass.states.async_set("update.esphome", "on", {"friendly_name": "ESPHome"})
    coord = make_coordinator(hass)
    monkeypatch.setattr(coord, "_build_result", _raise)

    result = await coord._async_update_data()
    assert result["update_cycle_failed"] is True
    # The application pillar saw one new pending update before the assembly failed.
    assert result["diagnostic_update_added"] == 1
    assert result["diagnostic_update_pruned"] == 0
    assert result["diagnostic_update_pending_skipped"] == 0


async def test_neutral_result_carries_empty_current_cycle_diagnostics(
    hass: HomeAssistant,
) -> None:
    coord = make_coordinator(hass)
    result = coord._neutral_result()
    assert result["diagnostic_stages"] == []
    assert result["diagnostic_first_seen_status"] is None
    assert result["diagnostic_first_seen_reason"] is None
    assert result["diagnostic_first_seen_loaded"] == 0
    assert result["diagnostic_first_seen_invalid"] == 0


async def test_stage_guard_re_raises_cancellation(hass: HomeAssistant) -> None:
    """Cancellation is not swallowed as a stage error, matching the pillar safety net."""
    coord = make_coordinator(hass)

    async def _cancelled() -> None:
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await coord._guard_stage("hardware", _cancelled, _HardwareResult())
    assert coord._diagnosis.stages == []


async def test_sensor_exposes_the_diagnostics_and_keeps_counts_with_long_lists(
    hass: HomeAssistant,
) -> None:
    """Counts stay present on the sensor even when the capped lists are long."""
    coord = make_coordinator(hass)
    for index in range(120):  # more than every 100-entry list cap
        hass.states.async_set(
            f"update.u{index:03d}", "on", {"friendly_name": f"Update {index:03d}"}
        )
    coord.data = await coord._async_update_data()
    sensor = HaghsSensor(coord, hass.config_entries.async_entries("haghs")[0])
    attrs = sensor.extra_state_attributes

    assert attrs["diagnostic_update_added"] == 120
    assert attrs["diagnostic_update_pruned"] == 0
    assert attrs["diagnostic_update_pending_skipped"] == 0
    # The detailed stage list is excluded from recorder history; the counts are not.
    assert "diagnostic_stages" in HaghsSensor._unrecorded_attributes
    for key in (
        "diagnostic_update_added",
        "diagnostic_update_pruned",
        "diagnostic_update_pending_skipped",
        "diagnostic_first_seen_loaded",
        "diagnostic_first_seen_invalid",
    ):
        assert key not in HaghsSensor._unrecorded_attributes
    assert any(entry["stage"] == STAGE_APPLICATION for entry in attrs["diagnostic_stages"])
