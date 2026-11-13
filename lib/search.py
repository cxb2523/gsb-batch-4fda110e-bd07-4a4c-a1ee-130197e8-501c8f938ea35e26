"""sourceboard search — 按关键词搜 10 个平台，结果整理成同一种格式并生成看板。

除知乎优先走官方免费工具外，其余平台走 TikHub（每次约 $0.001–0.01，见 prices.json）。
每个平台各自记录状态：搜到了、正常但没有结果、钥匙或余额有问题、被限流、接口出错。
接口报错不等于“网上没有”，所以失败的平台会原样写进结果和看板顶部。
"""
import argparse
import concurrent.futures
import datetime as dt
import html
import json
import os
import re
import subprocess
import sys
import time
from email.utils import parsedate_to_datetime
from pathlib import Path

import core
import paid
import sbconfig
from core import CURRENT, Fail

NAMES = {'douyin': '抖音', 'xiaohongshu': '小红书', 'bilibili': 'B站', 'weibo': '微博', 'zhihu': '知乎',
         'wechat': '公众号', 'youtube': 'YouTube', 'reddit': 'Reddit', 'tiktok': 'TikTok', 'x': 'X'}
ALIASES = {'dy': 'douyin', '抖音': 'douyin', 'xhs': 'xiaohongshu', '小红书': 'xiaohongshu', 'bili': 'bilibili', 'b站': 'bilibili',
           '微博': 'weibo', '知乎': 'zhihu', '公众号': 'wechat', 'weixin': 'wechat', '微信': 'wechat', 'yt': 'youtube',
           'twitter': 'x', '推特': 'x'}
ORDER = list(NAMES)
PREFIX = {'douyin': 'dy', 'xiaohongshu': 'xhs', 'bilibili': 'bili', 'weibo': 'wb', 'zhihu': 'zh', 'wechat': 'wx',
          'youtube': 'yt', 'reddit': 'rd', 'tiktok': 'tt', 'x': 'x'}  # 卡片编号前缀，各平台不能重复


# ---------- 小工具 ----------

def walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v)


def plain(text):
    return html.unescape(re.sub(r'<[^>]+>', '', str(text or ''))).strip()


def num(value):
    """把 '1.2万'、'722 views'、'1.5M' 这类写法变成数字；认不出返回 None（不填 0）。"""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    m = re.search(r'([\d][\d,]*\.?\d*)\s*([KkMmBb万亿]?)', str(value))
    if not m:
        return None
    n = float(m.group(1).replace(',', ''))
    n *= {'k': 1e3, 'm': 1e6, 'b': 1e9, '万': 1e4, '亿': 1e8}.get(m.group(2).lower(), 1)
    return int(n) if n == int(n) else n


def iso(value):
    """时间戳（秒或毫秒）或常见日期写法 → ISO 时间；认不出原样返回。"""
    if value in (None, '', 0, '0'):
        return ''
    try:
        n = float(value)
        if n > 1e12:
            n /= 1000
        return dt.datetime.fromtimestamp(n, dt.timezone.utc).isoformat(timespec='seconds')
    except (TypeError, ValueError):
        pass
    try:
        return parsedate_to_datetime(str(value)).astimezone(dt.timezone.utc).isoformat(timespec='seconds')
    except (TypeError, ValueError):
        pass
    try:  # 微博写法：Thu Oct 29 15:27:36 +0800 2026
        return dt.datetime.strptime(str(value), '%a %b %d %H:%M:%S %z %Y').astimezone(dt.timezone.utc).isoformat(timespec='seconds')
    except ValueError:
        return str(value)


def first_url(node, *keys):
    for key in keys:
        v = node.get(key) if isinstance(node, dict) else None
        if isinstance(v, dict):
            v = v.get('url_list') or v.get('url')
        if isinstance(v, list):
            v = next((x if isinstance(x, str) else (x or {}).get('url') for x in v if x), None)
        if isinstance(v, str) and v:
            return 'https:' + v if v.startswith('//') else v
    return ''


def stats(**pairs):
    return {k: num(v) for k, v in pairs.items() if num(v) is not None}


def item(platform, ident, **fields):
    fields['stats'] = {k: v for k, v in (fields.get('stats') or {}).items() if v is not None}
    return {'platform': platform, 'key': str(ident), **fields}


