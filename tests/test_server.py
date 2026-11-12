import asyncio
import base64
import gzip
import json
import socket
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

import pytest
from mcp.server.mcpserver.exceptions import ToolError
from nodemaven import NotFoundError, Page

import nodemaven_mcp.server as srv

SECRET = "s3cr@t:pw/1"


class FakeClient:
    def __init__(self):
        self.calls = []

    def me(self):
        self.calls.append(("me",))
        return {
            "proxy_username": "acct_user",
            "proxy_password": SECRET,
            "email": "owner@example.com",
            "data": 1024,
            "subscription_status": "active",
            "is_traffic_frozen": "false",
        }

    def sub_users(self, **filters):
        self.calls.append(("sub_users", filters))
        if filters.get("page", 1) > 1:
            return Page(results=[])
        return Page(results=[{"id": "1", "proxy_username": "sub1", "proxy_password": SECRET,
                              "is_default_user": False, "is_traffic_limited": True,
                              "used_traffic": 10, "traffic_limit": 100}])

    def countries(self, **filters):
        self.calls.append(("countries", filters))
        return Page(results=[{"name": "United States", "code": "us"}], count=1)

    def statistics_data(self, proxy_username, **filters):
        self.calls.append(("statistics_data", proxy_username, filters))
        return {"labels": ["00:00"], "data": [5]}

    def create_sub_user(self, proxy_username, proxy_password, **extra):
        self.calls.append(("create_sub_user", proxy_username, proxy_password, extra))
        return {"id": "7", "proxy_username": proxy_username, "proxy_password": proxy_password,
                "is_default_user": False, "is_traffic_limited": bool(extra),
                "traffic_limit": extra.get("traffic_limit", 0)}

    def update_sub_user(self, sub_user_id, **changes):
        self.calls.append(("update_sub_user", sub_user_id, changes))
        return {"id": sub_user_id, "proxy_username": "sub1", "proxy_password": SECRET, **changes}

    def reset_sub_user_usage(self, ids):
        self.calls.append(("reset_sub_user_usage", ids))
        return [{"id": i, "proxy_username": "sub1", "proxy_password": SECRET, "used_traffic": 0}
                for i in ids]

    def delete_sub_user(self, sub_user_id):
        self.calls.append(("delete_sub_user", sub_user_id))
        return {"message": "deleted"}

    def whitelist_ips(self, **filters):
        self.calls.append(("whitelist_ips", filters))
        if filters.get("page", 1) > 1:
            raise NotFoundError("404 past the end")
        return Page(results=[{"id": 3, "ip": "192.0.2.7", "user_id": 99, "protocol": "HTTP",
                              "ports": [10000, 10001], "number_of_proxies": 2}])

    def upsert_whitelist_ip(self, ip, ports_count, **extra):
        self.calls.append(("upsert_whitelist_ip", ip, ports_count, extra))
        return {"ip_id": 3, "message": "created"}

    def delete_whitelist_ip(self, ip_id):
        self.calls.append(("delete_whitelist_ip", ip_id))
        return {"message": "deleted"}

    def domain_statistics(self, proxy_username, **filters):
        self.calls.append(("domain_statistics", filters))
        return Page(results=[["www.amazon.com", 40, 34756266],
                             ["speed.cloudflare.com", 46, 47147592],
                             ["cdn.jsdelivr.net", 59, 60633404],
                             {"domain_name": "example.com", "requests": 1, "data": 99}])


