"""MCP server for NodeMaven residential proxies.

It builds proxy strings, checks them, tests them against a site, and reads
locations, usage, statistics, sub-users and whitelisted IPs from the NodeMaven
API. Tools that change the account (sub-users, whitelisted IPs) refuse to run
unless ``NODEMAVEN_MCP_ALLOW_WRITE=1`` is set.

Credentials stay in this process. API responses are reduced to an allowlist of
fields before they are returned, and proxy passwords are replaced with a
placeholder unless ``NODEMAVEN_MCP_REVEAL_PASSWORD=1`` is set.
"""

from __future__ import annotations

import base64
import http.client
import os
import re
import secrets
import time
import urllib.error
import urllib.request
import zlib
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from typing import Any, Literal, Optional
from urllib.parse import quote, unquote, urljoin, urlsplit

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from nodemaven import Client, NodeMavenError, NotFoundError, Proxy

PASSWORD_PLACEHOLDER = "<PROXY_PASSWORD>"
SIGNUP_URL = "https://dashboard.nodemaven.com/accounts/signup/"
PROMO = "the code MCPNM gives 2 GB of free traffic, once per account"
SOCKS5_PORT = 1080
MAX_ROWS = 100
DOMAIN_FETCH_LIMIT = 1000

ACCOUNT_FIELDS = ("proxy_username", "data", "subscription_status", "is_traffic_frozen")
SUB_USER_FIELDS = (
    "id",
    "proxy_username",
    "is_default_user",
    "is_traffic_limited",
    "used_traffic",
    "traffic_limit",
)
WHITELIST_FIELDS = (
    "id",
    "ip",
    "name",
    "protocol",
    "ports",
    "number_of_proxies",
    "type",
    "country_code",
    "region_code",
    "city_code",
    "isp_code",
    "sticky",
    "ttl",
    "quality_filter_enabled",
)
LOCATION_KINDS = ("countries", "regions", "cities", "isps")

SITE_TIMEOUT = 30
SITE_READ_LIMIT = 2 * 2**20
SITE_MAX_REDIRECTS = 10
SITE_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
SITE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
)
BLOCK_PAGE_MAX = 64 * 1024
BLOCK_STATUSES = {401: "unauthorized", 403: "forbidden", 407: "proxy auth",
                  429: "rate limited", 503: "unavailable"}
BLOCK_MARKERS = (
    ("awswaf", "AWS WAF challenge"),
    ("not a robot", "robot check"),
    ("captcha", "captcha"),
    ("cf-chl", "Cloudflare challenge"),
    ("just a moment...", "Cloudflare challenge"),
    ("access denied", "access denied"),
    ("unusual traffic", "unusual traffic page"),
    ("are you a robot", "robot check"),
)
#: Secrets shorter than this are redacted only where they stand alone.
REDACT_MIN_LENGTH = 6

server = MCPServer(
    name="nodemaven",
    instructions=(
        "Tools for NodeMaven residential proxies. Use proxy_url to get a proxy "
        "string with country/region/city/ISP targeting and sticky sessions, "
        "check_proxy to confirm it connects and see the exit IP, test_proxy_on_site "
        "to see whether a site answers through the proxy, list_locations to find "
        "valid location codes, and account_status, traffic_stats, top_domains, "
        "list_sub_users and list_whitelist_ips for the account. create_sub_user, "
        "update_sub_user, reset_sub_user_usage, delete_sub_user, add_whitelist_ip "
        "and remove_whitelist_ip change the account: confirm with the user before "
        "calling them. They work only when the server allows writes."
    ),
)


def _client_token(value: object) -> Optional[str]:
    """The MCP client's own name as one token that is safe in a header."""
    if not isinstance(value, str):
        return None
    kept = "".join(c if c.isascii() and (c.isalnum() or c in "._-") else " " for c in value)
    return "-".join(kept.lower().split())[:64].strip("-") or None


def _product() -> str:
    try:
        return f"nodemaven-mcp/{version('nodemaven-mcp')}"
    except PackageNotFoundError:
        return "nodemaven-mcp"


