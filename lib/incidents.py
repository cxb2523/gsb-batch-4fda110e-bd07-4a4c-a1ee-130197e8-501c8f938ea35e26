"""External-disk incident event log. No credentials, network or third-party imports."""
import argparse
import collections
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading
import time
import uuid

import sbconfig
DEFAULT_DIR = sbconfig.home() / 'incidents'
STATUS_LABELS = {'pending':'未告知', 'notified':'已告知', 'resolved':'已解决'}
PLATFORMS = {'youtube':'YouTube','x':'X','twitter':'X','douyin':'抖音','xiaohongshu':'小红书','bilibili':'B站','wechat':'公众号','wechat_channels':'视频号'}
_RUN_LOCK = threading.Lock()
_FAILURES = collections.Counter()
_PAID_USED = False
_STORAGE_WARNINGS = set()


def reset_run():
    global _PAID_USED
    with _RUN_LOCK:
        _FAILURES.clear()
        _PAID_USED = False


def directory():
    return Path(os.environ.get('SOURCEBOARD_INCIDENT_DIR') or DEFAULT_DIR).resolve()


def stamp(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(timespec='seconds')


@contextlib.contextmanager
def locked(root, name='.lock', timeout=2):
    root.mkdir(parents=True, exist_ok=True)
    with (root/name).open('a') as lock:
        deadline = time.monotonic()+timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline: raise TimeoutError('异常台账正忙，未取得写锁')
                time.sleep(.005)
        try: yield
        finally: fcntl.flock(lock, fcntl.LOCK_UN)


def load(root):
    """Canonical JSONL, strict replay: never discard corrupted history silently."""
    path=root/'events.jsonl'
    if not path.exists(): return []
    rows={}
    with path.open() as source:
        for line in source:
            event=json.loads(line)
            row=event['incident']
            if not isinstance(row,dict) or row.get('status') not in STATUS_LABELS or not isinstance(row.get('summary'),str):
                raise ValueError('异常事件格式损坏')
            rows[row['id']]=row
    return sorted(rows.values(),key=lambda r:r['first_seen'])


def append(root, rows, row, event):
    payload=json.dumps({'event':event,'at':stamp(time.time()),'incident':row},ensure_ascii=False)+'\n'
    with (root/'events.jsonl').open('a') as out:
        out.write(payload);out.flush();os.fsync(out.fileno())
    # A readable folded view; event log remains authoritative after any interrupted write.
    view={r['id']:r for r in rows};view[row['id']]=row
    # The hook reads a compact pending-only checkpoint, so a frequently repeated
    # incident cannot make years of event history slow down conversations.
    pending_temp=root/'pending.json.part'
    pending_temp.write_text(json.dumps({'event_bytes':(root/'events.jsonl').stat().st_size,
                                        'items':[r for r in view.values() if r['status']=='pending']},ensure_ascii=False)+'\n')
    pending_temp.replace(root/'pending.json')
    temp=root/'incidents.json.part'
    temp.write_text(json.dumps({'schema_version':1,'items':list(view.values())},ensure_ascii=False,indent=2)+'\n')
    temp.replace(root/'incidents.json')


def add(*, severity, summary, category='manual', platform='unknown', capability='search', endpoint='', evidence='', source='', daily=False, occurrences=1):
    if severity not in ('高','中','低'): raise ValueError('严重度必须是高、中或低')
    if not summary.strip(): raise ValueError('需要给用户看的中文说明')
    root=directory();epoch=time.time();ts=stamp(epoch)
    with locked(root):
        rows=load(root)
        def identity(r):
            key=(r['platform'],r['capability'],r['category'])
            if daily:
                return key
            # Manual reports have no stable machine error code. Different
            # summaries must remain visible even with only --source supplied.
            if r['category']=='manual':
                key += (r.get('source',''), r.get('endpoint',''), r.get('summary','').strip())
            return key
        key=identity(dict(platform=platform,capability=capability,category=category,source=source,endpoint=endpoint,summary=summary))
        matching=[r for r in rows if identity(r)==key and
                  ((r['first_seen'][:10]==ts[:10]) if daily else (r['status']!='resolved' and 0<=epoch-r['first_epoch']<86400))]
        if matching:
            row=dict(matching[-1])
            # Low balance is one observation per UTC day, even after notification/resolution.
            if daily: return row
            row.update(last_seen=ts,count=row['count']+occurrences)
            if evidence: row['evidence']=str(evidence)
            if endpoint: row['endpoint']=endpoint
            if ('低','中','高').index(severity)>('低','中','高').index(row['severity']): row['severity']=severity
        else:
            row={'id':'INC-'+dt.datetime.fromtimestamp(epoch,dt.timezone.utc).strftime('%Y%m%d-')+uuid.uuid4().hex[:10],
                 'first_seen':ts,'last_seen':ts,'first_epoch':epoch,'count':occurrences,'severity':severity,
                 'category':category,'platform':platform,'capability':capability,'endpoint':endpoint,
                 'evidence':str(evidence or root/'events.jsonl'),'source':source,'summary':summary.strip(),'status':'pending'}
        append(root,rows,row,'observed')
        return row


def listing(include_resolved=False):
    root=directory()
    if not (root/'events.jsonl').exists(): return []
    with locked(root): rows=load(root)
    return [r for r in rows if include_resolved or r['status']!='resolved']


def pending():
    rows=[r for r in listing() if r['status']=='pending']
    return {'count':len(rows),'items':[{'id':r['id'],'severity':r['severity'],'summary':r['summary']} for r in rows[:3]]}


def transition(ident, status, note=''):
    if status not in ('notified','resolved'): raise ValueError('未知状态')
    if status=='resolved' and not note.strip(): raise ValueError('关闭异常需要 --note 说明修复结果')
    root=directory()
    with locked(root):
        rows=load(root)
        selected=[r for r in rows if (ident=='all' and status=='notified' and r['status']=='pending') or r['id']==ident]
        if not selected and ident!='all': raise ValueError('没有这个异常编号：'+ident)
        for r in selected:
            if r['status']=='resolved' or (status=='notified' and r['status']=='notified'): continue
            r.update(status=status)
            r[status+'_at']=stamp(time.time())
            if note:r['resolution_note']=note
            append(root,rows,r,status)
        return selected


def safe(fn, *args, **kwargs):
    """Auto-reporting cannot erase a grab result; storage failures are visibly reported."""
    try: return fn(*args,**kwargs)
    except (OSError, ValueError, KeyError, TypeError, TimeoutError) as e:
        message='异常台账暂不可用：'+str(e)
        if message not in _STORAGE_WARNINGS:
            print('⚠ '+message,file=sys.stderr)
            _STORAGE_WARNINGS.add(message)
        return None


def emit_pending():
    result=safe(pending)
    if result is None: return {'count':None,'items':[],'storage_error':True}
    if result['count']:
        print('\n⚠ 渠道异常：有 '+str(result['count'])+' 条还没告诉用户',file=sys.stderr)
        for row in result['items']: print(f"  [{row['id']}] {row['summary']}",file=sys.stderr)
        print('（给 Agent）请在回复开头告诉用户哪里坏了、影响什么、建议怎么办；说完运行 sourceboard incidents notify <编号>。查看全部：sourceboard incidents。\n',file=sys.stderr)
    return result


def evidence_path():
    import core
    ctx=core.CURRENT.get()
    return str(ctx.out/'raw') if ctx else ''


def observe(**kwargs):
    kwargs.setdefault('evidence',evidence_path())
    return safe(add,**kwargs)


def paid_used():
    global _PAID_USED
    with _RUN_LOCK: _PAID_USED=True


def code_in(doc):
    if isinstance(doc,dict):
        for k in ('code','status_code','status','http_status'):
            value=doc.get(k)
            if str(value).isdigit() and 400<=int(value)<=599: return int(value)
        for key in ('response','data','error'):
            code=code_in(doc.get(key))
            if code:return code
    if isinstance(doc,str):
        match=re.search(r'(?:HTTP\s*(?:Error\s+)?|(?:code|status_code)[\"\x27]?\s*[:=]\s*[\"\x27]?|(?:limit|TikHub)\s+)([45]\d\d)\b',doc,re.I)
        if match:return int(match[1])
    return None


def paid_error_kind(error):
    """Classify transport/API errors once for both capabilities and incidents.

    Inspect error envelopes, never arbitrary tweet/comment text. The CLI may
    encode an HTTP response body inside its JSON `error` string.
    """
    code = code_in(error)
    text = str(error)
    if code == 402:
        return 'balance_empty'
    if code == 403 and re.search(r'<!doctype\s+html\b|<html\b|<head\b|<title\b|<body\b|text/html', text, re.I):
        return 'rate_limit'
    if code in (429, 461):
        return 'rate_limit'

    def messages(doc):
        if isinstance(doc, dict):
            for key in ('error', 'message', 'detail', 'response', 'data'):
                value = doc.get(key)
                if isinstance(value, dict):
                    yield from messages(value)
                elif isinstance(value, str) and key in ('error', 'message', 'detail'):
                    yield value
        elif isinstance(doc, str):
            # A bare CLI error is not JSON evidence of invalid credentials.
            start = doc.find('{')
            if start >= 0:
                try:
                    yield from messages(json.loads(doc[start:]))
                except ValueError:
                    pass

    invalid_key = any(re.search(
        r'\b(?:invalid|expired|revoked)\s+(?:api[ _-]?)?key\b|'
        r'\b(?:api[ _-]?key)\s+(?:is\s+)?(?:invalid|expired|revoked)\b|'
        r'(?:API\s*key|密钥|钥匙).{0,8}(?:无效|失效|过期)', msg, re.I)
        for msg in messages(error))
    if code == 401 or invalid_key:
        return 'permission'
    if code == 403:
        return 'access_denied'
    return None



def transport_error(error):
    """Transport exceptions, not HTTP responses/business errors or arbitrary numbers."""
    if code_in(error) is not None: return False
    return bool(re.search(r'IncompleteRead|RemoteDisconnected|ConnectionResetError|ConnectionAbortedError|BrokenPipeError|URLError|SSLError|TimeoutError|ReadTimeout|timed out|connection reset|connection aborted|unexpected EOF', str(error), re.I))


def unsupported_type(platform, endpoint, value):
    return observe(severity='中', category='unsupported_type', platform=platform, capability='content',
                   endpoint=endpoint, source='sourceboard',
                   summary=f'{PLATFORMS.get(platform, platform)}暂不支持的类型：{value}；正文可能缺失，建议保留原始返回并补充该类型解析。')

def paid_error(path, error, capability=None):
    platform=path.split('/')[3] if path.startswith('/api/v1/') else 'tikhub'
    platform={'twitter':'x','wechat_mp':'wechat'}.get(platform,platform)
    cap=capability or capability_for(path)
    code=code_in(error)
    category=None;severity='高';occurrences=1
    kind=paid_error_kind(error)
    if kind=='balance_empty': category='balance_empty';text='TikHub 余额不足，付费搜索和取数可能停用；建议充值后重试。'
    elif kind=='permission':category='permission';text='TikHub 鉴权失败，钥匙不可用，付费搜索和取数受影响；建议检查账户和钥匙配置。'
    elif kind=='access_denied':
        category='access_denied';severity='中'
        text='TikHub 返回403拒绝访问，原因尚未确认，相关数据可能缺失；建议检查原始返回和服务状态。'
    elif kind=='rate_limit':
        category='rate_limit';severity='中'
        text='TikHub 被拦或限流，本轮已收紧并停止后续付费请求，未连续重试；相关数据可能缺失，建议稍后低频重试。'
    elif transport_error(error):
        category='network_error';severity='中'
        text='TikHub 网络传输中断，响应未完整收到；最多重试一次，费用可能已产生，见本次 paid_calls 和原始错误。'
    elif (code and code>=500) or re.search('timeout|timed out|超时',str(error),re.I):
        with _RUN_LOCK:
            _FAILURES[path]+=1
            count=_FAILURES[path]
        if count<2:return
        if count==2:occurrences=2
        category='service_unstable';severity='中'
        text='TikHub 同一接口在本轮至少两次超时或服务出错，相关数据可能缺失；建议稍后重试并检查服务状态。'
    if category:
        return observe(severity=severity,summary=text,category=category,platform=platform,capability=cap,endpoint=path,source='TikHub',occurrences=occurrences)


def capability_for(path):
    if 'comment' in path:return 'comments'
    if any(k in path for k in ('profile','user_info')):return 'profile'
    if any(k in path for k in ('user_post','posted_notes','user_posts','user_tweet')):return 'posts'
    if 'statistics' in path:return 'stats'
    if 'pgy/' in path:return 'reads'
    if any(k in path for k in ('subtitle','caption')):return 'subtitles'
    if 'playurl' in path:return 'media'
    return 'content'


def schema(platform, capability, endpoint, error=''):
    if expected_content(error):return
    return observe(severity='中',category='schema_changed',platform=platform,capability=capability,endpoint=endpoint,source='TikHub',
                   summary=f'{PLATFORMS.get(platform,platform)}的付费取数结果格式变了，{ {"comments":"评论","content":"正文","profile":"账号资料","posts":"作品列表","stats":"互动数据","media":"媒体地址","subtitles":"字幕"}.get(capability,capability)}暂时读不全；建议让 Agent 对照原始返回修复解析后再用。')


def expected_content(note):
    return bool(re.search(r'已删除|不存在|私密|链接错误|加密|U2FsdGVk|\[deleted\]|\[removed\]|\b(?:404|410)\b|not[_ ]found|unavailable|private|removed|deleted|invalid (?:url|parameter)',str(note),re.I))


# Only free routes previously verified in README/selftest are monitored. Known unusable
# anonymous routes (e.g. Reddit .json, small XHS creators) are intentionally absent.
VERIFIED_FREE = {
    'douyin':{'iesdouyin share page (guest ttwid + Android UA)','Googlebot SEO page'},
    'wechat':{'article HTML #js_content'}, 'x':{'syndication tweet-result'},
    'youtube':{'YouTube Official.videos','yt-dlp YouTube'},
    'tiktok':{'yt-dlp TikTok extractor (play stream = no watermark)','oEmbed'},
    'instagram':{'yt-dlp Instagram extractor (post/reel, guest GraphQL)'},
    'threads':{'Googlebot UA SSR','facebookexternalhit UA og'},
    'linkedin':{'guest page JSON-LD'},'reddit':{'.rss Atom','arctic-shift archive (snapshot)'},
    'bluesky':{'public AppView getPostThread'}, 'telegram':{'t.me/s web preview'},
    'medium':{'author RSS (full text)','article OpenGraph (summary only)'},
    'substack':{'Substack public /api/v1/posts'},'pinterest':{'Pinterest public JSON-LD/OpenGraph'},
    'facebook':{'yt-dlp Facebook extractor (public video)'},
}


def free_routes(res,ctx):
    if ctx.no_paid:return
    import paid, routes
    methods=[m for m in res.methods if not m.get('paid') and m.get('method') in VERIFIED_FREE.get(res.platform,set())]
    bad=[m for m in methods if '暂不支持的类型' not in m.get('note','') and m['status'] in ('connector_failed','auth_failed','rate_limited') and not expected_content(m.get('note',''))]
    if not bad:return
    # An earlier failed attempt is retained even when a later free or paid route succeeds.
    free_success=any(m['status'] in ('success','index_partial') for m in methods)
    route=routes.DETAIL.get(res.platform)
    cost=paid.price(route[0]) if route and not free_success else 0
    extra=f'现在若需付费兜底，每条正文多花约 ${cost:.3f}（美元估算，评论另计）' if cost else '本次仍可尝试其他免费路线，每条新增费用为 $0'
    observe(severity='低',category='free_route_broken',platform=res.platform,capability=bad[0]['capability'],endpoint=res.url or bad[0]['method'],source=bad[0]['method'],
            summary=f'{PLATFORMS.get(res.platform,res.platform)}原先能用的免费路线失败了；{extra}。建议检查游客接口，修复后恢复免费路线。')


def balance(doc):
    if not isinstance(doc,dict) or not doc.get('ok'):return
    value=doc.get('user_data',{}).get('balance')
    try: amount=float(value)
    except (TypeError,ValueError):return
    if amount<1:
        return observe(severity='中',category='low_balance',platform='tikhub',capability='account',endpoint='account',source='TikHub',daily=True,
                       summary=f'TikHub 余额只剩约 ${amount:.4f}，低于 $1，后续付费搜索和取数可能中断；建议提前充值。')


def finish_paid():
    if not _PAID_USED:return
    import subprocess,paid,core
    try:
        p=subprocess.run([*paid.CLI,'account'],capture_output=True,text=True,env=core.SAFE_ENV,timeout=40)
        # Account is free; evidence never includes account IDs or keys.
        doc=json.loads(p.stdout)
        if p.returncode or not doc.get('ok'):
            paid_error('account',doc);return
        balance(doc)
    except (OSError,ValueError,subprocess.TimeoutExpired) as e:
        paid_error('account',type(e).__name__)


def command(argv):
    parser=argparse.ArgumentParser(prog='sourceboard incidents',description='搜索异常：先告诉用户，再标记已告知；修好后关闭。')
    parser.add_argument('action',nargs='?',default='list',choices=('list','add','notify','resolve'))
    parser.add_argument('ident',nargs='?')
    parser.add_argument('--json',action='store_true')
    parser.add_argument('--severity',choices=('高','中','低'),default='中')
    parser.add_argument('--summary');parser.add_argument('--note',default='')
    parser.add_argument('--platform',default='unknown');parser.add_argument('--source',default='Agent')
    parser.add_argument('--capability',default='search');parser.add_argument('--category',default='manual')
    parser.add_argument('--endpoint',default='');parser.add_argument('--evidence',default='')
    args=parser.parse_args(argv)
    if args.action=='add':
        if not args.summary:parser.error('add 需要 --summary 给用户看的中文说明')
        result={'item':add(severity=args.severity,summary=args.summary,platform=args.platform,source=args.source,capability=args.capability,category=args.category,endpoint=args.endpoint,evidence=args.evidence)}
    elif args.action in ('notify','resolve'):
        if not args.ident:parser.error('需要异常编号；notify 也可用 all')
        result={'items':transition(args.ident,'notified' if args.action=='notify' else 'resolved',args.note)}
    else: result={'items':listing()}
    result['pending_incidents']=emit_pending()
    if args.json:print(json.dumps(result,ensure_ascii=False))
    elif 'message' in result:print(result['message'])
    else:
        rows=[result['item']] if 'item' in result else result.get('items',[])
        if not rows:print('没有未解决的异常。')
        for r in rows:print(f"[{r['id']}] {r['severity']} · {STATUS_LABELS[r['status']]} · {r['count']}次 · {r['summary']}")
    return 0
