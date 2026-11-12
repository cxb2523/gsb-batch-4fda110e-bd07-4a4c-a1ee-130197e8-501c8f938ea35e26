#!/usr/bin/env python3
"""Regenerate the local sample pages used by tests/test_collector.py.

Each sample mimics the real index.html layout: nine ``_jXhml5N`` template
fragments, an ``atob('...')`` key literal, and the same collect/XOR/write
script.  Run with::

    python -I samples/build_samples.py
"""

from __future__ import annotations

import base64
from pathlib import Path

HERE = Path(__file__).resolve().parent
PREFIX = "_jXhml5"
FRAGMENTS = 9
KEY_B64 = base64.b64encode(b"sample-key-0123456789abcdef").decode("ascii")

DEMO_BODY = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sample decoded page</title>
</head>
<body>
  <h1>Decoded successfully</h1>
  <p>Hello from the offline collector sample.</p>
</body>
</html>
"""

# Invalid UTF-8: 0xFF / 0xFE can never appear in a valid UTF-8 stream.
BAD_UTF8_BODY = b"<p>partial</p>\xff\xfe<p>tail</p>\n"


def _encrypt(plain: bytes) -> str:
    key = base64.b64decode(KEY_B64)
    xored = bytes(b ^ key[i % len(key)] for i, b in enumerate(plain))
    return base64.b64encode(xored).decode("ascii")


def _split(payload: str, count: int = FRAGMENTS) -> list[str]:
    # Uneven chunks, similar to the real page (fragments are cut arbitrarily,
    # except the page must still concatenate to valid Base64; the real page
    # happens to split on multiples of 4).
    size = len(payload) // count
    pieces = [payload[i * size:(i + 1) * size] for i in range(count)]
    pieces[-1] += payload[count * size:]
    return pieces


def _page(parts: list[str | None]) -> str:
    templates = "".join(
        "" if part is None else f'<template id="{PREFIX}{i}">{part}</template>'
        for i, part in enumerate(parts)
    )
    script = f"""function uBfMmy(){{var x=20;return x*2;}}
(function(){{
var aCSbJy=atob('{KEY_B64}');
var IK4FZy=[];
for(var CQm2sH=0;CQm2sH<{FRAGMENTS};CQm2sH++){{
  var _e=document.getElementById('{PREFIX}'+CQm2sH);IK4FZy.push(_e?_e.innerHTML:'');
}}
var n4Call=IK4FZy.join('');
var vQ171L=atob(n4Call);
var zDfcXg=new Uint8Array(vQ171L.length);
for(CQm2sH=0;CQm2sH<vQ171L.length;CQm2sH++){{
  zDfcXg[CQm2sH]=vQ171L.charCodeAt(CQm2sH)^aCSbJy.charCodeAt(CQm2sH%aCSbJy.length);
}}
var Y3jM1E=new TextDecoder('utf-8').decode(zDfcXg);
document.open();
document.write(Y3jM1E);
document.close();
}})();"""
    return (
        '<!doctype html>\n<html><head><meta charset="UTF-8"><title>Load</title></head>'
        f"<body>{templates}<script>{script}</script><!-- end --></body></html>\n"
    )


def write(name: str, content: str) -> None:
    path = HERE / name
    path.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(HERE.parent)} ({len(content)} chars)")


def main() -> None:
    good = _split(_encrypt(DEMO_BODY.encode("utf-8")))
    write("sample_ok.html", _page(good))

    # Missing middle fragment (id _jXhml53).
    missing = list(good)
    missing[3] = None
    write("sample_missing_fragment.html", _page(missing))

    # Also cover a missing *last* fragment, only detectable via the loop count.
    missing_last = list(good)
    missing_last[-1] = None
    write("sample_missing_last_fragment.html", _page(missing_last))

    # Invalid Base64: inject a non-alphabet character into one fragment.
    bad_b64 = list(good)
    bad_b64[4] = bad_b64[4][:10] + "!" + bad_b64[4][11:]
    write("sample_bad_base64.html", _page(bad_b64))

    # XOR output is not valid UTF-8.
    bad_utf8 = _split(_encrypt(BAD_UTF8_BODY))
    write("sample_bad_utf8.html", _page(bad_utf8))


if __name__ == "__main__":
    main()