@pytest.fixture
def fake(monkeypatch):
    for var in ("NODEMAVEN_LOGIN", "NODEMAVEN_PASSWORD", "NODEMAVEN_MCP_REVEAL_PASSWORD",
                "NODEMAVEN_MCP_ALLOW_WRITE", "NODEMAVEN_HOST", "NODEMAVEN_PORT"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("NODEMAVEN_APIKEY", "test-key")
    client = FakeClient()
    state = srv._State()
    state._client = client
    monkeypatch.setattr(srv, "state", state)
    return client


READ_TOOLS = {"proxy_url", "check_proxy", "test_proxy_on_site", "list_locations",
              "account_status", "traffic_stats", "top_domains", "list_sub_users",
              "list_whitelist_ips"}
WRITE_TOOLS = {"create_sub_user", "update_sub_user", "reset_sub_user_usage",
               "delete_sub_user", "add_whitelist_ip", "remove_whitelist_ip"}


def test_tools_are_registered():
    names = {t.name for t in asyncio.run(srv.server.list_tools())}
    assert names == READ_TOOLS | WRITE_TOOLS


def test_proxy_url_hides_password_by_default(fake):
    out = srv.proxy_url(country="us", session_id="abc", ttl="10m")
    assert out["username"] == "acct_user-country-us-sid-abc-ttl-10m"
    assert out["url"] == ("http://acct_user-country-us-sid-abc-ttl-10m:<PROXY_PASSWORD>"
                          "@gate.nodemaven.com:8080")
    assert out["password_included"] is False
    assert SECRET not in json.dumps(out)


def test_proxy_url_reveals_encoded_password_when_allowed(fake, monkeypatch):
    monkeypatch.setenv("NODEMAVEN_MCP_REVEAL_PASSWORD", "1")
    out = srv.proxy_url(country="us")
    assert out["url"] == "http://acct_user-country-us:s3cr%40t%3Apw%2F1@gate.nodemaven.com:8080"
    assert out["password_included"] is True


def test_proxy_url_socks5(fake):
    out = srv.proxy_url(protocol="socks5")
    assert out["url"].startswith("socks5h://acct_user:")
    assert out["port"] == 1080


def test_proxy_url_mobile_names_the_type_and_residential_leaves_it_out(fake):
    mobile = srv.proxy_url(country="us", connection_type="mobile")
    assert mobile["username"] == "acct_user-country-us-type-mobile"
    residential = srv.proxy_url(country="us", connection_type="residential")
    assert residential["username"] == "acct_user-country-us"


def test_check_and_site_test_take_the_connection_type(fake, monkeypatch):
    seen = []
    real = srv._build_proxy

    def spy(protocol, connection_type="residential", **params):
        proxy = real(protocol, connection_type, **params)
        seen.append(proxy.username)
        raise srv.NodeMavenError("stop here")

    monkeypatch.setattr(srv, "_build_proxy", spy)
    for call in (lambda: srv.check_proxy(connection_type="mobile"),
                 lambda: srv.test_proxy_on_site("https://example.com", connection_type="mobile")):
        with pytest.raises(ToolError):
            call()
    assert seen == ["acct_user-type-mobile"] * 2


def test_env_credentials_skip_the_api(fake, monkeypatch):
    monkeypatch.setenv("NODEMAVEN_LOGIN", "env_user")
    monkeypatch.setenv("NODEMAVEN_PASSWORD", "env_pw")
    assert srv.proxy_url()["username"] == "env_user"
    assert ("me",) not in fake.calls


def test_invalid_parameter_is_a_tool_error(fake):
    with pytest.raises(ToolError):
        srv.proxy_url(country="us-east")


def test_account_status_returns_allowlisted_fields_only(fake):
    out = srv.account_status()
    assert out == {"proxy_username": "acct_user", "data": 1024,
                   "subscription_status": "active", "is_traffic_frozen": "false"}


def test_sub_users_drop_passwords(fake):
    out = srv.list_sub_users()
    assert SECRET not in json.dumps(out)
    assert out["rows"][0]["proxy_username"] == "sub1"


def test_locations_pass_filters_and_cap_limit(fake):
    out = srv.list_locations("countries", limit=5000)
    assert out["rows"] == [{"name": "United States", "code": "us"}]
    assert fake.calls[-1] == ("countries", {"connection_type": "residential", "limit": "100", "offset": "0"})


def test_stats_default_to_today(fake):
    out = srv.traffic_stats()
    assert out == {"labels": ["00:00"], "data": [5]}
    assert fake.calls[-1] == ("statistics_data", "acct_user", {"period": "today"})


def test_missing_api_key_is_reported(monkeypatch):
    monkeypatch.delenv("NODEMAVEN_APIKEY", raising=False)
    monkeypatch.setattr(srv, "state", srv._State())
    with pytest.raises(ToolError, match="NODEMAVEN_APIKEY"):
        srv.account_status()


def test_top_domains_labels_columns_and_sorts_by_bytes(fake):
    out = srv.top_domains(limit=2)
    assert fake.calls[-1] == ("domain_statistics", {"limit": 1000, "period": "today"})
    assert out["rows"] == [
        {"domain": "cdn.jsdelivr.net", "requests": 59, "bytes": 60633404},
        {"domain": "speed.cloudflare.com", "requests": 46, "bytes": 47147592},
    ]


def test_locations_omit_unknown_total(fake):
    assert "total" in srv.list_locations("countries")
    fake.countries = lambda **f: Page(results=[])
    assert "total" not in srv.list_locations("countries")


def test_read_tools_are_read_only_and_write_tools_are_not():
    tools = {t.name: t.annotations for t in asyncio.run(srv.server.list_tools())}
    assert all(tools[name].read_only_hint for name in READ_TOOLS)
    assert not any(tools[name].read_only_hint for name in WRITE_TOOLS)
    assert {n for n in WRITE_TOOLS if tools[n].destructive_hint} == {
        "reset_sub_user_usage", "delete_sub_user", "remove_whitelist_ip"}


def test_locations_page_with_offset(fake):
    fake.countries = lambda **f: (fake.calls.append(("countries", f)),
                                  Page(results=[{"code": c} for c in "abc"], count=7))[1]
    out = srv.list_locations("countries", limit=3, offset=3)
    assert fake.calls[-1][1]["offset"] == "3"
    assert out["next_offset"] == 6 and out["total"] == 7
    fake.countries = lambda **f: Page(results=[{"code": "z"}], count=7)
    assert "next_offset" not in srv.list_locations("countries", limit=3, offset=6)


def test_locations_without_count_page_while_full(fake):
    fake.countries = lambda **f: Page(results=[{"code": c} for c in "ab"])
    assert srv.list_locations("countries", limit=2)["next_offset"] == 2
    assert "next_offset" not in srv.list_locations("countries", limit=5)


def test_sub_users_page(fake):
    first = srv.list_sub_users()
    assert first["next_page"] == 2 and fake.calls[-1] == ("sub_users", {"page": 1})
    last = srv.list_sub_users(page=2)
    assert last["rows"] == [] and "next_page" not in last


@pytest.fixture
def writes(fake, monkeypatch):
    monkeypatch.setenv("NODEMAVEN_MCP_ALLOW_WRITE", "1")
    return fake


@pytest.mark.parametrize("call", [
    lambda: srv.create_sub_user("new1"),
    lambda: srv.update_sub_user("1", traffic_limit=5),
    lambda: srv.reset_sub_user_usage(["1"]),
    lambda: srv.delete_sub_user("1"),
    lambda: srv.add_whitelist_ip("192.0.2.7", 1),
    lambda: srv.remove_whitelist_ip("3"),
])
def test_write_tools_refuse_unless_allowed(fake, call):
    with pytest.raises(ToolError, match="NODEMAVEN_MCP_ALLOW_WRITE"):
        call()
    assert fake.calls == []


def test_create_sub_user_generates_and_hides_the_password(writes):
    out = srv.create_sub_user("new1", traffic_limit=1000)
    _, username, password, extra = writes.calls[-1]
    assert username == "new1" and len(password) == 32
    assert extra == {"traffic_limit": 1000, "is_traffic_limited": True}
    assert out["password"] == "<PROXY_PASSWORD>"
    assert password not in json.dumps(out)


def test_create_sub_user_reveals_the_password_when_allowed(writes, monkeypatch):
    monkeypatch.setenv("NODEMAVEN_MCP_REVEAL_PASSWORD", "1")
    out = srv.create_sub_user("new1")
    assert out["password"] == writes.calls[-1][2]
    assert writes.calls[-1][3] == {}


def test_update_sub_user_needs_a_change_and_drops_the_password(writes):
    with pytest.raises(ToolError, match="Nothing to change"):
        srv.update_sub_user("1")
    out = srv.update_sub_user("1", traffic_limit=500, is_traffic_limited=True)
    assert writes.calls[-1] == ("update_sub_user", "1", {"traffic_limit": 500, "is_traffic_limited": True})
    assert SECRET not in json.dumps(out)


def test_reset_and_delete_sub_user(writes):
    out = srv.reset_sub_user_usage(["1", "2"])
    assert [r["id"] for r in out["rows"]] == ["1", "2"]
    assert SECRET not in json.dumps(out)
    assert srv.delete_sub_user("1") == {"deleted": "1"}
    assert writes.calls[-1] == ("delete_sub_user", "1")


def test_whitelist_listing_drops_fields_and_ends_on_404(fake):
    out = srv.list_whitelist_ips()
    assert out["rows"] == [{"id": 3, "ip": "192.0.2.7", "protocol": "HTTP",
                            "ports": [10000, 10001], "number_of_proxies": 2}]
    assert out["next_page"] == 2
    assert srv.list_whitelist_ips(page=2) == {"page": 2, "rows": []}


def test_add_whitelist_ip_sends_protocol_and_targeting(writes):
    out = srv.add_whitelist_ip("192.0.2.7", 2, country="us", city="")
    assert writes.calls[-1] == ("upsert_whitelist_ip", "192.0.2.7", 2,
                                {"name": None, "protocol": "HTTP", "country": "us"})
    assert out == {"ip_id": 3, "ip": "192.0.2.7", "message": "created"}
    assert srv.remove_whitelist_ip("3") == {"removed": "3"}


@pytest.mark.parametrize("status, body, blocked, kind, evidence", [
    (200, b"<html>results</html>", None, None, None),
    (403, b"", "HTTP 403 (forbidden)", "status", "status:403"),
    (429, b"", "HTTP 429 (rate limited)", "status", "status:429"),
    (200, b"<title>Just a moment...</title>", "Cloudflare challenge",
     "page", "marker:just a moment..."),
    (200, b"<div class='g-recaptcha'></div>", "captcha", "page", "marker:captcha"),
    (202, b"<script src='https://x.awswaf.com/challenge.js'></script><noscript>"
          b"we need to verify that you're not a robot</noscript>", "AWS WAF challenge",
     "page", "marker:awswaf"),
])
def test_site_check_reads_the_status_and_the_page(fake, monkeypatch, status, body,
                                                 blocked, kind, evidence):
    seen = {}

    def fetch(proxy_url, url):
        seen["proxy"], seen["url"] = proxy_url, url
        return srv._Page(status=status, url=url, body=body)

    monkeypatch.setattr(srv, "_fetch_through", fetch)
    out = srv.test_proxy_on_site("https://example.com", country="de")
    assert out["blocked"] == blocked
    assert out["blocked_by"] == kind and out["evidence"] == evidence
    assert out["ok"] is (blocked is None)
    assert out["bytes"] == len(body)
    assert out["redirect_count"] == 0 and out["redirects"] == []
    assert "acct_user-country-de" in seen["proxy"]
    assert SECRET not in json.dumps(out)


def test_site_check_refuses_a_non_http_url(fake):
    with pytest.raises(ToolError, match="http or https"):
        srv.test_proxy_on_site("file:///etc/passwd")


def test_site_check_returns_a_failure_even_when_credentials_cannot_be_read(monkeypatch):
    # No env credentials and no API key: reading the password again would raise.
    monkeypatch.delenv("NODEMAVEN_LOGIN", raising=False)
    monkeypatch.delenv("NODEMAVEN_PASSWORD", raising=False)
    monkeypatch.delenv("NODEMAVEN_APIKEY", raising=False)
    monkeypatch.setattr(srv, "state", srv._State())

    class Dead:
        def url(self):
            return "http://u:s3cr%40t%3Apw%2F1@127.0.0.1:1"

    monkeypatch.setattr(srv, "_build_proxy", lambda *a, **k: Dead())
    out = srv.test_proxy_on_site("http://example.invalid/")
    assert out["ok"] is False and "error" in out
    assert "s3cr%40t" not in out["error"] and SECRET not in out["error"]


def test_site_check_redacts_a_short_password_without_mangling_the_message(fake, monkeypatch):
    # A one-character password must not rewrite "Unsupported" into nonsense,
    # while the copy inside the proxy URL must still go.
    class OneChar:
        def url(self):
            return "http://u:p@127.0.0.1:1"

    monkeypatch.setattr(srv, "_build_proxy", lambda *a, **k: OneChar())
    out = srv.test_proxy_on_site("https://example.invalid/")
    assert out["ok"] is False
    assert "Unsupported" in out["error"] or "URL" in out["error"]
    assert "@127.0.0.1" not in out["error"] or "<PROXY_PASSWORD>" in out["error"]


def test_redact_keeps_short_secrets_out_of_urls_only():
    text = "tunnel to http://u:p@h:1 failed: Unsupported method"
    assert srv._redact(text, ("p",)) == (
        "tunnel to http://u:<PROXY_PASSWORD>@h:1 failed: Unsupported method")
    assert srv._redact("bad s3cr@t:pw/1 here", ("s3cr@t:pw/1",)) == (
        "bad <PROXY_PASSWORD> here")
    # A punctuation-only secret must not rewrite every comma in the message.
    assert srv._redact("http://u:,@@h:1 well, yes", (",",)) == (
        "http://u:<PROXY_PASSWORD>@@h:1 well, yes")


def test_site_check_keeps_the_password_out_of_errors(fake, monkeypatch):
    def fetch(proxy_url, url):
        raise OSError(f"Tunnel connection failed via {proxy_url}")

    monkeypatch.setattr(srv, "_fetch_through", fetch)
    out = srv.test_proxy_on_site("https://example.com")
    assert out["ok"] is False and "OSError" in out["error"]
    assert "s3cr%40t" not in out["error"] and SECRET not in out["error"]


def test_site_check_returns_a_failure_when_the_proxy_is_unreachable(fake, monkeypatch):
    # A port nothing listens on: the connection is refused for real, not mocked.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    class StubProxy:
        def url(self):
            return f"http://u:{quote(SECRET, safe='')}@127.0.0.1:{port}"

    monkeypatch.setattr(srv, "_build_proxy", lambda *a, **k: StubProxy())
    out = srv.test_proxy_on_site("https://example.com")
    assert out["ok"] is False and "error" in out
    assert "status" not in out and "final_url" not in out
    assert quote(SECRET, safe="") not in json.dumps(out)
    assert SECRET not in json.dumps(out)


def test_a_full_page_with_a_captcha_widget_is_not_a_block(fake, monkeypatch):
    page = b"<form><div class='g-recaptcha'></div></form>" + b"x" * (srv.BLOCK_PAGE_MAX + 1)
    monkeypatch.setattr(srv, "_fetch_through",
                        lambda proxy_url, url: srv._Page(200, url, page))
    out = srv.test_proxy_on_site("https://example.com")
    assert out["ok"] is True and out["blocked"] is None and out["truncated"] is False


def test_a_large_page_that_is_not_200_is_not_scanned_for_markers(fake, monkeypatch):
    # 202 with a huge body: size alone is not a refusal, so no page verdict.
    page = b"<div class='g-recaptcha'></div>" + b"x" * (srv.BLOCK_PAGE_MAX + 1)
    monkeypatch.setattr(srv, "_fetch_through",
                        lambda proxy_url, url: srv._Page(202, url, page))
    out = srv.test_proxy_on_site("https://example.com")
    assert out["ok"] is True and out["blocked"] is None and out["blocked_by"] is None



def test_an_undecodable_body_is_not_called_clean(fake, monkeypatch):
    page = srv._Page(200, "https://example.com", b"not-gzip-at-all",
                     content_encoding="gzip",
                     decode_error="gzip: zlib.error: incorrect header check")
    monkeypatch.setattr(srv, "_fetch_through", lambda proxy_url, url: page)
    out = srv.test_proxy_on_site("https://example.com")
    assert out["ok"] is False
    assert out["blocked"] is None and out["blocked_by"] is None
    assert "decode_error" in out and "zlib.error" in out["decode_error"]



class FakeProxy(BaseHTTPRequestHandler):
    """A local HTTP server that also answers as the proxy for absolute-form GETs.

    Routing is by path, so one server plays the proxy and the site at once: the
    request line of a proxied GET carries the absolute URL, and ``self.path``
    is the whole of it. Requests are logged with ``Proxy-Authorization`` so the
    tests can prove the password was sent to the proxy and nowhere else.
    """

    #: ``{"path": (status, headers, body)}`` overrides the built-in routes.
    routes = {}
    seen = []
    encoding = None

    def do_GET(self):
        FakeProxy.seen.append((self.path, self.headers.get("Proxy-Authorization")))
        FakeProxy.encoding = self.headers.get("Accept-Encoding")
        parts = urlsplit(self.path)
        path = parts.path or "/"
        if path == "/abort":
            # Hang up mid-response: the client sees the connection die with no
            # status to judge, which is the "connection error" path.
            self.close_connection = True
            return
        route = FakeProxy.routes.get(path)
        if route is None:
            route = self.default_route(path)
        status, headers, body = route
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        if "Content-Length" not in headers:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        if path in ("/cut", "/cut-challenge"):
            # Hang up before the promised Content-Length was delivered.
            self.close_connection = True

    def default_route(self, path):
        if path == "/start":
            return 302, {"Location": "/final"}, b""
        if path == "/final":
            return 200, {}, b"<html>final page</html>"
        if path == "/challenge":
            return 200, {}, b"<title>Just a moment...</title>"
        if path == "/forbidden":
            return 403, {}, b"denied"
        if path == "/cut":
            # Promises 4000 bytes and sends 30, then the connection closes:
            # a body that never finished arriving, with no marker in the prefix.
            return 200, {"Content-Length": "4000"}, b"<html>partial page"
        if path == "/cut-challenge":
            return 200, {"Content-Length": "4000"}, b"<title>Just a moment...</title>"
        return 404, {}, b"not found"

    def log_message(self, *args):
        pass


@pytest.fixture
def site(fake, monkeypatch):
    """A live local proxy/site server, and a proxy string that points at it."""
    FakeProxy.routes, FakeProxy.seen, FakeProxy.encoding = {}, [], None
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeProxy)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]
    proxy = f"http://u:{quote(SECRET, safe='')}@127.0.0.1:{port}"

    class LocalProxy:
        def url(self):
            return proxy

    monkeypatch.setattr(srv, "_build_proxy", lambda *a, **k: LocalProxy())

    class Site:
        base = f"http://site.example.invalid:{port}"

        @staticmethod
        def url(path):
            return f"{Site.base}{path}"

        @staticmethod
        def set(path, status, body=b"", headers=None):
            FakeProxy.routes[path] = (status, headers or {}, body)

    try:
        yield Site
    finally:
        httpd.shutdown()


