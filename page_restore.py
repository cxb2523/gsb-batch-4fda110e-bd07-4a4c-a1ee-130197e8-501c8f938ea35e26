"""Browser-free restoration of pages that split their body into hidden divs.

The landing page in this repository keeps its real body in a set of hidden
``<div>`` elements whose ids are ``_Jmuzej2Rg0``, ``_Jmuzej2Rg1``, ... .
A small inline script concatenates the divs in numeric order, Base64-decodes the
result, XORs every byte with a fixed key (itself stored as a Base64 constant in
the script) and finally treats the bytes as UTF-8 before overwriting the page.

Crawlers do not run that script, so this module replays the same pipeline over
the raw HTML text and returns a structured, checkable result instead of a
blank page.  It is pure standard library and never touches the network.

Usage::

    >>> from page_restore import restore_page
    >>> result = restore_page(open("index.html", encoding="utf-8").read())
    >>> result.ok
    True
    >>> result.shard_count
    6
    >>> result.html[:15]
    '<!DOCTYPE html>'

Failure stages are stable identifiers:

``missing_shard``
    No shards found, a shard id is duplicated, numbering is not contiguous
    from 0, or a shard exists but its content is the empty string.  Messages
    always name the shard id involved.
``empty_key``
    The XOR key is unusable: empty / zero-length, or Base64 key text that
    decodes to nothing or is not Base64 at all.  Checked before the byte loop
    runs.
``base64``
    Base64 decoding raised an error or produced zero bytes.
``utf8``
    The XORed bytes are not valid UTF-8.  Reported as a result, never raised.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional, Sequence

#: Prefix used by the landing page's shard ids.
SHARD_PREFIX = "_Jmuzej2Rg"

#: Fixed XOR key from the page script, still Base64-encoded (48 bytes).
DEFAULT_KEY_B64 = (
    "Tkw0cgrx/wuBbntV12WUJ7retMxnGvJAl7341DlGGm2bwjBVSHYgIQU4OHT01z7q"
)

# Stable failure-stage identifiers.
STAGE_MISSING_SHARD = "missing_shard"
STAGE_EMPTY_KEY = "empty_key"
STAGE_BASE64 = "base64"
STAGE_UTF8 = "utf8"

_WHITESPACE_RE = re.compile(r"[ \t\r\n\f\v]+")


def _declared_shard_count(html: str, prefix: str) -> Optional[int]:
    """Read the shard count the page script iterates over, if declared.

    The page loops over a fixed bound before reading each shard, e.g.::

        for (var i = 0; i < 6; i++) { ... getElementById('_Jmuzej2Rg' + i) ... }

    Detecting that bound lets us notice a missing *trailing* shard, which is
    otherwise indistinguishable from a shorter page.  If the script uses a
    different shape, we simply fall back to continuity checks.
    """
    pattern = (
        r"<\s*(\d+)\s*;[^;{}]*\+\+\s*\)\s*\{[^;{}]*"
        r"getElementById\(\s*(['\"])" + re.escape(prefix) + r"\2"
    )
    match = re.search(pattern, html, re.S)
    if not match:
        return None
    count = int(match.group(1))
    return count if count > 0 else None


@dataclass(frozen=True)
class RestoreResult:
    """Outcome of replaying the page's restore pipeline.

    ``ok`` is True only when the full payload decoded.  On success ``html`` is
    the restored document, ``shard_ids`` lists the ids in the order they were
    concatenated, and ``shard_count`` is the number of shards joined.  On
    failure ``html`` is None, ``stage`` is one of the ``STAGE_*`` constants and
    ``message``/``details`` explain what went wrong.
    """

    ok: bool
    html: Optional[str]
    shard_ids: tuple[str, ...]
    shard_count: int
    stage: Optional[str] = None
    message: str = ""
    details: tuple[str, ...] = field(default_factory=tuple)
    byte_length: int = 0

    @property
    def failure_stage(self) -> Optional[str]:
        """Alias for :attr:`stage`, helpful when reading failure results."""
        return self.stage

    def to_dict(self) -> dict:
        """Return a JSON-serialisable view of the result."""
        return {
            "ok": self.ok,
            "stage": self.stage,
            "message": self.message,
            "details": list(self.details),
            "shard_count": self.shard_count,
            "shard_ids": list(self.shard_ids),
            "byte_length": self.byte_length,
            "html": self.html,
        }


class _ShardParser(HTMLParser):
    """Collect the text content of every ``<div id="<prefix><n>">``."""

    def __init__(self, prefix: str) -> None:
        super().__init__(convert_charrefs=True)
        self._id_re = re.compile(r"^" + re.escape(prefix) + r"(\d+)$")
        # (exact id, numeric index, text content)
        self.records: list[tuple[str, int, str]] = []
        self._active_id: Optional[str] = None
        self._active_index = 0
        self._depth = 0
        self._parts: list[str] = []

    def _open(self, shard_id: str, index: int) -> None:
        self._active_id = shard_id
        self._active_index = index
        self._depth = 1
        self._parts = []

    def _close(self) -> None:
        if self._active_id is not None:
            self.records.append(
                (self._active_id, self._active_index, "".join(self._parts))
            )
        self._active_id = None
        self._active_index = 0
        self._depth = 0
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if self._active_id is not None:
            if tag == "div":
                self._depth += 1
            return
        if tag != "div":
            return
        shard_id = dict(attrs).get("id") or ""
        match = self._id_re.match(shard_id)
        if match:
            self._open(shard_id, int(match.group(1)))

    def handle_startendtag(self, tag, attrs):
        # A self-closing shard div is an existing but empty shard.
        if self._active_id is not None:
            return
        if tag != "div":
            return
        shard_id = dict(attrs).get("id") or ""
        match = self._id_re.match(shard_id)
        if match:
            self._open(shard_id, int(match.group(1)))
            self._close()

    def handle_endtag(self, tag):
        if self._active_id is None or tag != "div":
            return
        self._depth -= 1
        if self._depth == 0:
            self._close()

    def handle_data(self, data):
        if self._active_id is not None:
            self._parts.append(data)

    def finish(self) -> list[tuple[str, int, str]]:
        # An unclosed shard behaves like an unclosed div in a browser: its text
        # content runs to the end of the document.
        self.close()
        if self._active_id is not None:
            self._close()
        return self.records


def _failure(
    stage: str,
    message: str,
    *,
    shard_ids: Sequence[str] = (),
    details: Sequence[str] = (),
    byte_length: int = 0,
) -> RestoreResult:
    return RestoreResult(
        ok=False,
        html=None,
        shard_ids=tuple(shard_ids),
        shard_count=len(shard_ids),
        stage=stage,
        message=message,
        details=tuple(details),
        byte_length=byte_length,
    )


def _resolve_key(key: Optional[object]) -> tuple[Optional[bytes], Optional[str]]:
    """Normalise the key argument.

    ``None`` means the page's fixed Base64 key.  A ``str`` is decoded as
    Base64 (mirroring the script); ``bytes`` are used verbatim.  Returns
    ``(key_bytes, error_message)``; exactly one of them is None.
    """
    if key is None:
        key = DEFAULT_KEY_B64
    if isinstance(key, bytes):
        if not key:
            return None, "XOR 密钥为空（长度为零），无法进入逐字节异或循环"
        return key, None
    if isinstance(key, str):
        text = _WHITESPACE_RE.sub("", key)
        if not text:
            return None, "XOR 密钥为空（长度为零），无法进入逐字节异或循环"
        try:
            raw = base64.b64decode(text.encode("ascii"), validate=True)
        except UnicodeEncodeError:
            return None, "XOR 密钥包含非 ASCII 字符，不是合法 Base64"
        except (binascii.Error, ValueError) as exc:
            return None, f"XOR 密钥不是合法 Base64: {exc}"
        if not raw:
            return None, "XOR 密钥解码后长度为零，无法进入逐字节异或循环"
        return raw, None
    return None, f"XOR 密钥类型不受支持: {type(key).__name__}"


def restore_page(
    html: str,
    key: Optional[object] = None,
    *,
    shard_prefix: str = SHARD_PREFIX,
) -> RestoreResult:
    """Restore a sharded page body from its HTML source text.

    :param html: Raw page HTML, exactly as fetched (script is not executed).
    :param key: XOR key.  ``None`` uses the page's fixed Base64 constant; pass
        a ``str`` for Base64 key text or ``bytes`` for a raw key.
    :param shard_prefix: Id prefix for shards; defaults to the landing page's.
    :return: :class:`RestoreResult`; failures are values, not exceptions.

    Validation order: shard collection/continuity/content -> key preflight ->
    Base64 -> XOR -> UTF-8.  Nothing is decoded after a shard failure.
    """

    prefix = shard_prefix
    parser = _ShardParser(prefix)
    parser.feed(html)
    records = parser.finish()

    if not records:
        return _failure(
            STAGE_MISSING_SHARD,
            f'未找到任何分片：页面中不存在 id 形如 "{prefix}<N>" 的 div',
        )

    by_index: dict[int, tuple[str, str]] = {}
    duplicate_ids: list[str] = []
    for shard_id, index, text in records:
        if index in by_index:
            duplicate_ids.append(shard_id)
        else:
            by_index[index] = (shard_id, text)

    issues: list[str] = []
    if duplicate_ids:
        issues.append("分片 id 重复: " + ", ".join(f'"{i}"' for i in duplicate_ids))

    indices = sorted(by_index)
    missing_ids = [
        f"{prefix}{i}" for i in range(0, indices[-1] + 1) if i not in by_index
    ]
    declared = _declared_shard_count(html, prefix)
    if declared is not None and indices[-1] + 1 < declared:
        missing_ids.extend(
            f"{prefix}{i}"
            for i in range(indices[-1] + 1, declared)
            if i not in by_index
        )
    if missing_ids:
        if indices[0] != 0:
            issues.append(
                "分片编号未从 0 开始，缺失: "
                + ", ".join(f'"{i}"' for i in missing_ids)
            )
        else:
            issues.append(
                "分片编号不连续，缺失: " + ", ".join(f'"{i}"' for i in missing_ids)
            )

    empty_ids = [shard_id for shard_id, text in by_index.values() if text == ""]
    if empty_ids:
        issues.append(
            "分片内容为空串: " + ", ".join(f'"{i}"' for i in empty_ids)
        )

    ordered_ids = tuple(by_index[i][0] for i in indices)
    if issues:
        return _failure(
            STAGE_MISSING_SHARD,
            "分片校验失败: " + "；".join(issues),
            shard_ids=ordered_ids,
            details=issues,
        )

    # Key preflight happens before Base64/XOR so an empty key is diagnosed
    # as such rather than as a payload problem.
    key_bytes, key_error = _resolve_key(key)
    if key_error is not None:
        return _failure(
            STAGE_EMPTY_KEY,
            key_error,
            shard_ids=ordered_ids,
        )

    payload = "".join(by_index[i][1] for i in indices)
    normalised = _WHITESPACE_RE.sub("", payload)
    if not normalised:
        return _failure(
            STAGE_BASE64,
            "拼接后的分片载荷为空，无法进行 Base64 解码",
            shard_ids=ordered_ids,
        )

    try:
        decoded = base64.b64decode(normalised.encode("ascii"), validate=True)
    except UnicodeEncodeError:
        return _failure(
            STAGE_BASE64,
            "拼接载荷包含非 ASCII 字符，不是合法 Base64 文本",
            shard_ids=ordered_ids,
        )
    except (binascii.Error, ValueError) as exc:
        return _failure(
            STAGE_BASE64,
            f"Base64 解码失败: {exc}",
            shard_ids=ordered_ids,
        )

    if len(decoded) == 0:
        return _failure(
            STAGE_BASE64,
            "Base64 解码结果为空（0 字节），视为坏载荷",
            shard_ids=ordered_ids,
        )

    key_len = len(key_bytes)
    plain_bytes = bytes(
        byte ^ key_bytes[i % key_len] for i, byte in enumerate(decoded)
    )

    try:
        restored = plain_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        return _failure(
            STAGE_UTF8,
            "异或后按 UTF-8 解码失败: "
            f"{exc.reason}（字节偏移 {exc.start}，字节 0x{plain_bytes[exc.start]:02x}）",
            shard_ids=ordered_ids,
            byte_length=len(decoded),
        )

    return RestoreResult(
        ok=True,
        html=restored,
        shard_ids=ordered_ids,
        shard_count=len(ordered_ids),
        stage=None,
        message=(
            f"还原成功：按编号升序拼接 {len(ordered_ids)} 个分片"
            f"（{ordered_ids[0]}..{ordered_ids[-1]}），"
            f"Base64 解出 {len(decoded)} 字节并完成 UTF-8 解码"
        ),
        byte_length=len(decoded),
    )


def restore_page_file(
    path: str | Path,
    key: Optional[object] = None,
    *,
    shard_prefix: str = SHARD_PREFIX,
) -> RestoreResult:
    """Read ``path`` as UTF-8 and restore it.  Never fetches anything."""
    text = Path(path).read_text(encoding="utf-8")
    return restore_page(text, key=key, shard_prefix=shard_prefix)


def _force_utf8_stdio() -> None:
    """Print restored HTML on consoles whose default encoding is not UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):  # pragma: no cover - exotic streams
            pass


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Restore a sharded landing page offline from its HTML text."
    )
    parser.add_argument(
        "html",
        nargs="?",
        default="-",
        help="HTML file path, or '-' to read HTML from stdin (default).",
    )
    parser.add_argument(
        "--key-b64",
        default=None,
        help="Override the XOR key with Base64 text (defaults to the page constant).",
    )
    parser.add_argument(
        "--shard-prefix", default=SHARD_PREFIX, help="Shard id prefix."
    )
    parser.add_argument(
        "--html-only",
        action="store_true",
        help="Print only the restored HTML text after a successful restore.",
    )
    args = parser.parse_args(argv)
    _force_utf8_stdio()

    if args.html == "-":
        html = sys.stdin.read()
    else:
        html = Path(args.html).read_text(encoding="utf-8")

    result = restore_page(
        html, key=args.key_b64, shard_prefix=args.shard_prefix
    )

    if args.html_only:
        if not result.ok:
            print(f"{result.stage}: {result.message}", file=sys.stderr)
            return 1
        print(result.html)
        return 0

    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
