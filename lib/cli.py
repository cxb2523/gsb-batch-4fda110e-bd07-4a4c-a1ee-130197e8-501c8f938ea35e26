#!/usr/bin/python3
"""sourceboard grab — public single-link content packages, no accounts required."""
import argparse
import concurrent.futures
from dataclasses import dataclass, field
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

import core
from core import CURRENT, Fail, Result, external_path, now
import extras
import paid
import routes
import enrich
import profiles
import board
import sbconfig
import incidents

WRITE_LOCK = threading.Lock()
VERSION = '0.1.0'
_runtime_finished = False
_pending_summary = None


def finish_runtime():
    global _runtime_finished, _pending_summary
    if not _runtime_finished:
        _runtime_finished = True
        incidents.safe(incidents.finish_paid)
        _pending_summary = incidents.emit_pending()
    return _pending_summary


def print_json(data):
    data['pending_incidents'] = finish_runtime()
    print(json.dumps(data, ensure_ascii=False, separators=(',', ':')))


@dataclass
class Context:
    out: Path
    timeout: int
    no_paid: bool
    raw_counter: int = 0
    cost: float = 0
    ledger_cost: float = 0
    ytdlp: dict = field(default_factory=dict)
    clean_video: bool = False
    paid_calls: list = field(default_factory=list)


def progress(note):
    return


def paid_attempt(res, cap, fn):
    import copy
    before = copy.deepcopy(res.__dict__)
    start = time.monotonic()
    try:
        status = fn(res)
        res.log(cap, 'TikHub ' + cap, True, elapsed=time.monotonic()-start, paid=True, status=status or 'success')
        return True
    except Exception as e:
        res.__dict__.update(before)
        res.log(cap, 'TikHub ' + cap, False, str(e), time.monotonic()-start, paid=True, status=getattr(e, 'status', 'connector_failed'))
        return False


def resolve_url(platform, url):
    host = urlsplit(url).hostname or ''
    if host in ('v.douyin.com', 'b23.tv', 'xhslink.com', 'vm.tiktok.com', 'vt.tiktok.com', 'pin.it', 'fb.watch', 'redd.it') or host.endswith('.xhslink.com'):
        r = core.get(url, core.UA_ANDROID)
        return routes.parse_input(r.url)
    return platform, url


def run_free(res, args):
    name = res.platform
    # Comments with a TikHub interface are never fetched by free comment routes.
    free_comments = args.comments and name not in routes.COMMENTS
    opts = argparse.Namespace(with_comments=free_comments)
    if name in ('generic', 'pinterest', 'youtube'):
        getattr(extras, name)(res, opts)
    elif name == 'bilibili':
        def ytd():
            core.fill_from_ytdlp(res, core.ytdlp_info(res.url))
        core.attempt(res, 'content', [('yt-dlp Bilibili (--no-paid)', ytd)])
    elif name == 'xiaohongshu':
        # Anonymous HTML only: no signatures, login activation or browser cookies.
        def page():
            h = core.get(res.url).text
            if re.search(r'/login|登录后查看|验证码', h[:12000]):
                raise Fail('小红书公开页需要登录或被风控', 'auth_failed')
            m = re.search(r'__INITIAL_STATE__=(\{.*?\})</script>', h, re.S)
            if not m:
                raise Fail('quality_gate: 小红书游客页无笔记正文')
            d = json.loads(m.group(1).replace('undefined', 'null'))
            paid.normalize_detail(res, d)
        core.attempt(res, 'content', [('Xiaohongshu anonymous HTML (--no-paid)', page)])
    elif name in ('weibo', 'zhihu', 'wechat_channels'):
        extras.generic(res, opts)
    else:
        importlib.import_module('platforms.' + name).scrape(res, opts)
    if not free_comments:
        # Keep comments that arrived with the content page itself (no extra request), e.g. LinkedIn JSON-LD.
        res.free_comments = res.comments
        res.comments = []
    if name == 'reddit' and res.text and 'arctic_snapshot_retrieved_on' in res.extra:
        if not core.quality_error(res):
            if res.capabilities['content']['status'] not in ('success', 'index_partial'):
                res.setcap('content', 'index_partial', 'arctic-shift archive', '第三方存档快照，非实时；快照采集：' + res.extra['arctic_snapshot_retrieved_on'])
            res.setcap('stats', 'index_partial', 'arctic-shift archive', '存档互动数，非实时')
    if name == 'medium' and res.items:
        res.setcap('content', 'index_partial', 'author RSS', '给定链接是作者主页，返回最近 RSS 条目，并非指定单篇文章')
    if name == 'substack' and res.extra.get('paywall'):
        res.setcap('content', 'index_partial', 'Substack public API', '仅公开预览，不读取付费内容')