def test_site_check_follows_a_redirect_and_reports_the_hops(site):
    out = srv.test_proxy_on_site(site.url("/start"))
    assert out["ok"] is True
    assert out["status"] == 200
    assert out["final_url"] == site.url("/final")
    assert out["redirect_count"] == 1
    assert out["redirects"] == [site.url("/start")]
    assert out["bytes"] == len(b"<html>final page</html>")
    assert out["blocked"] is None and out["blocked_by"] is None
    assert SECRET not in json.dumps(out)


def test_site_check_follows_a_chain_of_redirects(site):
    site.set("/a", 301, headers={"Location": "/b"})
    site.set("/b", 307, headers={"Location": "/c"})
    site.set("/c", 200, b"<html>landed</html>")
    out = srv.test_proxy_on_site(site.url("/a"))
    assert out["ok"] is True
    assert out["final_url"] == site.url("/c")
    assert out["redirect_count"] == 2
    assert out["redirects"] == [site.url("/a"), site.url("/b")]


@pytest.mark.parametrize("target", [
    "ftp://files.example.invalid/x",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "mailto:someone@example.invalid",
])
def test_site_check_stops_at_a_redirect_off_http_and_says_where(site, target):
    site.set("/go", 302, headers={"Location": target})
    out = srv.test_proxy_on_site(site.url("/go"))
    assert out["ok"] is False
    assert out["status"] == 302
    assert out["final_url"] == site.url("/go")
    assert out["stopped_at"] == target
    assert out["evidence"] == "status:302"
    # No hop was followed: the 302 that pointed away is the last URL, and
    # the count is what was followed, not what was seen.
    assert out["redirect_count"] == 0
    assert out["redirects"] == []
    assert out["bytes"] == 0
    # The proxy must not carry the target; one request only.
    assert [p for p, _ in FakeProxy.seen] == [site.url("/go")]
    assert SECRET not in json.dumps(out)


