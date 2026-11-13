"""TikHub adapter: invokes the bundled tikhub.py only; never reads credentials itself."""
import contextlib
import hashlib
import uuid
import fcntl
import json
import os
import sys
from pathlib import Path
import re
import subprocess
import threading
import time
from urllib.parse import urlsplit
from core import CURRENT, Fail, SAFE_ENV, save_raw, external_path, ts, strip_html, quality_error, now
import routes
import incidents
import sbconfig

CLI = [sys.executable, '-B', str(sbconfig.LIB / 'tikhub.py')]
ROOT = sbconfig.home() / 'state'
LEDGER = sbconfig.home() / 'tikhub' / 'usage.jsonl'
PRICES = sbconfig.LIB / 'prices.json'
UNCERTAIN = ROOT / 'uncertain-charges.jsonl'
PAID_LOCK = threading.Lock()
THROTTLED = False


def error_status(error):
    return {'rate_limit': 'rate_limited', 'permission': 'auth_failed',
            'balance_empty': 'auth_failed'}.get(incidents.paid_error_kind(error), 'connector_failed')


def read_rows():
    rows = []
    if LEDGER.exists():
        for line in LEDGER.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def price(path):
    cfg = json.loads(PRICES.read_text(encoding='utf-8'))
    keys = [k for k in cfg['endpoints'] if path.startswith(k)]
    return float(cfg['endpoints'][max(keys, key=len)]['usd'] if keys else cfg['default']['usd'])


def row_cost(row):
    if not row.get('billable') or row.get('cache_hit'):
        return 0.0
    return price(row.get('endpoint', '')) if row.get('est_usd', 0) else 0.0


def task_spent(task):
    rows = [r for r in read_rows() if r.get('task') == task]
    amount = sum(row_cost(r) for r in rows)
    if UNCERTAIN.exists():
        for line in UNCERTAIN.read_text().splitlines():
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('task') == task and not any(x.get('endpoint') == r['endpoint'] and x.get('epoch', 0) >= r['started_epoch'] and x.get('epoch', 0) <= r.get('ended_epoch', float('inf')) and ('params' not in r or request_matches(x,r['endpoint'],r['params'])) for x in rows):
                amount += r['reserved_usd']
    return round(amount, 6)


def unwrap(doc):
    if incidents.paid_error_kind(doc):
        raise Fail('TikHub: ' + str(doc)[:500], error_status(doc))
    d = doc
    for _ in range(5):
        if not isinstance(d, dict):
            break
        code = d.get('code', d.get('status_code'))
        if d.get('ok') is False:
            raise Fail('TikHub ' + str(d.get('error') or d.get('message') or code), error_status(d))
        if code is not None and str(code) not in ('0', '200'):
            raise Fail('TikHub business code ' + str(code) + ': ' + str(d.get('message', ''))[:200])
        if 'response' in d:
            d = d['response']
        elif 'data' in d and any(k in d for k in ('code', 'status_code', 'router', 'request_id')):
            d = d['data']
        else:
            break
    return d


