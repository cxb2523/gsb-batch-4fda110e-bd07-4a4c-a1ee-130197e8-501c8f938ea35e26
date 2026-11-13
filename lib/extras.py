"""Additional stdlib free routes and existing-caption retrieval."""
import html
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit, urlencode, parse_qs
import xml.etree.ElementTree as ET
import core
from core import get, meta_tag, strip_html, Fail, attempt, ts, CURRENT, ytdlp_info, fill_from_ytdlp, save_raw


def generic(res, o):
    def page():
        r = get(res.url)
        h = r.text
        if 'substack' in h.lower() and '/p/' in res.url:
            from platforms.substack import scrape
            res.platform = 'substack'
            scrape(res, o)
            return
        res.title = meta_tag(h, 'og:title') or ((re.search(r'<title[^>]*>(.*?)</title>', h, re.I | re.S) or [None, ''])[1])
        res.title = strip_html(res.title)
        body = re.search(r'<(?:article|main)\b[^>]*>(.*?)</(?:article|main)>', h, re.S | re.I)
        res.text = strip_html(body.group(1) if body else re.sub(r'<head\b.*?</head>', '', h, flags=re.S | re.I))
        res.author = meta_tag(h, 'author')
        res.extra['description'] = meta_tag(h, 'description') or meta_tag(h, 'og:description')
        res.published = meta_tag(h, 'article:published_time')
        if meta_tag(h, 'og:image'):
            res.images.append(meta_tag(h, 'og:image'))
    if attempt(res, 'content', [('generic public HTML', page)]):
        res.setcap('content', 'index_partial', 'generic public HTML', '通用 HTML 提取；可能混入导航或缺少动态内容')


def pinterest(res, o):
    def page():
        h = get(res.url, core.UA_GOOGLEBOT).text
        # Only public JSON-LD/OG, no gallery-dl configs or authenticated sessions.
        res.title = meta_tag(h, 'og:title')
        res.text = meta_tag(h, 'og:description') or meta_tag(h, 'description')
        for block in re.findall(r'<script[^>]+type=[\"\x27]application/ld\+json[\"\x27][^>]*>(.*?)</script>', h, re.S):
            try:
                from paid import walk
                for v in walk(json.loads(block)):
                    if v.get('@type') in ('SocialMediaPosting', 'ImageObject', 'CreativeWork'):
                        res.text = v.get('articleBody') or v.get('description') or res.text
                        a = v.get('author') or {}
                        res.author = a.get('name', '') if isinstance(a, dict) else str(a)
                        res.published = ts(v.get('datePublished'))
            except ValueError:
                pass
        image = meta_tag(h, 'og:image')
        if image:
            res.images.append(image)
    attempt(res, 'content', [('Pinterest public JSON-LD/OpenGraph', page)])


def youtube(res, o):
    def official():
        from youtube_official import Official
        c = Official(str(CURRENT.get().out / 'official-quota'))
        data = c.videos([res.id])
        save_raw('youtube-official', data)
        if isinstance(data, dict):
            v = data.get('found', data).get(res.id) or {}
        elif isinstance(data, list):
            v = data[0] if data else {}
        else:
            v = {}
        if not v.get('ok'):
            raise Fail('YouTube 官方详情未返回有效视频')
        res.title, res.text = v.get('title', ''), v.get('description', '')
        res.author, res.published = v.get('channel', ''), v.get('published_at_utc', '')
        res.stats = {k: v.get(k) for k in ('views', 'likes', 'comments') if v.get(k) is not None}
        res.extra['duration'] = v.get('duration_seconds')
    def ytd():
        fill_from_ytdlp(res, ytdlp_info(res.url))
    attempt(res, 'content', [('YouTube Official.videos', official), ('yt-dlp YouTube', ytd)])


def extract_caption(text, ext):
    if ext == 'json3':
        d = json.loads(text)
        return '\n'.join(''.join(s.get('utf8', '') for s in e.get('segs', [])) for e in d.get('events', []) if e.get('segs'))
    if ext in ('srv1', 'srv2', 'srv3', 'ttml', 'xml') or text.lstrip().startswith('<?xml'):
        root = ET.fromstring(text)
        return '\n'.join(''.join(x.itertext()) for x in root.iter() if x.tag.split('}')[-1] in ('text', 'p'))
    lines, last = [], ''
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith(('WEBVTT', 'Kind:', 'Language:', 'NOTE', 'STYLE', 'REGION')) or '-->' in line or line.isdigit():
            continue
        line = html.unescape(re.sub(r'<[^>]*>', '', line))
        if line != last:
            lines.append(line)
            last = line
    return '\n'.join(lines)


