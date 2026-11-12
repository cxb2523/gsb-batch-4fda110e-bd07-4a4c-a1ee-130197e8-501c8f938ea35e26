"""Offline tests for :mod:`page_restore`.

Everything here runs on in-memory strings; no network access, no browser, no
third-party packages.  The sample payload is built the same way the landing
page builds its own: UTF-8 HTML -> fixed-key XOR -> Base64 -> split into
``_Jmuzej2Rg0..N`` divs.

Run with::

    python -I -m unittest discover -s tests -v
"""

import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from page_restore import (  # noqa: E402
    DEFAULT_KEY_B64,
    SHARD_PREFIX,
    STAGE_BASE64,
    STAGE_EMPTY_KEY,
    STAGE_MISSING_SHARD,
    STAGE_UTF8,
    restore_page,
    restore_page_file,
)

KEY = base64.b64decode(DEFAULT_KEY_B64)

SAMPLE_HTML = (
    "<!DOCTYPE html>\n"
    '<html lang="zh-CN"><head><meta charset="utf-8">'
    "<title>还原样例 / Restored sample</title></head>\n"
    "<body><h1>真正的正文</h1>"
    "<p>这段文字由分片拼接、Base64 解码、逐字节异或后还原。</p>"
    "</body></html>\n"
)


def encode_payload(text, key=KEY):
    """Turn plain HTML into the page's Base64 payload string."""
    raw = text.encode("utf-8")
    xored = bytes(byte ^ key[i % len(key)] for i, byte in enumerate(raw))
    return base64.b64encode(xored).decode("ascii")


def split_shards(payload, chunk_size):
    """Split a payload the way the page does: round-robin sized slices."""
    return [
        payload[index : index + chunk_size]
        for index in range(0, len(payload), chunk_size)
    ]


def render_shards(shards, prefix=SHARD_PREFIX, extra_divs="", declared=None):
    """Render shard text as the hidden divs plus the page's loop script.

    ``shards`` may be a sequence (index i renders as id prefix+i) or a mapping
    of ``{index: text}`` so callers can drop a shard without renumbering the
    rest.  ``declared`` mirrors the fixed bound in the page script's ``for``
    loop; by default it is the highest rendered index plus one.
    """
    if isinstance(shards, dict):
        items = sorted(shards.items())
    else:
        items = list(enumerate(shards))
    divs = "".join(
        f'<div id="{prefix}{index}" style="display:none">{text}</div>'
        for index, text in items
    )
    if declared is None:
        declared = items[-1][0] + 1 if items else 0
    script = (
        "<script>/* page restore script */\n"
        "(function(){\n"
        "var jnrjb0=[];\n"
        f"for(var aggE9u=0;aggE9u<{declared};aggE9u++){{\n"
        f"  var _e=document.getElementById('{prefix}'+aggE9u);"
        "jnrjb0.push(_e?_e.textContent:'');\n"
        "}\n"
        "})();</script>"
    )
    return (
        "<html><head><title>Surface</title></head><body><!-- page loaded -->"
        f"{divs}{extra_divs}{script}"
        "</body></html>"
    )


def base_page(chunk_size=97, extra_divs=""):
    shards = split_shards(encode_payload(SAMPLE_HTML), chunk_size)
    return render_shards(shards, extra_divs=extra_divs), shards