def unique(rows):
    seen, out = set(), []
    for r in rows:
        if r['key'] and r['key'] not in seen:
            seen.add(r['key'])
            out.append(r)
    return out


# ---------- 各平台：怎么发请求、怎么读结果 ----------

def douyin_params(kw, o):
    return {'keyword': kw, 'cursor': (o.page - 1) * 20, 'sort_type': {'hot': '1', 'new': '2'}.get(o.sort, '0'), 'publish_time': '0',
            'filter_duration': '0', 'content_type': '0', 'search_id': '', 'backtrace': ''}


def douyin_parse(doc):
    out = []
    for a in walk(doc):
        if not (a.get('aweme_id') and 'desc' in a and isinstance(a.get('statistics'), dict)):
            continue
        s, author, video = a['statistics'], a.get('author') or {}, a.get('video') or {}
        out.append(item('douyin', a['aweme_id'], title=plain(a.get('desc'))[:80], text=plain(a.get('desc')), author=author.get('nickname', ''),
                        url=f'https://www.douyin.com/video/{a["aweme_id"]}', published_at=iso(a.get('create_time')),
                        cover=first_url(video, 'cover', 'origin_cover'),
                        # 搜索结果里的播放数常年是 0，不当真；要播放量用 grab 抓单条。
                        stats=stats(likes=s.get('digg_count'), comments=s.get('comment_count'), shares=s.get('share_count'), collects=s.get('collect_count'),
                                    views=s.get('play_count') or None),
                        extra={'author_followers': num(author.get('follower_count'))}))
    return out


def xhs_parse(doc):
    out = []
    for wrap in walk(doc):
        n = wrap.get('note')
        if not (isinstance(n, dict) and n.get('id')):
            continue
        user = n.get('user') or {}
        token = n.get('xsec_token') or wrap.get('xsec_token') or ''
        url = f'https://www.xiaohongshu.com/explore/{n["id"]}' + (f'?xsec_token={token}&xsec_source=pc_search' if token else '')
        title = plain(n.get('title') or n.get('display_title') or '') or plain(n.get('desc'))[:60]
        out.append(item('xiaohongshu', n['id'], title=title, text=plain(n.get('desc')), author=user.get('nickname', ''), url=url,
                        published_at=iso(n.get('timestamp')), cover=first_url({'i': n.get('images_list')}, 'i'),
                        stats=stats(likes=n.get('liked_count'), collects=n.get('collected_count'), comments=n.get('comments_count'), shares=n.get('shared_count'))))
    return out


def bili_parse(doc):
    out = []
    for v in walk(doc):
        if not (v.get('bvid') and v.get('title')):
            continue
        out.append(item('bilibili', v['bvid'], title=plain(v['title']), text=plain(v.get('description')), author=v.get('author', ''),
                        url=f'https://www.bilibili.com/video/{v["bvid"]}', published_at=iso(v.get('pubdate')), cover=first_url(v, 'pic'),
                        stats=stats(views=v.get('play'), likes=v.get('like'), favorites=v.get('favorites'), comments=v.get('review'), danmaku=v.get('video_review'))))
    return out


def weibo_parse(doc):
    out = []
    for m in walk(doc):
        if not (m.get('mid') and 'text' in m and 'reposts_count' in m):
            continue
        if m.get('ad_marked') or m.get('promotion'):
            continue  # 搜索结果里夹的推广
        user = m.get('user') or {}
        text = plain(m.get('text_raw') or m.get('text'))
        out.append(item('weibo', m['mid'], title=text[:60], text=text, author=user.get('screen_name', ''),
                        url=f'https://m.weibo.cn/status/{m["mid"]}', published_at=iso(m.get('created_at')), cover=first_url(m, 'thumbnail_pic', 'bmiddle_pic'),
                        stats=stats(reposts=m.get('reposts_count'), comments=m.get('comments_count'), likes=m.get('attitudes_count'))))
    return out


