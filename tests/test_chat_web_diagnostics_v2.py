"""Auditable collection diagnostics for the credential-free web tools.

Every web tool result now carries a fixed-vocabulary diagnostics trail:
the stages reached (url/dns/connect/headers/body/workspace/done), the final
conclusion, per-hop redirect records, raw wire bytes read and the final
source URL. Only local fixture sockets and temporary storage are used; no
public request, credential or upstream error text can enter a snapshot.
"""

import errno
import json
import os
import socket
import time
from unittest.mock import Mock, patch
from uuid import uuid4

from new_api_cockpit.features.chat import web_tools as web
from new_api_cockpit.features.chat.workspace import Workspace
from test_chat_storage import StorageFixture
from test_chat_web_tools_v2 import URL, context, reply, upstream

STAGE_NAMES = {
    "arguments",
    "enabled",
    "url",
    "dns",
    "connect",
    "headers",
    "body",
    "search",
    "results",
    "workspace",
    "done",
}
REDIRECT_REASONS = {
    "followed",
    "too_many_redirects",
    "https_downgrade",
    "search_cross_host",
    "redirect_loop",
    "redirect_rejected",
}
SEARCH_ENV = {
    "CHAT_WEB_SEARCH_BACKEND": "searxng",
    "CHAT_WEB_SEARXNG_URL": "http://search.test/search",
}


def assert_trail_shape(test, result):
    """Invariants shared by every success and failure diagnostics block."""
    test.assertIn("diagnostics", result)
    diag = result["diagnostics"]
    test.assertEqual(
        set(diag),
        {"stages", "raw_bytes", "redirects", "source_url", "hops"}
        | ({"code"} if result["ok"] is False else set()),
    )
    test.assertIsInstance(diag["raw_bytes"], int)
    test.assertGreaterEqual(diag["raw_bytes"], 0)
    test.assertIsInstance(diag["redirects"], int)
    test.assertGreaterEqual(diag["redirects"], 0)
    test.assertIsInstance(diag["source_url"], str)
    for stage in diag["stages"]:
        test.assertIn(stage["stage"], STAGE_NAMES)
        test.assertIn(stage["status"], {"success", "failure"})
        if stage["status"] == "failure":
            test.assertIn(stage["code"], web._MESSAGES)
            if result["ok"] is False:
                test.assertEqual(stage["code"], result["code"])
    for hop in diag["hops"]:
        test.assertIn(hop["reason"], REDIRECT_REASONS)
        test.assertIsInstance(hop["hop"], int)
        test.assertIsInstance(hop["status"], int)
        test.assertTrue(hop["source"])
    if result["ok"] is False:
        test.assertEqual(diag["code"], result["code"])
        test.assertEqual(diag["stages"][-1]["status"], "failure")
    else:
        test.assertEqual(diag["stages"][-1]["stage"], "done")
        test.assertEqual(diag["stages"][-1]["status"], "success")