class NormalPathTests(unittest.TestCase):
    def test_restores_html_shard_count_and_order(self):
        page, shards = base_page()
        self.assertGreater(len(shards), 3, "sample should span several shards")

        result = restore_page(page)

        self.assertTrue(result.ok)
        self.assertIsNone(result.stage)
        self.assertEqual(result.html, SAMPLE_HTML)
        self.assertEqual(result.shard_count, len(shards))
        self.assertEqual(
            result.shard_ids,
            tuple(f"{SHARD_PREFIX}{i}" for i in range(len(shards))),
        )
        self.assertEqual(result.byte_length, len(SAMPLE_HTML.encode("utf-8")))

    def test_order_is_numeric_not_element_order(self):
        # Shards present in the HTML in scrambled element order but with
        # ascending ids must still be joined 0..N.
        shards = split_shards(encode_payload(SAMPLE_HTML), 89)
        divs = "".join(
            f'<div id="{SHARD_PREFIX}{index}" style="display:none">{text}</div>'
            for index, text in reversed(list(enumerate(shards)))
        )
        page = f"<html><body>{divs}</body></html>"

        result = restore_page(page)

        self.assertTrue(result.ok)
        self.assertEqual(result.html, SAMPLE_HTML)
        self.assertEqual(
            result.shard_ids,
            tuple(f"{SHARD_PREFIX}{i}" for i in range(len(shards))),
        )

    def test_unrelated_hidden_divs_are_ignored(self):
        page, shards = base_page(
            extra_divs=(
                '<div id="_xrFFDJi" style="display:none">0</div>'
                '<div id="x19a0df1e" style="display:none"></div>'
                '<div id="_Jmuzej2RgX" style="display:none">not-a-shard</div>'
            )
        )
        result = restore_page(page)

        self.assertTrue(result.ok)
        self.assertEqual(result.html, SAMPLE_HTML)
        self.assertEqual(result.shard_count, len(shards))

    def test_whitespace_inside_shards_is_tolerated(self):
        shards = split_shards(encode_payload(SAMPLE_HTML), 83)
        padded = ["\n  " + text + "\n  " for text in shards]
        page = render_shards(padded)

        result = restore_page(page)

        self.assertTrue(result.ok)
        self.assertEqual(result.html, SAMPLE_HTML)

    def test_real_landing_page_in_repo(self):
        repo_root = Path(__file__).resolve().parents[1]
        index = repo_root / "index.html"
        if not index.exists():
            self.skipTest("index.html not present")
        result = restore_page_file(index)

        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.shard_count, 6)
        self.assertEqual(
            result.shard_ids, tuple(f"{SHARD_PREFIX}{i}" for i in range(6))
        )
        self.assertTrue(result.html.lstrip().startswith("<!DOCTYPE html>"))


class NegativePathTests(unittest.TestCase):
    def test_missing_middle_shard_fails_and_names_it(self):
        page, shards = base_page()
        gap = 2
        page = render_shards(
            {index: text for index, text in enumerate(shards) if index != gap},
            declared=len(shards),
        )

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertIn(f"{SHARD_PREFIX}{gap}", result.message)
        self.assertIsNone(result.html)
        # Validation stops before decoding: no byte count is reported.
        self.assertEqual(result.byte_length, 0)

    def test_missing_trailing_shard_fails_and_names_it(self):
        page, shards = base_page()
        page = render_shards(shards[:-1], declared=len(shards))

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertIn(f"{SHARD_PREFIX}{len(shards) - 1}", result.message)

    def test_numbering_not_starting_at_zero(self):
        page = "".join(
            f'<div id="{SHARD_PREFIX}{i}" style="display:none">QUFB</div>'
            for i in (1, 2)
        )
        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertIn(f'"{SHARD_PREFIX}0"', result.message)

    def test_no_shards_at_all(self):
        result = restore_page("<html><body>no shards here</body></html>")

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertEqual(result.shard_count, 0)

    def test_invalid_base64_fails(self):
        page = render_shards(["QUJD", "@@@invalid@@@"])

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_BASE64)
        self.assertIn("Base64", result.message)
        self.assertIsNone(result.html)

    def test_padding_only_payload_fails_at_base64(self):
        # "====" is non-empty and not an empty-shard, but it is padding only:
        # Base64 decoding rejects it / yields nothing.
        page = render_shards(["===="])

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_BASE64)
        self.assertIn("Base64", result.message)
        self.assertIsNone(result.html)

    def test_whitespace_only_payload_fails_as_empty_payload(self):
        # Each shard is non-empty, so it passes shard checks; after
        # whitespace stripping there is nothing left to decode.
        page = render_shards(["   ", "\n\t", "  "])

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_BASE64)
        self.assertIn("载荷为空", result.message)
        self.assertEqual(result.shard_count, 3)

    def test_xored_bytes_not_utf8_fails_without_raising(self):
        # Craft ciphertext that XORs to 0xFF bytes, which UTF-8 rejects.
        key = base64.b64decode(DEFAULT_KEY_B64)
        bad_plain = bytes([0xFF] * 32)
        bad_payload = bytes(
            byte ^ key[i % len(key)] for i, byte in enumerate(bad_plain)
        )
        page = render_shards(split_shards(
            base64.b64encode(bad_payload).decode("ascii"), 20
        ))

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_UTF8)
        self.assertIn("UTF-8", result.message)
        self.assertEqual(result.byte_length, 32)
        self.assertEqual(
            result.shard_ids, tuple(f"{SHARD_PREFIX}{i}" for i in range(3))
        )


