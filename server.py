#!/usr/bin/env python3
"""0xStudy Agentic 钱包简易 — BSC 资产 / 一键卖出 / 发送 / 记录.

Runs on 127.0.0.1:8100 behind Caddy. It shells out to the Binance Agentic
Wallet CLI (baw) using each wallet's own BINANCE_BAW_DIR. No key material is
stored or returned here.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal, ROUND_DOWN, localcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
HOME = Path(os.path.expanduser("~"))
BAW = os.environ.get("BAW_BIN") or shutil.which("baw") or str(HOME / "agent" / "npm-global" / "bin" / "baw")
PATH = f"{HOME}/agent/node/bin:{HOME}/agent/npm-global/bin:" + os.environ.get("PATH", "")
PORT = 8100
CHAIN = "56"
NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
USDT = "0x55d398326f99059ff775485246999027b3197955"
USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"
MARKET_STALE_SECONDS = 120
WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"
BSC_RPCS = [
    "https://bsc-dataseed.binance.org/",
    "https://bsc-rpc.publicnode.com",
    "https://bsc-dataseed1.defibit.io/",
    "https://1rpc.io/bnb",
]
DEX_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/"
HONEYPOT = "https://api.honeypot.is/v2/IsHoneypot"

DEFAULT_WALLETS: list[dict[str, Any]] = []
COLORS = ["#d4654a", "#4f6f9f", "#7c6a9f", "#2f8f7a", "#b07a12", "#a35476", "#3f6294"]
WALLETS: list[dict[str, Any]] = []
WALLET_BY_ID: dict[str, dict[str, Any]] = {}
CONFIG_PATH = DATA / "wallets.json"
TASKS_PATH = DATA / "tasks.json"
_config_lock = threading.RLock()
_next_slot = 7

_cache_lock = threading.RLock()
_balance_refresh_lock = threading.Lock()
_balance_cache: dict[str, Any] = {"ts": 0.0, "wallets": {}}
_market_cache: dict[str, Any] = {"ts": 0.0, "data": {}}
BALANCE_PATH = DATA / "balance-cache.json"
MARKET_PATH = DATA / "market-cache.json"
_audit_cache: dict[str, dict[str, Any]] = {}
_decimals_cache: dict[str, int] = {}
# Per-wallet history state.  A record keeps the last successful page *and*
# the outcome of the most recent attempt, so a failed refresh can keep serving
# old rows without pretending they are fresh.
_history_cache: dict[str, dict[str, Any]] = {}
HISTORY_DIR = DATA / "history"
HISTORY_DIR.mkdir(exist_ok=True)
HISTORY_FRESH_SECONDS = 60
HISTORY_RETRY_SECONDS = 8
HISTORY_WAIT_SECONDS = 90
# ``wallet -> Event`` for an in-flight refresh.  Concurrent callers join the
# same event instead of starting a second BAW request.
_history_inflight: dict[str, threading.Event] = {}
_history_refresh_lock = threading.Lock()
_task_lock = threading.RLock()
_tasks: dict[str, dict[str, Any]] = {}
_keepalive: dict[str, Any] = {"wallets": {}, "at": None}
_wallet_locks: dict[str, threading.Lock] = {}
_audit_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="audit")
_baw_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="baw")
_pending_wallets: dict[str, dict[str, Any]] = {}
_relogin_pending: set[str] = set()
_last_dex_error: str | None = None

RISK_CONFIRM_RE = re.compile(
    r"(confirm|verification|risk control|2fa|authenticator|binance app|"
    r"风控|确认|验证|审核|待确认)",
    re.I,
)
RISK_BLOCK_RE = re.compile(r"(locked|tx-lock|交易锁|trading disabled|暂停交易)", re.I)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


def now_iso_ms() -> str:
    """ISO timestamp with millisecond precision (used for fetch attempts).

    A successful fetch and the failed retry that follows can happen inside the
    same wall-clock second; second precision would make them indistinguishable.
    ``+08:00``-style offsets keep ``Date.parse`` happy in browsers.
    """
    local = time.localtime()
    ms = int(time.time() * 1000) % 1000
    return time.strftime("%Y-%m-%dT%H:%M:%S", local) + f".{ms:03d}" + time.strftime("%z", local)[:3] + ":" + time.strftime("%z", local)[3:]


def _apply_wallets(items: list[dict[str, Any]]) -> None:
    global WALLETS, WALLET_BY_ID, _wallet_locks
    clean: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        wid = str(item.get("id") or "").strip()
        if not re.fullmatch(r"w\d+", wid) or wid in seen:
            continue
        seen.add(wid)
        clean.append({
            "id": wid,
            "label": str(item.get("label") or wid)[:30],
            "agent": str(item.get("agent") or item.get("label") or wid)[:50],
            "address": str(item.get("address") or ""),
            "color": str(item.get("color") or COLORS[len(clean) % len(COLORS)]),
            "trade": item.get("trade", True) is not False,
        })
    WALLETS = clean
    WALLET_BY_ID = {w["id"]: w for w in clean}
    for w in clean:
        _wallet_locks.setdefault(w["id"], threading.Lock())


def save_wallet_config() -> None:
    with _config_lock:
        payload = {"nextSlot": _next_slot, "wallets": WALLETS}
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CONFIG_PATH)


def load_wallet_config() -> None:
    global _next_slot
    with _config_lock:
        if CONFIG_PATH.exists():
            try:
                payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                items = payload.get("wallets")
                _next_slot = max(7, int(payload.get("nextSlot") or 7))
                if isinstance(items, list):
                    _apply_wallets(items)
                    return
            except Exception:
                pass
        _next_slot = 7
        _apply_wallets([dict(w) for w in DEFAULT_WALLETS])
        save_wallet_config()


def qr_svg(data: str) -> str:
    if not data:
        return ""
    try:
        import segno  # type: ignore
        qr = segno.make(data, error="m")
        buf = io.BytesIO()
        qr.save(buf, kind="svg", scale=6, border=2)
        svg = buf.getvalue().decode("utf-8", "replace")
        pos = svg.find("<svg")
        return svg[pos:] if pos >= 0 else svg
    except Exception:
        return ""


def set_keepalive_status(wallet: str, status: str, error: str | None = None) -> None:
    with _cache_lock:
        current = _keepalive.setdefault("wallets", {})
        current[wallet] = {"at": now_iso(), "status": status, "error": error}
        _keepalive["at"] = now_iso()
    save_keepalive()


def wallet_address(slot: str) -> str:
    r = baw(slot, ["wallet", "address", "--json"], timeout=45)
    if not r.get("success"):
        code = str(((r.get("error") or {}).get("name") or "") if isinstance(r.get("error"), dict) else "")
        set_keepalive_status(slot, "UNCONNECTED" if code == "NOT_LOGGED_IN" else "UNKNOWN", err_text(r))
        return ""
    for item in ((r.get("data") or {}).get("addresses") or []):
        if str(item.get("binanceChainId")) == CHAIN:
            set_keepalive_status(slot, "CONNECTED", None)
            return str(item.get("address") or "")
    set_keepalive_status(slot, "UNKNOWN", "BAW 没有返回 BSC 地址")
    return ""


def wallet_ready_error(wallet: str, check_lock: bool = True) -> str | None:
    """Backend-side permission/session checks shared by sell and send.

    Call this while holding the wallet lock for any actual submission.
    """
    w = WALLET_BY_ID.get(wallet)
    if not w:
        return "wallet not found"
    if w.get("sessionBlocked"):
        return "该钱包会话地址与绑定不一致，请重新登录恢复绑定"
    if wallet in _relogin_pending:
        return "该钱包正在重新登录，请稍后再试"
    if not w.get("trade"):
        return "该钱包未开启交易权限（只读）"
    expected = str(w.get("address") or "")
    actual = wallet_address(wallet)
    if not actual:
        set_keepalive_status(wallet, "UNCONNECTED", "地址读取失败，会话可能已退出")
        return "BAW 会话已退出或地址读取失败，请重新登录"
    if expected and actual.lower() != expected.lower():
        with _config_lock:
            w["sessionBlocked"] = True
            save_wallet_config()
        set_keepalive_status(wallet, "MISMATCH", "会话地址与看板绑定不一致")
        return "BAW 会话地址与看板配置不一致，已阻止操作"
    if check_lock:
        lock = baw(wallet, ["wallet", "tx-lock", "--binanceChainId", CHAIN, "--json"], timeout=30)
        if not lock.get("success"):
            return "无法确认交易锁状态，请稍后重试"
        lock_status = str((lock.get("data") or {}).get("status") or "").upper()
        if lock_status == "LOCKED":
            return "交易锁已开启，请先在币安 App 解锁"
        if lock_status not in ("UNLOCKED", ""):
            return f"交易锁状态未知（{lock_status}），已停止操作"
    return None


def short_addr(a: str | None) -> str:
    if not a:
        return ""
    return a[:6] + "…" + a[-4:]


def to_decimal(v: Any, default: str = "0") -> Decimal:
    try:
        if v is None or v == "":
            return Decimal(default)
        return Decimal(str(v))
    except Exception:
        return Decimal(default)


def json_get(url: str, timeout: int = 20) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "0xstudy-agentic/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def rpc_call(method: str, params: list[Any], timeout: int = 8) -> Any:
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last: Any = None
    for url in BSC_RPCS:
        try:
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json", "User-Agent": "0xstudy-agentic/1.0"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                j = json.loads(r.read().decode("utf-8", "replace"))
            if "result" in j:
                return j["result"]
            last = j
        except Exception as e:  # noqa: BLE001
            last = repr(e)
    raise RuntimeError(f"rpc failed: {last}")


def token_decimals(token: str) -> int:
    token = token.lower()
    if token in (NATIVE, WBNB, USDT, USDC):
        return 18
    with _cache_lock:
        cached = _decimals_cache.get(token)
        if cached is not None:
            return cached
    raw = rpc_call("eth_call", [{"to": token, "data": "0x313ce567"}, "latest"], timeout=8)
    try:
        decimals = int(str(raw), 16)
    except Exception as exc:
        raise ValueError("无法读取代币 decimals，已阻止发送") from exc
    if not (0 <= decimals <= 36):
        raise ValueError("代币 decimals 异常，已阻止发送")
    with _cache_lock:
        _decimals_cache[token] = decimals
    return decimals


def token_base_units(qty: Decimal, decimals: int, truncate: bool = True) -> int:
    # Token balances can carry more decimal places than the token itself
    # (for example 652.9205138214195022412 with 18 decimals).  Percentage
    # sends truncate to exact on-chain units and leave only dust; manual
    # input must be rejected instead of silently changing the user's amount.
    # Use explicit high precision so large values survive the 28-digit
    # default Decimal context.
    with localcontext() as ctx:
        ctx.prec = 80
        scaled = qty * (Decimal(10) ** decimals)
        if not truncate and scaled != scaled.to_integral_value():
            raise ValueError(f"数量小数位超过代币精度（{decimals} 位），请减少小数位")
        units = int(scaled)
    if units <= 0:
        raise ValueError("数量过小")
    return units


def build_transfer_call(token: str, qty: Decimal, recipient: str, truncate: bool = True) -> tuple[str, str, str, int]:
    token = token.lower()
    if token == NATIVE:
        units = token_base_units(qty, 18, truncate=truncate)
        return recipient, str(units), "0x", units
    decimals = token_decimals(token)
    units = token_base_units(qty, decimals, truncate=truncate)
    data = (
        "0xa9059cbb"
        + recipient.lower().removeprefix("0x").rjust(64, "0")
        + format(units, "x").rjust(64, "0")
    )
    return token, "0", data, units


def allocate_units(target_units: int, wallet_units: list[int]) -> list[int]:
    """Split an exact base-unit target proportionally, never over-drawing."""
    total = sum(wallet_units)
    if target_units <= 0 or total <= 0 or target_units > total:
        return []
    shares = [min(w, target_units * w // total) for w in wallet_units]
    remaining = target_units - sum(shares)
    for i, w in enumerate(wallet_units):
        if remaining <= 0:
            break
        extra = min(w - shares[i], remaining)
        shares[i] += extra
        remaining -= extra
    return shares if remaining == 0 else []


def preview_amount_matches(raw: Any, units: int) -> bool:
    """Compare preview amount without losing JS-number precision on huge values."""
    try:
        shown = Decimal(str(raw))
    except Exception:
        return False
    expected = Decimal(units)
    tolerance = max(Decimal(1), abs(expected) * Decimal("0.000000001"))
    return abs(shown - expected) <= tolerance


def contract_send(wallet: str, token: str, qty: Decimal, recipient: str, truncate: bool = True) -> dict[str, Any]:
    address = wallet_address(wallet)
    if not address:
        raise ValueError("无法读取当前 BAW 会话地址")
    expected = str((WALLET_BY_ID.get(wallet) or {}).get("address") or "")
    if expected and address.lower() != expected.lower():
        raise ValueError("提交前 BAW 会话地址与看板绑定不一致，已停止")
    to, value, input_data, units = build_transfer_call(token, qty, recipient, truncate=truncate)
    preview = baw(wallet, [
        "contract-call", "preview",
        "--binanceChainId", CHAIN,
        "--from", address,
        "--to", to,
        "--value", value,
        "--inputData", input_data,
        "--json",
    ], timeout=70)
    if not preview.get("success"):
        return {"ok": False, "needsPhoneConfirm": is_phone_confirm(preview), "error": err_text(preview)}
    pdata = preview.get("data") or {}
    sim = pdata.get("simulationResult") or {}
    sim_code = str(sim.get("simulationCode") or "")
    if sim_code and sim_code not in ("000000000", "0"):
        return {"ok": False, "error": f"合约模拟失败：{sim.get('simulationErrorDetail') or sim_code}"}
    parsed = pdata.get("parsedTx") or {}
    if str(parsed.get("recipient") or "").lower() != recipient.lower():
        return {"ok": False, "error": "合约预览收款地址不一致，已阻止"}
    if token != NATIVE and str(parsed.get("contractAddress") or "").lower() != token:
        return {"ok": False, "error": "合约预览代币地址不一致，已阻止"}
    if not preview_amount_matches(parsed.get("amount"), units):
        return {"ok": False, "error": "合约预览数量不一致，已阻止"}
    request_id = str(pdata.get("requestId") or "")
    if not request_id:
        return {"ok": False, "error": "合约预览没有返回 requestId"}
    execute = baw(wallet, ["contract-call", "execute", "--requestId", request_id, "--json"], timeout=100)
    if not execute.get("success"):
        return {
            "ok": False,
            "needsPhoneConfirm": is_phone_confirm(execute),
            "timeout": is_timeout(execute),
            "error": "执行超时，链上结果待核实；请先查钱包记录，不要重复提交" if is_timeout(execute) else err_text(execute),
        }
    data = execute.get("data") or {}
    if not isinstance(data, dict):
        data = {"result": data}
    data.setdefault("requestId", request_id)
    data.setdefault("method", "contract-call")
    data.setdefault("recipient", recipient)
    data.setdefault("value", value)
    return {"ok": True, "data": data, "requestId": request_id}


def baw(wallet: str, args: list[str], timeout: int = 70) -> dict[str, Any]:
    if wallet not in WALLET_BY_ID and not (HOME / "aw" / wallet).is_dir():
        return {"success": False, "error": "unknown wallet"}
    env = os.environ.copy()
    env["PATH"] = PATH
    env["BINANCE_BAW_DIR"] = str(HOME / "aw" / wallet)
    try:
        p = subprocess.run(
            [BAW, *args],
            capture_output=True,
            timeout=timeout,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return {"success": False, "error": f"baw timeout after {timeout}s"}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": repr(e)}
    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    start = out.find("{")
    if start < 0:
        return {"success": False, "error": (err or out or f"baw rc={p.returncode}")[:700]}
    try:
        data = json.loads(out[start:])
    except Exception:
        return {"success": False, "error": (out[start:] or err)[:700]}
    if not isinstance(data, dict):
        return {"success": False, "error": "invalid baw response"}
    if not data.get("success") and not data.get("error"):
        data["error"] = err[:700] or "unknown baw error"
    return data


def err_text(result: dict[str, Any]) -> str:
    e = result.get("error")
    if isinstance(e, dict):
        return str(e.get("message") or e.get("name") or json.dumps(e, ensure_ascii=False))[:700]
    return str(e or "unknown error")[:700]


def is_phone_confirm(result: dict[str, Any]) -> bool:
    if result.get("success"):
        return False
    text = err_text(result)
    return bool(RISK_CONFIRM_RE.search(text))


def is_locked(result: dict[str, Any]) -> bool:
    if result.get("success"):
        return False
    return bool(RISK_BLOCK_RE.search(err_text(result)))


def is_timeout(result: dict[str, Any]) -> bool:
    return "timeout" in err_text(result).lower()


# ---------------------------------------------------------------- wallets / balances
def wallet_balance(wallet: str) -> dict[str, Any]:
    r = baw(wallet, ["wallet", "balance", "--binanceChainId", CHAIN, "--hideLowValue", "false", "--json"])
    rows = r.get("data") if isinstance(r.get("data"), list) else []
    return {
        "ok": bool(r.get("success")),
        "rows": rows,
        "error": None if r.get("success") else err_text(r),
        "updatedAt": now_iso(),
    }


def load_balance_cache() -> None:
    global _balance_cache
    try:
        data = json.loads(BALANCE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("wallets"), dict):
            data["ts"] = float(data.get("ts") or 0)
            _balance_cache = data
    except Exception:
        pass


def save_balance_cache(data: dict[str, Any]) -> None:
    try:
        tmp = BALANCE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(BALANCE_PATH)
    except Exception:
        pass


def load_market_cache() -> None:
    global _market_cache
    try:
        data = json.loads(MARKET_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            # Preserve the real age. The UI may paint a stale snapshot, but the
            # sell path refuses to submit until a fresh baseline exists.
            _market_cache = data
            _market_cache["ts"] = float(data.get("ts") or 0)
    except Exception:
        pass


def save_market_cache(data: dict[str, Any]) -> None:
    try:
        tmp = MARKET_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(MARKET_PATH)
    except Exception:
        pass


def refresh_balances(force: bool = False) -> dict[str, Any]:
    global _balance_cache
    with _cache_lock:
        if not force and _balance_cache["wallets"] and time.time() - _balance_cache["ts"] < 3.2:
            return _balance_cache
    with _balance_refresh_lock:
        with _cache_lock:
            if not force and _balance_cache["wallets"] and time.time() - _balance_cache["ts"] < 3.2:
                return _balance_cache
            old = _balance_cache
        # Network calls happen outside _cache_lock so the page can always read.
        result: dict[str, Any] = {"ts": time.time(), "wallets": {}}
        futures = { _baw_pool.submit(wallet_balance, w["id"]): w["id"] for w in WALLETS }
        for f in as_completed(futures):
            wid = futures[f]
            try:
                result["wallets"][wid] = f.result()
            except Exception as e:  # noqa: BLE001
                result["wallets"][wid] = {"ok": False, "rows": [], "error": repr(e), "updatedAt": now_iso()}
        # If a wallet failed, preserve its last successful rows for a short grace window.
        for wid, item in result["wallets"].items():
            if not item["ok"] and old.get("wallets", {}).get(wid, {}).get("ok"):
                previous = old["wallets"][wid]
                if time.time() - old["ts"] < 20:
                    result["wallets"][wid] = {**previous, "stale": True, "error": item.get("error")}
        with _cache_lock:
            _balance_cache = result
        save_balance_cache(result)
        return result


def all_token_rows(balances: dict[str, Any]) -> dict[str, dict[str, Any]]:
    tokens: dict[str, dict[str, Any]] = {}
    for w in WALLETS:
        item = balances.get("wallets", {}).get(w["id"], {})
        for row in item.get("rows", []) or []:
            addr = str(row.get("address") or "").lower()
            if not addr:
                continue
            qty = to_decimal(row.get("balance"))
            if qty <= 0:
                continue
            rec = tokens.setdefault(addr, {
                "address": addr,
                "symbol": str(row.get("symbol") or addr[:6]),
                "bawValue": Decimal(0),
                "holders": [],
            })
            rec["holders"].append({"wallet": w["id"], "qty": qty, "value": to_decimal(row.get("value"))})
            rec["bawValue"] += to_decimal(row.get("value"))
    return tokens


# ---------------------------------------------------------------- market data
def dex_snapshot(addresses: list[str]) -> dict[str, dict[str, Any]]:
    global _last_dex_error
    addresses = [a.lower() for a in addresses if a]
    if not addresses:
        return {}
    now = time.time()
    with _cache_lock:
        if _market_cache["data"] and now - _market_cache["ts"] < 4:
            old = _market_cache["data"]
            if all(a in old for a in addresses):
                return old
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(addresses), 25):
        part = addresses[i:i + 25]
        try:
            payload = json_get(DEX_TOKENS + ",".join(part), timeout=18)
        except Exception as e:  # noqa: BLE001
            _last_dex_error = repr(e)[:200]
            continue
        by_base: dict[str, list[dict[str, Any]]] = {}
        for pair in payload.get("pairs") or []:
            if str(pair.get("chainId") or "").lower() != "bsc":
                continue
            base = str((pair.get("baseToken") or {}).get("address") or "").lower()
            if base:
                by_base.setdefault(base, []).append(pair)
        for addr in part:
            pairs = by_base.get(addr) or []
            if not pairs:
                continue
            pairs.sort(key=lambda p: float((p.get("liquidity") or {}).get("usd") or 0), reverse=True)
            best = pairs[0]
            liq = (best.get("liquidity") or {})
            out[addr] = {
                "price": float(best.get("priceUsd") or 0),
                "liquidity": float(liq.get("usd") or 0),
                "dex": str(best.get("dexId") or ""),
                "labels": best.get("labels") or [],
                "pair": str(best.get("pairAddress") or ""),
                "quote": str((best.get("quoteToken") or {}).get("symbol") or ""),
                "quoteAddress": str((best.get("quoteToken") or {}).get("address") or "").lower(),
                "change24": float((best.get("priceChange") or {}).get("h24") or 0),
                "url": str(best.get("url") or ""),
                "pairCount": len(pairs),
                "ts": now,
            }
    with _cache_lock:
        merged = dict(_market_cache["data"])
        merged.update(out)
        _market_cache["data"] = merged
        if out:
            _market_cache["ts"] = now
        save_market_cache(_market_cache)
        return merged


def address_for_market(addr: str) -> str:
    return WBNB if addr.lower() == NATIVE else addr.lower()


def ensure_audit(addr: str, meta: dict[str, Any]) -> None:
    addr = addr.lower()
    if addr in (NATIVE, USDT, WBNB, USDC):
        return
    now = time.time()
    with _cache_lock:
        old = _audit_cache.get(addr)
        if old and now - old.get("ts", 0) < 600 and not old.get("pending"):
            return
        if old and old.get("pending") and now - old.get("ts", 0) < 60:
            return
        _audit_cache[addr] = {"ts": now, "pending": True, "risk": "未审计", "hidden": False}
    try:
        payload = json_get(f"{HONEYPOT}?address={urllib.parse.quote(meta.get('address') or addr)}&chainID=56", timeout=22)
        h = payload.get("honeypotResult") or {}
        sim = payload.get("simulationResult") or {}
        sell_tax = sim.get("sellTax")
        buy_tax = sim.get("buyTax")
        is_hp = bool(h.get("isHoneypot"))
        risk = "貔貅" if is_hp else ("高税" if (sell_tax or 0) > 50 else "")
        _audit_cache[addr] = {
            "ts": now,
            "pending": False,
            "risk": risk,
            "hidden": bool(is_hp or (sell_tax or 0) > 50),
            "isHoneypot": is_hp,
            "sellTax": sell_tax,
            "buyTax": buy_tax,
            "liquidity": (payload.get("pair") or {}).get("liquidity"),
        }
    except Exception as e:  # noqa: BLE001
        _audit_cache[addr] = {
            "ts": now,
            "pending": False,
            "risk": "未审计",
            "hidden": False,
            "error": repr(e)[:120],
        }


def ensure_audits(tokens: dict[str, dict[str, Any]], markets: dict[str, dict[str, Any]]) -> None:
    for addr, rec in tokens.items():
        m = markets.get(address_for_market(addr)) or {}
        value = float(rec.get("bawValue") or 0)
        if addr in (NATIVE, USDT, WBNB) or value >= 0.5 or (m.get("liquidity") or 0) >= 1000:
            _audit_pool.submit(ensure_audit, addr, {"address": addr})


def token_risk(addr: str, meta: dict[str, Any], value: float) -> dict[str, Any]:
    addr = addr.lower()
    if addr in (NATIVE, USDT, USDC):
        return {"level": "safe", "label": "主流", "hidden": False}
    m = meta
    if not m or not m.get("price"):
        return {"level": "danger", "label": "无池子", "hidden": True, "reason": "DEX 找不到可交易池"}
    liq = float(m.get("liquidity") or 0)
    if liq < 1000:
        return {"level": "danger", "label": "低流动性", "hidden": True, "reason": f"池子流动性仅 ${liq:,.0f}"}
    with _cache_lock:
        a = _audit_cache.get(addr) or {}
    if a.get("pending"):
        return {"level": "warn", "label": "审计中", "hidden": value < 1, "reason": "正在检查卖出税/貔貅"}
    if a.get("isHoneypot"):
        return {"level": "danger", "label": "貔貅", "hidden": True, "reason": "模拟卖出失败 / 无法卖出"}
    if (a.get("sellTax") or 0) > 50:
        return {"level": "danger", "label": "高税", "hidden": True, "reason": f"卖出税 {a.get('sellTax')}%"}
    if a.get("risk") == "未审计":
        return {"level": "warn", "label": "未审计", "hidden": value < 1, "reason": "暂无貔貅审计结果"}
    return {"level": "safe", "label": "正常", "hidden": value < 1, "reason": ""}


# ---------------------------------------------------------------- portfolio
def _tax_number(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n < 0 or n > 100:
        return None
    return round(n, 4)


def token_tax(addr: str) -> dict[str, Any]:
    addr = addr.lower()
    if addr in (NATIVE, USDT, USDC, WBNB):
        return {"buy": 0, "sell": 0}
    with _cache_lock:
        audit = _audit_cache.get(addr) or {}
    return {"buy": _tax_number(audit.get("buyTax")), "sell": _tax_number(audit.get("sellTax"))}


def build_portfolio(wallet_filter: str = "all") -> dict[str, Any]:
    # The background loop keeps this warm. Never make the UI wait for a full
    # six-wallet CLI sweep; a stale snapshot is better than a four-second page.
    balances = _balance_cache
    if not balances.get("wallets"):
        balances = refresh_balances(force=True)
    tokens = all_token_rows(balances)
    market_addrs = {address_for_market(a) for a in tokens}
    market_addrs.add(WBNB)
    markets = _market_cache.get("data") or {}
    if not markets or any(a not in markets for a in market_addrs):
        threading.Thread(target=dex_snapshot, args=(sorted(market_addrs),), daemon=True).start()
        markets = _market_cache.get("data") or {}
    elif time.time() - _market_cache.get("ts", 0) > 4:
        # Stale-while-revalidate: the page never waits for DexScreener.
        threading.Thread(target=dex_snapshot, args=(sorted(market_addrs),), daemon=True).start()
    ensure_audits(tokens, markets)
    wallets = []
    for w in WALLETS:
        item = balances.get("wallets", {}).get(w["id"], {})
        rows = item.get("rows", []) or []
        total = 0.0
        visible = 0.0
        for row in rows:
            addr = str(row.get("address") or "").lower()
            qty = float(to_decimal(row.get("balance")))
            m = markets.get(address_for_market(addr)) or {}
            price = float(m.get("price") or 0)
            value = qty * price
            risk = token_risk(addr, m, value)
            total += value
            if not risk.get("hidden"):
                visible += value
        ka = _keepalive.get("wallets", {}).get(w["id"], {})
        ka_status = str(ka.get("status") or "").upper()
        session_status = "online" if ka_status == "CONNECTED" else ("offline" if ka_status else "checking")
        if w.get("sessionBlocked"):
            session_status = "blocked"
        wallets.append({
            **w,
            "status": session_status,
            "sessionStatus": session_status,
            "sessionBlocked": bool(w.get("sessionBlocked")),
            "balanceStatus": "online" if item.get("ok") else "offline",
            "error": ka.get("error") or item.get("error"),
            "stale": bool(item.get("stale")),
            "updatedAt": item.get("updatedAt"),
            "balanceUsd": round(total, 2),
            "visibleUsd": round(visible, 2),
            "keepaliveAt": ka.get("at"),
            "keepaliveStatus": ka.get("status"),
        })

    selected_ids = [w["id"] for w in WALLETS] if wallet_filter == "all" else ([wallet_filter] if wallet_filter in WALLET_BY_ID else [])
    combined: dict[str, dict[str, Any]] = {}
    for w in WALLETS:
        if w["id"] not in selected_ids:
            continue
        item = balances.get("wallets", {}).get(w["id"], {})
        for row in item.get("rows", []) or []:
            addr = str(row.get("address") or "").lower()
            qty = to_decimal(row.get("balance"))
            if qty <= 0:
                continue
            rec = combined.setdefault(addr, {
                "address": addr,
                "symbol": str(row.get("symbol") or addr[:6]),
                "holders": [],
                "qty": Decimal(0),
            })
            rec["qty"] += qty
            rec["holders"].append({"wallet": w["id"], "qty": str(qty)})

    out_tokens = []
    for addr, rec in combined.items():
        m = markets.get(address_for_market(addr)) or {}
        price = float(m.get("price") or 0)
        qty = rec["qty"]
        value = float(qty) * price
        risk = token_risk(addr, m, value)
        holders = []
        for h in rec["holders"]:
            hq = to_decimal(h["qty"])
            holders.append({**h, "value": round(float(hq) * price, 6)})
        holders.sort(key=lambda x: x["value"], reverse=True)
        native = addr == NATIVE
        out_tokens.append({
            "address": addr,
            "symbol": rec["symbol"],
            "name": "BNB" if native else rec["symbol"],
            "native": native,
            "price": price,
            "priceSource": "DEX" if m.get("price") else "N/A",
            "marketAge": round(time.time() - float(m.get("ts") or _market_cache.get("ts") or 0), 1) if m else None,
            "marketStale": bool(not m or (time.time() - float(m.get("ts") or _market_cache.get("ts") or 0)) > MARKET_STALE_SECONDS),
            "change24": float(m.get("change24") or 0),
            "liquidity": float(m.get("liquidity") or 0),
            "dex": m.get("dex") or "",
            "labels": m.get("labels") or [],
            "pair": m.get("pair") or "",
            "quote": m.get("quote") or "",
            "pairCount": m.get("pairCount") or 0,
            "qty": str(qty),
            "value": round(value, 4),
            "holders": holders,
            "risk": risk,
            "tax": token_tax(addr),
            "hidden": bool(risk.get("hidden")),
            "kline": "https://web3.okx.com/zh-hans/token/bsc/" + (WBNB if native else addr),
            "marketAddress": address_for_market(addr),
        })

    out_tokens.sort(key=lambda t: (1 if t["hidden"] else 0, -t["value"]))
    total = sum(t["value"] for t in out_tokens)
    visible = sum(t["value"] for t in out_tokens if not t["hidden"])
    hidden = [t for t in out_tokens if t["hidden"]]
    return {
        "wallets": wallets,
        "tokens": out_tokens,
        "selectedWallet": wallet_filter,
        "totalUsd": round(visible, 2),
        "totalAllUsd": round(total, 2),
        "visibleUsd": round(visible, 2),
        "hiddenUsd": round(total - visible, 2),
        "hiddenCount": len(hidden),
        "visibleCount": len(out_tokens) - len(hidden),
        "updatedAt": now_iso(),
        "balanceAge": round(time.time() - _balance_cache["ts"], 1),
        "marketAge": round(time.time() - _market_cache["ts"], 1),
        "keepalive": _keepalive,
        "dexError": _last_dex_error,
    }


# ---------------------------------------------------------------- history
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
_history_enrich_cache: dict[str, tuple[float, dict[str, Any], str]] = {}
_token_meta_cache: dict[str, tuple[str, int]] = {}


def _decode_abi_string(raw: Any) -> str:
    try:
        b = bytes.fromhex(str(raw or "")[2:])
        if len(b) >= 64:
            offset = int.from_bytes(b[:32], "big")
            if offset + 32 <= len(b):
                length = int.from_bytes(b[offset:offset + 32], "big")
                return b[offset + 32:offset + 32 + length].decode("utf-8", "replace").strip("\x00 ")
        return b.rstrip(b"\x00").decode("utf-8", "replace").strip("\x00 ")
    except Exception:
        return ""


def _token_symbol(addr: str) -> str:
    addr = addr.lower()
    if addr == NATIVE:
        return "BNB"
    if addr == USDT:
        return "USDT"
    if addr == USDC:
        return "USDC"
    if addr == WBNB:
        return "WBNB"
    with _cache_lock:
        cached = _token_meta_cache.get(addr)
    if cached:
        return cached[0]
    try:
        symbol = _decode_abi_string(rpc_call("eth_call", [{"to": addr, "data": "0x95d89b41"}, "latest"], timeout=6))
    except Exception:
        symbol = ""
    symbol = symbol[:24] or short_addr(addr)
    with _cache_lock:
        _token_meta_cache[addr] = (symbol, 0)
    return symbol


def _history_amount(raw: Any, token: str) -> str:
    try:
        decimals = token_decimals(token)
        qty = Decimal(int(str(raw), 16)) / (Decimal(10) ** decimals)
        return fmt_qty(qty, token)
    except Exception:
        return ""


def _wallet_address_lower(wallet: str) -> str:
    w = WALLET_BY_ID.get(wallet) or {}
    return str(w.get("address") or "").strip().lower()


def _enrich_contract_history(wallet: str, tx_hash: str) -> dict[str, Any]:
    """Resolve one contract call from the perspective of ``wallet``.

    The cache key carries the wallet id and the cached value carries the
    address it was computed for: the same txHash under a different wallet (or
    after a wallet is re-bound to another address) is never reused.
    """
    if not tx_hash:
        return {}
    wallet_l = _wallet_address_lower(wallet)
    if not re.fullmatch(r"0x[0-9a-f]{40}", wallet_l):
        return {}
    now = time.time()
    cache_key = f"{wallet}:{tx_hash}"
    with _cache_lock:
        cached = _history_enrich_cache.get(cache_key)
        if cached and cached[2] == wallet_l and now - cached[0] < 1800:
            return cached[1]
    result: dict[str, Any] = {}
    try:
        receipt = rpc_call("eth_getTransactionReceipt", [tx_hash], timeout=10)
        tx = rpc_call("eth_getTransactionByHash", [tx_hash], timeout=10)
        if not isinstance(receipt, dict) or not isinstance(tx, dict):
            return {}
        # A contract call can emit several ERC-20 Transfer logs. Match only
        # transfers that involve this wallet, then describe the dominant flow.
        transfers: list[dict[str, Any]] = []
        for log in receipt.get("logs") or []:
            topics = log.get("topics") or []
            if len(topics) < 3 or str(topics[0]).lower() != TRANSFER_TOPIC:
                continue
            try:
                from_addr = "0x" + str(topics[1])[-40:].lower()
                to_addr = "0x" + str(topics[2])[-40:].lower()
            except Exception:
                continue
            # Direction is decided by the wallet being viewed right now.
            if wallet_l not in (from_addr, to_addr):
                continue
            token_addr = str(log.get("address") or "").lower()
            amount = _history_amount(log.get("data"), token_addr)
            if not amount:
                continue
            symbol = _token_symbol(token_addr)
            transfers.append({
                "token": token_addr, "symbol": symbol, "amount": amount,
                "from": from_addr, "to": to_addr,
                "direction": "out" if from_addr == wallet_l else "in",
                "counterparty": to_addr if from_addr == wallet_l else from_addr,
            })
        # De-duplicate wrapping/duplicate logs.
        unique: dict[tuple[str, str, str, str], dict[str, Any]] = {}
        for t in transfers:
            unique[(t["token"], t["from"], t["to"], t["amount"])] = t
        transfers = list(unique.values())
        out = [t for t in transfers if t["direction"] == "out"]
        inc = [t for t in transfers if t["direction"] == "in"]
        if out and inc:
            result = {
                "kind": "交易",
                "symbol": inc[0]["symbol"],
                "amount": f"卖出 {out[0]['amount']} {out[0]['symbol']} → 收到 {inc[0]['amount']} {inc[0]['symbol']}",
                "counterparty": short_addr(str(tx.get("to") or "")),
                "contractAddress": str(tx.get("to") or ""),
            }
        elif out:
            result = {
                "kind": "发送",
                "symbol": out[0]["symbol"],
                "amount": f"{out[0]['amount']} {out[0]['symbol']}",
                "counterparty": short_addr(out[0]["counterparty"]),
                "contractAddress": out[0]["token"],
            }
        elif inc:
            result = {
                "kind": "接收",
                "symbol": inc[0]["symbol"],
                "amount": f"{inc[0]['amount']} {inc[0]['symbol']}",
                "counterparty": short_addr(inc[0]["counterparty"]),
                "contractAddress": inc[0]["token"],
            }
        else:
            # Native BNB sent by a contract-call transaction.
            value = int(str(tx.get("value") or "0x0"), 16)
            if value > 0:
                from_addr = str(tx.get("from") or "").lower()
                to_addr = str(tx.get("to") or "").lower()
                amount = _history_amount(hex(value), NATIVE)
                if from_addr == wallet_l:
                    result = {"kind": "发送", "symbol": "BNB", "amount": f"{amount} BNB", "counterparty": short_addr(to_addr), "contractAddress": to_addr}
                elif to_addr == wallet_l:
                    result = {"kind": "接收", "symbol": "BNB", "amount": f"{amount} BNB", "counterparty": short_addr(from_addr), "contractAddress": from_addr}
    except Exception:
        result = {}
    with _cache_lock:
        _history_enrich_cache[cache_key] = (now, result, wallet_l)
    return result


def normalize_history(wallet: str, raw: dict[str, Any]) -> list[dict[str, Any]]:
    txs = ((raw.get("data") or {}).get("transactions") or []) if raw.get("success") else []
    out = []
    contract_seen = 0
    wallet_addr = _wallet_address_lower(wallet)
    wallet_label = (WALLET_BY_ID.get(wallet) or {}).get("label", wallet)
    for tx in txs:
        if not isinstance(tx, dict):
            continue
        hashes = tx.get("txHashList") or []
        h = hashes[0] if hashes and isinstance(hashes[0], dict) else {}
        ins = (h.get("instructions") or {})
        sends = ins.get("send") or []
        receives = ins.get("receive") or []
        send = sends[0] if sends else None
        receive = receives[0] if receives else None
        token = (send or receive or {}).get("tokenInfo") or {}
        symbol = token.get("symbol") or ""
        tx_type = tx.get("txType") or "contract"
        if tx_type == "transfer":
            kind = "发送" if send and not receive else "接收" if receive and not send else "交易"
        elif tx_type == "contract_call":
            kind = "交易" if send and receive else "合约"
        else:
            kind = "合约"
        amount = ""
        if send:
            amount = f"{send.get('amount')} {((send.get('tokenInfo') or {}).get('symbol') or '')}".strip()
        elif receive:
            amount = f"{receive.get('amount')} {((receive.get('tokenInfo') or {}).get('symbol') or '')}".strip()
        counterparty = ""
        for candidate in (send, receive):
            if not candidate:
                continue
            a = str((candidate.get("addressInfo") or {}).get("address") or "")
            if a and a.lower() != wallet_addr:
                counterparty = short_addr(a)
                break
        contract_address = ""
        if tx_type == "contract_call" and contract_seen < 6:
            contract_seen += 1
            enriched = _enrich_contract_history(wallet, str(tx.get("txHash") or h.get("txHash") or ""))
            if enriched:
                kind = str(enriched.get("kind") or kind)
                symbol = str(enriched.get("symbol") or symbol)
                amount = str(enriched.get("amount") or amount)
                counterparty = str(enriched.get("counterparty") or counterparty)
                contract_address = str(enriched.get("contractAddress") or "")
        # Belt-and-braces: a transfer row must never contradict the wallet it
        # came from.  The instructions carry sender/receiver lists; if the
        # wallet is the receiver and not the sender, the direction is "接收"
        # even when the sender list is populated (e.g. gas-paying relayer).
        if tx_type == "transfer" and send and receive:
            send_addrs = {
                str((c.get("addressInfo") or {}).get("address") or "").lower()
                for c in sends if isinstance(c, dict)
            }
            receive_addrs = {
                str((c.get("addressInfo") or {}).get("address") or "").lower()
                for c in receives if isinstance(c, dict)
            }
            if wallet_addr and wallet_addr in receive_addrs and wallet_addr not in send_addrs:
                kind = "接收"
            elif wallet_addr and wallet_addr in send_addrs and wallet_addr not in receive_addrs:
                kind = "发送"
        fee = ((h.get("networkFee") or {}).get("feeValue"))
        fee_bnb = 0.0
        if fee:
            try:
                fee_bnb = float(Decimal(str(fee)) / Decimal(10 ** int((h.get("networkFee") or {}).get("feeTokenDecimals") or 18)))
            except Exception:
                fee_bnb = 0.0
        out.append({
            "wallet": wallet,
            "walletLabel": wallet_label,
            "walletAddress": wallet_addr,
            "time": tx.get("txTime"),
            "kind": kind,
            "txType": tx_type,
            "symbol": symbol,
            "amount": amount,
            "counterparty": counterparty,
            "contractAddress": contract_address,
            "status": tx.get("status") or h.get("status") or "unknown",
            "txHash": tx.get("txHash") or h.get("txHash") or "",
            "feeBnb": round(fee_bnb, 8),
        })
    return out


def _history_disk_path(wallet: str) -> Path:
    return HISTORY_DIR / (re.sub(r"[^a-zA-Z0-9_-]", "_", wallet) + ".json")


def _empty_history_state(wallet: str) -> dict[str, Any]:
    return {
        "wallet": wallet,
        "address": _wallet_address_lower(wallet),
        "items": [],
        "ok": None,               # outcome of the most recent attempt
        "error": None,            # readable reason when ok is False
        "fetchedAt": None,        # last successful fetch (ISO)
        "fetchedTs": 0.0,
        "attemptedAt": None,      # most recent attempt, success or not
        "attemptedTs": 0.0,
        "stale": False,           # items predate the last failed attempt
        "failures": 0,
        "refreshing": False,
    }


def _read_history_disk(wallet: str) -> dict[str, Any]:
    """Load the last successful snapshot (legacy list-only files included)."""
    state = _empty_history_state(wallet)
    try:
        data = json.loads(_history_disk_path(wallet).read_text(encoding="utf-8"))
    except Exception:
        return state
    if isinstance(data, list):
        # Pre-metadata cache: keep the rows but admit we do not know their age.
        state["items"] = [x for x in data if isinstance(x, dict)]
        return state
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            state["items"] = [x for x in items if isinstance(x, dict)]
        fetched_at = data.get("fetchedAt")
        state["fetchedAt"] = str(fetched_at) if fetched_at else None
        try:
            state["fetchedTs"] = float(data.get("fetchedTs") or 0.0)
        except (TypeError, ValueError):
            state["fetchedTs"] = 0.0
        if not state["fetchedTs"] and state["fetchedAt"]:
            try:
                state["fetchedTs"] = time.mktime(time.strptime(state["fetchedAt"][:19], "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                state["fetchedTs"] = 0.0
        if data.get("address"):
            state["address"] = str(data["address"]).lower()
        current = _wallet_address_lower(wallet)
        if current and state["address"] and current != state["address"]:
            # The wallet was re-bound to a different address: old rows belong
            # to someone else and must not be served under this wallet.
            state["items"] = []
            state["fetchedAt"] = None
            state["fetchedTs"] = 0.0
        # A disk snapshot proves an earlier success, not the outcome of the
        # current process's most recent attempt, so leave ``ok`` unknown.
    return state


def _write_history_disk(wallet: str, state: dict[str, Any]) -> None:
    payload = {
        "wallet": wallet,
        "address": state.get("address") or "",
        "fetchedAt": state.get("fetchedAt"),
        "fetchedTs": state.get("fetchedTs") or 0.0,
        "items": state.get("items") or [],
    }
    try:
        tmp = _history_disk_path(wallet).with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_history_disk_path(wallet))
    except Exception:
        pass


def _history_attempt_age(snapshot: dict[str, Any], now: float) -> float:
    try:
        return now - float(snapshot.get("attemptedTs") or 0.0)
    except (TypeError, ValueError):
        return float("inf")


def _history_snapshot(wallet: str) -> dict[str, Any]:
    """Return a copy of the per-wallet state, loading disk on first touch."""
    with _history_refresh_lock:
        refreshing = wallet in _history_inflight
    with _cache_lock:
        state = _history_cache.get(wallet)
        if state is None:
            state = _read_history_disk(wallet)
            _history_cache[wallet] = state
        snapshot = {**state, "items": list(state.get("items") or [])}
    snapshot["refreshing"] = refreshing
    return snapshot


def _claim_history_refresh(wallet: str) -> threading.Event | None:
    """Claim the single refresh slot for a wallet; None means already running."""
    with _history_refresh_lock:
        if wallet in _history_inflight:
            return None
        event = threading.Event()
        _history_inflight[wallet] = event
        return event


def _refresh_history(wallet: str, claimed: threading.Event | None = None) -> dict[str, Any]:
    """Fetch one wallet's history.  A second caller joins the in-flight run.

    Returns the resulting per-wallet state.  On failure the previous success
    stays cached and the state records the failure reason and attempt time.
    """
    running = claimed
    if running is None:
        running = _claim_history_refresh(wallet)
    if running is None:
        # Reuse the request already in flight rather than stacking another one.
        with _history_refresh_lock:
            event = _history_inflight.get(wallet)
        if event is not None:
            event.wait(HISTORY_WAIT_SECONDS)
        return _history_snapshot(wallet)

    state = _history_snapshot(wallet)
    started = time.time()
    attempt_iso = now_iso_ms()
    try:
        r = baw(wallet, ["wallet", "tx-history", "--binanceChainId", CHAIN, "--size", "50", "--json"])
        if not r.get("success"):
            reason = err_text(r)
            raise RuntimeError(reason or "BAW 没有返回交易记录")
        items = normalize_history(wallet, r)
        # A wallet re-bound to another address must not inherit old rows.
        address = _wallet_address_lower(wallet)
        if state.get("address") and address and state["address"] != address:
            state["items"] = []
            state["ok"] = None
        fresh = {
            **state,
            "wallet": wallet,
            "address": address,
            "items": items,
            "ok": True,
            "error": None,
            "fetchedAt": attempt_iso,
            "fetchedTs": started,
            "attemptedAt": attempt_iso,
            "attemptedTs": started,
            "stale": False,
            "failures": 0,
            "refreshing": False,
        }
        with _cache_lock:
            _history_cache[wallet] = fresh
        _write_history_disk(wallet, fresh)
        return {**fresh, "items": list(items)}
    except Exception as exc:  # noqa: BLE001
        reason = str(exc) or "unknown error"
        reason = reason.strip()[:700]
        failed = {
            **state,
            "wallet": wallet,
            "ok": False,
            "error": reason,
            "attemptedAt": attempt_iso,
            "attemptedTs": started,
            # Rows now predate the failed attempt: mark them explicitly stale.
            "stale": bool(state.get("items")),
            "failures": int(state.get("failures") or 0) + 1,
            "refreshing": False,
        }
        with _cache_lock:
            _history_cache[wallet] = failed
        return {**failed, "items": list(failed.get("items") or [])}
    finally:
        with _history_refresh_lock:
            _history_inflight.pop(wallet, None)
        running.set()


def _refresh_history_async(wallet: str) -> None:
    """Start a refresh unless one is already running or recently failed."""
    snapshot = _history_snapshot(wallet)
    # Back off after a failure so the polling loop does not hammer BAW.
    if snapshot.get("ok") is False and _history_attempt_age(snapshot, time.time()) < HISTORY_RETRY_SECONDS:
        return
    event = _claim_history_refresh(wallet)
    if event is None:
        return
    threading.Thread(target=_refresh_history, args=(wallet, event), daemon=True).start()


def history_state(wallet: str, force: bool = False) -> dict[str, Any]:
    """Per-wallet history with explicit freshness metadata.

    ``force`` asks for a fresh attempt; concurrent callers share one request.
    """
    now = time.time()
    snapshot = _history_snapshot(wallet)
    # A successful fetch of an empty wallet is still a valid result: do not
    # treat "no rows" as "never fetched" and refetch on every request.
    usable = bool(snapshot.get("items")) or snapshot.get("ok") is True
    age = now - float(snapshot.get("fetchedTs") or 0.0)
    fresh_enough = bool(snapshot.get("fetchedAt")) and age < HISTORY_FRESH_SECONDS
    if usable and not force and fresh_enough:
        return snapshot
    if force:
        # An explicit refresh waits for the outcome (sharing an in-flight run);
        # the response then carries this attempt's success/failure marker.
        return _refresh_history(wallet)
    if usable:
        # Stale-while-revalidate: paint the last success instantly.
        _refresh_history_async(wallet)
        return snapshot
    # Avoid hammering BAW after a recent failure; the state already explains it.
    if snapshot.get("ok") is False and _history_attempt_age(snapshot, now) < HISTORY_RETRY_SECONDS:
        return snapshot
    # Nothing cached yet: fetch, joining any in-flight request instead of
    # issuing a duplicate BAW call.
    return _refresh_history(wallet)


def history_for(wallet: str, force: bool = False) -> list[dict[str, Any]]:
    """Compatibility wrapper returning only rows."""
    return history_state(wallet, force=force).get("items") or []


def build_history(wallet_filter: str = "all", limit: int = 80, force: bool = False) -> dict[str, Any]:
    if wallet_filter == "all":
        with ThreadPoolExecutor(max_workers=3) as ex:
            states = list(ex.map(lambda w: history_state(w, force=force), [w["id"] for w in WALLETS]))
    elif wallet_filter in WALLET_BY_ID:
        states = [history_state(wallet_filter, force=force)]
    else:
        # Unknown wallet: a readable reason beats an empty list that looks like
        # "this wallet has no records".
        reason = f"钱包不存在：{wallet_filter}"
        return {
            "items": [], "selectedWallet": wallet_filter, "updatedAt": None,
            "attemptedAt": None, "ok": False, "error": reason,
            "errors": [{"wallet": wallet_filter, "error": reason}],
            "stale": False, "wallets": {},
        }

    items: list[dict[str, Any]] = []
    wallets: dict[str, dict[str, Any]] = {}
    for state in states:
        wid = state["wallet"]
        fetched_at = state.get("fetchedAt")
        for item in state.get("items") or []:
            # Stamp each row with the snapshot it came from so the UI can show
            # freshness per record, even when wallets are merged.
            items.append({**item, "fetchedAt": fetched_at, "stale": bool(state.get("stale"))})
        wallets[wid] = {
            "wallet": wid,
            "label": (WALLET_BY_ID.get(wid) or {}).get("label", wid),
            "address": state.get("address") or "",
            "ok": state.get("ok"),
            "error": state.get("error"),
            "fetchedAt": fetched_at,
            "attemptedAt": state.get("attemptedAt"),
            "stale": bool(state.get("stale")),
            "failures": int(state.get("failures") or 0),
            "refreshing": bool(state.get("refreshing")),
            "count": len(state.get("items") or []),
        }

    items.sort(key=lambda x: x.get("time") or "", reverse=True)
    fetched = [(float(s.get("fetchedTs") or 0.0), s.get("fetchedAt")) for s in states if s.get("fetchedAt")]
    failed = any(s.get("ok") is False for s in states)
    # ``ok`` describes the most recent attempt(s), not merely that rows exist.
    overall_ok = False if failed else (True if states and all(s.get("ok") is True for s in states) else None)
    errors = [
        {"wallet": s["wallet"], "error": s.get("error")}
        for s in states if s.get("ok") is False and s.get("error")
    ]
    attempted = [s.get("attemptedAt") for s in states if s.get("attemptedAt")]
    return {
        "items": items[:limit],
        "selectedWallet": wallet_filter,
        "updatedAt": max(fetched)[1] if fetched else None,
        "attemptedAt": max(attempted) if attempted else None,
        "ok": overall_ok,
        "error": errors[0]["error"] if errors else None,
        "errors": errors,
        "stale": any(bool(s.get("stale")) for s in states),
        "wallets": wallets,
    }


# ---------------------------------------------------------------- quote / trade
def target_for(token: str) -> str:
    t = token.lower()
    if t == USDT:
        return NATIVE
    return USDT


def token_market(token: str) -> dict[str, Any]:
    addr = address_for_market(token)
    markets = dex_snapshot([addr])
    return markets.get(addr) or {}


def quote_for(wallet: str, token: str, qty: str, slippage: str | float = "auto") -> dict[str, Any]:
    token = token.lower()
    target = target_for(token)
    r = baw(wallet, [
        "market-order", "quote", "--binanceChainId", CHAIN,
        "--fromToken", token, "--toToken", target,
        "--fromTokenQty", qty, "--slippage", str(slippage), "--json",
    ], timeout=35)
    if not r.get("success"):
        return {
            "ok": False,
            "error": err_text(r),
            "needsPhoneConfirm": is_phone_confirm(r),
            "wallet": wallet,
        }
    data = r.get("data") or {}
    to_amount = to_decimal(data.get("toCoinAmount"))
    from_amount = to_decimal(data.get("fromCoinAmount") or qty)
    m = token_market(token)
    token_price = float(m.get("price") or 0)
    target_price = 1.0 if target == USDT else float(token_market(NATIVE).get("price") or 0)
    market_ts = float(m.get("ts") or _market_cache.get("ts") or 0)
    market_age = time.time() - market_ts if market_ts else 1e9
    tax = token_tax(token)
    with _cache_lock:
        audit = _audit_cache.get(token.lower()) or {}
    major = token in (NATIVE, USDT, USDC, WBNB)
    blocked_reason = None
    if not m or token_price <= 0 or float(m.get("liquidity") or 0) <= 0:
        blocked_reason = "行情基准缺失，禁止提交；请稍后刷新行情"
    elif target_price <= 0:
        blocked_reason = "目标资产价格基准缺失，禁止提交"
    elif market_age > MARKET_STALE_SECONDS:
        blocked_reason = f"行情基准已过期（{int(market_age)} 秒），禁止提交"
    elif not major and audit.get("hidden"):
        blocked_reason = "该代币被风险策略标记为貔貅/高税，禁止提交"
    tax_unknown = bool(not major and (tax.get("buy") is None or tax.get("sell") is None))

    expected_usd = float(from_amount) * token_price
    actual_usd = float(to_amount) * target_price
    if blocked_reason is None and expected_usd <= 0:
        blocked_reason = "无法计算预期价值，禁止提交"
    deviation = ((actual_usd - expected_usd) / expected_usd * 100) if expected_usd > 0 else 0.0
    guard = "blocked" if blocked_reason else "ok"
    if not blocked_reason:
        if deviation < -8:
            guard = "blocked"
        elif deviation < -3:
            guard = "warn"
    return {
        "ok": blocked_reason is None,
        "error": blocked_reason,
        "wallet": wallet,
        "token": token,
        "target": target,
        "fromSymbol": data.get("fromCoinSymbol"),
        "toSymbol": data.get("toCoinSymbol"),
        "fromAmount": str(from_amount),
        "toAmount": str(to_amount),
        "slippagePct": round(float(data.get("slippage") or 0) * 100, 3),
        "impliedPrice": float(to_amount) / float(from_amount) if float(from_amount) else 0,
        "marketPrice": token_price,
        "actualUsd": round(actual_usd, 4),
        "expectedUsd": round(expected_usd, 4),
        "deviationPct": round(deviation, 3),
        "guard": guard,
        "baseline": "missing" if blocked_reason and ("基准" in blocked_reason or "过期" in blocked_reason) else "ok",
        "marketAgeSec": round(market_age, 1) if market_age < 1e8 else None,
        "tax": tax,
        "taxUnknown": tax_unknown,
        "needsTaxAck": bool(tax_unknown or (tax.get("sell") is not None and tax["sell"] > 10)),
        "pool": {
            "dex": m.get("dex"),
            "labels": m.get("labels"),
            "pair": m.get("pair"),
            "liquidity": m.get("liquidity"),
            "quote": m.get("quote"),
            "pairCount": m.get("pairCount"),
        },
        "raw": data,
    }


def wallet_token_qty(wallet: str, token: str) -> tuple[Decimal, str | None]:
    token = token.lower()
    balances = _balance_cache
    if not balances.get("wallets"):
        balances = refresh_balances(force=True)
    item = balances.get("wallets", {}).get(wallet, {})
    for row in item.get("rows", []) or []:
        if str(row.get("address") or "").lower() == token:
            return to_decimal(row.get("balance")), None
    return Decimal(0), "余额为 0"


def qty_for_pct(wallet: str, token: str, pct: float) -> tuple[Decimal, str | None]:
    qty, err = wallet_token_qty(wallet, token)
    if err:
        return Decimal(0), err
    with localcontext() as ctx:
        ctx.prec = 80
        amount = qty * Decimal(str(pct)) / Decimal(100)
        if pct >= 99.999 and token == NATIVE:
            amount -= Decimal("0.0005")
    if amount <= 0:
        return Decimal(0), "数量过小"
    try:
        decimals = token_decimals(token)
        units = token_base_units(amount, decimals)
    except ValueError as exc:
        return Decimal(0), str(exc)
    return Decimal(units) / (Decimal(10) ** decimals), None


def parse_positive_amount(raw: Any) -> Decimal:
    try:
        d = Decimal(str(raw))
    except Exception as exc:
        raise ValueError("invalid amount") from exc
    if not d.is_finite() or d <= 0:
        raise ValueError("invalid amount")
    return d


def fmt_qty(d: Decimal, token: str) -> str:
    """Format a token quantity without ever trimming integer zeros.

    Only the fractional part may be stripped.  Examples:
    10 -> "10", 100.0 -> "100", 120 -> "120", 0.5000 -> "0.5".
    """
    if not d.is_finite() or d < 0:
        raise ValueError("invalid quantity")
    if token == NATIVE:
        d = d.quantize(Decimal("0.000000000000000001"), rounding=ROUND_DOWN)
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def save_tasks() -> None:
    try:
        with _task_lock:
            data = {"tasks": list(_tasks.values())}
        tmp = TASKS_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(TASKS_PATH)
    except Exception:
        pass


def load_tasks() -> None:
    global _tasks
    try:
        data = json.loads(TASKS_PATH.read_text(encoding="utf-8"))
        tasks = data.get("tasks") if isinstance(data, dict) else None
        if not isinstance(tasks, list):
            return
        loaded: dict[str, dict[str, Any]] = {}
        for task in tasks:
            if not isinstance(task, dict) or not task.get("id"):
                continue
            if task.get("status") in ("queued", "running"):
                task["status"] = "unknown"
                task["error"] = "服务重启，提交结果待核实；请用交易哈希或钱包记录核对"
                task["finishedAt"] = now_iso()
            loaded[str(task["id"])] = task
        _tasks = loaded
    except Exception:
        pass


def new_task(kind: str, legs: list[dict[str, Any]], idem: str | None, fingerprint: str | None = None) -> dict[str, Any]:
    with _task_lock:
        if idem:
            for t in _tasks.values():
                if t.get("idempotencyKey") == idem and time.time() - float(t.get("createdTs", 0)) < 86400:
                    if fingerprint and t.get("fingerprint") not in (None, fingerprint):
                        raise ValueError("idempotency key reused with different operation")
                    return t
        if len(_tasks) > 300:
            terminal = sorted(
                ((tid, t) for tid, t in _tasks.items() if t.get("status") in ("submitted", "partial", "failed", "unknown")),
                key=lambda item: float(item[1].get("createdTs") or 0),
            )
            for tid, _ in terminal[:max(0, len(_tasks) - 250)]:
                _tasks.pop(tid, None)
        task_id = f"t{int(time.time() * 1000)}{os.urandom(2).hex()}"
        task = {
            "id": task_id,
            "kind": kind,
            "status": "queued",
            "createdAt": now_iso(),
            "createdTs": time.time(),
            "legs": legs,
            "idempotencyKey": idem,
            "fingerprint": fingerprint,
        }
        _tasks[task_id] = task
    save_tasks()
    return task


def claim_task(task: dict[str, Any]) -> bool:
    with _task_lock:
        if task.get("started") or task.get("status") != "queued":
            return False
        task["started"] = True
        task["startedAt"] = now_iso()
    save_tasks()
    return True


def invalidate_history(wallet: str) -> None:
    """Drop cached rows and start a refresh (used after a submission)."""
    with _cache_lock:
        _history_cache.pop(wallet, None)
    _refresh_history_async(wallet)


def add_audit(entry: dict[str, Any]) -> None:
    try:
        with open(DATA / "audit.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": now_iso(), **entry}, ensure_ascii=False) + "\n")
    except Exception:
        pass


def run_sell_task(task: dict[str, Any], token: str, pct: float, slippage: float, amount: str | None = None, tax_ack: bool = False, tax_unknown_ack: bool = False) -> None:
    token = token.lower()
    target = target_for(token)
    task["status"] = "running"
    try:
        with ThreadPoolExecutor(max_workers=min(3, len(task["legs"]))) as ex:
            futures = {}
            for leg in task["legs"]:
                futures[ex.submit(sell_leg, leg, token, target, pct, slippage, tax_ack, tax_unknown_ack)] = leg
            for f in as_completed(futures):
                leg = futures[f]
                try:
                    f.result()
                except Exception as e:  # noqa: BLE001
                    leg["status"] = "failed"
                    leg["error"] = repr(e)
        statuses = {l.get("status") for l in task["legs"]}
        if "unknown" in statuses:
            task["status"] = "unknown"
        elif "needs_confirm" in statuses:
            task["status"] = "needs_confirm"
        elif statuses <= {"submitted"}:
            task["status"] = "submitted"
        elif "submitted" in statuses:
            task["status"] = "partial"
        else:
            task["status"] = "failed"
        task["finishedAt"] = now_iso()
        for leg in task["legs"]:
            invalidate_history(leg["wallet"])
        add_audit({"task": task["id"], "kind": "sell", "token": token, "pct": pct, "amount": amount, "legs": task["legs"]})
        save_tasks()
    except Exception:  # noqa: BLE001
        task["status"] = "failed"
        task["error"] = traceback.format_exc()[-800:]
        task["finishedAt"] = now_iso()
        save_tasks()


def sell_leg(leg: dict[str, Any], token: str, target: str, pct: float, slippage: float, tax_ack: bool = False, tax_unknown_ack: bool = False) -> None:
    wid = leg["wallet"]
    leg["status"] = "checking"
    with _wallet_locks.setdefault(wid, threading.Lock()):
        ready_err = wallet_ready_error(wid)
        if ready_err:
            leg.update(status="failed", error=ready_err)
            return
        if leg.get("fixedQty"):
            try:
                qty = Decimal(str(leg["fixedQty"]))
            except Exception:
                leg.update(status="failed", error="invalid amount")
                return
            if qty <= 0:
                leg.update(status="failed", error="amount must be positive")
                return
        else:
            qty, err = qty_for_pct(wid, token, pct)
            if err:
                leg.update(status="failed", error=err)
                return
        q = fmt_qty(qty, token)
        leg["qty"] = q
        leg["status"] = "quoting"
        pre = quote_for(wid, token, q, slippage)
        if not pre.get("ok"):
            leg.update(status="needs_confirm" if pre.get("needsPhoneConfirm") else "failed",
                       error=pre.get("error"))
            return
        leg["quote"] = {k: pre.get(k) for k in ("toAmount", "toSymbol", "deviationPct", "guard", "slippagePct", "pool")}
        if pre.get("guard") == "blocked":
            leg.update(status="failed", error=f"报价偏离最优池 {pre.get('deviationPct')}% ，已拦截（保护）")
            return
        if pre.get("taxUnknown") and not tax_unknown_ack:
            leg.update(status="failed", error="交易税未检测，需要确认后才能提交")
            return
        sell_tax = (pre.get("tax") or {}).get("sell")
        if sell_tax is not None and sell_tax > 10 and not tax_ack:
            leg.update(status="failed", error=f"卖出税 {sell_tax}%，需要额外确认")
            return
        leg["status"] = "submitting"
        r = baw(wid, [
            "market-order", "swap", "--binanceChainId", CHAIN,
            "--fromToken", token, "--toToken", target,
            "--fromTokenQty", q, "--slippage", str(slippage),
            "--mev", "true", "--gasLevel", "HIGH", "--json",
        ], timeout=85)
        if not r.get("success"):
            if is_phone_confirm(r):
                leg.update(status="needs_confirm", error=err_text(r))
            elif is_timeout(r):
                leg.update(status="unknown", error="执行超时，链上结果待核实；请先查钱包记录，不要重复提交")
            else:
                leg.update(status="failed", error=err_text(r))
            return
        data = r.get("data") or {}
        leg.update(
            status="submitted",
            orderId=data.get("orderId") or data.get("id"),
            txHash=data.get("txHash"),
            result=data if isinstance(data, dict) else {},
        )


def run_send_task(task: dict[str, Any], token: str, pct: float, recipient: str, amount: str | None = None) -> None:
    token = token.lower()
    task["status"] = "running"
    try:
        with ThreadPoolExecutor(max_workers=min(3, len(task["legs"]))) as ex:
            futures = {ex.submit(send_leg, leg, token, pct, recipient, amount): leg for leg in task["legs"]}
            for f in as_completed(futures):
                leg = futures[f]
                try:
                    f.result()
                except Exception as e:  # noqa: BLE001
                    leg["status"] = "failed"
                    leg["error"] = str(e) or repr(e)
        statuses = {l.get("status") for l in task["legs"]}
        if "unknown" in statuses:
            task["status"] = "unknown"
        elif "needs_confirm" in statuses:
            task["status"] = "needs_confirm"
        elif statuses <= {"submitted"}:
            task["status"] = "submitted"
        elif "submitted" in statuses:
            task["status"] = "partial"
        else:
            task["status"] = "failed"
        task["finishedAt"] = now_iso()
        for leg in task["legs"]:
            invalidate_history(leg["wallet"])
        add_audit({"task": task["id"], "kind": "send", "token": token, "pct": pct, "amount": amount, "to": recipient, "legs": task["legs"]})
        save_tasks()
    except Exception:  # noqa: BLE001
        task["status"] = "failed"
        task["error"] = traceback.format_exc()[-800:]
        task["finishedAt"] = now_iso()
        save_tasks()


CONFIRM_STATUSES = {
    "PENDING_CONFIRMATION", "NEEDS_CONFIRMATION", "NEEDS_CONFIRM",
    "WAITING_CONFIRMATION", "REQUIRE_CONFIRMATION", "CONFIRMATION_REQUIRED",
}
FAILED_STATUSES = {"FAILED", "REJECTED", "CANCELLED", "CANCELED", "ERROR"}


def classify_execute_status(data: dict[str, Any]) -> str:
    status = str(data.get("status") or "").upper()
    if data.get("requireConfirmation") is True or status in CONFIRM_STATUSES:
        return "needs_confirm"
    if status in FAILED_STATUSES:
        return "failed"
    return "submitted"


def send_leg(leg: dict[str, Any], token: str, pct: float, recipient: str, amount: str | None = None) -> None:
    wid = leg["wallet"]
    leg["status"] = "checking"
    with _wallet_locks.setdefault(wid, threading.Lock()):
        ready_err = wallet_ready_error(wid)
        if ready_err:
            leg.update(status="failed", error=ready_err)
            return
        if amount is not None:
            try:
                qty = Decimal(str(amount))
            except Exception:
                leg.update(status="failed", error="invalid amount")
                return
            if qty <= 0:
                leg.update(status="failed", error="amount must be positive")
                return
        else:
            qty, err = qty_for_pct(wid, token, pct)
            if err:
                leg.update(status="failed", error=err)
                return
        q = fmt_qty(qty, token)
        leg["qty"] = q
        leg["status"] = "submitting"
        try:
            result = contract_send(wid, token, qty, recipient, truncate=amount is None)
        except Exception as e:  # noqa: BLE001
            leg.update(status="failed", error=str(e) or repr(e))
            return
        if not result.get("ok"):
            if result.get("needsPhoneConfirm"):
                leg.update(status="needs_confirm", error=result.get("error"))
            elif result.get("timeout"):
                leg.update(status="unknown", error=result.get("error"))
            else:
                leg.update(status="failed", error=result.get("error"))
            return
        data = result.get("data") or {}
        tx_hash = data.get("txHash") or data.get("txId") or data.get("hash")
        order_id = data.get("orderId")
        outcome = classify_execute_status(data)
        if outcome == "needs_confirm":
            leg.update(status="needs_confirm", txHash=tx_hash, orderId=order_id, error="需要到币安 App 确认这笔合约调用")
            return
        if outcome == "failed":
            leg.update(status="failed", error=str(data.get("message") or data.get("error") or data.get("status") or "failed"))
            return
        leg.update(status="submitted", txHash=tx_hash, orderId=order_id, result=data)


def start_sell(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("token") or "").lower()
    wallet_ids = list(dict.fromkeys(str(x) for x in (payload.get("walletIds") or []) if str(x) in WALLET_BY_ID))
    amount_raw = payload.get("amount")
    amount: str | None = None
    if amount_raw not in (None, ""):
        amount_dec = parse_positive_amount(amount_raw)
        amount = format(amount_dec, "f")
    try:
        pct = float(payload.get("pct") or 0)
        slippage = float(payload.get("slippage") or 1)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid pct/slippage") from exc
    if not math.isfinite(pct) or not math.isfinite(slippage):
        raise ValueError("invalid pct/slippage")
    if not token or not wallet_ids:
        raise ValueError("token and walletIds required")
    if amount is None and not (0 < pct <= 100):
        raise ValueError("invalid pct")
    if not (0.05 <= slippage <= 50):
        raise ValueError("invalid slippage")
    idem = str(payload.get("idempotencyKey") or "") or None
    tax_ack = payload.get("taxAck") is True
    tax_unknown_ack = payload.get("taxUnknownAck") is True
    fingerprint = hashlib.sha256(json.dumps({
        "kind": "sell", "token": token, "wallets": wallet_ids,
        "amount": amount, "pct": pct, "slippage": slippage,
        "taxAck": tax_ack, "taxUnknownAck": tax_unknown_ack,
    }, sort_keys=True).encode()).hexdigest()
    if amount is not None:
        try:
            decimals = token_decimals(token)
            target_units = token_base_units(Decimal(amount), decimals, truncate=False)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        balances: list[tuple[str, int]] = []
        for w in wallet_ids:
            qty, err = wallet_token_qty(w, token)
            if err or qty <= 0:
                continue
            balances.append((w, token_base_units(qty, decimals)))
        total_units = sum(units for _, units in balances)
        if total_units <= 0:
            raise ValueError("no token balance")
        if target_units > total_units:
            raise ValueError("amount exceeds selected wallet balance")
        shares = allocate_units(target_units, [units for _, units in balances])
        if not shares:
            raise ValueError("no sellable amount")
        legs = []
        for (w, _), units in zip(balances, shares):
            if units <= 0:
                continue
            qty = Decimal(units) / (Decimal(10) ** decimals)
            fixed = format(qty, "f")
            if "." in fixed:
                fixed = fixed.rstrip("0").rstrip(".")
            legs.append({"wallet": w, "status": "queued", "fixedQty": fixed or "0"})
        if not legs:
            raise ValueError("no sellable amount")
    else:
        legs = [{"wallet": w, "status": "queued"} for w in wallet_ids]
    task = new_task("sell", legs, idem, fingerprint)
    if not claim_task(task):
        return task
    threading.Thread(target=run_sell_task, args=(task, token, pct, slippage, amount, tax_ack, tax_unknown_ack), daemon=True).start()
    return task


def start_send(payload: dict[str, Any]) -> dict[str, Any]:
    token = str(payload.get("token") or "").lower()
    wallet_ids = list(dict.fromkeys(str(x) for x in (payload.get("walletIds") or []) if str(x) in WALLET_BY_ID))
    amount_raw = payload.get("amount")
    amount: str | None = None
    if amount_raw not in (None, ""):
        amount_dec = parse_positive_amount(amount_raw)
        amount = format(amount_dec, "f")
    try:
        pct = float(payload.get("pct") or 100)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid pct") from exc
    if not math.isfinite(pct):
        raise ValueError("invalid pct")
    recipient = str(payload.get("recipient") or "").strip()
    if not token or not wallet_ids or not re.fullmatch(r"0x[a-fA-F0-9]{40}", recipient):
        raise ValueError("invalid token/wallet/recipient")
    if amount is None and not (0 < pct <= 100):
        raise ValueError("invalid pct")
    if amount is not None:
        try:
            token_base_units(Decimal(amount), token_decimals(token), truncate=False)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
    idem = str(payload.get("idempotencyKey") or "") or None
    fingerprint = hashlib.sha256(json.dumps({
        "kind": "send", "token": token, "wallets": wallet_ids,
        "amount": amount, "pct": pct, "recipient": recipient.lower(),
    }, sort_keys=True).encode()).hexdigest()
    legs = [{"wallet": w, "status": "queued"} for w in wallet_ids]
    task = new_task("send", legs, idem, fingerprint)
    if not claim_task(task):
        return task
    threading.Thread(target=run_send_task, args=(task, token, pct, recipient, amount), daemon=True).start()
    return task


# ---------------------------------------------------------------- wallet add / remove
def start_wallet_add(payload: dict[str, Any]) -> dict[str, Any]:
    global _next_slot
    label = str(payload.get("label") or "").strip()[:30]
    now_ms = int(time.time() * 1000)
    for pending_slot, pending in list(_pending_wallets.items()):
        if int(pending.get("expireAt") or 0) and int(pending["expireAt"]) < now_ms - 3_600_000:
            _pending_wallets.pop(pending_slot, None)
    if len(_pending_wallets) > 12:
        oldest = sorted(_pending_wallets.items(), key=lambda item: float(item[1].get("expireAt") or 0))[:len(_pending_wallets) - 12]
        for pending_slot, _ in oldest:
            _pending_wallets.pop(pending_slot, None)
    with _config_lock:
        slot = f"w{_next_slot}"
        _next_slot += 1
        save_wallet_config()
    wdir = HOME / "aw" / slot
    wdir.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(wdir, 0o700)
    except Exception:
        pass
    r = baw(slot, ["auth", "signin", "--json"], timeout=70)
    if not r.get("success"):
        return {"ok": False, "error": err_text(r)}
    data = r.get("data") or {}
    url = str(data.get("urlForWeb") or "")
    qr_id = str(data.get("qrCodeId") or "")
    if not url or not qr_id:
        return {"ok": False, "error": "BAW 没有返回二维码"}
    expire_at = int(data.get("expireAt") or 0)
    expires_in = max(0, int(expire_at / 1000 - time.time())) if expire_at > 10_000_000_000 else 300
    pending = {
        "slot": slot,
        "label": label or f"钱包 {slot}",
        "url": url,
        "qrCodeId": qr_id,
        "pairingCode": str(data.get("pairingCode") or ""),
        "expireAt": expire_at,
        "status": "waiting",
        "error": None,
        "wallet": None,
        "at": now_iso(),
    }
    _pending_wallets[slot] = pending
    threading.Thread(target=_verify_wallet, args=(slot, qr_id), daemon=True).start()
    return {
        "ok": True,
        "slot": slot,
        "url": url,
        "qrSvg": qr_svg(url),
        "pairingCode": pending["pairingCode"],
        "expiresIn": expires_in,
    }


def start_wallet_relogin(wallet_id: str) -> dict[str, Any]:
    w = WALLET_BY_ID.get(wallet_id)
    if not w:
        return {"ok": False, "error": "wallet not found"}
    if wallet_id in _relogin_pending:
        return {"ok": False, "error": "该钱包已有扫码请求，请完成或等待过期后再试"}
    lock = _wallet_locks.setdefault(wallet_id, threading.Lock())
    if not lock.acquire(blocking=False):
        return {"ok": False, "error": "该钱包正在提交交易，请稍后再重新登录"}
    try:
        if wallet_id in _relogin_pending:
            return {"ok": False, "error": "该钱包已有扫码请求，请完成或等待过期后再试"}
        _relogin_pending.add(wallet_id)
    finally:
        lock.release()
    now_ms = int(time.time() * 1000)
    for pending_slot, pending in list(_pending_wallets.items()):
        if int(pending.get("expireAt") or 0) and int(pending["expireAt"]) < now_ms - 3_600_000:
            _pending_wallets.pop(pending_slot, None)
    try:
        r = baw(wallet_id, ["auth", "signin", "--json"], timeout=70)
    except Exception:
        _relogin_pending.discard(wallet_id)
        raise
    if not r.get("success"):
        _relogin_pending.discard(wallet_id)
        return {"ok": False, "error": err_text(r)}
    data = r.get("data") or {}
    url = str(data.get("urlForWeb") or "")
    qr_id = str(data.get("qrCodeId") or "")
    if not url or not qr_id:
        _relogin_pending.discard(wallet_id)
        return {"ok": False, "error": "BAW 没有返回二维码"}
    expire_at = int(data.get("expireAt") or 0)
    expires_in = max(0, int(expire_at / 1000 - time.time())) if expire_at > 10_000_000_000 else 300
    pending = {
        "slot": wallet_id,
        "label": w.get("label") or wallet_id,
        "url": url,
        "qrCodeId": qr_id,
        "pairingCode": str(data.get("pairingCode") or ""),
        "expireAt": expire_at,
        "status": "waiting",
        "error": None,
        "wallet": None,
        "relogin": True,
        "expectedAddress": str(w.get("address") or ""),
        "at": now_iso(),
    }
    _pending_wallets[wallet_id] = pending
    threading.Thread(target=_verify_wallet, args=(wallet_id, qr_id), daemon=True).start()
    return {
        "ok": True,
        "slot": wallet_id,
        "url": url,
        "qrSvg": qr_svg(url),
        "pairingCode": pending["pairingCode"],
        "expiresIn": expires_in,
    }


def _verify_wallet_inner(slot: str, qr_id: str) -> None:
    pending = _pending_wallets.get(slot)
    if not pending:
        return
    r = baw(slot, ["auth", "verify", "--qrCodeId", qr_id, "--json"], timeout=620)
    if not r.get("success"):
        pending["status"] = "expired"
        pending["error"] = err_text(r)
        return
    addr = wallet_address(slot)
    if not addr:
        pending["status"] = "failed"
        pending["error"] = "二维码已确认，但读取 BSC 地址失败"
        return
    label = pending.get("label") or f"钱包 {slot}"
    existing = WALLET_BY_ID.get(slot)
    if existing:
        expected = str(pending.get("expectedAddress") or "")
        if expected and addr.lower() != expected.lower():
            with _config_lock:
                existing["sessionBlocked"] = True
                save_wallet_config()
            pending["status"] = "failed"
            pending["error"] = f"扫码钱包地址与 {slot} 原地址不一致，该钱包已锁定；请用原钱包重新登录恢复"
            set_keepalive_status(slot, "MISMATCH", str(pending["error"]))
            return
        with _config_lock:
            existing["address"] = addr
            existing["sessionBlocked"] = False
            save_wallet_config()
    else:
        duplicate = next((w for w in WALLETS if str(w.get("address") or "").lower() == addr.lower()), None)
        if duplicate:
            pending["status"] = "failed"
            pending["error"] = f"该地址已绑定 {duplicate['id']}，请用它自己的“重新登录”"
            return
        with _config_lock:
            # A duplicate slot cannot happen, but keep the config clean.
            WALLETS[:] = [w for w in WALLETS if w["id"] != slot]
            _apply_wallets(WALLETS + [{
                "id": slot,
                "label": label,
                "agent": label,
                "address": addr,
                "color": COLORS[len(WALLETS) % len(COLORS)],
                "trade": False,
            }])
            save_wallet_config()
    pending["status"] = "added"
    pending["wallet"] = dict(WALLET_BY_ID.get(slot) or {})
    pending["error"] = None
    _keepalive.setdefault("wallets", {})[slot] = {"at": now_iso(), "status": "CONNECTED", "error": None}
    _keepalive["at"] = now_iso()
    try:
        refresh_balances(force=True)
    except Exception:
        pass
    threading.Thread(target=lambda: history_for(slot), daemon=True).start()


def _verify_wallet(slot: str, qr_id: str) -> None:
    try:
        _verify_wallet_inner(slot, qr_id)
    finally:
        _relogin_pending.discard(slot)


def pending_wallet(slot: str) -> dict[str, Any]:
    p = _pending_wallets.get(slot)
    if not p:
        return {"status": "missing"}
    return {k: v for k, v in p.items() if k != "qrCodeId"}


def set_wallet_trade(wallet_id: str, trade: bool) -> dict[str, Any]:
    with _config_lock:
        w = WALLET_BY_ID.get(wallet_id)
        if not w:
            return {"ok": False, "error": "wallet not found"}
        w["trade"] = bool(trade)
        save_wallet_config()
    return {"ok": True, "wallet": dict(w)}


def rename_wallet(wallet_id: str, label: str) -> dict[str, Any]:
    clean = str(label or "").strip()[:30]
    if not clean:
        raise ValueError("label required")
    with _config_lock:
        w = WALLET_BY_ID.get(wallet_id)
        if not w:
            return {"ok": False, "error": "wallet not found"}
        w["label"] = clean
        save_wallet_config()
    return {"ok": True, "wallet": dict(w)}


def remove_wallet(wallet_id: str) -> dict[str, Any]:
    if wallet_id not in WALLET_BY_ID:
        return {"ok": False, "error": "wallet not found"}
    with _config_lock:
        _apply_wallets([w for w in WALLETS if w["id"] != wallet_id])
        save_wallet_config()
    _keepalive.get("wallets", {}).pop(wallet_id, None)
    with _cache_lock:
        _history_cache.pop(wallet_id, None)
    _balance_cache["ts"] = 0
    try:
        refresh_balances(force=True)
    except Exception:
        pass
    return {"ok": True, "removed": wallet_id}


# ---------------------------------------------------------------- keepalive
def load_keepalive() -> None:
    global _keepalive
    try:
        _keepalive = json.loads((DATA / "keepalive.json").read_text(encoding="utf-8"))
    except Exception:
        _keepalive = {"wallets": {}, "at": None}


def save_keepalive() -> None:
    try:
        tmp = DATA / "keepalive.json.tmp"
        tmp.write_text(json.dumps(_keepalive, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(DATA / "keepalive.json")
    except Exception:
        pass


def keepalive_once() -> None:
    global _keepalive
    out: dict[str, dict[str, Any]] = {}

    def check(w: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        try:
            r = baw(w["id"], ["wallet", "status", "--json"], timeout=20)
            raw = str(((r.get("data") or {}).get("status") or ("CONNECTED" if r.get("success") else "UNKNOWN"))).upper()
            return w["id"], {
                "at": now_iso(),
                "status": raw if raw in ("CONNECTED", "UNCONNECTED") else "UNKNOWN",
                "error": None if r.get("success") else err_text(r),
            }
        except Exception as exc:  # noqa: BLE001
            return w["id"], {"at": now_iso(), "status": "UNKNOWN", "error": repr(exc)[:160]}

    with ThreadPoolExecutor(max_workers=max(1, min(6, len(WALLETS)))) as pool:
        for wid, state in pool.map(check, WALLETS):
            out[wid] = state
    with _cache_lock:
        _keepalive = {"wallets": out, "at": now_iso()}
    save_keepalive()


def keepalive_loop() -> None:
    time.sleep(3)
    while True:
        try:
            keepalive_once()
        except Exception:
            pass
        time.sleep(15)


def data_loop() -> None:
    """Keep BAW balances and DEX prices warm so /api/portfolio is instant."""
    time.sleep(1)
    while True:
        try:
            refresh_balances(force=True)
            tokens = all_token_rows(_balance_cache)
            addrs = {address_for_market(a) for a in tokens}
            addrs.add(WBNB)
            dex_snapshot(sorted(addrs))
        except Exception:
            pass
        time.sleep(2.5)


def history_loop() -> None:
    """Prefetch every wallet's records so the History tab never waits."""
    time.sleep(4)
    while True:
        try:
            for wallet in list(WALLETS):
                history_for(wallet["id"])
                time.sleep(0.15)
        except Exception:
            pass
        time.sleep(45)


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "0xStudyAgentic/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep journald small; redact query strings (QR/addresses) and never log bodies/cookies.
        msg = fmt % args
        msg = re.sub(r'(/[^\s"?]+)\?[^\s"]+', r"\1?[redacted]", msg)
        print("%s - %s" % (self.address_string(), msg))

    def _json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        ct = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
              ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml"}.get(path.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _svg(self, body: str, status: int = 200) -> None:
        raw = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _payload(self) -> dict[str, Any]:
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ValueError("body too large")
        raw = self.rfile.read(n) if n else b"{}"
        data = json.loads(raw.decode("utf-8", "replace") or "{}")
        if not isinstance(data, dict):
            raise ValueError("object required")
        if self.headers.get("X-Requested-With") != "agentic":
            raise PermissionError("missing request header")
        return data

    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            qs = urllib.parse.parse_qs(parsed.query)
            if path in ("/", "/index.html"):
                return self._file(ROOT / "static" / "index.html")
            if path == "/app.js":
                return self._file(ROOT / "static" / "app.js")
            if path == "/styles.css":
                return self._file(ROOT / "static" / "styles.css")
            if path.startswith("/assets/"):
                name = path[len("/assets/"):]
                if re.fullmatch(r"[A-Za-z0-9_-]+\.(png|svg|jpg|jpeg)", name):
                    return self._file(ROOT / "static" / "assets" / name)
                return self._json({"error": "not found"}, 404)
            if path == "/api/qr":
                text = (qs.get("text") or [""])[0].strip()
                if not re.fullmatch(r"0x[a-fA-F0-9]{40}", text):
                    return self._json({"error": "invalid address"}, 400)
                svg = qr_svg(text)
                if not svg:
                    return self._json({"error": "qr unavailable"}, 500)
                return self._svg(svg)
            if path == "/api/portfolio":
                wallet = (qs.get("wallet") or ["all"])[0]
                return self._json(build_portfolio(wallet))
            if path == "/api/wallets":
                return self._json({"wallets": WALLETS, "nextSlot": _next_slot})
            if path == "/api/wallets/pending":
                slot = (qs.get("slot") or [""])[0]
                return self._json(pending_wallet(slot))
            if path == "/api/history":
                wallet = (qs.get("wallet") or ["w1"])[0]
                limit = int((qs.get("limit") or ["80"])[0])
                force = str((qs.get("refresh") or ["0"])[0]).lower() in ("1", "true", "yes")
                return self._json(build_history(wallet, min(limit, 300), force=force))
            if path == "/api/keepalive":
                return self._json({"keepalive": _keepalive, "wallets": [w["id"] for w in WALLETS]})
            if path == "/api/health":
                return self._json({"ok": True, "service": "agentic-wallet", "updatedAt": now_iso(),
                                   "balanceAge": round(time.time() - _balance_cache["ts"], 1),
                                   "keepalive": _keepalive})
            if path.startswith("/api/task/"):
                tid = path.rsplit("/", 1)[-1]
                with _task_lock:
                    task = _tasks.get(tid)
                if not task:
                    return self._json({"error": "task not found"}, 404)
                return self._json(task)
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            payload = self._payload()
            if path == "/api/wallets/start":
                return self._json(start_wallet_add(payload))
            if path.startswith("/api/wallets/") and path.endswith("/relogin"):
                wallet_id = path[len("/api/wallets/"):-len("/relogin")].strip("/")
                return self._json(start_wallet_relogin(wallet_id))
            if path.startswith("/api/wallets/") and path.endswith("/rename"):
                wallet_id = path[len("/api/wallets/"):-len("/rename")].strip("/")
                return self._json(rename_wallet(wallet_id, str(payload.get("label") or "")))
            if path.startswith("/api/wallets/") and path.endswith("/trade"):
                wallet_id = path[len("/api/wallets/"):-len("/trade")].strip("/")
                return self._json(set_wallet_trade(wallet_id, payload.get("trade") is True))
            if path == "/api/quote":
                wallet = str(payload.get("wallet") or "w1")
                token = str(payload.get("token") or "").lower()
                try:
                    pct = float(payload.get("pct") or 50)
                except (TypeError, ValueError) as exc:
                    raise ValueError("invalid pct") from exc
                if not math.isfinite(pct) or not (0 < pct <= 100):
                    raise ValueError("invalid pct")
                if wallet not in WALLET_BY_ID or not token:
                    raise ValueError("invalid wallet/token")
                if payload.get("qty") not in (None, ""):
                    qty = parse_positive_amount(payload.get("qty"))
                else:
                    qty, err = qty_for_pct(wallet, token, pct)
                    if err:
                        return self._json({"ok": False, "error": err})
                q = fmt_qty(qty, token)
                return self._json(quote_for(wallet, token, q, payload.get("slippage") or "auto"))
            if path == "/api/sell":
                task = start_sell(payload)
                return self._json(task, 202)
            if path == "/api/send":
                task = start_send(payload)
                return self._json(task, 202)
            return self._json({"error": "not found"}, 404)
        except PermissionError as e:
            return self._json({"error": str(e)}, 403)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"error": str(e)}, 500)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            if self.headers.get("X-Requested-With") != "agentic":
                return self._json({"error": "missing request header"}, 403)
            path = urllib.parse.urlparse(self.path).path
            if path.startswith("/api/wallets/"):
                wallet_id = path.rsplit("/", 1)[-1]
                result = remove_wallet(wallet_id)
                return self._json(result, 200 if result.get("ok") else 404)
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)


def main() -> None:
    load_wallet_config()
    load_balance_cache()
    load_market_cache()
    load_keepalive()
    load_tasks()
    # Warm caches in the background; first page request does not wait for audits.
    threading.Thread(target=data_loop, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    threading.Thread(target=keepalive_loop, daemon=True).start()
    print(f"agentic-wallet listening on 127.0.0.1:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