class _State:
    def __init__(self) -> None:
        self._client: Optional[Client] = None
        self._credentials: Optional[tuple[str, str]] = None
        #: The connected MCP client's name, once it has introduced itself.
        self.client_name: Optional[str] = None

    def user_agent(self, base: str = "") -> str:
        """What API requests are sent as: the SDK's own product, this server's
        and, in brackets, the MCP client that is calling."""
        client = f" ({self.client_name})" if self.client_name else ""
        return f"{base} {_product()}{client}".strip()

    def _transport(self):
        """The SDK's transport with this server named in User-Agent; None, and
        so the SDK's default, where the SDK has no such transport to wrap."""
        try:
            from nodemaven.api import _urllib_transport as send
        except ImportError:
            return None

        def transport(method, url, headers, body):
            agent = self.user_agent(headers.get("User-Agent", ""))
            return send(method, url, {**headers, "User-Agent": agent}, body)

        return transport

    def client(self) -> Client:
        if self._client is None:
            if not os.environ.get("NODEMAVEN_APIKEY"):
                raise NodeMavenError(
                    "NODEMAVEN_APIKEY is not set. Create an API key in the NodeMaven "
                    "dashboard and pass it in the server's environment. No account yet? "
                    f"Sign up at {SIGNUP_URL} - {PROMO}."
                )
            self._client = Client(transport=self._transport())
        return self._client

    def credentials(self) -> tuple[str, str]:
        if self._credentials is None:
            login = os.environ.get("NODEMAVEN_LOGIN")
            password = os.environ.get("NODEMAVEN_PASSWORD")
            if not (login and password):
                me = self.client().me()
                login, password = me["proxy_username"], me["proxy_password"]
            self._credentials = (login, password)
        return self._credentials


state = _State()


async def _note_client(ctx, call_next):
    """Remember who is calling. Never the reason a call fails."""
    if state.client_name is None:
        try:
            state.client_name = _client_token(ctx.session.client_params.client_info.name)
        except Exception:
            pass
    return await call_next(ctx)


server.middleware.append(_note_client)

READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=True)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=True)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=True)


def _reveal_password() -> bool:
    return os.environ.get("NODEMAVEN_MCP_REVEAL_PASSWORD") == "1"


def _require_write() -> None:
    if os.environ.get("NODEMAVEN_MCP_ALLOW_WRITE") != "1":
        raise ToolError(
            "This tool changes the NodeMaven account and writes are off. Set "
            "NODEMAVEN_MCP_ALLOW_WRITE=1 in the server's environment to allow them."
        )


