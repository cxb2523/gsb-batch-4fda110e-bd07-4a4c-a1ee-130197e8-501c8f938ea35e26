#!/usr/bin/env python3
"""Tests for collector.py against local sample pages and the real index.html.

Run from the repository root::

    python -I -m pytest tests/test_collector.py -q
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import collector  # noqa: E402

SAMPLES = ROOT / "samples"
INDEX = ROOT / "index.html"

# sha256 of the HTML produced by the real index.html payload pipeline.
# Captured from the initial repository snapshot (commit 5bfba06).
INDEX_HTML_SHA256 = "0a73ab2e0e6c50b2e7b78d4b87e452350218f49176cc0fc292b065c956653625"


def _read(name: str) -> str:
    return (SAMPLES / name).read_text(encoding="utf-8")


def _decoded_sample() -> str:
    return collector.collect_page(_read("sample_ok.html"))["html"]


# ---------------------------------------------------------------- success case


def test_success_restores_html() -> None:
    result = collector.collect_page(_read("sample_ok.html"))
    assert result["ok"] is True
    assert result["success"] is True
    assert result["reason"] == ""
    assert result["payload_error"] is None
    assert result["missing_fragment_ids"] == []
    assert result["fragments_expected"] == 9
    assert result["fragments_found"] == 9
    assert result["html"].startswith("<!DOCTYPE html>")
    assert "<h1>Decoded successfully</h1>" in result["html"]
    assert result["html"].endswith("</html>\n")


def test_success_result_is_json_serialisable() -> None:
    result = collector.collect_page(_read("sample_ok.html"))
    assert json.loads(json.dumps(result))["html"] == result["html"]


def test_collect_page_accepts_bytes() -> None:
    as_bytes = (SAMPLES / "sample_ok.html").read_bytes()
    assert collector.collect_page(as_bytes) == collector.collect_page(
        _read("sample_ok.html")
    )


def test_whitespace_and_terminal_newlines_are_ignored() -> None:
    # JavaScript's atob() strips ASCII whitespace; the collector must match.
    html = _read("sample_ok.html").replace('id="_jXhml54">', 'id="_jXhml54">\n  ')
    assert collector.collect_page(html)["html"] == _decoded_sample()


def test_collect_file_matches_collect_page() -> None:
    assert collector.collect_file(SAMPLES / "sample_ok.html") == collector.collect_page(
        _read("sample_ok.html")
    )


# ------------------------------------------------------- missing fragments


def test_missing_fragment_is_reported_with_its_id() -> None:
    result = collector.collect_page(_read("sample_missing_fragment.html"))
    assert result["ok"] is False
    assert result["html"] is None
    assert result["reason"] == collector.REASON_MISSING_FRAGMENT
    assert result["missing_fragment_ids"] == ["_jXhml53"]
    assert "_jXhml53" in result["detail"]
    assert result["fragments_expected"] == 9
    assert result["fragments_found"] == 8
    assert result["payload_error"] is None


def test_missing_last_fragment_is_detected_from_loop_count() -> None:
    # The last fragment cannot be inferred from the ids that remain, so the
    # expected count must come from the script's loop header.
    result = collector.collect_page(_read("sample_missing_last_fragment.html"))
    assert result["reason"] == collector.REASON_MISSING_FRAGMENT
    assert result["missing_fragment_ids"] == ["_jXhml58"]


def test_multiple_missing_fragments_are_all_listed() -> None:
    html = _read("sample_ok.html")
    html = html.replace('<template id="_jXhml51">', '<template id="_jXhml51x">')
    html = html.replace('<template id="_jXhml57">', '<template id="_jXhml57x">')
    result = collector.collect_page(html)
    assert result["reason"] == collector.REASON_MISSING_FRAGMENT
    assert result["missing_fragment_ids"] == ["_jXhml51", "_jXhml57"]


def test_empty_fragment_is_payload_corruption_not_missing() -> None:
    html = _read("sample_ok.html")
    # Keep the id, drop its payload: the element exists but carries nothing.
    html = html.replace('id="_jXhml53">', 'id="_jXhml53"></template><template>')
    result = collector.collect_page(html)
    assert result["ok"] is False
    assert result["reason"] == collector.REASON_PAYLOAD_CORRUPTED
    assert result["payload_error"] == collector.PAYLOAD_EMPTY_FRAGMENT
    assert result["missing_fragment_ids"] == []
    assert "_jXhml53" in result["detail"]


# ------------------------------------------------------ corrupted payloads


def test_invalid_base64_is_payload_corruption() -> None:
    result = collector.collect_page(_read("sample_bad_base64.html"))
    assert result["ok"] is False
    assert result["html"] is None
    assert result["reason"] == collector.REASON_PAYLOAD_CORRUPTED
    assert result["payload_error"] == collector.PAYLOAD_INVALID_BASE64
    assert "Base64" in result["detail"]
    assert result["missing_fragment_ids"] == []


def test_truncated_base64_is_payload_corruption() -> None:
    import re

    html = _read("sample_ok.html")
    # Drop two characters from a fragment: the concatenated length is then no
    # longer a multiple of four, which atob() rejects outright.
    html = re.sub(r'(id="_jXhml54">)([^<]{2})', r"\1", html, count=1)
    result = collector.collect_page(html)
    assert result["reason"] == collector.REASON_PAYLOAD_CORRUPTED
    assert result["payload_error"] == collector.PAYLOAD_INVALID_BASE64


def test_invalid_utf8_is_payload_corruption() -> None:
    result = collector.collect_page(_read("sample_bad_utf8.html"))
    assert result["ok"] is False
    assert result["reason"] == collector.REASON_PAYLOAD_CORRUPTED
    assert result["payload_error"] == collector.PAYLOAD_INVALID_UTF8
    assert "UTF-8" in result["detail"]


# ----------------------------------------------------------- script errors


def test_missing_key_literal_is_script_error() -> None:
    html = _read("sample_ok.html").replace("atob('", "atob( window.")
    result = collector.collect_page(html)
    assert result["reason"] == collector.REASON_SCRIPT_ERROR
    assert "key" in result["detail"].lower()


def test_invalid_key_base64_is_script_error() -> None:
    html = _read("sample_ok.html").replace("atob('c2", "atob('!!c2", 1)
    result = collector.collect_page(html)
    assert result["reason"] == collector.REASON_SCRIPT_ERROR


def test_no_fragments_at_all_is_script_error() -> None:
    result = collector.collect_page(
        "<!doctype html><html><body><p>blank Load page</p></body></html>"
    )
    assert result["reason"] == collector.REASON_SCRIPT_ERROR
    assert result["html"] is None


def test_non_text_input_is_script_error() -> None:
    result = collector.collect_page(123)  # type: ignore[arg-type]
    assert result["reason"] == collector.REASON_SCRIPT_ERROR


# --------------------------------------------------- real page compatibility


@pytest.mark.skipif(not INDEX.exists(), reason="index.html not present")
def test_real_index_html_decodes() -> None:
    import hashlib

    result = collector.collect_file(INDEX)
    assert result["ok"] is True
    assert result["reason"] == ""
    assert result["fragments_expected"] == 9
    assert result["fragments_found"] == 9
    assert hashlib.sha256(result["html"].encode("utf-8")).hexdigest() == INDEX_HTML_SHA256


# --------------------------------------------------------------- CLI behaviour


def test_cli_success(tmp_path: Path) -> None:
    out = tmp_path / "result.json"
    proc = subprocess.run(
        [sys.executable, str(ROOT / "collector.py"), str(SAMPLES / "sample_ok.html"),
         "--output", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert out.exists()


def test_cli_failure_exit_code_and_missing_id(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "collector.py"),
         str(SAMPLES / "sample_missing_fragment.html")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    payload = json.loads(proc.stdout)
    assert payload["reason"] == collector.REASON_MISSING_FRAGMENT
    assert payload["missing_fragment_ids"] == ["_jXhml53"]


def test_cli_unreadable_input() -> None:
    proc = subprocess.run(
        [sys.executable, str(ROOT / "collector.py"), "definitely-not-a-file.html"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