def zhihu_url(o):
    api, ident = str(o.get('url') or ''), o.get('id')
    if '/articles/' in api:
        return f'https://zhuanlan.zhihu.com/p/{ident}'
    if '/answers/' in api:
        q = (o.get('question') or {}).get('id')
        return f'https://www.zhihu.com/question/{q}/answer/{ident}' if q else f'https://www.zhihu.com/answer/{ident}'
    if '/questions/' in api:
        return f'https://www.zhihu.com/question/{ident}'
    if '/pins/' in api:
        return f'https://www.zhihu.com/pin/{ident}'
    return api.replace('api.zhihu.com', 'www.zhihu.com')


def zhihu_parse(doc):
    out = []
    for wrap in walk(doc):
        o = wrap.get('object')
        if not (isinstance(o, dict) and o.get('id') and (o.get('title') or o.get('question'))):
            continue
        title = plain(o.get('title') or (o.get('question') or {}).get('name'))
        out.append(item('zhihu', o['id'], title=title, text=plain(o.get('excerpt') or o.get('content'))[:600], author=(o.get('author') or {}).get('name', ''),
                        url=zhihu_url(o), published_at=iso(o.get('created_time')), cover=first_url(o.get('thumbnail_info') or {}, 'thumbnails'),
                        stats=stats(votes=o.get('voteup_count'), comments=o.get('comment_count'), favorites=o.get('zfav_count'))))
    return out


def zhihu_official_parse(doc):
    out = []
    for o in ((doc.get('Data') or {}).get('Items') or []):
        out.append(item('zhihu', o.get('ContentID') or o.get('Url'), title=plain(o.get('Title')).removesuffix(' - 知乎'), text=plain(o.get('ContentText')),
                        author=o.get('AuthorName', ''), url=o.get('Url', ''), published_at=iso(o.get('CreateTime')), cover='',
                        stats=stats(votes=o.get('VoteUpCount'), comments=o.get('CommentCount'))))
    return out


def wechat_parse(doc):
    out = []
    for a in walk(doc):
        if not (a.get('title') and a.get('doc_url')):
            continue
        out.append(item('wechat', a.get('docID') or a['doc_url'], title=plain(a['title']), text=plain(a.get('desc')), author=plain((a.get('source') or {}).get('title')),
                        url=str(a['doc_url']).replace('http://', 'https://', 1), published_at=iso(a.get('timestamp') or a.get('date')), cover=first_url(a, 'thumbUrl'),
                        stats={}))  # 公众号搜索不返回阅读和点赞
    return out


def youtube_parse(doc):
    out = []
    for v in walk(doc):
        if not (v.get('video_id') and v.get('title')):
            continue
        thumbs = v.get('thumbnails') or []
        out.append(item('youtube', v['video_id'], title=plain(v['title']), text=plain(v.get('description_snippet')), author=v.get('author', ''),
                        url=v.get('url') or f'https://www.youtube.com/watch?v={v["video_id"]}',
                        published_at=str(v.get('published_time') or ''),  # 搜索只给“2 周前”这种相对时间
                        cover=(thumbs[-1] or {}).get('url', '') if thumbs and isinstance(thumbs[-1], dict) else '',
                        stats=stats(views=v.get('view_count')), extra={'duration': v.get('duration')}))
    return out


def reddit_parse(doc):
    out = []
    for p in walk(doc):
        if not (p.get('postTitle') and p.get('permalink')):
            continue
        sub = (p.get('subreddit') or {}).get('prefixedName', '')
        author = (p.get('authorInfo') or {}).get('name', '')
        out.append(item('reddit', p.get('id') or p['permalink'], title=plain(p['postTitle']), text=plain((p.get('content') or {}).get('markdown'))[:800],
                        author=' · '.join(x for x in (author, sub) if x), url=p['permalink'] if p['permalink'].startswith('http') else 'https://www.reddit.com' + p['permalink'],  # url 字段常是视频或外链，不是帖子本身
                        published_at=str(p.get('createdAt') or '')[:19],
                        cover='', stats=stats(score=p.get('score'), comments=p.get('commentCount'), upvote_ratio=p.get('upvoteRatio'))))
    return out