class BoundaryPathTests(unittest.TestCase):
    def test_empty_shard_content_fails_and_names_it(self):
        page, shards = base_page()
        emptied = 1
        shards = list(shards)
        shards[emptied] = ""
        page = render_shards(shards)

        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertIn(f"{SHARD_PREFIX}{emptied}", result.message)
        self.assertIn("空串", result.message)
        self.assertIsNone(result.html)

    def test_self_closing_empty_shard_counts_as_empty(self):
        page = (
            f'<div id="{SHARD_PREFIX}0" style="display:none">QUFB</div>'
            f'<div id="{SHARD_PREFIX}1" style="display:none"/>'
        )
        result = restore_page(page)

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_MISSING_SHARD)
        self.assertIn(f"{SHARD_PREFIX}1", result.message)

    def test_empty_string_key_fails_before_byte_loop(self):
        page, shards = base_page()

        result = restore_page(page, key="")

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_EMPTY_KEY)
        self.assertEqual(result.byte_length, 0)
        self.assertEqual(result.shard_count, len(shards))
        self.assertEqual(
            result.shard_ids, tuple(f"{SHARD_PREFIX}{i}" for i in range(len(shards)))
        )

    def test_whitespace_only_and_empty_bytes_key_fail(self):
        page, _ = base_page()

        for key in ("  \n\t ", b""):
            with self.subTest(key=repr(key)):
                result = restore_page(page, key=key)
                self.assertFalse(result.ok)
                self.assertEqual(result.stage, STAGE_EMPTY_KEY)
                self.assertIn("密钥为空", result.message)

    def test_key_decoding_to_zero_length_fails(self):
        # "====" is Base64 padding only: valid text, zero-length result.
        page, _ = base_page()
        result = restore_page(page, key="====")

        self.assertFalse(result.ok)
        self.assertEqual(result.stage, STAGE_EMPTY_KEY)

    def test_custom_raw_key_roundtrip(self):
        key = b"\x01\x02\x03\x04"
        shards = split_shards(encode_payload(SAMPLE_HTML, key=key), 101)
        result = restore_page(render_shards(shards), key=key)

        self.assertTrue(result.ok)
        self.assertEqual(result.html, SAMPLE_HTML)
        self.assertEqual(result.shard_count, len(shards))


class ContractTests(unittest.TestCase):
    def test_results_serialise_for_reporting(self):
        page, shards = base_page()
        payload = restore_page(page).to_dict()

        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["shard_count"], len(shards))
        self.assertEqual(payload["shard_ids"][0], f"{SHARD_PREFIX}0")
        self.assertIsNone(payload["stage"])
        self.assertIsInstance(payload["html"], str)

    def test_never_raises_on_garbage_input(self):
        for garbage in ("", "<div", "not html at all", "<div id=\"\">x</div>"):
            with self.subTest(garbage=garbage):
                result = restore_page(garbage)
                self.assertFalse(result.ok)
                self.assertIn(
                    result.stage,
                    (STAGE_MISSING_SHARD, STAGE_BASE64, STAGE_UTF8),
                )
                self.assertTrue(result.message)


if __name__ == "__main__":
    unittest.main()