def _pick(row: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    return {k: row[k] for k in fields if isinstance(row, dict) and k in row}


def _params(**values: Any) -> dict[str, str]:
    return {k: str(v) for k, v in values.items() if v not in (None, "")}


def _build_proxy(protocol: str, connection_type: str = "residential", **params: Any) -> Proxy:
    login, password = state.credentials()
    port = SOCKS5_PORT if protocol == "socks5" else None
    # Without `type` the gateway draws from the residential pool, so only mobile
    # is named: residential usernames stay as they were, and so do their sessions.
    if connection_type == "mobile":
        params["type"] = "mobile"
    return Proxy(login=login, password=password, port=port, **_params(**params))


@server.tool(annotations=READ_ONLY)
def proxy_url(
    country: Optional[str] = None,
    region: Optional[str] = None,
    city: Optional[str] = None,
    isp: Optional[str] = None,
    session_id: Optional[str] = None,
    ttl: Optional[str] = None,
    filter: Optional[str] = None,
    protocol: Literal["http", "socks5"] = "http",
    connection_type: Literal["residential", "mobile"] = "residential",
) -> dict[str, Any]:
    """Build a NodeMaven proxy string.

    Targeting goes into the username. Without session_id every request gets a
    new exit IP; with session_id the same exit is kept for ttl (e.g. "10m",
    "1h", "24h"). country is a two-letter code; region, city and isp take the
    codes from list_locations. filter is the IP quality filter, e.g. "medium".
    connection_type picks residential or mobile IPs; for mobile, take the
    location codes from list_locations with connection_type="mobile".
    The password is a placeholder unless the server allows revealing it.
    """
    try:
        proxy = _build_proxy(
            protocol,
            connection_type,
            country=country,
            region=region,
            city=city,
            isp=isp,
            sid=session_id,
            ttl=ttl,
            filter=filter,
        )
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    scheme = "socks5h" if protocol == "socks5" else "http"
    host, port = proxy.server.rsplit(":", 1)
    if _reveal_password():
        password = quote(state.credentials()[1], safe="")
    else:
        password = PASSWORD_PLACEHOLDER
    return {
        "url": f"{scheme}://{quote(proxy.username, safe='')}:{password}@{host}:{port}",
        "username": proxy.username,
        "host": host,
        "port": int(port),
        "password_included": _reveal_password(),
    }


@server.tool(annotations=READ_ONLY)
def check_proxy(
    country: Optional[str] = None,
    region: Optional[str] = None,
    city: Optional[str] = None,
    isp: Optional[str] = None,
    session_id: Optional[str] = None,
    ttl: Optional[str] = None,
    filter: Optional[str] = None,
    connection_type: Literal["residential", "mobile"] = "residential",
) -> dict[str, Any]:
    """Open one connection through the proxy and report the result.

    Sends no traffic through the tunnel. Returns the gateway status, the exit
    IP when the gateway reports it, and how long the connection took. A 407 can
    mean a wrong parameter value as well as wrong credentials. For mobile, take
    the location codes from list_locations with connection_type="mobile".
    """
    try:
        result = _build_proxy(
            "http",
            connection_type,
            country=country,
            region=region,
            city=city,
            isp=isp,
            sid=session_id,
            ttl=ttl,
            filter=filter,
        ).check()
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return {
        "ok": result.ok,
        "status": result.status,
        "reason": result.reason,
        "exit_ip": result.exit_ip,
        "seconds": round(result.elapsed, 3),
        "meaning": result.meaning,
    }


class _ThroughProxy(urllib.request.BaseHandler):
    """Routes every http and https request through the proxy.

    ``ProxyHandler`` consults ``NO_PROXY`` and the system bypass list, which would
    send a matching site directly from this machine and report it as a proxy test.
    """

    handler_order = 100  # before the HTTP(S) handlers, like ProxyHandler

    def __init__(self, proxy_url: str) -> None:
        parts = urlsplit(proxy_url)
        self.server = f"{parts.hostname}:{parts.port}"
        user_pass = f"{unquote(parts.username or '')}:{unquote(parts.password or '')}"
        self.auth = "Basic " + base64.b64encode(user_pass.encode()).decode("ascii")

    def _route(self, req: urllib.request.Request) -> None:
        req.add_header("Proxy-Authorization", self.auth)
        req.set_proxy(self.server, "http")

    http_open = https_open = _route


class _HttpRedirectsOnly(urllib.request.HTTPRedirectHandler):
    """Never follows a redirect itself; hands every 3xx back to the caller.

    The caller walks the hops so that each URL, the count and the scheme of each
    target are on the record. urllib's own handler treats ``ftp`` as followable,
    which would fetch a redirect target from this machine while everything
    downstream believed the proxy had carried it.

    Both halves of urllib's handler are replaced. ``redirect_request`` returning
    None is not enough: the inherited ``http_error_30x`` would still validate the
    ``Location`` and, for a scheme it refuses outright, raise with the *target*
    as the error URL rather than the URL that answered. The explicit 30x methods
    below raise ``HTTPError`` carrying ``req.full_url``, so ``geturl()`` is the
    hop that answered for every redirect, followable or not.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None

    def _stop(self, req, fp, code, msg, headers):  # type: ignore[no-untyped-def]
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)

    http_error_301 = http_error_302 = http_error_303 = http_error_307 = http_error_308 = _stop


@dataclass
class _Page:
    """One request and what came back, before any judgement is made."""

    status: int
    url: str
    body: bytes
    #: Every URL whose redirect was followed, in order. The hop that issued the
    #: last redirect is ``url`` when it was not (``stopped_at``) or could not
    #: (``redirect_limit``) be followed.
    redirects: list[str] = field(default_factory=list)
    #: Set when a redirect pointed at a scheme the proxy cannot carry, e.g.
    #: ``ftp://``. ``url`` is then the URL that answered the redirect.
    stopped_at: Optional[str] = None
    #: The redirect chain was longer than ``SITE_MAX_REDIRECTS``.
    redirect_limit: bool = False
    #: The page outran the read limit; part of it is missing from ``body``.
    truncated: bool = False
    #: The body stopped arriving before the read limit for an error: a dropped
    #: connection, a short read, or the deadline. The keyword scan saw only a
    #: prefix, so a miss is not evidence that the whole page is clean.
    incomplete: Optional[str] = None
    #: ``Content-Encoding`` values that were removed before the keyword scan.
    content_encoding: Optional[str] = None
    #: A content coding was present but could not be undone (bad stream or one
    #: this code does not know). The keyword scan cannot be trusted then, so
    #: the result says so rather than claiming the page is clean.
    decode_error: Optional[str] = None


def _redact(message: str, secrets: "tuple[str, ...]") -> str:
    """Replace every known form of a proxy password in ``message``.

    Both the raw secret and its percent-encoded form can turn up: urllib quotes
    a proxy URL before putting it in an error, and the caller's own string keeps
    the raw one. Every non-empty candidate is replaced, longest first, so a
    secret that contains another secret is not left half-visible.

    A short secret is replaced only where a proxy URL puts it: between ``:`` and
    ``@``. Substring-replacing a one- or two-character password would rewrite
    ordinary words ("Unsupported" with the password ``p`` became
    ``Unsu<PROXY_PASSWORD><PROXY_PASSWORD>orted``) and hand back an unreadable
    error, and a punctuation-only one would rewrite every comma. The leak site
    is the ``user:password@host`` inside a proxy URL, so that context is both
    necessary and sufficient.
    """
    forms = {f for secret in secrets if secret for f in (secret, quote(secret, safe=""))}
    for form in sorted(forms, key=len, reverse=True):
        if len(form) >= REDACT_MIN_LENGTH:
            message = message.replace(form, PASSWORD_PLACEHOLDER)
            continue
        pattern = re.compile(r"(?<=:)" + re.escape(form) + r"(?=@)")
        message = pattern.sub(PASSWORD_PLACEHOLDER, message)
    return message


def _proxy_password(proxy_url: str) -> Optional[str]:
    """The password inside a proxy URL, decoded, or None when there is none."""
    try:
        return unquote(urlsplit(proxy_url).password or "") or None
    except ValueError:
        return None


def _codings(headers: Any) -> list[str]:
    value = headers.get("Content-Encoding") or headers.get("content-encoding") or ""
    return [c.strip().lower() for c in value.split(",") if c.strip()]


def _inflate(data: bytes, wbits: list[int], limit: int) -> tuple[bytes, bool, bool, Optional[str]]:
    """Undo one content coding, returning ``(text, complete, truncated, error)``.

    ``wbits`` is a list because ``deflate`` is ambiguous in the wild: the RFC
    says zlib-wrapped, some servers send a raw deflate stream. The first
    window that decodes without raising wins. ``complete`` is whether the
    stream ended; ``truncated`` is whether output stopped because it hit the
    limit while more was still inside.
    """
    last_error: Optional[Exception] = None
    for window in wbits:
        decoder = zlib.decompressobj(window)
        try:
            out = decoder.decompress(data, limit)
        except zlib.error as e:
            last_error = e
            continue
        complete = decoder.eof
        # ``unconsumed_tail`` is non-empty when ``max_length`` stopped the
        # output before the input ran out, which is what makes the decoded
        # limit real: the rest is still inside the stream, not yet produced.
        truncated = not complete and bool(decoder.unconsumed_tail)
        return out[:limit], complete, truncated, None
    return b"", False, False, f"zlib.error: {last_error}"


def _decode_body(
    raw: bytes, codings: list[str], limit: int, raw_complete: bool, raw_truncated: bool = False
) -> tuple[bytes, bool, Optional[str]]:
    """Decode the body, returning ``(text, truncated, error)``.

    Codings are removed in reverse order of the header, per the RFC. Each stage
    is bounded by the same limit as the socket read, so a gzip bomb cannot get
    past the limit by expanding after it.

    ``raw_complete`` says the socket delivered the whole body; ``raw_truncated``
    says the read stopped at the limit with more still on the wire. Together
    they decide what a stream without an end means: a stream cut at the limit is
    expected to be unfinished and is no error, while one that ended early on a
    fully delivered body is corrupt.

    Known limitation: with no codings, ``truncated`` is just the socket read's,
    because a body larger than the limit is a normal large page rather than an
    error. For a coded body with more still on the wire, the stream really is
    incomplete and that is marked, since the undecoded remainder is not text.
    """
    data = raw
    truncated = raw_truncated
    for coding in reversed(codings):
        if coding in ("identity", ""):
            continue
        if coding == "deflate":
            windows = [zlib.MAX_WBITS, -zlib.MAX_WBITS]
        elif coding in ("gzip", "x-gzip"):
            windows = [16 + zlib.MAX_WBITS]
        else:
            return data[:limit], truncated, f"unsupported Content-Encoding {coding!r}"
        out, complete, hit_limit, error = _inflate(data, windows, limit)
        if error is not None:
            # Keep the bytes as they arrived: a broken stream still has a
            # prefix worth scanning, and the error explains the rest.
            return data[:limit], truncated, f"{coding}: {error}"
        if not complete and raw_complete and not hit_limit:
            return out[:limit], truncated, f"{coding}: stream ended before the trailer"
        data = out
        truncated = truncated or hit_limit
        raw_complete = complete
        raw_truncated = not complete
    return data[:limit], truncated, None


def _declared_length(response: Any) -> Optional[int]:
    """The body length the response promised, when it promised one."""
    if response.headers.get("Transfer-Encoding"):
        return None
    value = response.headers.get("Content-Length")
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _short_body(response: Any, received: int) -> Optional[str]:
    """Whether fewer bytes arrived than the response declared, and why.

    ``HTTPResponse.read(amt)`` does not raise ``IncompleteRead`` when a
    ``Content-Length`` body ends early with an amount given: it returns ``b""``
    and closes, which is indistinguishable from a body that ended normally
    unless the declared length is compared. Chunked bodies do raise, and are
    caught in ``_read_body``; this covers the length-delimited ones.
    """
    expected = _declared_length(response)
    if expected is None or received >= expected:
        return None
    return f"body stopped after {received} of {expected} declared bytes"


def _read_body(response: Any, deadline: float) -> tuple[bytes, bool, Optional[str]]:
    """Read at most ``SITE_READ_LIMIT`` bytes as ``(body, truncated, incomplete)``.

    ``truncated`` is set only when the body is a genuine prefix of a longer
    page: one byte past the limit was actually there, or the response declared
    more than was read. ``incomplete`` is an error summary set when the read
    stopped before a normal end of stream - a dropped connection, a short read
    or the deadline - so part of the body is missing for a reason other than
    its size.
    """
    body = bytearray()
    while len(body) < SITE_READ_LIMIT:
        if time.monotonic() >= deadline:
            return bytes(body), False, f"no complete body within {SITE_TIMEOUT}s"
        try:
            chunk = response.read(min(64 * 1024, SITE_READ_LIMIT - len(body)))
        except http.client.IncompleteRead as e:
            # ``partial`` holds the bytes that did arrive before the stream died.
            body += e.partial
            return bytes(body)[:SITE_READ_LIMIT], False, (
                f"IncompleteRead: stream ended after {len(e.partial)} more bytes"
            )
        except OSError as e:
            return bytes(body), False, f"{type(e).__name__}: {e}"
        if not chunk:
            return bytes(body), False, _short_body(response, len(body))
        body += chunk
    # The limit was reached. A declared length says whether more is coming
    # without another read, which could otherwise wait out the whole timeout on
    # a server that trickles the rest of a huge page.
    expected = _declared_length(response)
    if expected is not None:
        return bytes(body), len(body) < expected, None
    # No declared length: ask for one byte more, so a body ending exactly at
    # the limit is not reported as cut off.
    try:
        more = response.read(1)
    except (http.client.IncompleteRead, OSError):
        more = b""
    return bytes(body), bool(more), None


def _request_headers() -> dict[str, str]:
    return {
        "User-Agent": SITE_USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate",
    }


def _fetch_through(proxy_url: str, url: str) -> _Page:
    """GET ``url`` through ``proxy_url``, following http(s) hops by hand."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _ThroughProxy(proxy_url), _HttpRedirectsOnly()
    )
    deadline = time.monotonic() + SITE_TIMEOUT
    redirects: list[str] = []
    request = urllib.request.Request(url, headers=_request_headers())
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"no answer within {SITE_TIMEOUT}s")
        try:
            response = opener.open(request, timeout=remaining)
        except urllib.error.HTTPError as e:
            # 4xx/5xx and, because the redirect handler never follows, 3xx too.
            response = e
        with response:
            status = response.getcode()
            final_url = response.geturl()
            headers = response.headers
            raw, read_truncated, read_error = _read_body(response, deadline)
            location = headers.get("Location") or headers.get("URI")

        if status in SITE_REDIRECT_STATUSES and location:
            # Resolve the target against the URL that answered; a relative
            # Location is legal and common, so ``urljoin`` is not optional.
            target = urljoin(final_url, location)
            if urlsplit(target).scheme not in ("http", "https"):
                # Zero redirects were followed; ``final_url`` is the hop that
                # issued the redirect and ``stopped_at`` is where it pointed.
                return _Page(status=status, url=final_url, body=b"", redirects=redirects,
                             stopped_at=target)
            if len(redirects) >= SITE_MAX_REDIRECTS:
                # The chain is longer than the limit; stop rather than chase a
                # loop for the whole timeout. Nothing further is read.
                return _Page(status=status, url=final_url, body=b"", redirects=redirects,
                             redirect_limit=True)
            redirects.append(final_url)
            request = urllib.request.Request(target, headers=_request_headers())
            continue

        codings = _codings(headers)
        body, decode_truncated, decode_error = _decode_body(
            raw, codings, SITE_READ_LIMIT,
            raw_complete=not (read_truncated or read_error),
            raw_truncated=read_truncated,
        )
        return _Page(
            status=status,
            url=final_url,
            body=body,
            redirects=redirects,
            truncated=read_truncated or decode_truncated,
            # A body that did not arrive whole cannot be cleared by a keyword
            # miss; that is the difference between "no marker found" and "the
            # rest was never read".
            incomplete=read_error,
            content_encoding=", ".join(codings) if codings else None,
            decode_error=decode_error,
        )


