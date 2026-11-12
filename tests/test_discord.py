"""Tests for the Discord notifier using a fake poster (no real webhook)."""

import pytest

from notifications.discord import notify


def test_notify_no_jobs_sends_nothing():
    calls = []
    sent = notify([], webhook_url="https://discord.test/hook", poster=lambda u, p: calls.append((u, p)), sleep=lambda _s: None)
    assert sent == 0
    assert calls == []


def test_notify_no_jobs_needs_no_webhook():
    # An empty run must not fail even when no webhook is configured.
    sent = notify([], webhook_url=None, poster=lambda u, p: None, sleep=lambda _s: None)
    assert sent == 0


def test_notify_without_webhook_raises():
    with pytest.raises(ValueError, match="DISCORD_WEBHOOK"):
        notify(
            [{"company": "Acme", "title": "data analyst", "link": "https://a.test/1"}],
            webhook_url=None,
        )


def test_notify_posts_once_per_normalized_new_job():
    jobs = [
        {
            "company": "Acme",
            "title": "junior data analyst",
            "link": "https://acme.test/jobs/1",
        },
        {
            "company": "Beta",
            "title": "ml engineer",
            "link": "https://beta.test/jobs/7",
        },
    ]
    calls = []
    sleeps = []

    sent = notify(
        jobs,
        webhook_url="https://discord.test/hook",
        poster=lambda url, payload: calls.append((url, payload)),
        sleep=sleeps.append,
    )

    assert sent == 2
    assert len(calls) == 2
    for url, payload in calls:
        assert url == "https://discord.test/hook"
        assert payload["embeds"][0]["title"] == "🎯 New Job Found!"
    assert "Acme" in calls[0][1]["embeds"][0]["description"]
    assert sleeps == [0.4, 0.4]
