#!/usr/bin/env python3
"""SourceBoard 的 TikHub 只读入口。

钥匙只在本程序内部从本机配置文件读取，不进命令行参数、不打印。
在直接请求 TikHub 接口之外，本程序加了四件事：
  1. 每次调用记一笔估算花费（账本）；  2. 同一请求 24 小时内复用缓存，不重复扣费；
  3. 大结果落盘，只回摘要；  4. 预算和余额的软提醒。

用法（一般通过 `sourceboard api ...` 调用）:
  account                          账户与余额摘要(免费)
  usage                            今日/累计调用记录 + 实时余额(免费)
  usage --by task|endpoint|day --since 7d [--task 任务号]
  get --path /api/v1/... --param k=v [--param k=v]    只读 GET
  post --path /api/v1/... --json '{"keyword":"x"}'   只读 POST(一批搜索接口只接受 POST);
                                   仅放行路径末段以 fetch_/get_/search_/multi_get_/check_ 开头的读取类接口
附加开关(任意位置): --full 全量打印; --no-cache 跳过缓存(仍保存新的成功非空结果)。
环境变量: TIKHUB_TASK=任务号; TIKHUB_BUDGET_USD=预算; TIKHUB_QUIET=1 关闭提醒;
  TIKHUB_NO_CACHE=1 跳过缓存; TIKHUB_CACHE_TTL_HOURS=24 调整时长(0禁用)。
单价表: lib/prices.json，按接口最长前缀匹配，未知接口按 $0.01 估算。金额都是估算，不是账单。
成功但空的返回仍按收费估算；超时按可能扣费估算；明确的 HTTP/业务失败按 0 估算。
提醒只写 stderr；直接调用付费接口时，今天的估算花费超过每日预算上限会拒绝（search/grab 另有自己的预算拦截）。
结果与账本在数据目录的 tikhub/ 下（默认 ~/SourceBoard/tikhub/）。
"""
import json
import os
import subprocess
import sys
import time
import hashlib
import math
import re
import fcntl
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sbconfig

ENV_FILE = sbconfig.ENV_FILE
OUT_ROOT = sbconfig.home() / "tikhub"
LEDGER = OUT_ROOT / "usage.jsonl"
PRICES_FILE = sbconfig.LIB / "prices.json"
INLINE_LIMIT = 6000      # 超过这个字符数只回摘要
HEAD_CHARS = 3000
FREE_CMDS = {"account", "usage"}
_PRICE_CACHE = (None, None)


def die(msg, code=2):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def load_env():
    cfg = sbconfig.load_env()
    if os.environ.get("TIKHUB_API_KEY"):
        cfg["TIKHUB_API_KEY"] = os.environ["TIKHUB_API_KEY"]
    if not cfg.get("TIKHUB_API_KEY"):
        die("还没有配置 TikHub 钥匙。先运行 sourceboard setup，按提示把钥匙填进本机配置。")
    return cfg


def read_ledger():
    rows = []
    if LEDGER.is_file():
        for line in LEDGER.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
            except json.JSONDecodeError:
                pass
    return rows


def option(args, flag, default=None):
    value = default
    for i, arg in enumerate(args):
        if arg == flag and i + 1 < len(args):
            value = args[i + 1]
        elif arg.startswith(flag + "="):
            value = arg.split("=", 1)[1]
    return value