def tiktok_parse(doc):
    out = []
    for a in walk(doc):
        if not (a.get('aweme_id') and 'desc' in a and isinstance(a.get('statistics'), dict)):
            continue
        s, author, video = a['statistics'], a.get('author') or {}, a.get('video') or {}
        handle = author.get('unique_id', '')
        out.append(item('tiktok', a['aweme_id'], title=plain(a.get('desc'))[:80], text=plain(a.get('desc')), author=author.get('nickname') or handle,
                        url=f'https://www.tiktok.com/@{handle}/video/{a["aweme_id"]}', published_at=iso(a.get('create_time')),
                        cover=first_url(video, 'cover', 'origin_cover'),
                        stats=stats(views=s.get('play_count'), likes=s.get('digg_count'), comments=s.get('comment_count'), shares=s.get('share_count'), collects=s.get('collect_count'))))
    return out


def x_parse(doc):
    out = []
    for t in walk(doc):
        if not (t.get('tweet_id') and 'text' in t):
            continue
        handle = t.get('screen_name') or (t.get('user_info') or {}).get('screen_name', '')
        media = t.get('media') if isinstance(t.get('media'), list) else []
        cover = next((m.get('media_url_https') or m.get('url') for m in media if isinstance(m, dict) and (m.get('media_url_https') or m.get('url'))), '')
        text = plain(t.get('text'))
        out.append(item('x', t['tweet_id'], title=text[:80], text=text, author=handle, url=f'https://x.com/{handle}/status/{t["tweet_id"]}',
                        published_at=iso(t.get('created_at')), cover=cover or '',
                        stats=stats(views=t.get('views'), likes=t.get('favorites'), replies=t.get('replies'), reposts=t.get('retweets'), quotes=t.get('quotes'), bookmarks=t.get('bookmarks'))))
    return out


ROUTES = {
    'douyin': ('/api/v1/douyin/search/fetch_video_search_v2', 'post', douyin_params, douyin_parse),
    'xiaohongshu': ('/api/v1/xiaohongshu/app_v2/search_notes', 'get',
                    lambda kw, o: {'keyword': kw, 'page': o.page, 'sort_type': {'hot': 'popularity_descending', 'new': 'time_descending'}.get(o.sort, 'general')}, xhs_parse),
    'bilibili': ('/api/v1/bilibili/web/fetch_general_search', 'get',
                 lambda kw, o: {'keyword': kw, 'order': {'hot': 'click', 'new': 'pubdate'}.get(o.sort, 'totalrank'), 'page': o.page, 'page_size': 20}, bili_parse),
    'weibo': ('/api/v1/weibo/app/fetch_search_all', 'get', lambda kw, o: {'query': kw, 'search_type': 1, 'page': o.page}, weibo_parse),
    'zhihu': ('/api/v1/zhihu/web/fetch_article_search_v3', 'get', lambda kw, o: {'keyword': kw, 'limit': 20, 'offset': (o.page - 1) * 20}, zhihu_parse),
    'wechat': ('/api/v1/wechat_search/v2/fetch_search', 'post', lambda kw, o: {'keyword': kw, 'business_type': 'article', 'sort': 'default', 'raw': False}, wechat_parse),
    'youtube': ('/api/v1/youtube/web_v2/get_general_search_v2', 'get',
                lambda kw, o: {'keyword': kw, 'type': 'video', 'sort_by': 'upload_date' if o.sort == 'new' else 'relevance'}, youtube_parse),
    'reddit': ('/api/v1/reddit/app/fetch_dynamic_search', 'get', lambda kw, o: {'query': kw, 'search_type': 'post', 'sort': 'RELEVANCE', 'need_format': 'true'}, reddit_parse),
    'tiktok': ('/api/v1/tiktok/app/v3/fetch_video_search_result', 'get', lambda kw, o: {'keyword': kw, 'count': 20, 'offset': (o.page - 1) * 20, 'sort_type': 0, 'region': o.region}, tiktok_parse),
    'x': ('/api/v1/twitter/web/fetch_search_timeline', 'get', lambda kw, o: {'keyword': kw, 'search_type': 'Latest' if o.sort == 'new' else 'Top'}, x_parse),
}


# ---------- 执行 ----------

def zhihu_cli():
    explicit = sbconfig.get('ZHIHU_CLI')
    if explicit and Path(explicit).is_file():
        return explicit
    for cand in (sbconfig.which('zhihu-cli'), Path.home() / 'Library/Application Support/zhihu-cli/current/zhihu-cli',
                 Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'zhihu-cli/current/zhihu-cli'):
        if cand and Path(cand).is_file():
            return str(cand)
    return ''