def finalize_capabilities(res, args):
    content_source = res.capabilities['content']['source']
    res.images = list(dict.fromkeys(u for u in res.images if isinstance(u, str) and u.startswith(('https://', 'http://'))))
    res.videos = list(dict.fromkeys(u for u in res.videos if isinstance(u, str) and u.startswith(('https://', 'http://'))))
    res.stats = {k: v for k, v in res.stats.items() if v is not None and v != ''}
    if res.stats and res.capabilities['stats']['status'] == 'not_attempted':
        status = 'index_partial' if res.capabilities['content']['status'] == 'index_partial' else 'success'
        res.setcap('stats', status, content_source, '原始公开互动；未返回的字段不填 0')
    elif not res.stats:
        res.setcap('stats', 'not_attempted', '', '当前路线未返回公开互动数据')
    for k in res.stats:
        res.stats_sources.setdefault(k, content_source)
    if res.images or res.videos:
        res.setcap('media', 'success', content_source, '已取得地址；默认未下载，签名地址可能过期')
    else:
        res.setcap('media', 'not_attempted', '', '未取得媒体地址；默认不下载')
    if not args.comments:
        res.setcap('comments', 'not_attempted', '', '批量默认关闭评论；可用 --with-comments；单条可用 --no-comments')
        res.comments = []


def with_media(res):
    ctx = CURRENT.get()
    if not (res.images or res.videos):
        return
    dest = ctx.out / 'media'
    dest.mkdir(exist_ok=True)
    failed = []
    handled_bili = False
    if res.platform == 'bilibili':
        try:
            handled_bili = enrich.bili_media(res, dest)
        except Exception as e:
            failed.append(str(e))
    media = [('image', u) for u in res.images] + ([] if handled_bili else [('video', u) for u in res.videos])
    for i, (kind, url) in enumerate(media):
        if url in res.extra.get('separate_video_tracks', []):
            failed.append('DASH 分离音轨尚未合并；仅保留地址与 raw 元数据')
            continue
        ext = Path(urlsplit(url).path).suffix.lower()
        if ext not in ('.jpg', '.png', '.jpeg', '.webp', '.gif', '.mp4', '.m4v', '.mov', '.m3u8'):
            ext = '.jpg' if kind == 'image' else '.mp4'
        if ext == '.m3u8':
            failed.append('HLS 播放列表未合并；仅保留地址')
            continue
        try:
            f = enrich.download_video(res, url, dest / f'{i+1:03d}-{kind}{ext}') if kind == 'video' else core.download(url, dest / f'{i+1:03d}-{kind}{ext}', ua=core.UA_ANDROID if res.platform == 'douyin' else core.UA_DESKTOP, referer=res.url)
            res.media_files.append(f)
        except Exception as e:
            failed.append(str(e))
    res.setcap('media', 'index_partial' if failed else 'success', '--with-media public HTTP', '; '.join(failed) or f'已下载 {len(res.media_files)} 个媒体文件')