def number(value, default=0.0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def price_table():
    global _PRICE_CACHE
    try:
        stat = PRICES_FILE.stat()
        signature = (str(PRICES_FILE), stat.st_mtime_ns, stat.st_size)
        if signature == _PRICE_CACHE[0]:
            return _PRICE_CACHE[1]
        data = json.loads(PRICES_FILE.read_text(encoding="utf-8"))
        if isinstance(data.get("endpoints"), dict):
            _PRICE_CACHE = (signature, data)
            return data
    except (OSError, ValueError, AttributeError):
        pass
    return {"default": {"usd": 0.01, "status": "未核", "timeout": 30}, "endpoints": {}}


def price_for(endpoint):
    table = price_table()
    matches = [p for p in table["endpoints"] if endpoint.startswith(p)]
    item = dict(table.get("default", {}))
    if matches:
        item.update(table["endpoints"][max(matches, key=len)])
    return max(0, number(item.get("usd"), 0.01)), item.get("status", "未核"), max(30, number(item.get("timeout"), 30))


def endpoint_of(row):
    return row.get("endpoint") or option(row.get("args", []), "--path", row.get("cmd", "unknown"))


def cost_of(row):
    if "est_usd" in row:
        return max(0, number(row["est_usd"]))
    if row.get("billable") and row.get("ok"):
        return price_for(endpoint_of(row))[0]
    return 0.0


def response_info(rc, out):
    """保守分类: 无法辨认的结构不缓存;任一非空数据列表优先于空列表。"""
    try:
        parsed = json.loads(out)
    except (ValueError, TypeError):
        return rc == 0, None
    if rc != 0:
        return False, None

    def failed(data):
        codes = [number(data.get(k)) for k in ("code", "status_code")]
        return (data.get("ok") is False or data.get("success") is False
                or any(code >= 400 or code < 0 for code in codes))

    node = parsed
    while isinstance(node, dict):
        if failed(node):
            return False, None
        if "response" not in node:
            break
        node = node["response"]

    containers = {"data", "result", "results", "items", "item_list", "list", "notes", "videos",
                  "tweets", "statuses", "users", "feeds", "entries", "comments", "aweme_list",
                  "search_item_list", "video_list", "rows", "itemList"}
    metadata = {"code", "ok", "success", "message", "msg", "status", "status_code", "status_msg",
                "cursor", "has_more", "hasMore", "total", "count", "page", "page_size", "next_cursor",
                "request_id", "requestId", "time", "timestamp", "router", "params"}

    def empty(data):
        if data is None or data == "":
            return True
        if isinstance(data, list):
            return len(data) == 0
        if not isinstance(data, dict):
            return False if data else None
        if not data:
            return True
        children = [empty(v) for k, v in data.items() if k in containers or isinstance(v, list)]
        if False in children:
            return False
        if True in children:
            return True
        content = [v for k, v in data.items() if k not in metadata and k not in containers]
        return False if any(v not in (None, "", [], {}) for v in content) else None

    # Business failure can also be nested in data envelopes.
    nested = node
    while isinstance(nested, dict):
        if failed(nested):
            return False, None
        if "data" not in nested:
            break
        nested = nested["data"]
    return True, empty(node)


@contextmanager
def saving_lock(name="state", nonblocking=False):
    folder = OUT_ROOT / ".saving"
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / (name + ".lock")).open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def read_state():
    try:
        state = json.loads((OUT_ROOT / ".saving/state.json").read_text())
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(state):
    target = OUT_ROOT / ".saving/state.json"
    temp = target.with_suffix(f".{os.getpid()}.tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)


def append_entry(entry):
    # One write in append mode; all updated CLI processes share the same short lock.
    with saving_lock():
        with LEDGER.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def notify_error():
    if os.environ.get("TIKHUB_QUIET") != "1":
        sys.stderr.write("[tikhub] 提醒/缓存辅助状态不可用，继续原调用。\n")


def account_balance(out):
    try:
        data = json.loads(out)
        if data.get("ok") is False:
            return None
        user = data["user_data"]
        balance = number(user.get("balance"), None)
        if balance is not None:
            return balance
    except (ValueError, KeyError, TypeError, AttributeError):
        pass
    return None


def snapshot_account(out, started, row_count):
    if json.loads(out).get("account_cache", {}).get("hit"):
        return  # Never extend the lifetime or reset the cost baseline of an old snapshot.
    balance = account_balance(out)
    if balance is not None:
        with saving_lock():
            state = read_state()
            if started >= state.get("snapshot", {}).get("time", 0):
                state["snapshot"] = {"time": started, "balance": balance, "rows": row_count}
            state["account_attempt"] = started
            write_state(state)


def bootstrap_snapshot(state, rows):
    if state.get("snapshot"):
        return
    for i in range(len(rows) - 1, -1, -1):
        row = rows[i]
        if row.get("cmd") == "account" and row.get("ok") and row.get("file"):
            try:
                balance = account_balance(Path(row["file"]).read_text())
                if balance is not None:
                    state["snapshot"] = {"time": datetime.fromisoformat(row["ts"]).timestamp(),
                                         "balance": balance, "rows": i + 1}
                    return
            except (OSError, ValueError):
                continue


def refresh_account(env):
    # Wait for the shared refresh: another process's failure must not be hidden.
    with saving_lock("account-refresh"):
        with saving_lock("account-request"):
            try:
                recent = json.loads((OUT_ROOT / ".saving/account-response.json").read_text())
            except (OSError, ValueError):
                recent = {}
        if recent.get('rc') and 0 <= time.time() - recent.get('time', 0) < failure_ttl(recent.get('out', '')):
            return recent['rc'], recent['out'], recent.get('err', '')
        with saving_lock():
            rows, state = read_ledger(), read_state()
            bootstrap_snapshot(state, rows)
            now = time.time()
            snap = state.get("snapshot", {})
            spent = sum(cost_of(r) for r in rows[snap.get("rows", 0):])
            due = not snap or now - snap["time"] >= 600 or spent >= 0.5 - 1e-9
            if not due:
                write_state(state)
                return None
        rc, out, err = run_script("tikhub_api.py", ["--timeout", "30", "account"], env)
        record_result("account", ["account"], rc, out, err, time.time() - now, False,
                      "account", started=now, row_count=len(rows), automatic=True)
        if rc or not response_info(rc, out)[0]:
            return rc or 2, out, err
        return None


def soft_notices(env):
    try:
        with saving_lock():
            rows, state = read_ledger(), read_state()
            today = datetime.now().strftime("%Y-%m-%d")
            task = os.environ.get("TIKHUB_TASK", "")
            task_rows = [r for r in rows if r.get("task", "") == task and (task or r.get("ts", "").startswith(today))]
            task_cost = sum(cost_of(r) for r in task_rows)
            day_cost = sum(cost_of(r) for r in rows if r.get("ts", "").startswith(today))
            snap = state.get("snapshot")
            balance = None if not snap else snap["balance"] - sum(cost_of(r) for r in rows[snap["rows"]:])
            budget = max(0, number(os.environ.get("TIKHUB_BUDGET_USD")))
            scope = ["task", task] if task else ["unnamed", today]
            candidates = []
            if budget:
                for fraction in (0.5, 1, 1.5):
                    if task_cost + 1e-9 >= budget * fraction:
                        label = f"{fraction:.0%}"
                        candidates.append(([*scope, "budget", label], f"预算阈值 {label}"))
            else:
                for threshold in (1, 3, 5):
                    if task_cost + 1e-9 >= threshold:
                        candidates.append(([*scope, "usd", threshold], f"任务阈值 ${threshold}"))
            for threshold in (3, 6):
                if day_cost + 1e-9 >= threshold:
                    candidates.append(([today, "daily", threshold], f"今日阈值 ${threshold}"))
            if balance is not None:
                for threshold in (2, 1):
                    if balance < threshold:
                        candidates.append(([today, "balance", threshold], f"余额低于 ${threshold}"))
            sent = state.setdefault("notices", {})
            if os.environ.get("TIKHUB_QUIET") != "1":
                for key, label in candidates:
                    token = json.dumps(key, ensure_ascii=False)
                    if token in sent:
                        continue
                    suffix = "；请提醒用户充值" if label.startswith("余额低于") else ""
                    budget_text = f"（预算 ${budget:g}，{task_cost / budget:.0%}）" if budget else ""
                    balance_text = "未知" if balance is None else f"${max(0, balance):.4f}"
                    sys.stderr.write(f"[tikhub] {label}；任务 {task or '(未命名/今日)'} 约 ${task_cost:.4f}{budget_text}；今日约 ${day_cost:.4f}；余额约 {balance_text}{suffix}\n")
                    sent[token] = time.time()
            write_state(state)
    except Exception:
        notify_error()


def request_key(cmd, args, env):
    if cmd not in ("get", "post"):
        return None
    path = option(args, "--path")
    if not path or not path.startswith("/api/v1/") or ".." in path:
        return None
    if cmd == "post" and not re.match(r"^(fetch|get|search|multi_get|check)_", path.rsplit("/", 1)[-1]):
        return None
    try:
        params = {}
        for i, arg in enumerate(args):
            value = args[i + 1] if arg == "--param" and i + 1 < len(args) else arg[8:] if arg.startswith("--param=") else None
            if value is not None:
                k, sep, v = value.partition("=")
                if not sep or not k.strip():
                    return None
                params[k.strip()] = v
        body = json.loads(option(args, "--json", "{}")) if cmd == "post" else None
        if cmd == "post" and not isinstance(body, dict):
            return None
        base = option(args, "--base-url", env.get("TIKHUB_BASE_URL") or sbconfig.DEFAULT_BASE)
        # Do not bypass the backend's validation of unknown/invalid arguments.
        if number(option(args, "--timeout", "30"), None) is None:
            return None
        allowed = {"--path", "--base-url", "--timeout", "--output"}
        allowed.add("--param" if cmd == "get" else "--json")
        if args.count(cmd) != 1:
            return None
        i = 0
        while i < len(args):
            arg = args[i]
            if arg == cmd:
                i += 1
            elif arg.split("=", 1)[0] in allowed:
                if "=" not in arg and i + 1 == len(args):
                    return None
                i += 1 if "=" in arg else 2
            else:
                return None
        canonical = [cmd, base.rstrip("/"), path, params, body]
        return hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    except (ValueError, TypeError):
        return None


def cached_result(key, ttl):
    now = time.time()
    for row in reversed(read_ledger()):
        if row.get("request_key") != key or row.get("cache_hit") or not row.get("ok") or row.get("empty") is not False:
            continue
        if not 0 <= now - row.get("epoch", 0) < ttl * 3600:
            continue
        try:
            original = Path(row.get("cache_file") or row["file"])
            out = original.read_text(encoding="utf-8")
            if response_info(row["rc"], out) != (True, False):
                continue
            return row, original, out
        except (OSError, ValueError, KeyError):
            continue
    return None


def record_result(cmd, args, rc, out, err, elapsed, billable, endpoint,
                  key=None, hit=None, payload=None, started=None, row_count=0, automatic=False):
    now = datetime.now()
    run_dir = OUT_ROOT / "runs" / now.strftime("%Y-%m-%d")
    run_dir.mkdir(parents=True, exist_ok=True)
    run_file = hit[1] if hit else run_dir / f"{now.strftime('%H%M%S%f')}-{os.getpid()}-{cmd}.json"
    if not hit:
        run_file.write_text(out, encoding="utf-8")
    ok, empty = response_info(rc, payload if payload is not None else out)
    usd, status, _ = price_for(endpoint)
    timeout = bool(re.search(r"timed?\s*out|timeout|超时", out + err, re.I)) and not ok
    # HTTP failures (notably an unpaid 402 mentioning an upstream timeout) are not charges.
    if re.search(r"HTTP\s+[45]\d\d|\"(?:code|status_code)\"\s*:\s*[45]\d\d", out, re.I):
        timeout = False
    estimate = usd if billable and (ok or timeout) else 0.0
    entry = {"ts": now.strftime("%Y-%m-%d %H:%M:%S"), "epoch": time.time(), "cmd": cmd,
             "billable": billable, "args": args[:40], "rc": rc, "ok": ok,
             "secs": round(elapsed, 1), "bytes": len(out), "file": str(run_file),
             "endpoint": endpoint, "est_usd": estimate, "price_status": status,
             "cost_basis": "超时可能扣费" if timeout else "单价估算", "task": os.environ.get("TIKHUB_TASK", ""),
             "empty": empty if ok else None, "cache_hit": bool(hit)}
    if key:
        entry["request_key"] = key
    if payload is not None and not hit and ok and empty is False:
        cache_file = run_file.with_suffix(".response.json")
        cache_file.write_text(payload, encoding="utf-8")
        entry["cache_file"] = str(cache_file)
    if automatic:
        entry["automatic"] = True
    append_entry(entry)
    if cmd == "account" and ok:
        snapshot_account(out, started if started is not None else time.time(), row_count)
    return run_file


def prepare_args(cmd, argv, timeout):
    if cmd == "post":
        return argv if option(argv, "--timeout") is not None else [*argv, "--timeout", str(timeout)]
    globals_, rest = [], []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg.split("=", 1)[0] in {"--timeout", "--output", "--base-url"}:
            globals_.append(arg)
            if "=" not in arg and i + 1 < len(argv):
                i += 1
                globals_.append(argv[i])
        else:
            rest.append(arg)
        i += 1
    if option(globals_, "--timeout") is None:
        globals_ = ["--timeout", str(timeout), *globals_]
    return [*globals_, *rest]


def usage_output(argv, rows, env, fresh_account=False):
    import argparse
    ap = argparse.ArgumentParser(prog="sourceboard api usage")
    ap.add_argument("--by", choices=("task", "endpoint", "day"))
    ap.add_argument("--since", help="例如7d/24h/30m或ISO日期")
    ap.add_argument("--task")
    a, _ = ap.parse_known_args(argv[argv.index("usage") + 1:])
    cutoff = None
    if a.since:
        match = re.fullmatch(r"(\d+(?:\.\d+)?)([dhm])", a.since)
        try:
            cutoff = datetime.now() - timedelta(seconds=float(match[1]) * {"d": 86400, "h": 3600, "m": 60}[match[2]]) if match else datetime.fromisoformat(a.since)
            if cutoff.tzinfo:
                cutoff = cutoff.astimezone().replace(tzinfo=None)
        except ValueError:
            ap.error("--since 应为7d/24h/30m或ISO日期")
    mine = [r for r in rows if r.get("billable")]
    by_day = {}
    for row in mine:
        day = row.get("ts", "")[:10]
        by_day[day] = by_day.get(day, 0) + 1
    before = len(rows)
    started = time.time()
    rc, out, err = run_script("tikhub_api.py", ["--timeout", "30", "account"], env, force_account=fresh_account)
    try:
        record_result("account", ["account"], rc, out, err, time.time() - started, False,
                      "account", started=started, row_count=before, automatic=True)
    except Exception:
        notify_error()
    try:
        account = compact_account(json.loads(out))
    except ValueError:
        account = {"raw": out[:300]}

    def selected(row):
        if not (row.get("billable") or row.get("cache_hit")):
            return False
        if a.task is not None and row.get("task", "") != a.task:
            return False
        if cutoff:
            try:
                return datetime.fromisoformat(row["ts"]) >= cutoff
            except (KeyError, ValueError):
                return False
        return True

    def summarize(items):
        measured = [r for r in items if r.get("ok") and not r.get("cache_hit") and isinstance(r.get("empty"), bool)]
        return {"est_usd": round(sum(cost_of(r) for r in items), 6), "calls": len(items),
                "billable_calls": sum(bool(r.get("billable")) for r in items),
                "empty_rate": sum(r["empty"] for r in measured) / len(measured) if measured else None,
                "empty_known": len(measured), "cache_hits": sum(bool(r.get("cache_hit")) for r in items),
                "unverified_calls": sum(price_for(endpoint_of(r))[1] == "未核" for r in items if not r.get("cache_hit"))}

    selected_rows = [r for r in rows if selected(r)]
    groups = {}
    if a.by:
        for row in selected_rows:
            name = row.get("task", "") if a.by == "task" else endpoint_of(row) if a.by == "endpoint" else row.get("ts", "")[:10]
            groups.setdefault(name, []).append(row)
    result = {"ok": rc == 0 and bool(account.get("ok")), "今日调用": by_day.get(datetime.now().strftime("%Y-%m-%d"), 0),
              "累计调用": len(mine), "按日": by_day, "账户": account, "账本": str(LEDGER),
              "汇总": summarize(selected_rows), "金额口径": "估算；旧行按当前单价补算，旧行空返回未知；失败0，已标记超时按可能扣费计"}
    if a.by:
        result.update({"by": a.by, "since": a.since, "分组": {k: summarize(v) for k, v in sorted(groups.items())}})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return rc or (0 if account.get("ok") else 2)


def compact_account(d):
    """把几十项权限路径压成「数量 + 平台列表」,避免大段输出占上下文。"""
    try:
        data = d.get("api_key_data", {})
        scopes = data.get("api_key_scopes", [])
        plats = sorted({x.split("/")[3] for x in scopes if x.startswith("/api/v1/") and len(x.split("/")) > 3})
        data["api_key_scopes"] = {"数量": len(scopes), "含 /mcp": "/mcp" in scopes, "平台": plats}
    except (AttributeError, IndexError):
        pass
    return d


def over_daily_budget(rows, cost):
    """直接用 `sourceboard api` 调付费接口时也守每日预算。search/grab 走 paid.py，那边已经按预算拦过，不重复拦。"""
    if os.environ.get("SOURCEBOARD_BUDGET_CHECKED") == "1":
        return ""
    budget = number(os.environ.get("TIKHUB_BUDGET_USD") or sbconfig.get("SOURCEBOARD_DAILY_BUDGET_USD"), 0)
    if budget <= 0:
        return ""
    today = datetime.now().strftime("%Y-%m-%d")
    spent = sum(cost_of(r) for r in rows if r.get("ts", "").startswith(today))
    if spent + cost > budget + 1e-9:
        return (f"预算不足：今天已估算 ${spent:.4f}，本接口约 ${cost:.4f}，每日上限 ${budget:g}。"
                "要放宽就运行 sourceboard setup --yes --budget 新的数字")
    return ""


def failure_ttl(out):
    """账户查询失败后多久内不再重试：被限流 10 分钟；钥匙错了不冷却（用户改好就能马上重试）；网络一时断开只等 30 秒。"""
    text = str(out)
    if "网络请求失败" in text:
        return 30
    if re.search(r"HTTP 40[13]\b", text):
        return 0
    return 600


def base_url(args, env):
    base = (option(args, "--base-url") or env.get("TIKHUB_BASE_URL") or sbconfig.DEFAULT_BASE).rstrip("/")
    sbconfig.check_base(base)
    return base


def http_json(method, url, key, body, timeout):
    """发一次请求，返回 (退出码, 解析后的数据或错误文字)。钥匙只放在请求头里。
    连接在拿到任何响应之前就被掐断时，换 TikHub 的另一个官方域名再试一次；
    超时和 HTTP 错误不换、不重试（可能已经扣费）。"""
    import socket, urllib.request, urllib.error
    from urllib.parse import urlsplit
    headers = {"Accept": "application/json", "User-Agent": "sourceboard/0.1"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    host = urlsplit(url).hostname
    urls = [url] + [url.replace("//" + host, "//" + h, 1) for h in sbconfig.TIKHUB_HOSTS if h != host]
    last = ""
    attempts = [urls[0], urls[0]] + urls[1:]  # 连接刚建立就被掐断时，同一域名先隔 1.5 秒再试一次
    for n, target in enumerate(attempts):
        if n:
            time.sleep(1.5)
        req = urllib.request.Request(target, data=data, method=method, headers=headers)
        # 钥匙用“不随跳转转发”的方式放：万一接口返回跳转到别的地址，钥匙不会被带过去。
        req.add_unredirected_header("Authorization", "Bearer " + key)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return 0, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:800].replace(key, "[REDACTED]")
            return 2, f"HTTP {e.code}:{detail}"
        except urllib.error.URLError as e:
            last = f"网络请求失败:{type(e).__name__} {str(e)[:150]}"
            reason = getattr(e, "reason", None)
            if isinstance(reason, (socket.timeout, TimeoutError)) or "timed out" in str(e):
                return 2, last
            continue
        except Exception as e:
            return 2, f"网络请求失败:{type(e).__name__} {str(e)[:150]}"
    return 2, last + "（两个官方域名都连不上）"


def _run_script(script, args, env):
    """只读 GET 和账户查询。返回 (退出码, 标准输出, 标准错误)。"""
    import urllib.parse
    fail = lambda msg: (2, json.dumps({"ok": False, "error": msg}, ensure_ascii=False), "")
    timeout = max(5, number(option(args, "--timeout", "30"), 30))
    try:
        base = base_url(args, env)
    except ValueError as e:
        return fail(str(e))
    key = env["TIKHUB_API_KEY"]
    if "account" in args:
        rc, data = http_json("GET", base + "/api/v1/tikhub/user/get_user_info", key, None, timeout)
        if rc or not isinstance(data, dict):
            return fail(str(data))
        doc = {"ok": True}
        doc.update({k: data[k] for k in ("code", "router", "api_key_data", "user_data") if k in data})
        return 0, json.dumps(doc, ensure_ascii=False, indent=2), ""
    if "get" not in args:
        return fail("不支持的子命令；可用 account / usage / get / post")
    path = option(args, "--path") or ""
    path = path if path.startswith("/") else "/" + path
    if not path.startswith("/api/v1/") or ".." in path:
        return fail("path 必须以 /api/v1/ 开头")
    params = []
    for i, arg in enumerate(args):
        value = args[i + 1] if arg == "--param" and i + 1 < len(args) else arg[8:] if arg.startswith("--param=") else None
        if value is not None:
            k, sep, v = value.partition("=")
            if not sep or not k.strip():
                return fail("--param 要写成 名字=值")
            params.append((k.strip(), v))
    url = base + path + ("?" + urllib.parse.urlencode(params) if params else "")
    rc, data = http_json("GET", url, key, None, timeout)
    if rc:
        return fail(str(data))
    text = json.dumps({"ok": True, "path": path, "response": data}, ensure_ascii=False, indent=2)
    target = option(args, "--output")
    if target:
        target = Path(target).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return 0, json.dumps({"ok": True, "output": str(target)}, ensure_ascii=False) + "\n", ""
    return 0, text, ""


def run_script(script, args, env, force_account=False):
    if script != "tikhub_api.py" or "account" not in args or "--help" in args:
        return _run_script(script, args, env)
    # All paths (account, usage, auto-refresh, grab finish) use this lock.
    # Hold it across the request; cache failures as well, never retry a 429.
    with saving_lock("account-request"):
        target = OUT_ROOT / ".saving/account-response.json"
        try:
            cached = json.loads(target.read_text())
        except (OSError, ValueError):
            cached = {}
        base = option(args, "--base-url", env.get("TIKHUB_BASE_URL", ""))
        output = option(args, "--output")
        # 缓存按钥匙区分：用户换了一把钥匙（比如第一次复制错了重跑 setup），不能拿旧钥匙的失败结果糊弄他。
        key_fp = hashlib.sha256(env.get("TIKHUB_API_KEY", "").encode()).hexdigest()[:16]
        age = time.time() - cached.get("time", 0)
        ttl = 60 if cached.get("rc") == 0 else failure_ttl(cached.get("out", ""))
        # Explicit fresh/output requests bypass successful cache entries only;
        # neither option can bypass a shared account failure cooldown.
        use_cache = not (force_account or output) or cached.get("rc") != 0
        if use_cache and cached.get("base") == base and cached.get("key_fp") == key_fp and 0 <= age < ttl and "out" in cached:
            doc = json.loads(cached["out"])
            doc["account_cache"] = {"hit": True, "age_seconds": round(age, 2)}
            return cached["rc"], json.dumps(doc, ensure_ascii=False), cached.get("err", "")
        # Reserve the next network slot even if a caller dies during the request.
        delay = max(0, 1.1 - (time.time() - cached.get("attempt", 0)))
        if delay:
            time.sleep(delay)
        started = time.time()
        target.write_text(json.dumps({"attempt": started}))
        rc, out, err = _run_script(script, args, env)
        cache_out = out
        if output and rc == 0:
            try:
                cache_out = Path(output).expanduser().resolve().read_text(encoding="utf-8")
            except OSError:
                rc = 2
                out = cache_out = json.dumps({"ok": False, "error": "账户输出文件不可读"}, ensure_ascii=False)
        key = env.get("TIKHUB_API_KEY")
        if key:
            out, err = out.replace(key, "[REDACTED]"), err.replace(key, "[REDACTED]")
            cache_out = cache_out.replace(key, "[REDACTED]")
        try:
            doc = json.loads(cache_out)
            if not isinstance(doc, dict):
                raise ValueError("account response is not an object")
        except ValueError:
            rc = 2
            out = cache_out = json.dumps({"ok": False, "error": "账户响应不是 JSON 对象"}, ensure_ascii=False)
        if not response_info(rc, cache_out)[0]:
            rc = rc or 2
            out = cache_out
        target.write_text(json.dumps({"attempt": started, "time": time.time(), "base": base, "key_fp": key_fp,
                                      "rc": rc, "out": cache_out, "err": err}, ensure_ascii=False))
        return rc, out, err


def run_post(argv, env):
    """只读 POST:TikHub 里有一批搜索/查询接口只接受 POST 请求体。"""
    import argparse
    fail = lambda msg: (2, json.dumps({"ok": False, "error": msg}, ensure_ascii=False), "")
    ap = argparse.ArgumentParser(prog="sourceboard api post")
    ap.add_argument("cmd")
    ap.add_argument("--path", required=True)
    ap.add_argument("--json", default="{}")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--base-url", default=None)
    a, _ = ap.parse_known_args(argv)
    path = a.path if a.path.startswith("/") else "/" + a.path
    if not path.startswith("/api/v1/") or ".." in path:
        return fail("path 必须以 /api/v1/ 开头")
    if not re.match(r"^(fetch|get|search|multi_get|check)_", path.rsplit("/", 1)[-1]):
        return fail("post 只放行读取类接口(末段以 fetch_/get_/search_/multi_get_/check_ 开头)")
    try:
        body = json.loads(a.json)
        assert isinstance(body, dict)
    except (json.JSONDecodeError, AssertionError):
        return fail("--json 必须是 JSON 对象")
    try:
        base = base_url(["--base-url", a.base_url] if a.base_url else [], env)
    except ValueError as e:
        return fail(str(e))
    rc, data = http_json("POST", base + path, env["TIKHUB_API_KEY"], body, a.timeout)
    if rc:
        return fail(str(data))
    return 0, json.dumps({"ok": True, "path": path, "response": data}, ensure_ascii=False, indent=2), ""


def main():
    argv = sys.argv[1:]
    full = "--full" in argv
    no_cache = "--no-cache" in argv or os.environ.get("TIKHUB_NO_CACHE") == "1"
    argv = [a for a in argv if a not in ("--full", "--over-limit", "--no-cache")]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    cfg = load_env()
    env = dict(os.environ)
    env["TIKHUB_API_KEY"] = cfg["TIKHUB_API_KEY"]
    if cfg.get("TIKHUB_BASE_URL"):
        env.setdefault("TIKHUB_BASE_URL", cfg["TIKHUB_BASE_URL"])

    # 子命令可能跟在全局选项(--timeout/--output/--base-url)后面
    opts_with_value = {"--base-url", "--timeout", "--output"}
    cmd, i = None, 0
    while i < len(argv):
        if argv[i] in opts_with_value:
            i += 2
            continue
        if not argv[i].startswith("-"):
            cmd = argv[i]
            break
        i += 1
    if cmd is None:
        die("没有识别到子命令,见 sourceboard api --help")
    if cmd not in ("account", "usage", "get", "post"):
        die("不支持的子命令；可用 account / usage / get / post")

    rows = read_ledger()
    if cmd == "usage":
        return usage_output(argv, rows, env, fresh_account=no_cache)

    billable = cmd not in FREE_CMDS
    endpoint = option(argv, "--path", cmd)
    script = "tikhub_api.py"
    script_args = prepare_args(cmd, argv, price_for(endpoint)[2])
    help_request = "--help" in argv or "-h" in argv
    key = None if help_request else request_key(cmd, script_args, env)
    ttl = max(0, number(os.environ.get("TIKHUB_CACHE_TTL_HOURS", "24"), 24))
    t0 = time.time()
    hit, payload = None, None
    guard = nullcontext()
    try:
        if key and ttl > 0 and not no_cache:
            guard = saving_lock("request-" + key)
            guard.__enter__()
        else:
            guard.__enter__()
    except OSError:
        guard = nullcontext()
        guard.__enter__()
        key = None
        notify_error()
    try:
        if key and not no_cache and ttl > 0:
            try:
                hit = cached_result(key, ttl)
            except Exception:
                notify_error()
        if hit:
            rc, out, err = hit[0]["rc"], hit[2], ""
            target = option(script_args, "--output") if cmd == "get" else None
            if target:
                try:
                    target = Path(target).expanduser().resolve()
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(out, encoding="utf-8")
                    payload = out
                    out = json.dumps({"ok": True, "output": str(target)}, ensure_ascii=False) + "\n"
                except OSError as error:
                    rc, out = 2, json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False) + "\n"
        else:
            if billable and not help_request:
                over = over_daily_budget(rows, price_for(endpoint)[0])
                if over:
                    die(over)
            preflight = refresh_account(env) if billable and not help_request else None
            if preflight:
                rc, out, err = preflight
                billable = False
            else:
                rc, out, err = run_post(script_args, env) if cmd == "post" else run_script(script, script_args, env, force_account=(cmd == "account" and no_cache))
            # --output emits a marker on stdout; classify/cache the actual saved response.
            target = option(script_args, "--output") if cmd == "get" else None
            if target and rc == 0:
                try:
                    payload = Path(target).expanduser().resolve().read_text(encoding="utf-8")
                except OSError:
                    pass
        out = out.replace(cfg["TIKHUB_API_KEY"], "[REDACTED]")
        err = err.replace(cfg["TIKHUB_API_KEY"], "[REDACTED]")
        if payload is not None:
            payload = payload.replace(cfg["TIKHUB_API_KEY"], "[REDACTED]")
        run_file = hit[1] if hit else OUT_ROOT / "runs"
        try:
            run_file = record_result(cmd, script_args, rc, out, err, time.time() - t0,
                                     billable and not hit, endpoint, key, hit, payload,
                                     started=t0, row_count=len(rows))
        except Exception:
            notify_error()
    finally:
        guard.__exit__(None, None, None)

    if not help_request:
        soft_notices(env)

    if err.strip():
        sys.stderr.write(err)
    if cmd == "account":
        try:
            out = json.dumps(compact_account(json.loads(out)), ensure_ascii=False, indent=2) + "\n"
        except json.JSONDecodeError:
            pass
    if full or len(out) <= INLINE_LIMIT:
        sys.stdout.write(out)
    else:
        sys.stdout.write(out[:HEAD_CHARS] + f"\n…(已截断,共 {len(out)} 字符;完整结果: {run_file};要全量请加 --full)\n")
    return rc


if __name__ == "__main__":
    sys.exit(main())