def _block_reason(page: _Page) -> Optional[tuple[str, str, str]]:
    """Why the page looks refused, as ``(kind, evidence, reason)``.

    ``kind`` separates the two families of interception: ``"status"`` for a
    refusal status, ``"page"`` for a page whose text carries a challenge
    marker. ``evidence`` names the status code or the marker that matched, so
    the verdict can be checked against the response instead of taken on trust.
    ``None`` means neither family matched.
    """
    if page.status in BLOCK_STATUSES:
        return ("status", f"status:{page.status}",
                f"HTTP {page.status} ({BLOCK_STATUSES[page.status]})")
    if page.decode_error is not None:
        # Compressed bytes that could not be undone are not text: a keyword
        # match in them would be coincidence, so no page verdict is given.
        # decode_error on the result says the scan did not happen.
        return None
    if 200 <= page.status < 300 and (page.truncated or len(page.body) > BLOCK_PAGE_MAX):
        # Challenge pages are small, whatever the status: a real page that
        # merely embeds a captcha widget or mentions "access denied" is not a
        # refusal, and a page cut off at the read limit is large by definition.
        # ``incomplete`` says separately that the body never finished arriving;
        # that is not a block verdict either.
        return None
    text = page.body.decode("utf-8", "replace").lower()
    for marker, label in BLOCK_MARKERS:
        if marker in text:
            return "page", f"marker:{marker}", label
    return None