class DiagnosticsFetchTest(StorageFixture):
    def test_success_keeps_original_fields_and_records_full_trail(self):
        with upstream(body=b"hello"):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertTrue(result["ok"], result)
        # Original envelope fields are untouched.
        self.assertEqual(
            set(result) - {"diagnostics"},
            {
                "ok",
                "source_url",
                "content_type",
                "text",
                "truncated",
                "bytes_read",
                "redirects",
                "untrusted",
            },
        )
        self.assertEqual(result["text"], "hello")
        diag = result["diagnostics"]
        assert_trail_shape(self, result)
        names = [stage["stage"] for stage in diag["stages"]]
        self.assertEqual(
            names,
            [
                "enabled",
                "arguments",
                "url",
                "dns",
                "connect",
                "headers",
                "body",
                "done",
            ],
        )
        self.assertTrue(all(stage["status"] == "success" for stage in diag["stages"]))
        # Raw wire bytes cover status line, headers and body, not decoded text.
        self.assertGreaterEqual(diag["raw_bytes"], result["bytes_read"])
        self.assertEqual(diag["redirects"], 0)
        self.assertEqual(diag["source_url"], URL)
        self.assertEqual(diag["hops"], [])

    def test_redirect_is_recorded_hop_by_hop_with_final_source(self):
        responses = [
            reply(b"", status=302, headers=[("Location", "/final")]),
            reply(b"final"),
        ]
        with upstream(responses=responses) as server:
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertTrue(result["ok"], result)
        assert_trail_shape(self, result)
        diag = result["diagnostics"]
        self.assertEqual(diag["redirects"], 1)
        self.assertEqual(diag["source_url"], "http://public.test/final")
        self.assertEqual(len(diag["hops"]), 1)
        hop = diag["hops"][0]
        self.assertEqual(
            hop,
            {
                "hop": 1,
                "source": URL,
                "target": "http://public.test/final",
                "status": 302,
                "reason": "followed",
            },
        )
        # Each hop revalidates dns/connect/headers independently.
        self.assertEqual([stage["stage"] for stage in diag["stages"]].count("dns"), 2)
        self.assertEqual(len(server.requests), 2)

    def test_body_over_two_mib_fails_at_body_stage_with_read_bytes(self):
        raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n" + b"x" * (
            2 * 1024 * 1024 + 1
        )
        with upstream(responses=[raw]):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WEB_RESPONSE_LIMIT")
        assert_trail_shape(self, result)
        diag = result["diagnostics"]
        self.assertEqual(
            diag["stages"][-1],
            {
                "stage": "body",
                "status": "failure",
                "hop": 0,
                "code": "WEB_RESPONSE_LIMIT",
            },
        )
        self.assertEqual(diag["raw_bytes"], 2 * 1024 * 1024 + 1)
        self.assertEqual(diag["source_url"], URL)
        self.assertEqual(diag["redirects"], 0)

    def test_headers_over_32kib_fails_at_headers_stage_with_read_bytes(self):
        raw = b"HTTP/1.1 200 OK\r\nX-Large: " + b"x" * 40000 + b"\r\n\r\n"
        with upstream(responses=[raw]):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_RESPONSE_LIMIT")
        assert_trail_shape(self, result)
        diag = result["diagnostics"]
        self.assertEqual(diag["stages"][-1]["stage"], "headers")
        self.assertEqual(diag["stages"][-1]["status"], "failure")
        self.assertGreater(diag["raw_bytes"], 32 * 1024)

    def test_declared_content_length_over_limit_is_a_response_limit(self):
        raw = b"HTTP/1.1 200 OK\r\nContent-Length: 2097153\r\n\r\n"
        with upstream(responses=[raw]):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_RESPONSE_LIMIT")
        self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "headers")

    def test_bad_chunked_framing_fails_at_body_stage(self):
        raw = (
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
            b"Transfer-Encoding: chunked\r\n\r\n3\r\nabcXX0\r\n\r\n"
        )
        with upstream(responses=[raw]):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_CONTENT_INVALID")
        assert_trail_shape(self, result)
        self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "body")
        self.assertGreater(result["diagnostics"]["raw_bytes"], 0)

    def test_content_encoding_and_duplicate_header_fail_at_headers_stage(self):
        cases = (
            reply(b"x", headers=[("Content-Encoding", "gzip")]),
            b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"
            b"Content-Length: 1\r\nContent-Length: 1\r\n\r\nx",
        )
        for raw in cases:
            with self.subTest(raw=raw), upstream(responses=[raw]):
                result = web.execute("http_fetch", {"url": URL}, None, context())
            self.assertEqual(result["code"], "WEB_CONTENT_INVALID")
            assert_trail_shape(self, result)
            self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "headers")

    def test_more_than_three_redirects_stops_on_fourth_hop(self):
        responses = [
            reply(b"", status=302, headers=[("Location", f"/hop-{i}")])
            for i in range(4)
        ]
        with upstream(responses=responses) as server:
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_REDIRECT_ERROR")
        assert_trail_shape(self, result)
        diag = result["diagnostics"]
        self.assertEqual(diag["redirects"], 4)
        self.assertEqual(len(server.requests), 4)
        last = diag["hops"][-1]
        self.assertEqual(last["hop"], 4)
        self.assertEqual(last["reason"], "too_many_redirects")
        self.assertEqual(last["target"], "http://public.test/hop-3")
        failure = diag["stages"][-1]
        self.assertEqual(failure["status"], "failure")
        self.assertEqual(failure["code"], "WEB_REDIRECT_ERROR")
        self.assertEqual(failure["hop"], 3)

    def test_https_downgrade_redirect_is_rejected_on_first_hop(self):
        with patch.object(
            web,
            "_request",
            return_value={"location": "http://public.test/plain", "status": 302},
        ):
            result = web.execute(
                "http_fetch",
                {"url": "https://public.test/start"},
                None,
                context(),
            )
        self.assertEqual(result["code"], "WEB_REDIRECT_ERROR")
        assert_trail_shape(self, result)
        hop = result["diagnostics"]["hops"][-1]
        self.assertEqual(hop["hop"], 1)
        self.assertEqual(hop["reason"], "https_downgrade")
        self.assertEqual(hop["source"], "https://public.test/start")
        self.assertEqual(hop["target"], "http://public.test/plain")

    def test_redirect_loop_is_named_distinctly(self):
        with upstream(
            responses=[reply(b"", status=302, headers=[("Location", "/page")])]
        ) as server:
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_REDIRECT_ERROR")
        self.assertEqual(result["diagnostics"]["hops"][-1]["reason"], "redirect_loop")
        self.assertEqual(len(server.requests), 1)

    def test_redirect_to_blocked_target_records_rejected_hop(self):
        with upstream(
            responses=[
                reply(b"", status=302, headers=[("Location", "http://127.0.0.1/x")])
            ]
        ) as server:
            result = web.execute("http_fetch", {"url": URL}, None, context())
        # The target's own policy verdict is preserved; the hop explains why.
        self.assertEqual(result["code"], "WEB_URL_BLOCKED")
        assert_trail_shape(self, result)
        hop = result["diagnostics"]["hops"][-1]
        self.assertEqual(hop["reason"], "redirect_rejected")
        self.assertIsNone(hop["target"])
        self.assertEqual(len(server.requests), 1)

    def test_network_failure_trail_never_leaks_upstream_error_text(self):
        with patch.object(
            web,
            "_resolve",
            side_effect=OSError("credential=synthetic-secret /host/private"),
        ):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_NETWORK_ERROR")
        assert_trail_shape(self, result)
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertNotIn("/host", json.dumps(result))

    def test_dns_failure_stops_at_dns_stage_without_opening_a_socket(self):
        process = Mock()
        process.communicate.return_value = (b"", None)
        process.returncode = 1  # The isolated helper exits non-zero on failure.
        process.poll.return_value = 1
        with (
            patch.object(web.subprocess, "Popen", return_value=process),
            patch.object(web.socket, "socket") as open_socket,
        ):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_DNS_ERROR")
        assert_trail_shape(self, result)
        self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "dns")
        self.assertEqual(result["diagnostics"]["raw_bytes"], 0)
        open_socket.assert_not_called()

    def test_connect_timeout_fails_at_connect_stage(self):
        sock = Mock()
        sock.connect_ex.return_value = errno.EINPROGRESS

        def not_ready(*args):
            time.sleep(0.005)
            return [], [], []

        with (
            patch.object(
                web,
                "_resolve",
                return_value=(
                    socket.AF_INET,
                    socket.SOCK_STREAM,
                    socket.IPPROTO_TCP,
                    ("8.8.8.8", 80),
                ),
            ),
            patch.object(web.socket, "socket", return_value=sock),
            patch.object(web.select, "select", side_effect=not_ready),
            patch.object(web, "CONNECT_SECONDS", 0.05),
        ):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertEqual(result["code"], "WEB_TIMEOUT")
        assert_trail_shape(self, result)
        self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "connect")
        sock.send.assert_not_called()