@contextlib.contextmanager
def budget_lock():
    with PAID_LOCK, (ROOT / '.paid.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@contextlib.contextmanager
def paid_slot():
    # Advisory file locks cap all sourceboard processes at three requests combined.
    while True:
        if THROTTLED:
            raise Fail('本次运行遇到拦截或限流；停止后续付费请求，不连续重试，请稍后低频重试', 'rate_limited')
        for i in range(3):
            f = (ROOT / f'.paid-slot-{i}.lock').open('a')
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                f.close()
                continue
            try:
                yield
            finally:
                f.close()
            return
        time.sleep(.05)


def request_matches(row, path, params):
    if row.get('endpoint') != path:
        return False
    args = row.get('args') or []
    actual = {}
    for i, arg in enumerate(args[:-1]):
        if arg == '--param':
            k, _, v = args[i+1].partition('='); actual[k] = v
        elif arg == '--json':
            try:
                actual.update({k: str(v) for k, v in json.loads(args[i+1]).items() if k != 'raw'})
            except ValueError:
                pass
    return actual == {k: str(v) for k, v in params.items() if k != 'raw'}


def call(path, params, method=None):
    for attempt_index in range(2):
        try:
            return _call_once(path, params, method)
        except Fail as e:
            if not getattr(e, "transport_retry", False) or attempt_index:
                raise


def _call_once(path, params, method=None):
    global THROTTLED
    ctx = CURRENT.get()
    if ctx and ctx.no_paid:
        raise Fail('--no-paid：TikHub 已禁用', 'not_attempted')
    if not sbconfig.get('TIKHUB_API_KEY'):
        raise Fail('还没配置 TikHub 钥匙：在你自己的终端运行 sourceboard setup', 'auth_failed')
    external_path(ROOT)
    ROOT.mkdir(parents=True, exist_ok=True)
    task = os.environ.get('TIKHUB_TASK') or 'sourceboard-' + time.strftime('%Y%m%d')
    # 没给任务预算时，用配置里的每日上限（setup 时设的）；都没有才不限。
    budget = float(os.environ.get('TIKHUB_BUDGET_USD') or sbconfig.get('SOURCEBOARD_DAILY_BUDGET_USD') or 'inf')
    cost = price(path)
    reservation_path = ROOT / 'paid-reservations.json'
    ident = uuid.uuid4().hex
    with paid_slot():
        with budget_lock():
            pending = json.loads(reservation_path.read_text()) if reservation_path.exists() else {}
            # A killed caller can still have incurred a charge: preserve its reservation.
            for key, v in list(pending.items()):
                try:
                    os.kill(v['pid'], 0)
                except ProcessLookupError:
                    with UNCERTAIN.open('a') as out:
                        out.write(json.dumps({**v, 'started_epoch': v['started_epoch'], 'note': 'caller exited before reconciliation'}) + '\n')
                    del pending[key]
            spent = task_spent(task)
            reserved = sum(v['reserved_usd'] for v in pending.values() if v['task'] == task)
            if spent + reserved + cost > budget + 1e-9:
                raise Fail(f'预算不足：已估算 ${spent:.4f}，在途 ${reserved:.4f}，本接口 ${cost:.4f}，预算 ${budget:.4f}', 'not_attempted')
            before = len(read_rows())
            pending[ident] = {'pid': os.getpid(), 'task': task, 'endpoint': path, 'params':params, 'started_epoch': time.time(), 'reserved_usd': cost}
            reservation_path.write_text(json.dumps(pending))
        verb = method or ('post' if path.startswith(('/api/v1/wechat_mp/', '/api/v1/wechat_channels/')) else 'get')
        args = [*CLI, verb, '--path', path]
        if verb == 'post':
            body = dict(params)
            if path.startswith(('/api/v1/wechat_mp/', '/api/v1/wechat_channels/')):
                body['raw'] = False
            args += ['--json', json.dumps(body, ensure_ascii=False)]
        else:
            for k, v in params.items():
                args += ['--param', f'{k}={v}']
        args += ['--timeout', '45', '--full']
        env = dict(SAFE_ENV, TIKHUB_TASK=task, TIKHUB_BUDGET_USD=str(budget), TIKHUB_QUIET='1', SOURCEBOARD_BUDGET_CHECKED='1')
        uncertain = False
        try:
            incidents.paid_used()
            try:
                p = subprocess.run(args, capture_output=True, text=True, env=env, timeout=110)
            except subprocess.TimeoutExpired:
                uncertain = True
                save_raw('tikhub-timeout', {'endpoint': path, 'charge_uncertain': True, 'reserved_usd': cost})
                incidents.paid_error(path, 'timeout')
                raise Fail('TikHub CLI超时；费用未确定，保留预留，不自动重试') from None
            rows = [r for r in read_rows()[before:] if r.get('task') == task and request_matches(r, path, params)]
            est = sum(row_cost(r) for r in rows)
            ledger_est = sum(r.get('est_usd', 0) for r in rows)
            if ctx:
                ctx.cost += est; ctx.ledger_cost += ledger_est
                ctx.paid_calls.append({'endpoint': path, 'estimated_usd': est, 'cli_estimated_usd': ledger_est, 'cache_hit': bool(rows and all(r.get('cache_hit') for r in rows)), 'ledger_files': [r.get('file') for r in rows]})
            save_raw('tikhub-stderr', p.stderr, 'log')
            try:
                doc = json.loads(p.stdout)
            except ValueError:
                save_raw('tikhub-invalid', p.stdout, 'log')
                error = p.stdout + '\n' + p.stderr
                kind = incidents.paid_error_kind(error)
                if kind:
                    incidents.paid_error(path, error)
                    status = error_status(error)
                    if status == 'rate_limited': THROTTLED = True
                    raise Fail('TikHub: ' + error[-500:], status) from None
                if incidents.transport_error(error):
                    uncertain = not rows
                    incidents.paid_error(path, error)
                    failure = Fail('TikHub 网络传输中断；响应不完整，最多重试一次；见 raw/')
                    failure.transport_retry = True
                    raise failure from None
                if p.returncode:
                    incidents.paid_error(path, error)
                    raise Fail('TikHub CLI执行失败：' + error[-500:]) from None
                incidents.schema(path.split('/')[3], incidents.capability_for(path), path)
                raise Fail('TikHub full output is not JSON; see raw/') from None
            save_raw('tikhub-' + path.split('/')[-1], doc)
            if p.returncode:
                incidents.paid_error(path, doc)
                msg = str(doc.get('error') or doc.get('message') or doc) if isinstance(doc, dict) else str(doc)
                status = error_status(doc)
                if not incidents.paid_error_kind(doc) and incidents.transport_error(doc):
                    uncertain = not rows
                    failure = Fail('TikHub 网络传输中断；响应不完整，最多重试一次；见 raw/')
                    failure.transport_retry = True
                    raise failure
                if status == 'rate_limited': THROTTLED = True
                raise Fail('TikHub: ' + msg[:500], status)
            try:
                return unwrap(doc)
            except Fail as e:
                incidents.paid_error(path, doc)
                if e.status == 'rate_limited': THROTTLED = True
                raise
        finally:
            with budget_lock():
                pending = json.loads(reservation_path.read_text())
                reservation = pending.pop(ident, None)
                if uncertain and reservation:
                    reservation['ended_epoch'] = time.time()
                    with UNCERTAIN.open('a') as out: out.write(json.dumps(reservation) + '\n')
                    if ctx:
                        ctx.cost += cost
                        ctx.paid_calls.append({'endpoint': path, 'estimated_usd': cost, 'charge_uncertain': True})
                reservation_path.write_text(json.dumps(pending))
                total = task_spent(task)
                marker = ROOT / ('.budget-half-' + hashlib.sha256(task.encode()).hexdigest()[:12])
                if budget != float('inf') and total >= budget/2 and not marker.exists():
                    print(f'提示：今天的估算花费已过预算一半（${total:.4f} / ${budget:.2f}），到上限后会停止付费调用。', file=sys.stderr)
                    marker.write_text(now())


def walk(obj):
    if isinstance(obj, dict):
        yield obj
        for value in obj.values():
            yield from walk(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from walk(value)


def pick(d, *keys):
    for key in keys:
        v = d.get(key)
        if v is not None and v != '':
            return v
    return None


def author(d):
    a = pick(d, 'author', 'user', 'user_info', 'owner', 'member', 'authorInfo')
    if isinstance(a, list):
        a = a[0] if a else {}
    if isinstance(a, dict):
        return str(pick(a, 'nickname', 'nick_name', 'name', 'uname', 'username', 'screen_name', 'display_name', 'displayName', 'handle', 'title') or '')
    return str(a or pick(d, 'author_name', 'nickname', 'channel', 'channelTitle') or '')


def normalize_detail(res, d):
    p = res.platform
    nodes = list(walk(d))
    if p in ('douyin', 'tiktok'):
        v = next((x for x in nodes if 'aweme_id' in x and ('video' in x or 'images' in x)), {})
        res.title = res.text = v.get('desc', '')
        res.author, res.published = author(v), ts(v.get('create_time'))
        stats = v.get('statistics') or {}
        res.stats = {k: stats.get(s) for k, s in (('likes', 'digg_count'), ('comments', 'comment_count'), ('shares', 'share_count'), ('collects', 'collect_count'))}
        for image in v.get('images') or []:
            urls = image.get('url_list') or []
            if urls:
                res.images.append(urls[-1])
        video = v.get('video') or {}
        cover = (video.get('origin_cover') or video.get('cover') or {}).get('url_list') or []
        res.images += cover[:1]
        play = (video.get('play_addr') or {}).get('url_list') or []
        if play:
            clean_video = getattr(CURRENT.get(), 'clean_video', False)
            res.videos.append(play[0].replace('playwm', 'play') if clean_video else play[0])
        return
    if p == 'wechat_channels':
        v = next((x for x in nodes if 'media' in x and ('id' in x or 'title' in x)), {})
        res.id = str(v.get('id') or res.id)
        res.title = str(v.get('title') or v.get('description') or '')
        res.text = str(v.get('description') or res.title)
        res.author, res.published = author(v), ts(v.get('create_time'))
        res.stats = {k: v.get(field) for k, field in (('likes','like_count'), ('comments','comment_count'), ('collects','fav_count'), ('shares','forward_count'))}
        media = v.get('media') or []
        if isinstance(media, dict): media = [media]
        res.extra['wechat_media'] = []
        for item in media:
            url = item.get('full_url') or (item.get('url', '') + (item.get('url_token') or ''))
            if isinstance(url, str) and url.startswith(('http://', 'https://')):
                res.videos.append(url)
                res.extra['wechat_media'].append({'url':url, 'duration':item.get('duration'), 'file_size':item.get('file_size')})
            cover = item.get('cover_url')
            if isinstance(cover, str) and cover.startswith(('http://','https://')):
                res.images.append(cover + (item.get('cover_url_token') or ''))
        return
    if p == 'bilibili':
        v = next((x for x in nodes if 'title' in x and ('owner' in x or 'stat' in x)), {})
        res.title, res.text = v.get('title', ''), v.get('desc', '')
        res.author, res.published = author(v), ts(v.get('pubdate') or v.get('ctime'))
        stat = v.get('stat') or {}
        res.stats = {k: stat.get(s) for k, s in (('views', 'view'), ('likes', 'like'), ('comments', 'reply'), ('shares', 'share'), ('collects', 'favorite'), ('coins', 'coin'))}
        if v.get('pic'):
            res.images.append(v['pic'])
        res.extra.update(aid=v.get('aid'), cid=v.get('cid'),duration=v.get('duration'))
        return
    if p == 'xiaohongshu':
        candidates = [x for x in nodes if any(k in x for k in ('desc', 'description', 'model_type')) and any(k in x for k in ('user', 'image_list', 'images_list', 'interact_info', 'note_id', 'id'))]
        # An unavailable target can be followed by unrelated recommendation
        # cards, including full descriptions. Never use those as the target.
        v = next((x for x in candidates if str(pick(x, 'note_id', 'id') or '') == res.id), {}) if res.id else next(iter(candidates), {})
        if v.get('model_type') == 'error':
            raise Fail('目标笔记不可用：' + str(v.get('text') or 'unavailable'))
        res.title = v.get('title', '')
        res.text = str(pick(v, 'desc', 'description', 'content') or '')
        res.author, res.published = author(v), ts(pick(v, 'time', 'timestamp', 'create_time'))
        stat = v.get('interact_info') or v.get('interactInfo') or v
        res.stats = {k: pick(stat, *keys) for k, keys in (
            ('likes', ('liked_count', 'likes', 'likedCount')), ('comments', ('comments_count', 'comment_count', 'commentCount')),
            ('collects', ('collected_count', 'collectedCount')), ('shares', ('shared_count', 'share_count', 'shareCount')))}
        for image in v.get('image_list') or v.get('images_list') or []:
            if isinstance(image, str):
                res.images.append(image)
            else:
                u = pick(image, 'url_size_large', 'url_default', 'url', 'urlDefault', 'original')
                if not u:
                    u = next((x.get('url') for x in image.get('info_list', []) if x.get('url')), None)
                if u:
                    res.images.append(u)
        for node in walk(v.get('video', {})):
            if node.get('master_url'):
                res.videos.append(node['master_url'])
        return
    if p == 'x':
        v = next((x for x in nodes if 'full_text' in x), {})
        res.text = v.get('full_text', '')
        res.title = res.text[:100]
        user = next((x for x in nodes if 'screen_name' in x), {})
        res.author = str(user.get('name') or user.get('screen_name') or '')
        res.published = ts(v.get('created_at'))
        res.stats = {k: v.get(s) for k, s in (('likes', 'favorite_count'), ('shares', 'retweet_count'), ('comments', 'reply_count'))}
        return
    # Other interfaces expose documented normalized data with title/text/body fields.
    if p == 'wechat':
        from platforms.wechat import message_content
        message = next((x for x in nodes if 'item_show_type' in x or 'real_item_show_type' in x), None)
        if message is not None and message_content(res, message):
            return
        v = next((x for x in nodes if any(isinstance(x.get(k), str) and x[k] for k in ('content_noencode', 'content_text', 'content_html', 'html_content', 'article_content'))), None)
        if v is not None:
            from platforms.wechat import article_images
            body = pick(v, 'content_noencode', 'content_html', 'html_content', 'article_content', 'content_text') or ''
            res.text = strip_html(body)
            res.title = str(v.get('title') or res.text[:100])
            res.author = str(pick(v, 'nick_name', 'nickname', 'author') or '')
            res.published = ts(pick(v, 'create_timestamp', 'ori_create_time', 'create_time', 'publish_time'))
            cover = pick(v, 'cdn_url', 'cover', 'cover_url')
            from platforms.wechat import qpic_image
            cover = qpic_image(cover)
            res.images = list(dict.fromkeys(([cover] if cover else []) + article_images(body)))
            return
        v = next((x for x in nodes if isinstance(x.get('content'), str) and any(k in x for k in ('title', 'nickname', 'author'))), None)
        v = v or next((x for x in nodes if any(k in x for k in ('content_html', 'html_content', 'content_text', 'article_content'))), {})
    elif p == 'reddit':
        v = next((x for x in nodes if 'title' in x and any(k in x for k in ('selftext', 'content', 'body', 'score'))), {})
    else:
        v = next((x for x in nodes if any(isinstance(x.get(k), str) and x.get(k) for k in ('full_text', 'text', 'description', 'body_html', 'content', 'desc')) and any(k in x for k in ('author', 'user', 'title', 'id', 'nickname', 'owner'))), {})
    res.title = str(pick(v, 'title', 'headline') or '')
    text = pick(v, 'full_text', 'text', 'selftext', 'content_text', 'content_html', 'html_content', 'article_content', 'body_html', 'body', 'description', 'desc', 'content') or ''
    if isinstance(text, dict):
        text = pick(text, 'text', 'html', 'body') or ''
    res.text = strip_html(text)
    res.title = res.title or res.text[:100]
    res.author = author(v)
    res.published = ts(pick(v, 'published_at', 'publish_time', 'create_time', 'created_time', 'created_at', 'timestamp', 'date', 'created', 'publish_timestamp'))
    res.stats = {k: pick(v, *keys) for k, keys in (('likes', ('like_count', 'likes', 'digg_count', 'favorite_count', 'attitudes_count')), ('comments', ('comment_count', 'comments_count', 'reply_count')), ('views', ('view_count', 'views')), ('shares', ('share_count', 'repost_count', 'reposts_count')))}
    if p=='zhihu' and v.get('voteup_count') is not None:
        res.stats['votes']=v['voteup_count'];res.stats_sources['votes']='TikHub voteup_count（赞同）'
    if p=='wechat_channels':
        for key,field in (('collects','fav_count'),('shares','forward_count')):
            if v.get(field) is not None:res.stats[key]=v[field]
    for node in walk(v):
        for key in ('image_url', 'cover', 'cover_url', 'thumbnail_url', 'original_url'):
            u = node.get(key)
            if isinstance(u, str) and u.startswith('http'):
                res.images.append(u)
        for key in ('video_url', 'play_url', 'download_url'):
            u = node.get(key)
            if isinstance(u, str) and u.startswith('http'):
                res.videos.append(u)


def detail(res):
    path, key = routes.DETAIL[res.platform]
    value = res.id
    if key in ('url', 'code_or_url', 'share_url'):
        value = res.url
    if res.platform == 'bilibili':
        value = routes.bv_to_av(res.id) if res.id.startswith('BV') else res.id.removeprefix('av')
    if res.platform == 'reddit':
        value = 't3_' + res.id
    if res.platform == 'zhihu':
        if '/pin/' in res.url:
            path, key = '/api/v1/zhihu/web/fetch_pin_detail', 'pin_id'
        elif '/p/' in res.url:
            path, key = '/api/v1/zhihu/web/fetch_column_article_detail', 'article_id'
        elif '/answer/' not in res.url:
            raise Fail('知乎只接受回答、文章或想法单条链接')
    if not value:
        raise Fail('链接中缺少作品 ID；无法安全调用详情接口')
    d = call(path, {key: value})
    if res.platform == 'xiaohongshu' and d == []:
        # This is a recognized empty upstream response, not a parser schema
        # change. It cannot establish whether a post is deleted or restricted.
        raise Fail('目标笔记返回空数据；上游未提供正文，无法确认是删除、私密或暂不可用；可能已计费，未自动付费重试')
    normalize_detail(res, d)
    error = quality_error(res)
    if error:
        if res.platform == 'wechat' and '暂不支持的类型' in res.capabilities['content'].get('note',''):
            raise Fail(res.capabilities['content']['note'])
        kind = res.extra.get('wechat_item_show_type') if res.platform == 'wechat' else None
        if kind not in (None, 0, 8, 10):
            incidents.unsupported_type('wechat', path, f'item_show_type={kind}')
            raise Fail(f'公众号暂不支持的类型：item_show_type={kind}')
        incidents.schema(res.platform, 'content', path, error+' '+str(d))
        raise Fail('quality_gate: ' + error)


def comment_items(d):
    """Recognize real comment records, never treat a schema mismatch as zero."""
    found, seen, recognized_empty = [], set(), isinstance(d, list) and not d
    top = d
    while isinstance(top, dict) and isinstance(top.get('data'), dict):
        top = top['data']
    if isinstance(top, dict):
        recognized_empty = any(isinstance(top.get(k), list) and not top[k] for k in ('comments', 'replies', 'comment_list', 'commentList', 'items', 'selected_comment', 'edges'))
    for node in walk(d):
        content = node.get('content')
        text = pick(node, 'text', 'full_text', 'body', 'comment_text', 'commentText', 'content_text')
        if isinstance(content, dict):
            text = text or pick(content, 'message', 'text', 'body', 'markdown', 'html')
        elif isinstance(content, str):
            text = text or content
        if isinstance(node.get('caption'), dict) and node.get('user'):
            text = text or node['caption'].get('text')
        if isinstance(text, dict):
            text = pick(text, 'text', 'html')
        if not isinstance(text, str) or not text.strip():
            continue
        a = author(node)
        if not a:
            a = str(pick(node, 'authorName', 'user_name', 'name') or '')
        if not a and not any(k in node for k in ('cid', 'comment_id', 'rpid', 'commentId')):
            continue
        text = strip_html(text)
        ident = str(pick(node, 'cid', 'comment_id', 'rpid', 'commentId', 'id') or '') + text
        if ident in seen:
            continue
        seen.add(ident)
        found.append({'author': a, 'text': text, 'likes': pick(node, 'digg_count', 'like_count', 'comment_like_count', 'likes', 'like', 'score', 'likeCount'), 'time': ts(pick(node, 'create_time', 'ctime', 'created_at', 'createdAt', 'date', 'timestamp', 'time', 'taken_at', 'published_time')), 'id': pick(node, 'cid', 'comment_id', 'rpid', 'commentId', 'id')})
    return found, recognized_empty


def comment_page(res, params):
    route = routes.comment_params(res.platform, res)
    if not route:
        raise Fail('单条链接中缺少评论接口所需 ID；没有调用', 'not_attempted')
    d = call(route[0], params)
    if res.platform == 'instagram':
        top = d.get('data', d) if isinstance(d, dict) else d
        if isinstance(top, dict) and 'items' in top:
            d = {'comments': top['items']}
    if res.platform == 'threads' and isinstance(d, dict):
        posts = [node for node in walk(d.get('edges', [])) if isinstance(node.get('caption'), dict) and node.get('user') and node.get('code') != res.id]
        d = {'comments': posts} if posts else d
    items, empty = comment_items(d)
    # Verified 2026-11-01: YouTube returns only a null continuation for a
    # video with zero comments (CWyXBb0EhiU). Restrict this to that platform
    # and its known terminal shape; arbitrary missing fields stay failures.
    if res.platform == 'youtube' and isinstance(d, dict):
        top = d.get('data', d)
        if isinstance(top, dict) and 'continuation_token' in top and top['continuation_token'] is None and set(top) <= {'continuation_token', 'total', 'total_comments'}:
            empty = all(top.get(k, 0) in (0, '0') for k in ('total', 'total_comments'))
    items = [c for c in items if str(c.get('id')) != res.id]
    res.comments = items
    if items:
        return items, d
    if empty:
        return [], d
    incidents.schema(res.platform, 'comments', route[0])
    raise Fail('quality_gate: 评论响应结构未识别，不能报零条')


def next_cursor(platform, d, previous=None, kind='comments'):
    nodes = list(walk(d))
    # A documented terminal marker wins over stale/nonempty cursor fields.
    if any(n.get(k) in (False, 0, '0') for n in nodes for k in ('has_more', 'hasMore', 'has_next_page') if k in n):
        return None
    keys = {
        'douyin': ('cursor', 'max_cursor') if kind == 'comments' else ('max_cursor',),
        'tiktok': ('cursor',) if kind == 'comments' else ('max_cursor',),
        'xiaohongshu': ('cursor', 'next_cursor', 'nextCursor'),
        'bilibili': ('next_offset', 'next'), 'x': ('next_cursor', 'cursor'),
        'instagram': ('next_pagination_token', 'pagination_token', 'next_max_id', 'end_cursor'),
        'youtube': ('continuation_token', 'continuation'), 'threads': ('end_cursor',),
        'linkedin': ('pagination_token', 'next_pagination_token'), 'reddit': ('after',),
        'weibo': ('max_id',), 'zhihu': ('next_offset', 'offset'),
    }.get(platform, ())
    for key in keys:
        for n in nodes:
            value = n.get(key)
            if value is not None and value != '' and value != previous and value not in (0, '0') and isinstance(value, (str, int)):
                return value
    # X GraphQL encodes the bottom cursor as a timeline entry.
    if platform == 'x':
        return next((n.get('value') for n in nodes if n.get('cursorType') == 'Bottom' and n.get('value') != previous), None)
    return None


def cursor_param(platform, kind='comments'):
    if kind == 'profile' and platform in ('douyin', 'tiktok'): return 'max_cursor'
    return {'instagram':'pagination_token','bilibili':'next_offset','youtube':'continuation_token','threads':'end_cursor','linkedin':'pagination_token','reddit':'after','weibo':'max_id','zhihu':'offset'}.get(platform, 'cursor')


def reddit_comments(res, pages):
    """Consume Reddit's comment forest, including independent reply cursors.

    `pages` is still the maximum number of paid requests, including replies.
    No cursor may cause a duplicate request or silently exceed that limit.
    """
    route = routes.comment_params('reddit', res)
    if not route:
        raise Fail('没有评论接口所需ID，未调用', 'not_attempted')
    path, initial = route
    reply_path = '/api/v1/reddit/app/fetch_comment_replies'
    pending = [(path, dict(initial))]
    scheduled, completed, seen = set(), set(), set()
    rows, fetched, reported_total = [], 0, 0
    stop_reason, note = '', ''

    def request_key(endpoint, params):
        return endpoint, params.get('after', params.get('cursor', ''))

    scheduled.add(request_key(*pending[0]))
    while pending and fetched < pages:
        endpoint, params = pending.pop(0)
        request = request_key(endpoint, params)
        try:
            doc = call(endpoint, params)
            post = doc.get('postInfoById') if isinstance(doc, dict) else None
            forest = post.get('commentForest') if isinstance(post, dict) else None
            if not isinstance(forest, dict) or post.get('id') != 't3_' + res.id:
                raise Fail('quality_gate: Reddit 评论森林结构未识别')
            info = forest.get('pageInfo') or {}
            if not isinstance(info, dict):
                raise Fail('quality_gate: Reddit pageInfo 结构未识别')
            trees = forest.get('trees')
            total = post.get('commentCount')
            if isinstance(total, int):
                reported_total = max(reported_total, total)
            verified_zero = total == 0 and info.get('hasNextPage') is False and not trees
            if not isinstance(trees, list) and not verified_zero:
                raise Fail('quality_gate: Reddit 缺少 trees 且没有明确零评论标记')
            trees = trees or []
            if not trees and info.get('hasNextPage') is not False:
                raise Fail('quality_gate: Reddit 空评论森林缺少终止标记')
            if any(not isinstance(t, dict) or not isinstance(t.get('more') or {}, dict) for t in trees):
                raise Fail('quality_gate: Reddit 评论游标结构未识别')
            nodes = [t['node'] for t in trees if isinstance(t, dict) and isinstance(t.get('node'), dict)]
            items, _ = comment_items({'comments': nodes})
            if nodes and not items:
                raise Fail('quality_gate: Reddit 评论节点文字未识别')
        except Exception as e:
            if str(e).startswith('quality_gate:'):
                incidents.schema('reddit', 'comments', endpoint)
            if not fetched:
                raise
            stop_reason, note = 'page_failed', f'第{fetched + 1}次评论请求失败：{e}'
            break
        fetched += 1
        completed.add(request)
        for c in items:
            key = str(c.get('id') or '') or (c['author'], c['text'])
            if key not in seen:
                rows.append(c)
                seen.add(key)
        root_cursor = False
        # Root pagination first; nested branches retain their own cursors even
        # when pageInfo.hasNextPage is false for the root listing.
        for tree in sorted(trees, key=lambda t: t.get('depth') or 0):
            more = tree.get('more') or {}
            cursor = more.get('cursor')
            if not isinstance(cursor, str) or not cursor:
                continue
            is_reply = bool(tree.get('depth') or str(tree.get('parentId') or '').startswith('t1_'))
            target = reply_path if is_reply else path
            key = 'cursor' if is_reply else 'after'
            root_cursor = root_cursor or not is_reply
            follow = {**initial, key: cursor}
            identity = request_key(target, follow)
            if identity in completed:
                stop_reason, note = 'repeated_cursor', '接口重复返回已读取游标；停止重复付费，评论可能不全'
            elif identity not in scheduled:
                scheduled.add(identity)
                pending.append((target, follow))
        if info.get('hasNextPage') is not False and not root_cursor:
            stop_reason, note = 'missing_cursor', '接口表示还有主评论，但未给可用游标；评论可能不全'
    if not stop_reason and pending:
        stop_reason, note = 'page_limit', '已达到 --comment-pages 请求上限；还有评论或子回复，可增加页数续抓'
    if not stop_reason and reported_total > len(rows):
        stop_reason, note = 'upstream_gap', f'游标已耗尽，但上游总数为{reported_total}，仅返回{len(rows)}条；其余评论可能已删除或不可公开读取'
    complete = not stop_reason
    res.comments = rows
    res.extra['comment_pagination'] = {
        'pages_requested': pages, 'pages_fetched': fetched, 'count': len(rows),
        'reported_total': reported_total, 'complete': complete,
        'stop_reason': stop_reason or 'end', 'pending_cursors': len(pending), 'note': note,
    }
    return 'index_partial' if not complete else 'success' if rows else 'true_zero'


def x_comments(res, pages):
    """TikHub's normalized X response: target metadata + thread + cursor.

    Only thread members are replies. initial_tweets and quoted tweets are
    context; recursive extraction would silently count them as comments.
    `pages` caps paid requests, and a cursor cycle must never be repaid.
    """
    route = routes.comment_params('x', res)
    if not route:
        raise Fail('没有评论接口所需ID，未调用', 'not_attempted')
    path, initial = route
    params = dict(initial)
    rows, seen, requested = [], set(), set()
    fetched, reported_total = 0, None
    stop_reason, note = '', ''
    while fetched < pages:
        cursor = params.get('cursor')
        requested.add(cursor)
        try:
            doc = call(path, params)
            if not isinstance(doc, dict) or str(doc.get('id')) != res.id or not isinstance(doc.get('thread'), list):
                raise Fail('quality_gate: X 目标或 thread 结构未识别')
            next_value = doc.get('cursor')
            if next_value is not None and not isinstance(next_value, str):
                raise Fail('quality_gate: X cursor 结构未识别')
            count = doc.get('replies')
            if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
                reported_total = max(reported_total or 0, count)
            items = []
            for node in doc['thread']:
                if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id']:
                    raise Fail('quality_gate: X thread 评论节点缺少 ID')
                if node['id'] == res.id:
                    continue
                # Project direct fields before using the generic normalizer,
                # which otherwise walks into quotes, media and user metadata.
                record = {k: node[k] for k in ('id', 'text', 'full_text', 'likes', 'created_at') if k in node}
                record['author'] = {'name': author(node)}
                parsed, _ = comment_items(record)
                if len(parsed) != 1 or str(parsed[0]['id']) != node['id']:
                    raise Fail('quality_gate: X thread 评论文字或作者未识别')
                items.extend(parsed)
        except Exception as e:
            if str(e).startswith('quality_gate:'):
                incidents.schema('x', 'comments', path)
            if not fetched:
                raise
            stop_reason, note = 'page_failed', f'第{fetched + 1}页失败：{e}'
            break
        fetched += 1
        for c in items:
            if c['id'] not in seen:
                seen.add(c['id'])
                rows.append(c)
        # Real zero-comment responses carry a stale Bottom cursor. Only the
        # matched target, explicit zero and an empty thread establish zero.
        if not rows and not doc['thread'] and reported_total == 0:
            break
        if not next_value:
            break
        if next_value in requested:
            stop_reason, note = 'repeated_cursor', '接口重复返回已读取游标；停止重复付费，评论可能不全'
            break
        if fetched == pages:
            stop_reason, note = 'page_limit', '已达到 --comment-pages 请求上限；还有游标，可增加页数续抓'
            break
        params = {**initial, 'cursor': next_value}
    if not stop_reason and reported_total is not None and reported_total > len(rows):
        stop_reason, note = 'upstream_gap', f'游标已耗尽，但上游回复数为{reported_total}，仅返回{len(rows)}条；其余回复可能无法公开读取'
    # A terminal empty continuation is valid after a recognized earlier page;
    # a first empty page without a zero count cannot prove zero comments.
    if not rows and reported_total != 0 and not stop_reason:
        stop_reason, note = 'unverified_zero', '接口返回空 thread，但没有明确零回复数；不能确认零评论'
    res.comments = rows
    res.extra['comment_pagination'] = {
        'pages_requested': pages, 'pages_fetched': fetched, 'count': len(rows),
        'reported_total': reported_total, 'complete': not stop_reason,
        'stop_reason': stop_reason or 'end', 'note': note,
    }
    return 'index_partial' if stop_reason else 'success' if rows else 'true_zero'


def comments(res, pages=1):
    if res.platform == 'x':
        return x_comments(res, pages)
    if res.platform == 'reddit':
        return reddit_comments(res, pages)
    route = routes.comment_params(res.platform, res)
    if not route: raise Fail('没有评论接口所需ID，未调用', 'not_attempted')
    params = dict(route[1]); rows = []; seen = set(); fetched = 0; note = ''
    for page in range(pages):
        try:
            items, doc = comment_page(res, params)
        except Exception as e:
            if not fetched: raise
            note = f'第{page+1}页失败：{e}'
            break
        fetched += 1
        for c in items:
            key = (str(c.get('id') or ''), c['author'], c['text'])
            if key not in seen: rows.append(c); seen.add(key)
        key = cursor_param(res.platform)
        cursor = next_cursor(res.platform, doc, params.get(key))
        if cursor is None:
            if fetched < pages: note = '已到末页，或接口未给可用游标；没有重复请求第一页'
            break
        params[key] = cursor
    res.comments = rows
    res.extra['comment_pagination'] = {'pages_requested':pages,'pages_fetched':fetched,'count':len(rows),'note':note}
    return 'index_partial' if '失败' in note else 'success' if rows else 'true_zero'