@server.tool(annotations=READ_ONLY)
def test_proxy_on_site(
    url: str,
    country: Optional[str] = None,
    region: Optional[str] = None,
    city: Optional[str] = None,
    isp: Optional[str] = None,
    session_id: Optional[str] = None,
    ttl: Optional[str] = None,
    filter: Optional[str] = None,
    connection_type: Literal["residential", "mobile"] = "residential",
) -> dict[str, Any]:
    """Request one page of a site through the proxy and say whether it answered.

    Sends one GET, follows at most 10 http or https redirects, and reads at most
    2 MB after decompressing gzip or deflate. Returns the status, the final URL,
    the redirect count (hops followed, not redirects seen), the decoded size and
    the time. A refusal is reported in ``blocked`` with ``blocked_by`` ("status"
    or "page") and ``evidence`` (the status code or the marker that matched),
    so the verdict can be checked rather than taken on trust. A redirect to
    anything but http or https is not followed: the probe stops there,
    ``stopped_at`` says where it pointed, ``final_url`` is the URL that issued
    it, and the result is not ok, because the proxy cannot carry that target.
    The same goes for a chain longer than the limit, which sets
    ``redirect_limit``. When ``decode_error`` is set the body could not be
    decompressed and no keyword verdict was attempted. The page itself is not
    returned. A plain HTTP request is a weaker test than a browser: a site that
    needs JavaScript can refuse it and still serve the same proxy in a browser.
    For mobile, take the location codes from list_locations with
    connection_type="mobile".
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ToolError("url must be an http or https address, e.g. https://example.com")
    try:
        proxy = _build_proxy(
            "http",
            connection_type,
            country=country,
            region=region,
            city=city,
            isp=isp,
            sid=session_id,
            ttl=ttl,
            filter=filter,
        )
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    started = time.monotonic()
    proxy_url = ""
    try:
        proxy_url = proxy.url()
        page = _fetch_through(proxy_url, url)
    except (OSError, ValueError, http.client.HTTPException) as e:
        message = f"{type(e).__name__}: {e}"
        # The proxy URL in hand is the reliable source of the secret; the
        # account credentials may be unreadable here (no API key, API down),
        # and the error must still come back as a result, not a second failure.
        candidates = [_proxy_password(proxy_url) or ""]
        try:
            candidates.append(state.credentials()[1])
        except NodeMavenError:
            pass
        message = _redact(message, tuple(candidates))
        return {"ok": False, "error": message,
                "seconds": round(time.monotonic() - started, 3)}
    verdict = _block_reason(page)
    out: dict[str, Any] = {
        "ok": (verdict is None and not page.stopped_at and not page.redirect_limit
               and not page.decode_error and page.incomplete is None
               and 200 <= page.status < 400),
        "status": page.status,
        "final_url": page.url,
        "redirects": page.redirects,
        "redirect_count": len(page.redirects),
        "bytes": len(page.body),
        "seconds": round(time.monotonic() - started, 3),
        "blocked": verdict[2] if verdict else None,
        "blocked_by": verdict[0] if verdict else None,
        "evidence": verdict[1] if verdict else None,
        "truncated": page.truncated,
    }
    if page.content_encoding:
        out["content_encoding"] = page.content_encoding
    if page.decode_error:
        out["decode_error"] = page.decode_error
    if page.incomplete:
        out["incomplete"] = page.incomplete
    if page.stopped_at is not None:
        out["stopped_at"] = page.stopped_at
        out["evidence"] = f"status:{page.status}"
    elif page.redirect_limit:
        out["evidence"] = f"redirect_count:{len(page.redirects)}"
    return out


@server.tool(annotations=READ_ONLY)
def list_locations(
    kind: Literal["countries", "regions", "cities", "isps"],
    country_code: Optional[str] = None,
    region_code: Optional[str] = None,
    connection_type: Literal["residential", "mobile"] = "residential",
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """List locations available for targeting, with the codes proxy_url takes.

    regions need country_code; cities and isps can be narrowed by country_code
    and region_code. At most 100 rows per call: when next_offset is returned,
    call again with offset=next_offset for the rest.
    """
    limit = max(1, min(limit, MAX_ROWS))
    offset = max(0, offset)
    filters = _params(
        country__code=country_code.lower() if country_code else None,
        region__code=region_code,
        connection_type=connection_type,
        limit=limit,
        offset=offset,
    )
    try:
        page = getattr(state.client(), kind)(**filters)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    rows = list(page.results)[:limit]
    out: dict[str, Any] = {"kind": kind, "offset": offset, "rows": rows}
    if page.count is not None:
        out["total"] = page.count
    more = offset + len(rows) < page.count if page.count is not None else len(rows) == limit
    if more:
        out["next_offset"] = offset + len(rows)
    return out


@server.tool(annotations=READ_ONLY)
def account_status() -> dict[str, Any]:
    """Remaining traffic (bytes), subscription status and whether traffic is frozen."""
    try:
        out = _pick(state.client().me(), ACCOUNT_FIELDS)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    if isinstance(out.get("data"), (int, float)) and out["data"] <= 0:
        out["note"] = f"No traffic left. Top up in the NodeMaven dashboard; {PROMO}."
    return out


def _domain_row(row: Any) -> Optional[dict[str, Any]]:
    # Rows arrive as [domain, requests, bytes]; the API documents the same fields
    # as an object (domain_name, requests, data), which is accepted too.
    if isinstance(row, (list, tuple)) and len(row) == 3:
        domain, requests, data = row
    elif isinstance(row, dict):
        domain, requests, data = row.get("domain_name"), row.get("requests"), row.get("data")
    else:
        return None
    return {"domain": domain, "requests": requests, "bytes": data}


def _stats_filters(period: Optional[str], start: Optional[str], end: Optional[str]) -> dict[str, str]:
    if not (period or start or end):
        period = "today"
    return _params(period=period, start=start, end=end)


@server.tool(annotations=READ_ONLY)
def traffic_stats(
    period: Optional[Literal["today", "hours24"]] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> dict[str, Any]:
    """Traffic used over time, as parallel labels and data arrays.

    Pass period, or start and end as dd-mm-yyyy (not ISO). Defaults to today.
    """
    try:
        login = state.credentials()[0]
        stats = state.client().statistics_data(login, **_stats_filters(period, start, end))
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return {"labels": stats.get("labels", []), "data": stats.get("data", [])}


@server.tool(annotations=READ_ONLY)
def top_domains(
    period: Optional[Literal["today", "hours24"]] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Domains reached through the proxy, largest traffic first, with bytes and request counts.

    Pass period, or start and end as dd-mm-yyyy (not ISO). Defaults to today.
    """
    try:
        login = state.credentials()[0]
        page = state.client().domain_statistics(
            login, limit=DOMAIN_FETCH_LIMIT, **_stats_filters(period, start, end)
        )
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    rows = [r for r in map(_domain_row, page.results) if r is not None]
    rows.sort(key=lambda r: r["bytes"] if isinstance(r["bytes"], (int, float)) else -1, reverse=True)
    return {"rows": rows[: max(1, min(limit, MAX_ROWS))]}