class DiagnosticsSearchTest(StorageFixture):
    def test_search_cross_host_redirect_is_rejected_and_backend_redacted(self):
        redirect = reply(
            b"", status=302, headers=[("Location", "http://other.test/elsewhere")]
        )
        with (
            patch.dict(os.environ, SEARCH_ENV, clear=True),
            upstream(responses=[redirect]),
        ):
            result = web.execute("web_search", {"query": "q"}, None, context())
        self.assertEqual(result["code"], "WEB_REDIRECT_ERROR")
        assert_trail_shape(self, result)
        diag = result["diagnostics"]
        self.assertEqual(diag["hops"][-1]["reason"], "search_cross_host")
        # The operator-configured backend coordinates never leave the module.
        serialized = json.dumps(result)
        self.assertNotIn("search.test", serialized)
        self.assertNotIn("other.test", serialized)
        self.assertEqual(diag["hops"][-1]["source"], "http://searxng.invalid/search")
        self.assertEqual(diag["hops"][-1]["target"], "http://searxng.invalid/elsewhere")

    def test_search_success_redacts_backend_from_source_url(self):
        entries = [{"title": "t", "url": "https://source.test/a", "content": "snippet"}]
        with (
            patch.dict(os.environ, SEARCH_ENV, clear=True),
            upstream(
                body=json.dumps({"results": entries}).encode(),
                kind="application/json",
            ),
        ):
            result = web.execute("web_search", {"query": "q"}, None, context())
        self.assertTrue(result["ok"], result)
        assert_trail_shape(self, result)
        self.assertEqual(
            result["diagnostics"]["source_url"], "http://searxng.invalid/search"
        )
        self.assertNotIn("search.test", json.dumps(result))
        names = {stage["stage"] for stage in result["diagnostics"]["stages"]}
        self.assertIn("search", names)
        self.assertIn("results", names)

    def test_search_unavailable_fails_before_any_byte_is_read(self):
        with patch.dict(os.environ, {}, clear=True):
            result = web.execute("web_search", {"query": "q"}, None, context())
        self.assertEqual(result["code"], "WEB_SEARCH_UNAVAILABLE")
        assert_trail_shape(self, result)
        self.assertEqual(result["diagnostics"]["raw_bytes"], 0)
        self.assertEqual(result["diagnostics"]["stages"][-1]["stage"], "search")