def subtitles(res):
    ctx = CURRENT.get()
    base_note = '未取得现成字幕；本工具不做语音转写'
    if res.platform not in ('youtube', 'bilibili', 'tiktok'):
        res.setcap('subtitles', 'not_attempted', '', base_note)
        return
    start = __import__('time').monotonic()
    try:
        # Even if Official handled details, yt-dlp remains the anonymous caption reader.
        info = ctx.ytdlp or ytdlp_info(res.url)
        if not res.videos or res.platform == 'youtube':
            fill_from_ytdlp(res, info)
        subs = {**(info.get('automatic_captions') or {}), **(info.get('subtitles') or {})}
        languages = [lang for lang in ('zh-Hans', 'zh-CN', 'zh', 'en', 'en-orig') if lang in subs]
        # yt-dlp may put translations from many source languages in `en`.
        # Prefer the actual English source track to Arabic -> English, etc.
        translated = lambda f: 'tlang' in parse_qs(urlsplit(f.get('url', '')).query)
        if 'en' in languages and 'en-orig' in languages and not any(not translated(f) for f in subs['en']):
            languages.remove('en-orig')
            languages.insert(languages.index('en'), 'en-orig')
        if not languages:
            languages = sorted(subs)[:1]
        if not languages:
            res.log('subtitles', 'yt-dlp captions', True, base_note, __import__('time').monotonic()-start, status='not_attempted')
            return
        errors = []
        for lang in languages:
            formats = sorted(subs[lang], key=lambda f: (translated(f), ('json3', 'vtt', 'srt', 'ttml').index(f.get('ext')) if f.get('ext') in ('json3', 'vtt', 'srt', 'ttml') else 9))
            for f in formats[:2]:
                try:
                    r = core.get_with_retry(f['url'])
                    body = extract_caption(r.text, f.get('ext', 'vtt'))
                    if not body.strip() or len(body.strip()) < 5:
                        raise Fail('empty caption body')
                    dest = core.external_path(ctx.out / 'subtitles')
                    dest.mkdir(exist_ok=True)
                    path = dest / (re.sub(r'[^\w-]', '', lang) + '.txt')
                    path.write_text(body)
                    res.extra.setdefault('subtitle_files', []).append(str(path))
                    res.extra.setdefault('subtitle_sources', []).append({'language': lang, 'automatic': lang not in info.get('subtitles', {}), 'url': f['url']})
                    res.log('subtitles', 'yt-dlp + existing caption HTTP', True, f'{lang}；仅字幕，没有 ASR', __import__('time').monotonic()-start)
                    return
                except Exception as e:
                    # Once a caption endpoint remains throttled, do not fan out
                    # to more formats/languages and erase the rate_limited status.
                    if getattr(e, 'status', '') == 'rate_limited':
                        raise
                    errors.append(str(e))
        raise Fail('; '.join(errors)[-500:])
    except Exception as e:
        res.log('subtitles', 'yt-dlp captions', False, str(e) + '；' + base_note, __import__('time').monotonic()-start, status=getattr(e, 'status', 'connector_failed'))
        if res.platform == 'bilibili' and not ctx.no_paid and res.extra.get('aid') and res.extra.get('cid'):
            bili_captions(res)


def bili_captions(res):
    """Paid metadata fallback for existing CC only; never download video or ASR."""
    import paid
    start = __import__('time').monotonic()
    base_note = '未取得现成字幕；本工具不做语音转写'
    try:
        d = paid.call('/api/v1/bilibili/web/fetch_video_subtitle', {'a_id': res.extra['aid'], 'c_id': res.extra['cid']})
        nodes = list(paid.walk(d))
        # Some responses return the caption segments directly.
        segments = next((n['body'] for n in nodes if isinstance(n.get('body'), list)), None)
        caption_url = next((n.get('subtitle_url') for n in nodes if n.get('subtitle_url')), None)
        if caption_url:
            caption_url = 'https:' + caption_url if caption_url.startswith('//') else caption_url
            body = get(caption_url).json()
            segments = body.get('body') if isinstance(body, dict) else None
        if segments:
            text = '\n'.join(str(n.get('content') or n.get('text') or '') for n in segments if isinstance(n, dict)).strip()
            if not text:
                import incidents
                incidents.schema('bilibili','subtitles','/api/v1/bilibili/web/fetch_video_subtitle')
                raise Fail('quality_gate: CC 字幕段落没有文字')
            ctx = CURRENT.get()
            dest = core.external_path(ctx.out / 'subtitles')
            dest.mkdir(exist_ok=True)
            path = dest / 'bilibili-cc.txt'
            path.write_text(text)
            res.extra.setdefault('subtitle_files', []).append(str(path))
            res.log('subtitles', 'TikHub Bilibili CC + public subtitle JSON', True, '现成字幕，无 ASR', __import__('time').monotonic()-start, paid=True)
            return
        if any(isinstance(n.get('subtitles'), list) and not n['subtitles'] for n in nodes):
            res.log('subtitles', 'TikHub Bilibili CC', True, base_note, __import__('time').monotonic()-start, paid=True, status='not_attempted')
            return
        import incidents
        incidents.schema('bilibili','subtitles','/api/v1/bilibili/web/fetch_video_subtitle',str(d))
        raise Fail('quality_gate: 字幕响应结构未识别或没有公开字幕地址')
    except Exception as e:
        res.log('subtitles', 'TikHub Bilibili CC', False, str(e) + '；' + base_note, __import__('time').monotonic()-start, paid=True, status=getattr(e, 'status', 'connector_failed'))
