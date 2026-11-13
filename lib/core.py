"""Stdlib runtime. Free parsing adapted from OmniScraper (MIT, BeatAPI 2026).

Only anonymous HTTP sessions and an optional local yt-dlp executable are used.
No browser integrations, account cookies, authentication configuration or ASR.
"""
import contextvars
import copy
import datetime as dt
from email.utils import parsedate_to_datetime
import html
from html.parser import HTMLParser
import http.cookiejar
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace
import sbconfig

DEFAULT_ROOT = sbconfig.home() / 'runs'
YTDLP = sbconfig.which('yt-dlp')
UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
UA_ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'
UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
UA_FBEXT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
CAPS = ('content', 'stats', 'comments', 'media', 'subtitles')
STATUSES = ('success', 'true_zero', 'auth_failed', 'connector_failed', 'rate_limited', 'index_partial', 'not_attempted')
CURRENT = contextvars.ContextVar('sourceboard_run', default=None)
SAFE_ENV = dict(os.environ, PATH=os.pathsep.join([os.environ.get('PATH', ''), str(Path.home() / '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']), PYTHONDONTWRITEBYTECODE='1')


class Fail(Exception):
    def __init__(self, note, status='connector_failed'):
        self.status = status
        super().__init__(note)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def external_path(value):
    """输出位置：用户给的任何目录都行，统一成绝对路径。"""
    return Path(value).expanduser().absolute().resolve()


def clean(obj):
    """Keep public response bodies, never provider request headers or credentials."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if k.lower() not in
                ('http_headers', 'cookies', 'cookie', 'authorization', 'api_key', 'access_token', 'refresh_token', 'decode_key', 'set-cookie')}
    if isinstance(obj, (tuple, list)):
        return [clean(v) for v in obj]
    return obj


def save_raw(label, data, suffix='json'):
    ctx = CURRENT.get()
    if not ctx:
        return ''
    external_path(ctx.out)
    ctx.raw_counter += 1
    path = external_path(ctx.out / 'raw' / f'{ctx.raw_counter:03d}-{re.sub(r"[^a-zA-Z0-9_-]", "-", label)[:80]}.{suffix}')
    path.parent.mkdir(parents=True, exist_ok=True)
    if suffix == 'json':
        path.write_text(json.dumps(clean(data), ensure_ascii=False, indent=2, default=str))
    else:
        path.write_text(str(data), encoding='utf-8')
    return str(path)


def ts(value):
    if not value:
        return ''
    try:
        s = str(value)
        if re.fullmatch(r'\d{8}', s):
            return dt.datetime.strptime(s, '%Y%m%d').replace(tzinfo=dt.timezone.utc).isoformat()
        if re.fullmatch(r'\d+(?:\.\d+)?', s):
            n = float(value)
            return dt.datetime.fromtimestamp(n / 1000 if n > 1e12 else n, dt.timezone.utc).isoformat()
        return dt.datetime.fromisoformat(s.replace('Z', '+00:00')).isoformat()
    except (ValueError, TypeError, OverflowError):
        try:
            return dt.datetime.strptime(str(value), '%a %b %d %H:%M:%S %z %Y').isoformat()
        except ValueError:
            return str(value)


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript'):
            self.skip += 1
        elif tag in ('p', 'br', 'div', 'li', 'h1', 'h2', 'h3') and not self.skip:
            self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript'):
            self.skip = max(0, self.skip - 1)
        elif tag in ('p', 'div', 'li') and not self.skip:
            self.parts.append('\n')
    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def strip_html(s):
    p = TextParser()
    p.feed(str(s or ''))
    return re.sub(r'\n\s*\n+', '\n\n', ''.join(p.parts)).strip()


def meta_tag(h, prop):
    for tag in re.findall(r'<meta\b[^>]+>', h, re.I):
        attrs = dict((k.lower(), html.unescape(v)) for k, _, v in re.findall(r'([\w:-]+)\s*=\s*([\"\x27])(.*?)\2', tag, re.S))
        if attrs.get('property', attrs.get('name', '')).lower() == prop.lower():
            return attrs.get('content', '')
    return ''


class Response:
    def __init__(self, body, url, status, headers):
        self.content, self.url, self.status_code, self.headers = body, url, status, headers
        charset = headers.get_content_charset() or 'utf-8'
        self.text = body.decode(charset, 'replace')
        self.cookies = {}
        for item in headers.get_all('Set-Cookie', []):
            name, _, value = item.split(';', 1)[0].partition('=')
            if name == 'ttwid':  # anonymous device identifier only
                self.cookies[name] = value
    def json(self):
        return json.loads(self.text)


class Session:
    def __init__(self, ua=UA_DESKTOP, referer=None, cookies=None):
        self.headers = {'User-Agent': ua}
        if referer:
            self.headers['Referer'] = referer
        self.cookies = dict(cookies or {})
        # No browser/profile cookie loading, no persistent cookie jar.
        self.opener = urllib.request.build_opener()
    def request(self, method, url, params=None, json=None, data=None, timeout=15, headers=None, **kw):
        if params:
            url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
        if urllib.parse.urlsplit(url).scheme not in ('http', 'https'):
            raise Fail('only public HTTP(S) URLs are supported')
        hdr = {**self.headers, **(headers or {})}
        guest = {k: v for k, v in self.cookies.items() if k in ('ttwid', 'buvid3', 'buvid4') and v}
        if guest:
            hdr['Cookie'] = '; '.join(f'{k}={v}' for k, v in guest.items())
        if json is not None:
            data = __import__('json').dumps(json).encode()
            hdr['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=data, method=method, headers=hdr)
        ctx = CURRENT.get()
        if ctx:
            timeout = min(timeout, ctx.timeout)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read(16 * 1024 * 1024 + 1)
                if len(body) > 16 * 1024 * 1024:
                    raise Fail('HTTP response exceeds 16 MiB metadata limit')
                resp = Response(body, r.url, r.status, r.headers)
        except urllib.error.HTTPError as e:
            body = e.read(2 * 1024 * 1024)
            save_raw('http-error', {'url': url, 'status': e.code, 'body': body.decode('utf-8', 'replace')})
            failure = Fail(f'HTTP {e.code}', 'rate_limited' if e.code in (429, 461) else 'auth_failed' if e.code in (401, 403) else 'connector_failed')
            value = (e.headers or {}).get('Retry-After', '')
            try:
                failure.retry_after = max(0, float(value))
            except (ValueError, TypeError):
                try:
                    failure.retry_after = max(0, parsedate_to_datetime(value).timestamp() - time.time())
                except (ValueError, TypeError, OverflowError):
                    pass
            raise failure from None
        save_raw('http-' + urllib.parse.urlsplit(url).hostname, {'url': url, 'final_url': resp.url, 'status': resp.status_code, 'body': resp.text})
        return resp
    def get(self, url, **kw):
        return self.request('GET', url, **kw)
    def post(self, url, **kw):
        return self.request('POST', url, **kw)


def session(ua=UA_DESKTOP, referer=None, cookies=None):
    return Session(ua, referer, cookies)


def get(url, ua=UA_DESKTOP, s=None, **kw):
    return (s or session(ua)).get(url, **kw)


def get_with_retry(url, attempts=2, **kw):
    """Bounded anonymous GET retries, used only for article/caption transport.

    Retry transport failures only. HTTP errors, including 429/461, stop at once.
    """
    for index in range(attempts):
        try:
            return get(url, **kw)
        except (Fail, urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, http.client.IncompleteRead, http.client.RemoteDisconnected) as e:
            status = getattr(e, 'status', 'connector_failed')
            if isinstance(e, (Fail, urllib.error.HTTPError)):
                raise
            delay = max(2 ** (index + 1), getattr(e, 'retry_after', 0))
            if index + 1 == attempts or delay > 30:
                reason = '服务端要求等待超过30秒，本轮停止' if delay > 30 else '达到重试上限，本轮停止'
                raise Fail(f'{e}；已尝试{index + 1}次，{reason}', status) from None
            save_raw('http-retry', {'url': url, 'attempt': index + 1, 'status': status, 'delay_seconds': delay})
            time.sleep(delay)


requests = SimpleNamespace(post=lambda url, **kw: session().post(url, **kw))


def quality_error(res):
    body = str(res.text or '').strip()
    title = str(res.title or '').strip()
    joined = body + '\n' + title
    if not joined.strip() or (not body and not res.images and not res.videos and not res.items):
        return '正文为空或关键字段全缺'
    if body in ('[deleted]', '[removed]'):
        return '内容已删除'
    encrypted = re.findall(r'U2FsdGVk[A-Za-z0-9+/=\s]{80,}', joined)
    longruns = re.findall(r'[A-Za-z0-9+/=]{500,}', joined)
    if encrypted or sum(map(len, longruns)) > len(joined) * .30:
        return '加密乱码或长编码段占比过高'
    structured_identity = bool(res.author and (res.stats or res.images or res.videos))
    if not structured_identity and len(body) < 800 and re.search(r'环境异常|访问过于频繁|请完成.*验证|安全验证|验证码|该内容已被|内容已删除|页面不存在|log in to continue|sign in to continue|verify you are human|page not found|post unavailable', joined, re.I):
        return '登录、验证、删除或错误页'
    if title.strip().lower() in ('login', 'log in', 'sign in', 'just a moment...', 'facebook - log in or sign up'):
        return '登录或挑战页'
    if not body and not res.author and not res.stats and not res.items:
        return '只有页面标题，缺少正文和身份信息'
    return ''


class Result:
    def __init__(self, platform, url):
        self.platform = platform
        self.url = url
        self.id = ''
        self.title = self.author = self.published = self.text = ''
        self.stats, self.stats_sources = {}, {}
        self.images, self.videos, self.comments, self.items = [], [], [], []
        self.extra, self.methods = {}, []
        self.needs_paid, self.media_files = [], []
        self.capabilities = {c: {'status': 'not_attempted', 'source': '', 'note': ''} for c in CAPS}
    def setcap(self, cap, status, source='', note=''):
        assert status in STATUSES
        self.capabilities[cap] = {'status': status, 'source': source, 'note': str(note)}
    def log(self, cap, method, ok, note='', elapsed=0, paid=False, status=None, **extra):
        status = status or ('success' if ok else 'connector_failed')
        self.methods.append(dict(capability=cap, method=method, status=status, note=str(note), seconds=round(elapsed, 3), paid=paid, **extra))
        self.setcap(cap, status, method, note)


def attempt(res, cap, chain):
    for name, fn in chain:
        before = copy.deepcopy(res.__dict__)
        start = time.monotonic()
        try:
            fn()
            if cap == 'content':
                error = quality_error(res)
                if error:
                    raise Fail('quality_gate: ' + error)
            elif cap == 'stats' and not any(v is not None and v != '' for v in res.stats.values()):
                raise Fail('quality_gate: stats 关键字段全缺')
            elif cap == 'comments' and not res.comments:
                raise Fail('empty comments without a verified zero marker')
            partial = any(x in name.lower() for x in ('summary only', 'archive', 'rss atom', 'opengraph'))
            res.log(cap, name, True, elapsed=time.monotonic() - start, status='index_partial' if partial else 'success')
            if res.stats:
                res.stats_sources.update({k: name for k, v in res.stats.items() if v is not None})
            return True
        except Exception as e:
            res.__dict__.update(before)
            res.log(cap, name, False, f'{type(e).__name__}: {e}', time.monotonic()-start, status=getattr(e, 'status', 'connector_failed'))
    res.needs_paid.append(cap)
    return False


def ytdlp_info(url, extra=None):
    ctx = CURRENT.get()
    if not YTDLP:
        raise Fail('本机没装 yt-dlp，这条免费路线跳过（装了会自动用上：pipx install yt-dlp 或 brew install yt-dlp）', 'not_attempted')
    args = [YTDLP, '--ignore-config', '--no-cache-dir', '--skip-download', '--dump-single-json',
            '--no-warnings', '--socket-timeout', '15', '--retries', '0', '--extractor-retries', '0',
            '--ignore-no-formats-error', '--playlist-end', '20']
    if (extra or {}).get('getcomments'):
        args += ['--write-comments', '--extractor-args', 'youtube:max_comments=20,all,0,0']
    args += ['--', url]
    try:
        p = subprocess.run(args, capture_output=True, text=True, env=SAFE_ENV, timeout=max(45, (ctx.timeout if ctx else 15)*5))
    except FileNotFoundError:
        raise Fail('yt-dlp 无法运行，这条免费路线跳过', 'not_attempted') from None
    save_raw('yt-dlp-stderr', p.stderr, 'log')
    if p.returncode:
        status = 'rate_limited' if re.search(r'HTTP (?:Error )?(?:429|461)\b', p.stderr) else 'connector_failed'
        raise Fail('yt-dlp: ' + p.stderr[-1400:], status)
    try:
        info = json.loads(p.stdout)
    except ValueError:
        raise Fail('yt-dlp returned invalid JSON') from None
    save_raw('yt-dlp', info)
    if ctx:
        ctx.ytdlp = info
    return info


def fill_from_ytdlp(res, info):
    entries = info.get('entries') or []
    if entries:
        # Carousel: preserve every original media URL, not only thumbnails.
        first = entries[0] or {}
        main = {**first, **{k: v for k, v in info.items() if v and k in ('description', 'title', 'uploader', 'timestamp', 'like_count', 'comment_count')}}
    else:
        main = info
        entries = [info]
    res.title = res.title or main.get('title') or ''
    res.text = res.text or main.get('description') or ''
    res.author = res.author or main.get('uploader') or main.get('channel') or ''
    res.published = res.published or ts(main.get('timestamp') or main.get('upload_date'))
    for key, dest in (('view_count', 'views'), ('like_count', 'likes'), ('comment_count', 'comments'), ('repost_count', 'shares')):
        v = main.get(key)
        if isinstance(v, int):
            res.stats[dest] = v + 2**32 if -2**31 <= v < 0 else v
            res.stats_sources[dest] = 'yt-dlp'
    for e in entries:
        if not e:
            continue
        u = e.get('url', '')
        ext = e.get('ext', '')
        if ext in ('jpg', 'jpeg', 'png', 'webp') and u:
            res.images.append(u)
        else:
            thumb = e.get('thumbnail')
            if thumb:
                res.images.append(thumb)
            formats = e.get('formats') or []
            direct = [f for f in formats if f.get('url', '').startswith('http') and f.get('vcodec') != 'none' and f.get('protocol') in ('https', 'http')]
            if direct:
                # Choose a combined stream when possible; no watermark service used.
                direct.sort(key=lambda f: (f.get('acodec') != 'none', f.get('height') or 0, f.get('tbr') or 0))
                res.videos.append(direct[-1]['url'])
                if direct[-1].get('acodec') == 'none':
                    res.extra.setdefault('separate_video_tracks', []).append(direct[-1]['url'])
            elif u.startswith('http'):
                res.videos.append(u)
    if main.get('comments'):
        res.comments = [{'author': c.get('author'), 'text': c.get('text'), 'likes': c.get('like_count'), 'time': ts(c.get('timestamp'))} for c in main['comments']]
    res.extra['duration'] = main.get('duration')
    if res.platform == 'tiktok' and res.videos:
        res.extra['watermark'] = 'no_watermark_play_stream'


def download(url, path, ua=UA_DESKTOP, referer=None, max_bytes=512*1024*1024, chunk_bytes=None):
    path = external_path(path)
    hdr = {'User-Agent': ua}
    if referer:
        hdr['Referer'] = referer
    req = urllib.request.Request(url, headers=hdr)
    part = path.with_suffix(path.suffix + '.part')
    try:
        total=0;expected=None;segments=0
        with part.open('wb') as out:
            while True:
                segments+=1
                if segments>1024:raise Fail('media range count exceeds limit')
                if chunk_bytes:
                    end=min(total+chunk_bytes-1,expected-1) if expected else total+chunk_bytes-1
                    req=urllib.request.Request(url,headers={**hdr,'Range':f'bytes={total}-{end}'})
                elif total: req=urllib.request.Request(url,headers={**hdr,'Range':f'bytes={total}-'})
                with urllib.request.urlopen(req,timeout=30) as r:
                    ctype=r.headers.get('Content-Type','')
                    if 'text/html' in ctype:raise Fail('download returned HTML instead of media')
                    interval=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',r.headers.get('Content-Range',''))
                    if getattr(r,'status',200)==206 and not interval:raise Fail('partial media response without usable Content-Range')
                    if interval:
                        start,end,size=map(int,interval.groups())
                        if start!=total or end<start or end>=size or (expected is not None and expected!=size):raise Fail('media Content-Range mismatch')
                        expected=size;chunk_expected=end-start+1
                    else:
                        if total:raise Fail('CDN did not honor continuation Range; incomplete media rejected')
                        expected=int(r.headers['Content-Length']) if r.headers.get('Content-Length') else None
                        chunk_expected=expected
                    if expected is not None and expected>max_bytes:raise Fail('download exceeds size limit')
                    chunk_size=0
                    while True:
                        block=r.read(65536)
                        if not block:break
                        total+=len(block);chunk_size+=len(block)
                        if total>max_bytes:raise Fail('download exceeds size limit')
                        out.write(block)
                    if chunk_expected is not None and chunk_size!=chunk_expected:raise Fail('truncated media response')
                    if expected is None or total==expected:break
        if total < 16:
            raise Fail('empty media response')
        part.replace(path)
        return str(path)
    finally:
        if part.exists():
            part.unlink()