def write_package(res, ctx, original, elapsed, args):
    external_path(ctx.out)
    d = {
        'schema_version': 1, 'sourceboard_version': VERSION, 'platform': res.platform,
        'input': original, 'canonical_url': res.url if res.extra.get('kind') == 'profile' else routes.canonical(res.platform, res.url, res.id), 'resolved_url': res.url,
        'id': res.id, 'title': res.title, 'author': res.author, 'published_at': res.published,
        'text': res.text, 'stats': res.stats, 'stats_sources': res.stats_sources,
        'images': res.images, 'videos': res.videos, 'media_files': res.media_files,
        'subtitles': res.extra.get('subtitle_files', []), 'comments': res.comments, 'items': res.items,
        'capabilities': res.capabilities, 'methods': res.methods, 'extra': res.extra,
        'estimated_cost_usd': round(ctx.cost, 6), 'tikhub_cli_estimated_cost_usd': round(ctx.ledger_cost, 6),
        'cost_basis': '接口单价估算，缓存命中为 0；实际扣费见账户前后快照，不把估算当账单',
        'paid_calls': ctx.paid_calls, 'retrieved_at': now(), 'seconds': round(elapsed, 3),
        'options': option_values(args),
        'profile': getattr(res, 'profile', None),
    }
    if paid.THROTTLED:
        d['extra']['paid_concurrency'] = {'limit':1,'note':'遇到429，降到1并停止后续付费请求'}
    path = ctx.out / 'meta.json'
    temp = path.with_suffix('.json.part')
    temp.write_text(json.dumps(d, ensure_ascii=False, indent=2))
    temp.replace(path)
    lines = [f'# {res.title or "未取得可用正文"}', '', f'- 平台：{res.platform}', f'- 作者：{res.author or "未返回"}', f'- 发布时间：{res.published or "未返回"}', f'- 原链接：{d["canonical_url"]}', f'- 抓取：{d["retrieved_at"]}', f'- 互动：{json.dumps(res.stats, ensure_ascii=False)}', f'- 费用估算：${ctx.cost:.4f}', '', '## 各能力状态', '']
    lines += [f'- {k}: **{v["status"]}** · {v["source"]} · {v["note"]}' for k, v in res.capabilities.items()]
    if res.stats_sources:
        lines += ['', '## 数据来源', '']+[f'- {key}：{source}' for key,source in res.stats_sources.items()]
    for key in ('views_enrichment','reads_enrichment'):
        if res.extra.get(key):
            value=res.extra[key];lines += [f'- {key}：**{value["status"]}** · {value.get("note","")}']
    lines += ['', '## 正文', '', res.text or '未取得可用正文。']
    if res.comments:
        lines += ['', '## 评论（实际 '+str(res.extra.get('comment_pagination',{}).get('pages_fetched',1))+' 页）', ''] + [f'- **{c.get("author", "")}**（赞 {c.get("likes", "未返回")}）：{c.get("text", "")}' for c in res.comments]
    if res.images or res.videos:
        lines += ['', '## 媒体地址（可能过期）', ''] + [f'- {u}' for u in res.images + res.videos]
    if d['subtitles']:
        lines += ['', '## 字幕 / 显式转写', ''] + ['- ' + p for p in d['subtitles']]
    if d.get('profile'):
        lines += ['', '## 账号资料', '', json.dumps(d['profile'],ensure_ascii=False,indent=2), '', '## 最近作品', '']
        lines += [f'- [{item.get("title") or item.get("id")}]({item.get("url")}) · {item.get("published_at") or "日期未返回"} · {json.dumps(item.get("stats",{}),ensure_ascii=False)}' for item in res.items]
    (ctx.out / 'content.md').write_text('\n'.join(lines) + '\n')
    return d


def package_key(platform, item_id, url, opts_key):
    digest = hashlib.sha256((platform + ':' + (item_id or url)).encode()).hexdigest()[:10]
    safe_id = re.sub(r'[^a-zA-Z0-9_.=-]', '_', item_id)[:40] or digest
    return f'{platform}-{safe_id}-{digest}-{opts_key}'


def option_values(args):
    return {k:getattr(args,k,None) for k in ('comments','no_paid','with_media','comment_pages','profile_pages','profile_views','xhs_reads','clean_video_url')}


def options_key(args):
    # Keep prior keys for unchanged defaults, extend only for new behavioral options.
    base = f'c{int(args.comments)}p{int(not args.no_paid)}m{int(args.with_media)}'
    values = option_values(args)
    new = {k:v for k,v in values.items() if k not in ('comments','no_paid','with_media')}
    return base + '-' + hashlib.sha256(json.dumps(new,sort_keys=True).encode()).hexdigest()[:8]


