#!/usr/bin/env python3
"""Offline collector for the obfuscated "Load" page shipped as index.html.

The page stores its real body in nine ``<template id="_jXhml5N">`` fragments.
At render time a small script concatenates the fragments, Base64-decodes the
result, XORs it byte-by-byte with a constant key (itself Base64-encoded in the
script), decodes the bytes as UTF-8, and finally calls ``document.write``.

This module re-implements that pipeline *without* a browser DOM and without
executing any page script.  It only reads the saved HTML text, so it can run
offline on a captured page::

    result = collect_page(html_text)

    {
        "ok":                     bool,       # did the page restore successfully?
        "success":                bool,       # alias of "ok"
        "html":                   str | None, # restored HTML text on success
        "reason":                 str,        # "" on success, otherwise a class below
        "detail":                 str,        # human-readable diagnostic
        "missing_fragment_ids":   [str],      # fragment ids absent from the page
        "payload_error":          str | None, # "invalid_base64" / "invalid_utf8" / "empty_fragment"
        "fragment_prefix":        str,        # e.g. "_jXhml5"
        "fragments_expected":     int | None, # e.g. 9
        "fragments_found":        int,
    }

Failure classes (``reason``):

``missing_fragment``
    One or more expected fragments (e.g. ``_jXhml51``) are not present in the
    HTML.  ``missing_fragment_ids`` names every absent fragment so the capture
    tool can point at the missing piece directly.

``payload_corrupted``
    All fragments are present but the payload cannot be restored: the
    concatenated text is not valid Base64, or the XOR result is not valid
    UTF-8 (or a fragment is empty).  ``payload_error`` narrows it down.

``script_error``
    The decoding script (or its parameters) could not be understood, or an
    unexpected error was raised while interpreting it (missing key literal,
    unreadable input, internal failure, ...).

Success means ``ok=True``, ``reason=""``, and ``html`` holds the exact text the
page's ``document.write`` would have received.

The collector deliberately does not modify the page: index.html keeps its
original templates and script, so its rendering behaviour is unchanged.

Command line::

    python collector.py saved_page.html
    python collector.py saved_page.html --output result.json

Exit status is 0 on success, 1 when the page could not be restored, and 2 when
the input file itself cannot be read.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from pathlib import Path
from typing import Any

# Machine-readable failure classes.  These are the values reported in
# ``result["reason"]``; on success the reason is the empty string.
REASON_NONE = ""
REASON_MISSING_FRAGMENT = "missing_fragment"
REASON_PAYLOAD_CORRUPTED = "payload_corrupted"
REASON_SCRIPT_ERROR = "script_error"

# Base64 payload sub-classification, reported in ``result["payload_error"]``.
PAYLOAD_INVALID_BASE64 = "invalid_base64"
PAYLOAD_INVALID_UTF8 = "invalid_utf8"
PAYLOAD_EMPTY_FRAGMENT = "empty_fragment"

_SCRIPT_RE = re.compile(r"(?is)<script\b[^>]*>(.*?)</script\s*>")
_TEMPLATE_RE = re.compile(r"(?is)<template\b([^>]*)>(.*?)</template\s*>")
_ID_ATTR_RE = re.compile(
    r"""id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""", re.IGNORECASE
)
# The key is passed to atob() as a string literal; atob(variable) is not a key.
_KEY_LITERAL_RE = re.compile(r"""atob\s*\(\s*(["'])([^"']*?)\1\s*\)""")

# The fragment-collection loop header, e.g.
#   for (var i = 0; i < 9; i++) { ... }
_LOOP_HEADER_RE = re.compile(
    r"""
    for\s*\(\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*
    \1\s*<\s*(\d+)\s*;\s*\1(?:\+\+|\+=\s*1)\s*\)
    """,
    re.VERBOSE,
)

# The id lookup inside the loop, e.g. getElementById('_jXhml5' + i).
_ID_LOOKUP_RE = re.compile(
    r"""getElementById\s*\(\s*(["'])(.*?)\1\s*\+\s*([A-Za-z_$][\w$]*)\s*\)"""
)

# JavaScript's atob() ignores ASCII whitespace (TAB, LF, FF, CR, SPACE).
_ASCII_WS_RE = re.compile(r"[ \t\n\f\r]+")


class _ScriptError(Exception):
    """The page's decoding script could not be interpreted."""


class _PayloadError(Exception):
    """The payload exists but cannot be turned back into valid HTML."""

    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail


def _empty_result() -> dict[str, Any]:
    return {
        "ok": False,
        "success": False,
        "html": None,
        "reason": REASON_NONE,
        "detail": "",
        "missing_fragment_ids": [],
        "payload_error": None,
        "fragment_prefix": "",
        "fragments_expected": None,
        "fragments_found": 0,
    }


def _as_html_text(value: str | bytes) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise _ScriptError(f"input HTML is not valid UTF-8: {exc}") from exc
    raise _ScriptError(
        f"expected the page HTML as str or bytes, got {type(value).__name__}"
    )


def _script_bodies(html: str) -> list[str]:
    return _SCRIPT_RE.findall(html)


def _extract_templates(html: str) -> dict[str, str]:
    """Return {template id: raw inner content}.

    The page's script reads ``innerHTML``; for the Base64 payload the raw
    template text is identical to innerHTML because the payload contains no
    markup characters.  Duplicate ids resolve to the first occurrence, which
    matches ``document.getElementById``.
    """
    templates: dict[str, str] = {}
    for match in _TEMPLATE_RE.finditer(html):
        attr_match = _ID_ATTR_RE.search(match.group(1))
        if not attr_match:
            continue
        template_id = next(g for g in attr_match.groups() if g is not None)
        templates.setdefault(template_id, match.group(2))
    return templates


def _decode_key_literal(key_b64: str) -> bytes:
    cleaned = _ASCII_WS_RE.sub("", key_b64)
    try:
        key = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _ScriptError(f"XOR key literal is not valid Base64: {exc}") from exc
    if not key:
        raise _ScriptError("XOR key literal decodes to an empty key")
    return key


def _fragment_layout(html: str) -> tuple[bytes, str, list[str]]:
    """Locate the key, prefix and expected fragment ids without running JS.

    The loop header is the authoritative source of the expected count, so a
    missing *last* fragment is detectable.  If the loop cannot be parsed
    (e.g. a future rewrite obfuscates it more), fall back to the ids that are
    actually present and infer the count from the highest numeric suffix.
    """
    scripts = _script_bodies(html)
    key_match = None
    loop_layout = None
    for body in scripts:
        if key_match is None:
            key_match = _KEY_LITERAL_RE.search(body)
        if loop_layout is None:
            header = _LOOP_HEADER_RE.search(body)
            if header is not None:
                lookup = _ID_LOOKUP_RE.search(body, header.end())
                # The id lookup must use the same counter as the loop header.
                if lookup is not None and lookup.group(3) == header.group(1):
                    loop_layout = (header.group(2), lookup.group(2))
        if key_match is not None and loop_layout is not None:
            break

    # Look in the whole document as a fallback (e.g. script split oddly).
    if key_match is None:
        key_match = _KEY_LITERAL_RE.search(html)
    if loop_layout is None:
        header = _LOOP_HEADER_RE.search(html)
        if header is not None:
            lookup = _ID_LOOKUP_RE.search(html, header.end())
            if lookup is not None and lookup.group(3) == header.group(1):
                loop_layout = (header.group(2), lookup.group(2))

    if key_match is None:
        raise _ScriptError(
            "could not find the Base64 XOR key literal (atob('...')) in the page"
        )
    key = _decode_key_literal(key_match.group(2))

    templates = _extract_templates(html)

    if loop_layout is not None:
        count, prefix = loop_layout
        expected = [f"{prefix}{index}" for index in range(int(count))]
        return key, prefix, expected

    # Fallback: infer the layout from the template ids themselves.
    suffix_re = re.compile(r"^(.*?)(\d+)$")
    indexed = [
        (int(match.group(2)), template_id)
        for template_id in templates
        if (match := suffix_re.match(template_id))
    ]
    if not indexed:
        raise _ScriptError(
            "could not locate the fragment loop or any numbered <template> ids"
        )
    # Use the prefix of the lowest-numbered id; ids 0..max are expected.
    lowest = min(indexed)[1]
    prefix = suffix_re.match(lowest).group(1)
    expected = [f"{prefix}{index}" for index in range(max(i for i, _ in indexed) + 1)]
    return key, prefix, expected


def _decode_payload(payload: str, key: bytes) -> str:
    cleaned = _ASCII_WS_RE.sub("", payload)
    if not cleaned:
        raise _PayloadError(PAYLOAD_INVALID_BASE64, "concatenated payload is empty")

    # JavaScript's atob() rejects lengths that are not a multiple of four.
    if len(cleaned) % 4:
        raise _PayloadError(
            PAYLOAD_INVALID_BASE64,
            f"Base64 payload length {len(cleaned)} is not a multiple of 4",
        )
    try:
        raw = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _PayloadError(
            PAYLOAD_INVALID_BASE64, f"Base64 payload is invalid: {exc}"
        ) from exc

    plain = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(raw))

    try:
        # The task treats the XOR result as part of the payload, so validate
        # UTF-8 strictly.  (TextDecoder without fatal:true would silently emit
        # U+FFFD replacement characters instead.)
        return plain.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _PayloadError(
            PAYLOAD_INVALID_UTF8, f"XOR result is not valid UTF-8: {exc}"
        ) from exc


def collect_page(html_text: str | bytes) -> dict[str, Any]:
    """Restore the real page from its captured HTML text.

    ``html_text`` is the page source as text (str or UTF-8 bytes).  No DOM,
    script execution, network access or browser API is used.  Returns a
    JSON-serialisable dict; see the module docstring for the schema.
    """
    result = _empty_result()

    try:
        html = _as_html_text(html_text)
        key, prefix, expected_ids = _fragment_layout(html)
        result["fragment_prefix"] = prefix
        result["fragments_expected"] = len(expected_ids)

        templates = _extract_templates(html)
        present_ids = [template_id for template_id in expected_ids if template_id in templates]
        result["fragments_found"] = len(present_ids)

        missing = [template_id for template_id in expected_ids if template_id not in templates]
        if missing:
            result["missing_fragment_ids"] = missing
            result["reason"] = REASON_MISSING_FRAGMENT
            result["detail"] = "missing template fragment(s): " + ", ".join(missing)
            return result

        empty = [
            template_id
            for template_id in expected_ids
            if not _ASCII_WS_RE.sub("", templates[template_id])
        ]
        if empty:
            result["reason"] = REASON_PAYLOAD_CORRUPTED
            result["payload_error"] = PAYLOAD_EMPTY_FRAGMENT
            result["detail"] = "empty template fragment(s): " + ", ".join(empty)
            return result

        payload = "".join(templates[template_id] for template_id in expected_ids)
        result["html"] = _decode_payload(payload, key)
        result["ok"] = True
        result["success"] = True
        return result

    except _PayloadError as exc:
        result["reason"] = REASON_PAYLOAD_CORRUPTED
        result["payload_error"] = exc.kind
        result["detail"] = exc.detail
    except _ScriptError as exc:
        result["reason"] = REASON_SCRIPT_ERROR
        result["detail"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - surface anything unforeseen as script_error
        result["reason"] = REASON_SCRIPT_ERROR
        result["detail"] = f"unexpected decoder error: {type(exc).__name__}: {exc}"
    return result


def collect_file(path: str | Path) -> dict[str, Any]:
    """Read a saved page from disk and restore it (see :func:`collect_page`)."""
    return collect_page(Path(path).read_bytes())


# Convenient alias for capture pipelines that call collectors by a short name.
collect = collect_page

__all__ = [
    "collect_page",
    "collect_file",
    "collect",
    "REASON_NONE",
    "REASON_MISSING_FRAGMENT",
    "REASON_PAYLOAD_CORRUPTED",
    "REASON_SCRIPT_ERROR",
    "PAYLOAD_INVALID_BASE64",
    "PAYLOAD_INVALID_UTF8",
    "PAYLOAD_EMPTY_FRAGMENT",
]


def _emit_json(text: str, stream: Any) -> bool:
    """Write JSON text to a console stream, tolerating non-UTF-8 terminals.

    Returns False if the stream cannot encode the text at all, in which case
    the caller should retry with ASCII-escaped JSON.
    """
    try:
        stream.write(text + "\n")
        return True
    except UnicodeEncodeError:
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Restore the real HTML hidden in a saved obfuscated Load page."
    )
    parser.add_argument("input", help="saved page HTML file")
    parser.add_argument(
        "-o", "--output", help="also write the JSON result to this file (UTF-8)"
    )
    parser.add_argument(
        "--compact", action="store_true", help="print compact JSON instead of indented"
    )
    parser.add_argument(
        "--ascii",
        action="store_true",
        help="escape non-ASCII characters in stdout JSON (for non-UTF-8 consoles)",
    )
    args = parser.parse_args(argv)

    try:
        raw = Path(args.input).read_bytes()
    except OSError as exc:
        print(f"cannot read {args.input}: {exc}", file=sys.stderr)
        return 2

    result = collect_page(raw)

    def render(ensure_ascii: bool) -> str:
        return json.dumps(
            result,
            ensure_ascii=ensure_ascii,
            indent=None if args.compact else 2,
        )

    text = render(args.ascii)
    if not _emit_json(text, sys.stdout):
        # Legacy console code pages (e.g. cp936 on Windows) cannot represent
        # the restored page; fall back to \uXXXX escapes, still valid JSON.
        sys.stdout.write(render(True) + "\n")

    if args.output:
        try:
            Path(args.output).write_text(render(False) + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"cannot write {args.output}: {exc}", file=sys.stderr)
            return 2
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