def test_site_check_stops_a_redirect_loop_at_the_limit(site):
    site.set("/loop", 302, headers={"Location": "/loop"})
    out = srv.test_proxy_on_site(site.url("/loop"))
    assert out["ok"] is False
    assert out["status"] == 302
    assert out["redirect_count"] == srv.SITE_MAX_REDIRECTS
    assert out["evidence"] == f"redirect_count:{srv.SITE_MAX_REDIRECTS}"
    assert out["final_url"] == site.url("/loop")
    # One request that issued the first 302, plus the SITE_MAX_REDIRECTS hops
    # that were followed; the last answer was not followed.
    assert len(FakeProxy.seen) == srv.SITE_MAX_REDIRECTS + 1


def test_site_check_asks_for_a_compressed_response(site):
    srv.test_proxy_on_site(site.url("/final"))
    assert "gzip" in (FakeProxy.encoding or "")
    assert "deflate" in (FakeProxy.encoding or "")


def test_site_check_decodes_gzip_before_looking_for_markers(site):
    page = b"<title>Just a moment...</title>"
    site.set("/gzip", 200, gzip.compress(page), {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/gzip"))
    assert out["content_encoding"] == "gzip"
    assert out["bytes"] == len(page)  # decoded size, not the compressed size
    assert out["blocked_by"] == "page"
    assert out["evidence"] == "marker:just a moment..."
    assert out["ok"] is False


def test_site_check_decodes_deflate(site):
    site.set("/deflate", 200, zlib.compress(b"<html>plain ok</html>"),
             {"Content-Encoding": "deflate"})
    out = srv.test_proxy_on_site(site.url("/deflate"))
    assert out["ok"] is True and out["blocked"] is None
    assert out["bytes"] == len(b"<html>plain ok</html>")


def test_site_check_decodes_a_raw_deflate_stream(site):
    # Some servers send raw deflate despite the RFC's zlib wrapper; both must work.
    comp = zlib.compressobj(9, zlib.DEFLATED, -zlib.MAX_WBITS)
    raw = comp.compress(b"<title>Just a moment...</title>") + comp.flush()
    site.set("/raw-deflate", 200, raw, {"Content-Encoding": "deflate"})
    out = srv.test_proxy_on_site(site.url("/raw-deflate"))
    assert out["blocked_by"] == "page" and out["evidence"] == "marker:just a moment..."


def test_site_check_reports_an_encoding_it_cannot_undo(site):
    site.set("/br", 200, b"\x00\x01\x02", {"Content-Encoding": "br"})
    out = srv.test_proxy_on_site(site.url("/br"))
    assert out["ok"] is False and out["blocked"] is None
    assert "unsupported Content-Encoding" in out["decode_error"]


def test_site_check_reports_a_mislabeled_gzip_body(site):
    site.set("/liar", 200, b"<html>captcha</html>", {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/liar"))
    assert out["ok"] is False
    assert out["blocked"] is None and out["blocked_by"] is None
    assert "zlib.error" in out["decode_error"]


def test_site_check_treats_a_302_without_location_as_the_final_answer(site):
    site.set("/empty", 302, b"no location")
    out = srv.test_proxy_on_site(site.url("/empty"))
    assert out["status"] == 302 and out["redirect_count"] == 0
    assert out["final_url"] == site.url("/empty")
    assert out["ok"] is True  # 3xx is not a refusal by status
    assert out["blocked"] is None


def test_site_check_decodes_a_gzip_page_that_was_a_block_by_status(site):
    page = gzip.compress(b"denied by policy")
    site.set("/gzip-403", 403, page, {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/gzip-403"))
    assert out["blocked_by"] == "status" and out["evidence"] == "status:403"


def test_site_check_decodes_a_compressed_large_page_without_flagging_it(site):
    # Over BLOCK_PAGE_MAX, so the captcha widget in it is not a refusal, and
    # over the 2 MB read limit so ``truncated`` is set honestly.
    body = b"<form><div class='g-recaptcha'></div></form>" + b"x" * (3 * 2**20)
    site.set("/big", 200, gzip.compress(body), {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/big"))
    assert out["ok"] is True and out["blocked"] is None
    assert out["bytes"] == srv.SITE_READ_LIMIT
    assert out["truncated"] is True


def test_site_check_reads_a_large_plain_page_up_to_the_limit(site):
    body = b"<html>big</html>" + b"y" * (srv.SITE_READ_LIMIT + 4096)
    site.set("/huge", 200, body)
    out = srv.test_proxy_on_site(site.url("/huge"))
    assert out["ok"] is True and out["truncated"] is True
    assert out["bytes"] == srv.SITE_READ_LIMIT


def test_a_body_that_ends_exactly_at_the_limit_is_not_truncated(site):
    body = b"z" * srv.SITE_READ_LIMIT
    site.set("/exact", 200, body)
    out = srv.test_proxy_on_site(site.url("/exact"))
    assert out["ok"] is True and out["truncated"] is False
    assert out["bytes"] == srv.SITE_READ_LIMIT


def test_a_body_cut_short_without_a_marker_is_not_called_ok(site):
    out = srv.test_proxy_on_site(site.url("/cut"))
    assert out["status"] == 200
    assert out["ok"] is False and "incomplete" in out
    assert out["blocked"] is None  # not a refusal, just an unfinished read


def test_a_challenge_in_a_body_cut_short_is_still_a_page_block(site):
    out = srv.test_proxy_on_site(site.url("/cut-challenge"))
    assert out["ok"] is False
    assert out["blocked_by"] == "page" and out["evidence"] == "marker:just a moment..."
    assert "incomplete" in out


def test_a_gzip_bomb_is_stopped_at_the_decoded_limit(site):
    body = b"x" * (8 * 2**20)  # compresses to a few KB
    site.set("/bomb", 200, gzip.compress(body), {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/bomb"))
    assert out["bytes"] == srv.SITE_READ_LIMIT
    assert out["truncated"] is True


def test_a_gzip_body_over_the_limit_is_a_page_refusal_only_if_the_marker_is_there(site):
    # Two pages over the limit after decompression: the marker inside is not a
    # flag when the page is a real large page, and one at the top of a modest
    # page is. Both are compressed, so both go through the decoder limit.
    body = b"<title>Just a moment...</title>" + b"x" * (srv.BLOCK_PAGE_MAX * 4)
    site.set("/gz-marker", 200, gzip.compress(body), {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/gz-marker"))
    assert out["ok"] is True and out["blocked"] is None
    assert out["bytes"] == len(body) and out["truncated"] is False


def test_a_marker_in_a_truncated_page_is_treated_as_a_large_page(site):
    # Over the decoded limit: the page is large by definition, so a challenge
    # marker in its text is not a refusal, exactly as for an uncompressed page
    # of that size. The cut-off is reported in ``truncated``.
    filler = b"x" * (srv.SITE_READ_LIMIT + 64 * 1024)
    body = b"<title>Just a moment...</title>" + filler
    site.set("/gz-cut", 200, gzip.compress(body), {"Content-Encoding": "gzip"})
    out = srv.test_proxy_on_site(site.url("/gz-cut"))
    assert out["ok"] is True and out["blocked"] is None
    assert out["truncated"] is True and out["bytes"] == srv.SITE_READ_LIMIT



def test_site_check_reports_a_status_refusal_from_a_real_response(site):
    out = srv.test_proxy_on_site(site.url("/forbidden"))
    assert out["ok"] is False
    assert out["status"] == 403
    assert out["blocked_by"] == "status" and out["evidence"] == "status:403"
    assert out["blocked"] == "HTTP 403 (forbidden)"
    assert SECRET not in json.dumps(out)


def test_site_check_reports_a_page_refusal_from_a_real_response(site):
    out = srv.test_proxy_on_site(site.url("/challenge"))
    assert out["ok"] is False and out["status"] == 200
    assert out["blocked_by"] == "page" and out["evidence"] == "marker:just a moment..."


def test_site_check_goes_through_the_proxy_with_basic_auth(site):
    out = srv.test_proxy_on_site(site.url("/final"))
    assert out["ok"] is True
    expected = "Basic " + base64.b64encode(f"u:{SECRET}".encode()).decode("ascii")
    assert FakeProxy.seen == [(site.url("/final"), expected)]


def test_site_check_ignores_no_proxy(site, monkeypatch):
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    out = srv.test_proxy_on_site(site.url("/final"))
    assert out["ok"] is True
    assert FakeProxy.seen[0][0] == site.url("/final")


def test_site_check_reports_a_dropped_connection_as_a_failure(site):
    # The proxy hangs up without a response: neither a status nor a page.
    out = srv.test_proxy_on_site(site.url("/abort"))
    assert out["ok"] is False
    assert "error" in out and "status" not in out
    assert SECRET not in json.dumps(out)




def test_missing_api_key_points_to_sign_up(monkeypatch):
    monkeypatch.delenv("NODEMAVEN_APIKEY", raising=False)
    monkeypatch.setattr(srv, "state", srv._State())
    with pytest.raises(ToolError, match="accounts/signup.*MCPNM"):
        srv.account_status()


def test_account_status_notes_an_empty_balance(fake, monkeypatch):
    assert "note" not in srv.account_status()
    me = fake.me
    monkeypatch.setattr(fake, "me", lambda: {**me(), "data": 0})
    out = srv.account_status()
    assert "No traffic left" in out["note"] and "MCPNM" in out["note"]


def test_client_name_becomes_one_header_safe_token():
    assert srv._client_token("Claude Code") == "claude-code"
    assert srv._client_token("cursor\r\nX-Injected: 1") == "cursor-x-injected-1"
    assert srv._client_token("x" * 200) == "x" * 64
    assert srv._client_token("  ") is None and srv._client_token(None) is None


def test_api_requests_name_the_server_and_the_calling_client(monkeypatch):
    seen = []

    class Api(BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.headers.get("User-Agent"))
            body = json.dumps({"proxy_username": "u", "data": 1}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Api)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setenv("NODEMAVEN_APIKEY", "test-key")
    monkeypatch.setenv("NODEMAVEN_BASE_URL", f"http://127.0.0.1:{httpd.server_port}")
    state = srv._State()
    monkeypatch.setattr(srv, "state", state)
    try:
        srv.account_status()
        state.client_name = "claude-code"
        srv.account_status()
    finally:
        httpd.shutdown()
    assert seen[0].startswith("nodemaven-python nodemaven-mcp") and "(" not in seen[0]
    assert seen[1].endswith(" (claude-code)")


def test_the_calling_client_is_noted_once_and_never_fails_a_call(monkeypatch):
    state = srv._State()
    monkeypatch.setattr(srv, "state", state)

    class Named:
        class session:
            class client_params:
                class client_info:
                    name = "Cursor"

    async def call_next(ctx):
        return "answer"

    assert asyncio.run(srv._note_client(object(), call_next)) == "answer"
    assert state.client_name is None
    assert asyncio.run(srv._note_client(Named, call_next)) == "answer"
    assert state.client_name == "cursor"

    class Other(Named):
        class session:
            class client_params:
                class client_info:
                    name = "Another"

    assert asyncio.run(srv._note_client(Other, call_next)) == "answer"
    assert state.client_name == "cursor"