@server.tool(annotations=READ_ONLY)
def list_sub_users(page: int = 1) -> dict[str, Any]:
    """Sub-users of the account with their traffic usage and limits. No passwords.

    Paged from page 1. When next_page is returned, call again with it for the
    rest; a page past the end comes back empty.
    """
    page = max(1, page)
    try:
        result = state.client().sub_users(page=page)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    rows = [_pick(row, SUB_USER_FIELDS) for row in result.results]
    out: dict[str, Any] = {"page": page, "rows": rows}
    if rows:
        out["next_page"] = page + 1
    return out


@server.tool(annotations=WRITE)
def create_sub_user(
    username: str,
    traffic_limit: Optional[int] = None,
) -> dict[str, Any]:
    """Create a sub-user with its own proxy login. Changes the account.

    The password is generated here. It is returned only if the server allows
    revealing passwords; otherwise the user reads it in the dashboard.
    traffic_limit is in the same unit list_sub_users shows for traffic_limit and
    used_traffic; leave it out for no limit.
    """
    _require_write()
    password = secrets.token_hex(16)
    limits: dict[str, Any] = {}
    if traffic_limit is not None:
        limits = {"traffic_limit": traffic_limit, "is_traffic_limited": True}
    try:
        created = state.client().create_sub_user(username, password, **limits)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    out = _pick(created, SUB_USER_FIELDS)
    out["password"] = password if _reveal_password() else PASSWORD_PLACEHOLDER
    return out