def job(original, args, root):
    start = time.monotonic()
    platform, url = routes.parse_input(original)
    item_id = routes.profile_id(platform,url) or routes.identify(platform, url)
    opts_key = options_key(args)
    key = package_key(platform, item_id, url, opts_key)
    out = external_path(root / key)
    if args.resume and (out / 'meta.json').exists():
        try:
            existing = json.loads((out / 'meta.json').read_text())
            # Failed content must be retried. A completed partial package remains reviewable.
            if existing['capabilities']['content']['status'] in ('success', 'index_partial') and (out / 'content.md').exists():
                return summary(existing, out, skipped=True)
        except (ValueError, KeyError):
            pass
    out.mkdir(parents=True, exist_ok=True)
    ctx = Context(out, args.timeout, args.no_paid, clean_video=bool(getattr(args, 'clean_video_url', False)))
    token = CURRENT.set(ctx)
    res = Result(platform, url)
    res.id = item_id
    try:
        try:
            platform, url = resolve_url(platform, url)
            res.platform, res.url = platform, url
            res.id = routes.identify(platform, url)
            profile_id = routes.profile_id(platform,url)
            if profile_id:
                res.id=profile_id
                profiles.scrape(res,args,profile_id)
                finalize_capabilities(res,args)
                if args.with_media: with_media(res)
            else:
                direct = platform in ('xiaohongshu', 'bilibili') and not args.no_paid
                if direct:
                    paid_attempt(res, 'content', paid.detail)
                else:
                    run_free(res, args)
                    if res.capabilities['content']['status'] not in ('success', 'index_partial') and platform in routes.DETAIL and not args.no_paid:
                        if platform in ('wechat', 'reddit'):
                            res.extra['content_fallback'] = {
                                'source': 'TikHub', 'reason': res.capabilities['content']['note'],
                                'note': '免费路线未取得正文，使用既有付费兜底；实际本次估算见 paid_calls',
                                'request_price_usd': paid.price(routes.DETAIL[platform][0]),
                            }
                        paid_attempt(res, 'content', paid.detail)
                if res.capabilities['content']['status'] in ('success', 'index_partial'):
                    gate = core.quality_error(res)
                    if gate:
                        res.text = ''
                        res.setcap('content', 'connector_failed', '', 'quality_gate: ' + gate)
                if args.comments and platform in routes.COMMENTS:
                    if getattr(res, 'free_comments', None) and res.capabilities['content']['status'] == 'success':
                        # Live page comments came free with the content request; archive snapshots (index_partial) still go to TikHub.
                        res.comments = res.free_comments
                        res.setcap('comments', 'success', res.capabilities['content']['source'], '随公开正文页一起返回的第一页评论，未调 TikHub')
                    elif args.no_paid:
                        res.setcap('comments', 'not_attempted', '', '--no-paid：本平台评论按既定路线走 TikHub，已跳过')
                    else:
                        paid_attempt(res, 'comments', lambda r:paid.comments(r,pages=args.comment_pages))
                elif args.comments:
                    if res.comments:
                        res.setcap('comments', 'success', res.capabilities['content']['source'], '公开页面/API 的第一页评论')
                    elif res.capabilities['comments']['status'] == 'not_attempted':
                        res.setcap('comments', 'not_attempted', '', '未找到无需登录的公开评论路线')
                if args.comment_pages > 1 and 'comment_pagination' not in res.extra:
                    res.extra['comment_pagination']={'pages_requested':args.comment_pages,'pages_fetched':1 if res.comments else 0,'note':'免费评论路线或正文随附评论只支持第一页；没有额外付费'}
                extras.subtitles(res)
                if platform == 'douyin' and res.id and not args.no_paid:
                    args.view_batcher.add(res)
                if platform == 'xiaohongshu' and args.xhs_reads and not args.no_paid:
                    enrich.xhs_reads(res)
                finalize_capabilities(res, args)
                if args.with_media:
                    with_media(res)
        except Exception as e:
            res.log('content', 'dispatch', False, f'{type(e).__name__}: {e}', status=getattr(e, 'status', 'connector_failed'))
        if args.no_paid:
            res.extra['paid_disabled'] = '所有 TikHub 调用禁用；缺失能力见 capabilities'
        if res.platform == 'douyin' and res.videos and ctx.clean_video:
            res.extra['watermark'] = 'playwm_replaced_with_play; source=anonymous_share_page'
        incidents.safe(incidents.free_routes, res, ctx)
        data = write_package(res, ctx, original, time.monotonic()-start, args)
        result = summary(data, out)
        progress(f'{res.platform} {res.id or url[:65]}：content={result["content_status"]}，comments={res.capabilities["comments"]["status"]}；{ctx.cost:.4f} USD')
        return result
    finally:
        CURRENT.reset(token)


