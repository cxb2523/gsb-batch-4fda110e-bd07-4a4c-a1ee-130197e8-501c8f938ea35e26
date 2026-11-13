"""Proxy connectivity testing and list parsing.

Tests a proxy by fetching an IP-echo service through it and reporting the exit IP,
country and latency. Used before assigning a proxy so you never launch a profile
on a dead or mislocated proxy. Also parses pasted proxy lists (several common
formats) into `Proxy` objects for the per-profile pool used by random/rotate modes.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx

from .models import Proxy

# IP-echo endpoint that also returns geo info.
_ECHO_URL = "https://ipinfo.io/json"
_TIMEOUT = 15.0


def parse_line(line: str, default_type: str = "http") -> Proxy | None:
    """Parse one proxy line into a Proxy, or None if it isn't a proxy.

    Accepts the common formats (blank lines and `#` comments are ignored):
      host:port
      protocol://host:port
      host:port:user:pass
      protocol://user:pass@host:port
      protocol://host:port:user:pass
    Protocols map to what the launcher supports: http / https / socks5 (any
    `socks*` scheme becomes socks5).
    """
    line = line.strip()
    if not line or line.startswith("#"):
        return None

    ptype = default_type
    rest = line
    if "://" in line:
        scheme, rest = line.split("://", 1)
        scheme = scheme.lower()
        if scheme in ("http", "https"):
            ptype = scheme
        elif scheme.startswith("socks"):
            ptype = "socks5"
        else:
            return None

    user = pw = ""
    # Legacy host:port:user:pass; preserve colons in passwords.
    if "@" not in rest and not rest.startswith("["):
        parts = rest.split(":", 3)
        if len(parts) == 4:
            rest = ":".join(parts[:2])
            user, pw = parts[2:]
    try:
        parsed = urlsplit(f"{ptype}://{rest}")
        host, port = parsed.hostname, parsed.port
        if not host or not port or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            return None
        if any(c.isspace() for c in host):
            return None
        if parsed.username is not None:
            user = unquote(parsed.username)
            pw = unquote(parsed.password or "")
        return Proxy(type=ptype, host=host, port=port, username=user, password=pw)
    except ValueError:
        return None


def parse_list(text: str, default_type: str = "http") -> list[Proxy]:
    """Parse a multi-line proxy list into Proxy objects, skipping bad lines."""
    out: list[Proxy] = []
    for raw in (text or "").splitlines():
        px = parse_line(raw, default_type)
        if px is not None:
            out.append(px)
    return out


async def test(proxy: Proxy, timeout: float = _TIMEOUT) -> dict[str, Any]:
    if not proxy.is_set:
        return {"ok": False, "error": "Proxy host/port not set"}

    # Build an authenticated proxy URL for httpx.
    scheme, address = proxy.server_url().split("://", 1)
    auth = f"{quote(proxy.username, safe='')}:{quote(proxy.password, safe='')}@" if proxy.username else ""
    proxy_url = f"{scheme}://{auth}{address}"

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(proxy=proxy_url, timeout=timeout) as client:
            resp = await client.get(_ECHO_URL)
            resp.raise_for_status()
            info = resp.json()
        latency_ms = round((time.perf_counter() - start) * 1000)
        return {
            "ok": True,
            "ip": info.get("ip"),
            "country": info.get("country"),
            "region": info.get("region"),
            "city": info.get("city"),
            "org": info.get("org"),
            "latency_ms": latency_ms,
        }
    except Exception as exc:  # noqa: BLE001 - report any failure to the UI
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# Public, free proxy lists (plain `host:port` per line) by protocol. These are
# community-maintained and best-effort — most free proxies are slow or dead, so the
# UI pairs "Fetch free" with "Test all" to keep only the ones that actually work.
_FREE_SOURCES = {
    "http": [
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
        "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000",
    ],
    "socks5": [
        "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
        "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000",
    ],
}
_HOSTPORT_RE = re.compile(r"^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$")


async def fetch_free(protocol: str = "http", limit: int = 100) -> list[str]:
    """Fetch a de-duplicated pool of free `host:port` proxies from public sources.

    `protocol` is "http" (also used for https) or "socks5". Returns plain
    `host:port` lines (no protocol prefix) — the caller labels them with the chosen
    type. Best-effort: sources that fail or time out are skipped; the rest are merged.
    """
    key = "socks5" if str(protocol).startswith("socks") else "http"
    seen: set[str] = set()
    out: list[str] = []

    async def _grab(client: httpx.AsyncClient, url: str) -> list[str]:
        try:
            r = await client.get(url)
            r.raise_for_status()
            return r.text.splitlines()
        except Exception:  # noqa: BLE001 - a dead source shouldn't fail the whole fetch
            return []

    async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
        results = await asyncio.gather(*(_grab(client, u) for u in _FREE_SOURCES[key]))

    for lines in results:
        for raw in lines:
            m = _HOSTPORT_RE.match(raw.strip())
            if not m:
                continue
            hp = m.group(0)
            if hp in seen:
                continue
            seen.add(hp)
            out.append(hp)
            if len(out) >= limit:
                return out
    return out


async def test_many(
    proxies: list[Proxy], concurrency: int = 24, timeout: float = 8.0,
    deadline: float | None = None,
) -> list[dict[str, Any]]:
    """Test a whole pool concurrently, preserving input order in the results.

    Each result carries the proxy's server URL and index so the UI can line the
    verdicts up against the pasted list (like chameleon's verification pass). A short
    per-proxy `timeout` and high `concurrency` keep big free-proxy lists (mostly dead)
    from taking minutes — the whole sweep stays within a handful of `timeout` windows.

    `deadline` is an optional whole-batch time limit in seconds. Without it the
    previous behaviour is unchanged (wait for every proxy). With it, proxies that
    have not finished when the deadline expires are cancelled and come back as
    `{"ok": False, "unfinished": True, "error": "deadline exceeded"}` entries, so a
    caller can report them separately from proxies that actually failed.
    """
    sem = asyncio.Semaphore(max(1, concurrency))
    results: dict[int, dict[str, Any]] = {}

    async def _one(idx: int, px: Proxy) -> None:
        async with sem:
            res = await test(px, timeout=timeout)
        res["index"] = idx
        res["server"] = f"{px.type}://{px.host}:{px.port}"
        results[idx] = res

    if not proxies:
        return []
    tasks = [asyncio.create_task(_one(i, p)) for i, p in enumerate(proxies)]
    if deadline is not None:
        _, pending = await asyncio.wait(tasks, timeout=deadline)
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
    else:
        await asyncio.gather(*tasks)

    out: list[dict[str, Any]] = []
    for i, px in enumerate(proxies):
        res = results.get(i)
        if res is None:
            # Only reachable when a deadline expired; test() never raises.
            res = {
                "ok": False,
                "unfinished": True,
                "error": "deadline exceeded",
                "index": i,
                "server": f"{px.type}://{px.host}:{px.port}",
            }
        out.append(res)
    return out


# ------------------------------------------------------------------ harvest ---

async def _fetch_source_text(url: str, timeout: float) -> str:
    """Fetch one free-proxy source and return its body text.

    Kept as a module-level function so tests can replace it and prove the harvest
    pipeline never touches the network.
    """
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp.text


def _failure_status(exc: BaseException) -> int | None:
    """Extract an HTTP status code from an httpx error, when there is one."""
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None) if response is not None else None


async def harvest(
    protocol: str = "http",
    expected: int = 100,
    verify: bool = True,
    total_timeout: float = 30.0,
    *,
    sources: list[str] | None = None,
    source_timeout: float = 12.0,
) -> dict[str, Any]:
    """Fetch, de-duplicate and (optionally) verify free proxies in three stages.

    Unlike `fetch_free`, each source is timed and reported on its own: one dead or
    slow source no longer hides which source the other entries came from. The first
    occurrence of a `host:port` wins and records its origin source. After de-duping,
    the pool is capped at `expected` entries and truncation is reported.

    When `verify` is true, the kept entries go through `test_many` with a single
    whole-batch `total_timeout`. Entries still running when that deadline expires are
    cancelled and reported as `unfinished` — they are never counted as usable and
    cannot make the request hang indefinitely.

    Returns source details, de-duplication counts, truncation status and the three
    verification buckets (`available`, `unfinished`, `unavailable`) with a failure
    reason summary. The raw `entries` list is always present so an operator can
    choose from untested entries when `verify` is false.
    """
    key = "socks5" if str(protocol).startswith("socks") else "http"
    ptype = key
    urls = list(sources) if sources is not None else list(_FREE_SOURCES[key])
    expected = max(1, int(expected))
    fetch_source = _fetch_source_text  # looked up at call time so tests can patch it

    # --- stage 1: fetch, each source timed and recorded independently ----------
    async def _grab(url: str) -> list[str]:
        start = time.perf_counter()
        detail: dict[str, Any] = {"url": url, "ok": False, "status": None, "error": None,
                                  "lines": 0, "deduped": 0, "kept": 0}
        try:
            text = await fetch_source(url, source_timeout)
        except Exception as exc:  # noqa: BLE001 - one bad source must not stop the rest
            detail["status"] = _failure_status(exc)
            detail["error"] = f"{type(exc).__name__}: {exc}"
            detail["elapsed_ms"] = round((time.perf_counter() - start) * 1000)
            return detail, []
        detail["ok"] = True
        hostports: list[str] = []
        for raw in (text or "").splitlines():
            m = _HOSTPORT_RE.match(raw.strip())
            if not m:
                continue
            # Same numeric check the parser applies, so an over-range or zero port
            # can't reach the verifier as an unset Proxy.
            if not 1 <= int(m.group(2)) <= 65535:
                continue
            hostports.append(m.group(0))
        detail["lines"] = len(hostports)
        detail["elapsed_ms"] = round((time.perf_counter() - start) * 1000)
        return detail, hostports

    fetched = await asyncio.gather(*(_grab(u) for u in urls))

    # --- stage 2: keep the first occurrence of each host:port ------------------
    seen: set[str] = set()
    entries: list[dict[str, Any]] = []
    raw_total = 0
    deduped = 0
    for detail, hostports in fetched:
        raw_total += len(hostports)
        for hp in hostports:
            if hp in seen:
                continue
            seen.add(hp)
            deduped += 1
            detail["deduped"] += 1
            if len(entries) >= expected:
                continue
            host, port = hp.rsplit(":", 1)
            entries.append({"hostport": hp, "host": host, "port": int(port),
                            "source": detail["url"]})
            detail["kept"] += 1

    truncated = deduped > len(entries)
    proxies = [Proxy(type=ptype, host=e["host"], port=e["port"]) for e in entries]

    result: dict[str, Any] = {
        "protocol": ptype,
        "expected": expected,
        "verify": bool(verify),
        "fetched": raw_total,
        "deduped": deduped,
        "kept": len(entries),
        "truncated": truncated,
        "truncated_count": deduped - len(entries),
        "source_failures": sum(1 for d in fetched if not d[0]["ok"]),
        "sources": [d for d, _ in fetched],
        # De-duplicated entries with their origin source, in first-seen order.
        "entries": [{"server": f"{ptype}://{e['hostport']}", "host": e["host"],
                     "port": e["port"], "source": e["source"]} for e in entries],
    }

    # --- stage 3: verify the kept entries under one batch deadline -------------
    if not verify:
        result.update({
            "available": [],
            "unfinished": [],
            "unavailable": [],
            "error_summary": [],
            # No verdicts were produced; expose the candidates explicitly (still with
            # their source) so they are never mistaken for proxies that passed a
            # live check.
            "untested": [{"server": f"{ptype}://{e['hostport']}", "host": e["host"],
                          "port": e["port"], "source": e["source"]} for e in entries],
            "counts": {"kept": len(entries), "available": 0, "unfinished": 0, "unavailable": 0},
        })
        return result

    per_proxy_timeout = max(0.5, min(8.0, float(total_timeout)))
    verdicts = await test_many(
        proxies, concurrency=120, timeout=per_proxy_timeout, deadline=float(total_timeout)
    )

    available: list[dict[str, Any]] = []
    unfinished: list[dict[str, Any]] = []
    unavailable: list[dict[str, Any]] = []
    for entry, verdict in zip(entries, verdicts):
        base = {
            "server": f"{ptype}://{entry['hostport']}",
            "host": entry["host"],
            "port": entry["port"],
            "source": entry["source"],
        }
        if verdict.get("unfinished"):
            unfinished.append({**base, "reason": verdict.get("error") or "deadline exceeded"})
        elif verdict.get("ok"):
            available.append({**base, **{
                k: verdict.get(k) for k in ("ip", "country", "region", "city", "org", "latency_ms")
            }})
        else:
            unavailable.append({**base, "error": verdict.get("error") or "test failed"})

    reason_counts: dict[str, int] = {}
    for item in unavailable:
        err = item["error"]
        reason = err.split(":", 1)[0].strip() or err
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
    error_summary = [{"reason": r, "count": n} for r, n in sorted(reason_counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    result.update({
        "available": available,
        "unfinished": unfinished,
        "unavailable": unavailable,
        "error_summary": error_summary,
        "untested": [],
        "counts": {
            "kept": len(entries),
            "available": len(available),
            "unfinished": len(unfinished),
            "unavailable": len(unavailable),
        },
    })
    return result