@server.tool(annotations=WRITE)
def update_sub_user(
    sub_user_id: str,
    traffic_limit: Optional[int] = None,
    is_traffic_limited: Optional[bool] = None,
) -> dict[str, Any]:
    """Change a sub-user's traffic limit, or turn the limit on or off. Changes the account."""
    _require_write()
    changes: dict[str, Any] = {}
    if is_traffic_limited is not None:
        changes["is_traffic_limited"] = is_traffic_limited
    if traffic_limit is not None:
        changes["traffic_limit"] = traffic_limit
    if not changes:
        raise ToolError("Nothing to change: pass traffic_limit or is_traffic_limited.")
    try:
        updated = state.client().update_sub_user(sub_user_id, **changes)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return _pick(updated, SUB_USER_FIELDS)


@server.tool(annotations=DESTRUCTIVE)
def reset_sub_user_usage(sub_user_ids: list[str]) -> dict[str, Any]:
    """Set the recorded traffic of one or more sub-users back to zero. Changes the account."""
    _require_write()
    if not sub_user_ids:
        raise ToolError("Pass at least one sub-user id.")
    try:
        rows = state.client().reset_sub_user_usage(sub_user_ids)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    rows = rows if isinstance(rows, list) else [rows]
    return {"rows": [_pick(row, SUB_USER_FIELDS) for row in rows]}