def summary(d, out, skipped=False):
    status = d['capabilities']['content']['status']
    return {'platform': d['platform'], 'id': d['id'], 'url': d['canonical_url'], 'content_status': status,
            'capabilities': {k: v['status'] for k, v in d['capabilities'].items()}, 'ok': status in ('success', 'index_partial'),
            'out': str(out), 'seconds': 0 if skipped else d['seconds'], 'estimated_cost_usd': 0 if skipped else d['estimated_cost_usd'], 'skipped': skipped}


def plan(inputs, args):
    total=0; direct=0; cm=0; dy=0; profile_calls=0; reads=0
    comment_pages=getattr(args,'comment_pages',1); profile_pages=getattr(args,'profile_pages',1)
    for line in inputs:
        p,url=routes.parse_input(line)
        if args.no_paid: continue
        ident=routes.profile_id(p,url)
        if ident:
            if p in routes.PROFILES:
                pr,items,_=routes.PROFILES[p]
                total+=paid.price(pr)+profile_pages*paid.price(items);profile_calls+=1+profile_pages
                if p=='douyin' and getattr(args,'profile_views',False):total+=profile_pages*12*paid.price(enrich.DY_VIEWS)
            continue
        if p in ('xiaohongshu','bilibili'):
            total+=paid.price(routes.DETAIL[p][0]);direct+=1
        if p=='douyin':dy+=1
        if p=='xiaohongshu' and getattr(args,'xhs_reads',False):
            total+=paid.price(enrich.XHS_READS);reads+=1
        if args.comments and p in routes.COMMENTS:
            total+=comment_pages*paid.price(routes.COMMENTS[p][0]);cm+=comment_pages
    total+=((dy+1)//2)*paid.price(enrich.DY_VIEWS)
    return {'items':len(inputs),'comments':args.comments,'comment_pages':comment_pages,'profile_pages':profile_pages,'no_paid':args.no_paid,
            'direct_paid_details':direct,'paid_comment_calls':cm,'profile_calls':profile_calls,'douyin_statistics_calls':(dy+1)//2,'xhs_read_calls':reads,
            'baseline_estimated_usd':round(total,6),'note':'评论/主页按最多页数估算，末页提前停；抖音并发可两条合查，串行或慢短链可能每条一次。缓存可减免；详情/字幕兜底、B站下载和主页逐条播放另计；--profile-views 每20条约另$0.01。TIKHUB_BUDGET_USD约束实际调用。'}


def doctor(args, root):
    """体检：数据目录、TikHub 钥匙和余额、可选的 yt-dlp / ffmpeg / 知乎 / YouTube 钥匙。"""
    checks = {'data_dir': str(sbconfig.home()), 'config_file': str(sbconfig.ENV_FILE), 'python': sys.version.split()[0],
              'tikhub': 'not_attempted', 'optional': {}, 'network': {}}
    import search
    for name, why in (('yt-dlp', 'YouTube/TikTok/Instagram/Facebook 的免费路线和现成字幕'), ('ffmpeg', 'B站视频下载时合并音画'), ('zhihu-cli', '知乎官方搜索（免费额度）')):
        path = search.zhihu_cli() if name == 'zhihu-cli' else sbconfig.which(name)
        checks['optional'][name] = {'installed': bool(path), 'used_for': why}
    checks['optional']['YOUTUBE_API_KEY'] = {'installed': bool(sbconfig.get('YOUTUBE_API_KEY')), 'used_for': 'YouTube 官方接口免费额度：视频详情、频道资料、上传列表'}
    if not args.no_paid:  # --no-paid guarantees zero TikHub invocations, including account.
        if not sbconfig.get('TIKHUB_API_KEY'):
            checks['tikhub'] = 'auth_failed'
            checks['tikhub_note'] = '还没配 TikHub 钥匙：运行 sourceboard setup'
        else:
            try:
                p = subprocess.run([*paid.CLI, 'account'], capture_output=True, text=True, env=core.SAFE_ENV, timeout=60)
                d = json.loads(p.stdout)
                checks['tikhub'] = 'success' if d.get('ok') else 'auth_failed'
                checks['balance_usd'] = d.get('user_data', {}).get('balance')
                checks['free_credit_usd'] = d.get('user_data', {}).get('free_credit')
                if p.returncode or not d.get('ok'):
                    checks['tikhub_note'] = str(d.get('error') or d)[:300]
                    incidents.paid_error('account', d)
            except Exception as e:
                checks['tikhub'] = 'connector_failed'
                checks['tikhub_note'] = type(e).__name__
    if args.probe:
        for p, u in (('douyin', 'https://www.iesdouyin.com'), ('bilibili', 'https://api.bilibili.com'), ('x', 'https://cdn.syndication.twimg.com'), ('bluesky', 'https://public.api.bsky.app')):
            try:
                core.get(u)
                checks['network'][p] = 'success'
            except Exception as e:
                checks['network'][p] = getattr(e, 'status', 'connector_failed')
        checks['network_note'] = '仅域名连通，不代表单条抓取通过'
    checks['daily_budget_usd'] = sbconfig.get('SOURCEBOARD_DAILY_BUDGET_USD') or '未设（不限）'
    return checks


def _main():
    ap = argparse.ArgumentParser(prog='sourceboard grab', description='丢链接或分享文案，抓回公开内容包并生成看板。作品链接和账号主页链接都可以。默认不下载图片和视频。')
    ap.add_argument('target', nargs='?', help='链接、整段分享文案，或 doctor（体检）')
    ap.add_argument('--input-file', type=Path)
    ap.add_argument('--out', default=str(core.DEFAULT_ROOT))
    ap.add_argument('--with-media', action='store_true')
    ap.add_argument('--no-paid', action='store_true')
    ap.add_argument('--xhs-reads', action='store_true', default=None, help='补小红书阅读/曝光（来自蒲公英，有延迟，小博主可能没有；每条多花约$0.02；默认关）')
    ap.add_argument('--comment-pages', type=int, default=1, choices=range(1,101), metavar='N', help='评论最多页数（1–100），默认1，每页一次调用')
    ap.add_argument('--profile-pages', type=int, default=1, choices=range(1,101), metavar='N', help='主页最近作品最多页数（1–100），默认1')
    ap.add_argument('--profile-views', action='store_true', help='显式补抖音主页各作品的自然播放，每2条$0.001')
    ap.add_argument('--clean-video-url', action='store_true', help='抖音给出不带水印的视频地址；默认只给平台原地址。请只用于你有权使用的内容')
    ap.add_argument('--open', action='store_true', help='生成看板后用浏览器打开')
    ap.add_argument('--no-board', action='store_true', help='不生成看板')
    cm = ap.add_mutually_exclusive_group()
    cm.add_argument('--no-comments', dest='comments', action='store_false')
    cm.add_argument('--with-comments', dest='comments', action='store_true')
    ap.set_defaults(comments=None)
    ap.add_argument('--json', action='store_true', help='stdout 只打印一行摘要 JSON；进度/预估到 stderr')
    ap.add_argument('--concurrency', type=int, default=4, choices=range(1, 9), metavar='N', help='同时抓几条（1–8），默认4')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--timeout', type=int, default=15, choices=range(3, 61), metavar='秒', help='免费路线单次超时（3–60 秒），默认15')
    ap.add_argument('--probe', action='store_true', help='doctor 免费探测公共域名连通性')
    ap.add_argument('--plan', action='store_true', help='离线输出路由和基准费用估算，不访问网络')
    ap.add_argument('--version', action='version', version=VERSION)
    args = ap.parse_args()
    try:
        root = external_path(args.out)
        root.mkdir(parents=True, exist_ok=True)
        scratch = external_path(root / '.scratch')
        scratch.mkdir(exist_ok=True)
        core.SAFE_ENV['TMPDIR'] = str(scratch)
        if args.target == 'doctor':
            result = doctor(args, root)
            print_json(result)
            return 0 if result['tikhub'] in ('success', 'not_attempted') else 1
        batch = args.input_file is not None
        if args.comments is None:
            args.comments = not batch
        if args.xhs_reads is None:
            args.xhs_reads = False
        if batch:
            inputs = [s.strip() for s in args.input_file.read_text().splitlines() if s.strip() and not s.lstrip().startswith('#')]
        elif args.target:
            inputs = [args.target]
        else:
            ap.error('需要链接或 --input-file')
        if not inputs:
            raise ValueError('清单没有链接')
        # Deduplicate canonical work before scheduling to avoid racing on the same package.
        unique = {}
        for s in inputs:
            p, u = routes.parse_input(s)
            k = p + ':' + ('profile:' + routes.profile_id(p,u) if routes.profile_id(p,u) else routes.identify(p,u) or u)
            unique.setdefault(k, s)
        inputs = list(unique.values())
        estimate = plan(inputs, args)
        if args.plan:
            print_json(estimate)
            return 0
        print('sourceboard 预估 ' + json.dumps(estimate, ensure_ascii=False), file=sys.stderr, flush=True)
        if not batch:
            # Every single grab is preserved, not overwritten by a later invocation.
            root = root / (time.strftime('%Y%m%d-%H%M%S') + '-' + str(os.getpid()))
            root.mkdir(exist_ok=True)
        dy_ids=[]
        for original in inputs:
            p,u=routes.parse_input(original); ident=routes.identify(p,u)
            if p!='douyin' or not ident or routes.profile_id(p,u): continue
            if args.resume:
                existing=root/package_key(p,ident,u,options_key(args))
                try:
                    d=json.loads((existing/'meta.json').read_text())
                    if d['capabilities']['content']['status'] in ('success','index_partial') and (existing/'content.md').exists(): continue
                except (OSError,ValueError,KeyError): pass
            dy_ids.append(ident)
        args.view_batcher=enrich.ViewsBatcher(dy_ids)
        results = []
        if args.concurrency == 1 or not batch:
            results = [job(s, args, root) for s in inputs]
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
                futures = {pool.submit(job, s, args, root): s for s in inputs}
                for f in concurrent.futures.as_completed(futures):
                    try:
                        results.append(f.result())
                    except Exception as e:
                        results.append({'url': futures[f], 'ok': False, 'error': str(e), 'content_status': 'connector_failed', 'capabilities': {}, 'seconds': 0, 'estimated_cost_usd': 0, 'skipped': False, 'platform': 'unknown', 'out': ''})
        if batch:
            import csv
            with (root / 'summary.csv').open('w', newline='') as out:
                writer = csv.writer(out)
                writer.writerow(['platform', 'url', 'content', 'stats', 'comments', 'media', 'subtitles', 'seconds', 'estimated_usd', 'skipped', 'out'])
                for r in results:
                    writer.writerow([r['platform'], r['url'], *[r['capabilities'].get(c, r['content_status'] if c == 'content' else '') for c in core.CAPS], r['seconds'], r['estimated_cost_usd'], r['skipped'], r['out']])
            (root / 'summary.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
            result = {'items': len(results), 'usable': sum(r['ok'] for r in results), 'skipped': sum(r['skipped'] for r in results), 'estimated_cost_usd': round(sum(r['estimated_cost_usd'] for r in results), 6), 'out': str(root), 'results': results}
        else:
            result = results[0]
        if not args.no_board:
            try:
                page = board.from_packages(root, title='抓取结果' if batch else '', open_browser=args.open)
                result['board'] = str(page)
            except Exception as e:
                result['board_error'] = f'{type(e).__name__}: {e}'
        if args.json:
            print_json(result)
        elif batch:
            print(f'{result["usable"]}/{result["items"]} 条有可用正文；跳过 {result["skipped"]}；估算 ${result["estimated_cost_usd"]:.4f}\n{root}/summary.csv')
        else:
            print(f'{result["platform"]} · 正文 {result["content_status"]} · {result["seconds"]:.1f} 秒 · 估算 ${result["estimated_cost_usd"]:.4f}\n{result["out"]}/content.md')
        return 0 if all(r['ok'] for r in results) else 1
    except (ValueError, OSError) as e:
        if args.json:
            print_json({'ok': False, 'status': 'connector_failed', 'error': str(e)})
        else:
            print('sourceboard: ' + str(e), file=sys.stderr)
        return 2


def main():
    global _runtime_finished, _pending_summary
    _runtime_finished = False
    _pending_summary = None
    incidents.reset_run()
    try:
        if len(sys.argv)>1 and sys.argv[1]=='incidents':
            try:
                code = incidents.command(sys.argv[2:])
                _runtime_finished = True  # command already emitted its post-transition state.
                return code
            except (ValueError,OSError,KeyError,TypeError,TimeoutError) as e:
                if '--json' in sys.argv: print_json({'ok':False,'error':str(e)})
                else: print('sourceboard incidents: '+str(e),file=sys.stderr)
                return 2
        return _main()
    finally:
        finish_runtime()


if __name__ == '__main__':
    sys.exit(main())