class DiagnosticsDownloadTest(StorageFixture):
    def _workspace(self, lease):
        rid, _, _ = self.accept(lease)
        return Workspace(self.store, self.scope, lease, rid), rid

    def test_download_success_trail_ends_in_workspace_then_done(self):
        with self.store.lease(self.scope, run=True) as lease:
            workspace, rid = self._workspace(lease)
            with upstream(body=b"downloaded text"):
                result = web.execute(
                    "download_url",
                    {"url": URL, "name": "source.txt"},
                    workspace,
                    context(run_id=rid),
                )
            self.assertTrue(result["ok"], result)
            assert_trail_shape(self, result)
            names = [stage["stage"] for stage in result["diagnostics"]["stages"]]
            self.assertIn("workspace", names)
            self.assertEqual(names[-1], "done")
            self.assertEqual(result["diagnostics"]["source_url"], URL)
            self.terminal(lease, rid)

    def test_write_limit_is_web_download_limit_not_a_network_error(self):
        with self.store.lease(self.scope, run=True) as lease:
            workspace, rid = self._workspace(lease)
            with upstream(body=b"x" * 65537, kind="text/plain"):
                result = web.execute(
                    "download_url",
                    {"url": URL, "name": "big.txt"},
                    workspace,
                    context(run_id=rid),
                )
            self.assertEqual(result["code"], "WEB_DOWNLOAD_LIMIT")
            assert_trail_shape(self, result)
            failure = result["diagnostics"]["stages"][-1]
            self.assertEqual(failure["stage"], "workspace")
            self.assertEqual(failure["code"], "WEB_DOWNLOAD_LIMIT")
            # The network phases all succeeded; only the write cap was hit.
            self.assertEqual(
                [
                    stage["status"]
                    for stage in result["diagnostics"]["stages"]
                    if stage["stage"] in {"dns", "connect", "headers", "body"}
                ],
                ["success", "success", "success", "success"],
            )
            self.assertEqual(self.store.files(self.scope), [])
            self.terminal(lease, rid)

    def test_run_id_mismatch_is_web_workspace_error_without_network_traffic(self):
        with self.store.lease(self.scope, run=True) as lease:
            workspace, rid = self._workspace(lease)
            foreign = context(run_id=str(uuid4()))
            self.assertNotEqual(foreign["run_id"], rid)
            with upstream(body=b"data") as server:
                result = web.execute(
                    "download_url",
                    {"url": URL, "name": "a.txt"},
                    workspace,
                    foreign,
                )
            self.assertEqual(result["code"], "WEB_WORKSPACE_ERROR")
            assert_trail_shape(self, result)
            failure = result["diagnostics"]["stages"][-1]
            self.assertEqual(failure["stage"], "workspace")
            self.assertEqual(failure["code"], "WEB_WORKSPACE_ERROR")
            self.assertEqual(result["diagnostics"]["raw_bytes"], 0)
            self.assertEqual(server.requests, [])
            self.terminal(lease, rid)

    def test_workspace_write_failure_is_distinct_from_download_limit(self):
        with self.store.lease(self.scope, run=True) as lease:
            workspace, rid = self._workspace(lease)
            rc = context(run_id=rid)
            with (
                upstream(body=b"data"),
                patch.object(
                    workspace,
                    "write_file",
                    side_effect=OSError("secret=/host/private"),
                ),
            ):
                result = web.execute(
                    "download_url",
                    {"url": URL, "name": "a.txt"},
                    workspace,
                    rc,
                )
            self.assertEqual(result["code"], "WEB_WORKSPACE_ERROR")
            assert_trail_shape(self, result)
            self.assertEqual(
                result["diagnostics"]["stages"][-1]["code"],
                "WEB_WORKSPACE_ERROR",
            )
            self.assertNotIn("/host", json.dumps(result))
            self.terminal(lease, rid)


