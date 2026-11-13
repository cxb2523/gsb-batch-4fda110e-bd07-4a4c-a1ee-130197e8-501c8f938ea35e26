"""CLI tests for partial-page failures during an export.

These tests run the real InstapaperClient against requests_mock responses
(no network access) and only mock authentication and config loading.
"""

import csv
import json
import logging
from unittest.mock import MagicMock

import pytest
import requests_mock

from instapaper_scraper import cli
from instapaper_scraper.constants import INSTAPAPER_BOOKMARKS_URL


def _bookmarks_payload(page, has_more):
    base = (page - 1) * 2
    return {
        "bookmarks": [
            {
                "id": base + 1,
                "title": f"Article {base + 1}",
                "url": f"http://example.com/{base + 1}",
            },
            {
                "id": base + 2,
                "title": f"Article {base + 2}",
                "url": f"http://example.com/{base + 2}",
            },
        ],
        "page": page,
        "has_more": has_more,
    }


@pytest.fixture
def mock_auth(monkeypatch):
    """Authenticator that is already logged in with a cached form key."""
    mock = MagicMock()
    instance = mock.return_value
    instance.login.return_value = True
    instance.form_key = "test_form_key"
    monkeypatch.setattr("instapaper_scraper.cli.InstapaperAuthenticator", mock)
    return mock


@pytest.fixture(autouse=True)
def isolate_config(monkeypatch, tmp_path):
    """Run the CLI from an empty config directory."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("instapaper_scraper.cli.CONFIG_DIR", tmp_path / "cfg")
    monkeypatch.setattr("instapaper_scraper.cli.CONFIG_FILENAME", "no_such_config.toml")
    return tmp_path


def _run_cli(monkeypatch, argv):
    monkeypatch.setattr("sys.argv", ["instapaper-scraper", *argv])
    cli.main()


def test_persistent_500_on_second_page_saves_page_one(
    mock_auth, monkeypatch, tmp_path, capsys, caplog
):
    """Page 2 keeps returning 500; page 1 articles are still written and the
    stop summary names page 2 and the HTTP status."""
    output = tmp_path / "out.json"
    with requests_mock.Mocker() as m:
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=1&sort=newest",
            json=_bookmarks_payload(1, has_more=True),
        )
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=2&sort=newest",
            status_code=500,
        )
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=3&sort=newest",
            json=_bookmarks_payload(3, has_more=False),
        )
        m.get(
            "https://www.instapaper.com/data/user_session",
            json={"user": {"form_key": "test_form_key"}},
        )
        monkeypatch.setenv("MAX_RETRIES", "2")
        monkeypatch.setenv("BACKOFF_FACTOR", "0.01")

        with caplog.at_level(logging.INFO):
            _run_cli(monkeypatch, ["--format", "json", "-o", str(output)])

        page3_requests = [
            r
            for r in m.request_history
            if r.path == "/data/bookmarks" and r.qs.get("page") == ["3"]
        ]

    assert page3_requests == []
    assert output.exists()
    with open(output, encoding="utf-8") as f:
        saved = json.load(f)
    assert [a["id"] for a in saved] == ["1", "2"]

    summary = capsys.readouterr().out
    assert "stopped at page 2" in summary
    assert "HTTP 500" in summary
    assert "Collected 2 article(s) from 1 page(s)" in summary
    # The run is partial, not a crash: no error exit was raised above.
    assert "Articles scraped and saved successfully." in caplog.text


def test_missing_bookmarks_field_saves_prior_pages_and_names_page(
    mock_auth, monkeypatch, tmp_path, capsys
):
    """A 200 response without 'bookmarks' on page 2 stops there and reports it."""
    output = tmp_path / "out.csv"
    with requests_mock.Mocker() as m:
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=1&sort=newest",
            json=_bookmarks_payload(1, has_more=True),
        )
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=2&sort=newest",
            json={"unexpected": True},
        )
        monkeypatch.setenv("MAX_RETRIES", "2")
        monkeypatch.setenv("BACKOFF_FACTOR", "0.01")

        _run_cli(monkeypatch, ["--format", "csv", "-o", str(output)])

    assert output.exists()
    with open(output, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert [r["id"] for r in rows] == ["1", "2"]

    summary = capsys.readouterr().out
    assert "stopped at page 2" in summary
    assert "invalid API response" in summary
    assert "bookmarks" in summary


def test_no_successful_page_does_not_write_a_file(
    mock_auth, monkeypatch, tmp_path, capsys
):
    """If the very first page fails, no empty output file is created."""
    output = tmp_path / "out.db"
    with requests_mock.Mocker() as m:
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=1&sort=newest",
            status_code=404,
        )
        _run_cli(monkeypatch, ["--format", "sqlite", "-o", str(output)])

        # 404 is unrecoverable: exactly one bookmarks request.
        assert len([r for r in m.request_history if r.path == "/data/bookmarks"]) == 1

    assert not output.exists()
    summary = capsys.readouterr().out
    assert "stopped at page 1" in summary
    assert "HTTP 404" in summary
    assert "no output file was written" in summary


def test_normal_completion_prints_completed_summary(
    mock_auth, monkeypatch, tmp_path, capsys
):
    """A clean run reports the completed outcome rather than a stop reason."""
    output = tmp_path / "out.json"
    with requests_mock.Mocker() as m:
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=1&sort=newest",
            json=_bookmarks_payload(1, has_more=True),
        )
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=2&sort=newest",
            json=_bookmarks_payload(2, has_more=False),
        )

        _run_cli(monkeypatch, ["--format", "json", "-o", str(output)])

    with open(output, encoding="utf-8") as f:
        assert len(json.load(f)) == 4
    summary = capsys.readouterr().out
    assert "reached the last page" in summary


def test_page_limit_summary(mock_auth, monkeypatch, tmp_path, capsys):
    """--limit stops cleanly with a page-limit summary, not a failure."""
    output = tmp_path / "out.json"
    with requests_mock.Mocker() as m:
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=1&sort=newest",
            json=_bookmarks_payload(1, has_more=True),
        )
        m.get(
            INSTAPAPER_BOOKMARKS_URL + "?section_type=home&page=2&sort=newest",
            json=_bookmarks_payload(2, has_more=True),
        )

        _run_cli(monkeypatch, ["--limit", "1", "--format", "json", "-o", str(output)])

        assert len([r for r in m.request_history if r.path == "/data/bookmarks"]) == 1

    summary = capsys.readouterr().out
    assert "page limit of 1" in summary
    assert "stopped at page" not in summary