def zhihu_official(kw):
    cli = zhihu_cli()
    if not cli:
        raise Fail('本机没装知乎官方工具', 'not_attempted')
    try:
        p = subprocess.run([cli, 'search', 'zhihu', '--query', kw, '--count', '10'], capture_output=True, text=True, timeout=40)
        doc = json.loads(p.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        raise Fail(f'知乎官方工具没有返回可读结果：{type(e).__name__}') from None
    code = str(doc.get('Code', ''))
    if code != '0':
        status = 'rate_limited' if code in ('429', '30001') else 'auth_failed' if code in ('401', '403') else 'connector_failed'
        raise Fail(f'知乎官方工具返回 {code}：{str(doc.get("Message"))[:120]}', status)
    return zhihu_official_parse(doc)


def search_one(platform, kw, o, root):
    from cli import Context
    out = root / 'raw' / platform
    out.mkdir(parents=True, exist_ok=True)
    ctx = Context(out, 45, o.no_paid)
    token = CURRENT.set(ctx)
    start = time.monotonic()
    row = {'platform': platform, 'name': NAMES[platform], 'status': 'not_attempted', 'count': 0, 'channel': '', 'note': '', 'cost_usd': 0.0}
    items = []
    try:
        if platform == 'zhihu' and not o.no_zhihu_official:
            try:
                items = zhihu_official(kw)
                row.update(channel='知乎官方工具（免费额度）', status='success' if items else 'true_zero')
            except Fail as e:
                row['note'] = f'官方工具没用上（{e}），改走 TikHub。'
        if row['status'] == 'not_attempted':
            path, method, build, parse = ROUTES[platform]
            row['channel'] = 'TikHub'
            doc = paid.call(path, build(kw, o), method)
            items = unique(parse(doc))
            row['status'] = 'success' if items else 'true_zero'
            if not items:
                row['note'] += '接口正常返回，但没有读出结果：可能真的没有，也可能是返回格式变了（原始返回在 raw/ 里）。'
    except Fail as e:
        row['status'] = e.status
        row['note'] += str(e)[:400]
    except Exception as e:  # 一个平台出错不能拖垮其他平台
        row['status'] = 'connector_failed'
        row['note'] += f'{type(e).__name__}: {str(e)[:300]}'
    finally:
        CURRENT.reset(token)
    row.update(count=len(items), cost_usd=round(ctx.cost, 6), seconds=round(time.monotonic() - start, 1),
               cache_hit=bool(ctx.paid_calls) and all(c.get('cache_hit') for c in ctx.paid_calls))
    return row, items


def pick_platforms(text):
    if not text or text == 'all':
        configured = sbconfig.get('SOURCEBOARD_PLATFORMS')
        text = configured if (configured and not text) else ','.join(ORDER)
    chosen = []
    for raw in re.split(r'[,，\s]+', text.strip()):
        if not raw:
            continue
        p = ALIASES.get(raw.lower(), raw.lower())
        if p not in ROUTES:
            raise ValueError(f'不认识的平台：{raw}。可选：{", ".join(ORDER)}')
        if p not in chosen:
            chosen.append(p)
    return chosen


def estimate(platforms, o):
    total, rows = 0.0, []
    for p in platforms:
        free = p == 'zhihu' and not o.no_zhihu_official and zhihu_cli()
        usd = 0.0 if (free or o.no_paid) else paid.price(ROUTES[p][0])
        total += usd
        rows.append({'platform': p, 'usd': usd, 'channel': '知乎官方工具' if free else 'TikHub'})
    return {'platforms': rows, 'estimated_usd': round(total, 6), 'note': '按单价表估算，不是账单；24 小时内同一搜索走缓存不再扣费。'}


def main(argv=None):
    ap = argparse.ArgumentParser(prog='sourceboard search', description='按关键词搜多个平台，结果整理成一张看板。')
    ap.add_argument('keyword', help='搜索词。中文平台不要把几个近义词塞进一个词里，会少搜到东西；宁可分几次搜。')
    ap.add_argument('--platforms', '-p', default='', help='逗号分隔：' + ','.join(ORDER) + '；也认中文名。不写就用 setup 时选的平台，没选过就全搜。')
    ap.add_argument('--sort', choices=('default', 'hot', 'new'), default='default', help='default 综合；hot 按热度；new 按最新（只对支持的平台生效）')
    ap.add_argument('--page', type=int, default=1, help='第几页，默认 1。翻页每页再收一次钱')
    ap.add_argument('--region', default='US', help='TikTok 搜索地区，默认 US')
    ap.add_argument('--out', default='', help='结果目录，默认在数据目录的 searches/ 下新建')
    ap.add_argument('--title', default='', help='看板标题，默认用搜索词')
    ap.add_argument('--no-paid', action='store_true', help='不调用 TikHub（这时只有知乎官方工具能搜）')
    ap.add_argument('--no-zhihu-official', action='store_true', help='知乎不走官方工具，直接走 TikHub')
    ap.add_argument('--plan', action='store_true', help='只显示会搜哪些平台、大概花多少，不联网')
    ap.add_argument('--json', action='store_true', help='stdout 只打一行摘要 JSON')
    ap.add_argument('--open', action='store_true', help='生成看板后用浏览器打开')
    o = ap.parse_args(argv)
    try:
        platforms = pick_platforms(o.platforms)
    except ValueError as e:
        print('sourceboard: ' + str(e), file=sys.stderr)
        return 2
    plan = estimate(platforms, o)
    if o.plan:
        print(json.dumps(plan, ensure_ascii=False, indent=None if o.json else 2))
        return 0
    print(f'sourceboard 搜索「{o.keyword}」：{len(platforms)} 个平台，预估 ${plan["estimated_usd"]:.3f}', file=sys.stderr, flush=True)
    slug = re.sub(r'[^\w一-鿿]+', '-', o.keyword).strip('-')[:40] or 'search'
    root = core.external_path(o.out) if o.out else sbconfig.sub('searches') / (time.strftime('%Y%m%d-%H%M%S') + '-' + slug)
    root.mkdir(parents=True, exist_ok=True)
    sources, items = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(platforms))) as pool:
        futures = {pool.submit(search_one, p, o.keyword, o, root): p for p in platforms}
        results = {futures[f]: f.result() for f in concurrent.futures.as_completed(futures)}
    for p in platforms:
        row, rows = results[p]
        sources.append(row)
        for i, r in enumerate(rows, 1):
            r['id'] = f'{PREFIX[p]}{i:02d}'
            items.append(r)
    data = {'schema': 1, 'kind': 'search', 'title': o.title or f'搜索：{o.keyword}', 'query': o.keyword, 'sort': o.sort,
            'created_at': core.now(), 'sources': sources, 'items': items, 'estimated_cost_usd': round(sum(s['cost_usd'] for s in sources), 6),
            'cost_note': '花费是按单价表的估算，不是账单；实际余额看 sourceboard account。'}
    (root / 'results.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    import board
    page = board.render(data, root / 'board.html', open_browser=o.open)
    import incidents
    incidents.safe(incidents.finish_paid)
    pending = incidents.emit_pending()
    failed = [s for s in sources if s['status'] not in ('success', 'true_zero')]
    summary = {'ok': bool(items), 'query': o.keyword, 'items': len(items), 'estimated_cost_usd': data['estimated_cost_usd'],
               'sources': [{k: s[k] for k in ('platform', 'status', 'count', 'channel', 'cost_usd', 'note')} for s in sources],
               'failed_platforms': [s['platform'] for s in failed], 'results': str(root / 'results.json'), 'board': str(page), 'pending_incidents': pending}
    if o.json:
        print(json.dumps(summary, ensure_ascii=False, separators=(',', ':')))
    else:
        for s in sources:
            mark = '✓' if s['status'] == 'success' else '○' if s['status'] == 'true_zero' else '✗'
            print(f'{mark} {s["name"]}：{s["count"]} 条 · {s["channel"]} · ${s["cost_usd"]:.3f}' + (f' · {s["status"]}：{s["note"][:120]}' if s['status'] != 'success' else ''))
        print(f'共 {len(items)} 条，估算 ${data["estimated_cost_usd"]:.3f}\n看板：{page}\n数据：{root / "results.json"}')
    return 0 if items else 1


if __name__ == '__main__':
    sys.exit(main())