class DiagnosticsEarlyFailureTest(StorageFixture):
    def test_disabled_unknown_tool_and_invalid_arguments_keep_their_codes(self):
        disabled = web.execute(
            "http_fetch", {"url": URL}, None, context(web_enabled=False)
        )
        self.assertEqual(disabled["code"], "WEB_DISABLED")
        assert_trail_shape(self, disabled)
        self.assertEqual(
            disabled["diagnostics"]["stages"],
            [{"stage": "enabled", "status": "failure", "code": "WEB_DISABLED"}],
        )
        self.assertEqual(disabled["diagnostics"]["raw_bytes"], 0)

        unknown = web.execute("shell", {}, None, context())
        self.assertEqual(unknown["code"], "WEB_UNKNOWN_TOOL")
        assert_trail_shape(self, unknown)
        self.assertEqual(unknown["diagnostics"]["stages"][-1]["stage"], "arguments")

        invalid = web.execute("http_fetch", {}, None, context())
        self.assertEqual(invalid["code"], "WEB_INVALID_ARGUMENTS")
        assert_trail_shape(self, invalid)
        self.assertEqual(invalid["diagnostics"]["stages"][-1]["stage"], "arguments")

    def test_blocked_url_fails_at_url_stage_before_dns(self):
        with patch.object(web, "_resolve") as resolve:
            result = web.execute(
                "http_fetch", {"url": "http://127.0.0.1/"}, None, context()
            )
        self.assertEqual(result["code"], "WEB_URL_BLOCKED")
        assert_trail_shape(self, result)
        stages = result["diagnostics"]["stages"]
        self.assertEqual(stages[-1]["stage"], "url")
        self.assertNotIn("dns", {stage["stage"] for stage in stages})
        resolve.assert_not_called()

    def test_failure_envelope_keeps_ok_false_code_and_message_only(self):
        with upstream(responses=[reply(b"x", status=500)]):
            result = web.execute("http_fetch", {"url": URL}, None, context())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "WEB_HTTP_ERROR")
        self.assertEqual(result["message"], web._MESSAGES["WEB_HTTP_ERROR"])
        assert_trail_shape(self, result)
        # No environment or credential-shaped field is attached anywhere.
        for key in ("headers", "auth", "cookie", "env", "exception"):
            self.assertNotIn(key, result)
            self.assertNotIn(key, result["diagnostics"])


if __name__ == "__main__":
    import unittest

    unittest.main()