@server.tool(annotations=DESTRUCTIVE)
def delete_sub_user(sub_user_id: str) -> dict[str, Any]:
    """Delete a sub-user. Its proxy login stops working. Cannot be undone."""
    _require_write()
    try:
        state.client().delete_sub_user(sub_user_id)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return {"deleted": sub_user_id}


@server.tool(annotations=READ_ONLY)
def list_whitelist_ips(page: int = 1) -> dict[str, Any]:
    """IP addresses allowed to use the proxy without a password, with their ports and targeting.

    Paged from page 1. When next_page is returned, call again with it for the rest.
    """
    page = max(1, page)
    try:
        result = state.client().whitelist_ips(page=page)
    except NotFoundError:
        if page == 1:
            raise ToolError("The whitelist endpoint answered 404.") from None
        return {"page": page, "rows": []}
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    rows = [_pick(row, WHITELIST_FIELDS) for row in result.results]
    out: dict[str, Any] = {"page": page, "rows": rows}
    if rows:
        out["next_page"] = page + 1
    return out


@server.tool(annotations=WRITE)
def add_whitelist_ip(
    ip: str,
    ports_count: int,
    protocol: Literal["HTTP", "SOCKS5"] = "HTTP",
    name: Optional[str] = None,
    country: Optional[str] = None,
    region: Optional[str] = None,
    city: Optional[str] = None,
    isp: Optional[str] = None,
) -> dict[str, Any]:
    """Allow an IP address to use the proxy without a password. Changes the account.

    ports_count is how many proxy ports the address gets. country, region, city
    and isp take the codes from list_locations. An address removed in the last
    hour can be refused as already whitelisted for a while.
    """
    _require_write()
    targeting = _params(country=country, region=region, city=city, isp=isp)
    try:
        added = state.client().upsert_whitelist_ip(
            ip, ports_count, name=name, protocol=protocol, **targeting
        )
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return {"ip_id": added.get("ip_id"), "ip": ip, "message": added.get("message")}


@server.tool(annotations=DESTRUCTIVE)
def remove_whitelist_ip(ip_id: str) -> dict[str, Any]:
    """Remove an address from the whitelist, by the id list_whitelist_ips or add_whitelist_ip gave."""
    _require_write()
    try:
        state.client().delete_whitelist_ip(ip_id)
    except NodeMavenError as e:
        raise ToolError(str(e)) from e
    return {"removed": ip_id}


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
