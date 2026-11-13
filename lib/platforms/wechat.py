# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import re
import html
from urllib.parse import urlsplit
from core import attempt, get_with_retry, meta_tag, strip_html, ts, Fail
NAME, MATCH = "wechat", r"mp\.weixin\.qq\.com/"


def article_images(body):
    images = []
    for _, value in re.findall(r'\b(?:data-src|src)\s*=\s*([\x22\x27])(.*?)\1', body, re.S | re.I):
        value = html.unescape(value)
        parsed = urlsplit(value)
        if parsed.scheme in ('http', 'https') and (parsed.hostname or '').endswith('.qpic.cn') and value not in images:
            images.append(value)
    return images


def js_literal(source, start):
    """Read WeChat's data literal only; never evaluate page JavaScript."""
    import ast
    import json
    pos = start
    def value(depth=0):
        nonlocal pos
        if depth > 40:
            raise ValueError('page data nesting exceeds limit')
        def space():
            nonlocal pos
            while pos < len(source) and source[pos].isspace(): pos += 1
        space()
        if pos >= len(source): raise ValueError('truncated page data')
        ch = source[pos]
        if ch in '{[':
            pos += 1; result = {} if ch == '{' else []; end = '}' if ch == '{' else ']'
            while True:
                space()
                if source[pos:pos+1] == end: pos += 1; return result
                if ch == '{':
                    if source[pos:pos+1] in ('"', "'"): key = value(depth+1)
                    else:
                        m = re.match(r'[A-Za-z_$][\w$]*', source[pos:])
                        if not m: raise ValueError('invalid page data key')
                        key = m[0]; pos += len(key)
                    space()
                    if source[pos:pos+1] != ':': raise ValueError('missing colon')
                    pos += 1; result[key] = value(depth+1)
                else: result.append(value(depth+1))
                space()
                if source[pos:pos+1] == ',': pos += 1
                elif source[pos:pos+1] != end: raise ValueError('invalid page data separator')
        if ch in ('"', "'"):
            m = re.match(r'''(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")''', source[pos:], re.S)
            if not m: raise ValueError('invalid page string')
            result = ast.literal_eval(m[0]).replace('\\/', '/')
            pos += len(m[0]); space()
            # The template coerces literal numeric strings with `* 1`.
            m = re.match(r'\*\s*1\b', source[pos:])
            if m:
                pos += len(m[0]); return float(result or 0) if '.' in result else int(result or 0)
            return result
        m = re.match(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true\b|false\b|null\b', source[pos:])
        if not m: raise ValueError('nonliteral page data')
        pos += len(m[0]); return json.loads(m[0])
    return value()


def page_data(h):
    data = {}
    m = re.search(r'window\.cgiDataNew\s*=\s*(?=\{)', h)
    if m:
        try: data = js_literal(h, m.end())
        except (ValueError, SyntaxError, IndexError): pass
    # Older picture pages use a separate literal array; ignore later computed assignments.
    for m in re.finditer(r'window\.picture_page_info_list\s*=\s*(?=\[)', h):
        try: pictures = js_literal(h, m.end())
        except (ValueError, SyntaxError, IndexError): continue
        if pictures:
            data['picture_page_info_list'] = pictures
            data.setdefault('item_show_type', 8)
            break
    return data


def message_content(res, data):
    """Normalize text/picture messages into the ordinary article fields."""
    kind = data.get('item_show_type', data.get('real_item_show_type'))
    if kind is None: return False
    try: kind = int(kind)
    except (TypeError, ValueError): pass
    res.extra['wechat_item_show_type'] = kind
    if kind not in (0, 8, 10):
        if data.get('content_noencode') or data.get('content_html') or data.get('content_text'): return False
        import incidents
        incidents.unsupported_type('wechat', res.url, f'item_show_type={kind}')
        raise Fail(f'公众号暂不支持的类型：item_show_type={kind}')
    if kind == 0: return False
    text_info = data.get('text_page_info') or {}
    body = text_info.get('content_noencode') or text_info.get('content') or data.get('content_noencode') or data.get('content') or ''
    if not isinstance(body, str): body = ''
    res.title = html.unescape(str(data.get('title') or ''))
    res.text = strip_html(html.unescape(body))
    res.author = html.unescape(str(data.get('nick_name') or data.get('nickname') or data.get('author') or ''))
    res.published = ts(data.get('create_timestamp') or data.get('ori_create_time') or data.get('create_time'))
    images = []
    # Each entry's top-level URL is the original; nested share-cover/watermark URLs are not pages.
    pictures = (data.get('picture_page_info_list') or []) + (text_info.get('picture_info') or [])
    for item in pictures:
        if not isinstance(item,dict): continue
        url = next((item[k] for k in ('cdn_url', 'url', 'img_url', 'pic_url', 'image_url', 'cdn_img_url') if isinstance(item.get(k),str) and item[k]), '')
        url = html.unescape(url)
        parsed = urlsplit(url)
        if parsed.scheme in ('http','https') and (parsed.hostname or '').endswith('.qpic.cn'):
            images.append(url)
    res.images = list(dict.fromkeys(images + article_images(body)))
    # Preserve a separate cover without substituting avatars or UI images.
    cover = data.get('cdn_url')
    if isinstance(cover,str) and cover.startswith(('http://','https://')):
        res.extra['cover_url'] = html.unescape(cover)
    return bool(res.text or res.images)

def scrape(res, o):
    def page():
        # Avoid an unnecessary HTTP redirect; retry transient TLS/read failures
        # once before the existing paid fallback. Never retry a challenge body.
        response = get_with_retry(re.sub(r'^http:', 'https:', res.url), attempts=2)
        h = response.text
        if 'wappoc_appmsgcaptcha' in urlsplit(getattr(response, 'url', '')).path:
            raise Fail('微信游客请求被转至验证码页，未取得正文；不重试验证页')
        data = page_data(h)
        if data and (data.get('item_show_type') in (8,10,'8','10') or 'id="js_content"' not in h) and message_content(res, data):
            return
        m = re.search(r'id="js_content"[^>]*>(.*?)</div>\s*<script', h, re.S) or re.search(r'id="js_content"[^>]*>(.*)', h, re.S)
        if not m:
            raise Fail("no #js_content (deleted/blocked article or captcha)")
        body = m.group(1)
        if re.search(r'U2FsdGVk[A-Za-z0-9+/=]{60,}', body):
            raise Fail('quality_gate: #js_content 含 U2FsdGVk 加密块，不能作为正文')
        res.title = meta_tag(h, "og:title")
        res.author = (re.search(r'var nickname = htmlDecode\("([^"]*)"', h) or re.search(r'id="js_name">\s*([^<]+)', h) or [0, ""])[1].strip()
        t = re.search(r"var ct = \"(\d+)\"", h) or re.search(r"create_time\s*[:=]\s*['\"]?(\d+)", h)
        res.published = ts(t.group(1)) if t else ""
        res.text = strip_html(body)
        cov = meta_tag(h, "og:image")
        res.images = list(dict.fromkeys(([html.unescape(cov)] if cov else []) + article_images(body)))
    attempt(res, "content", [("article HTML #js_content", page)])
    res.extra["note"] = "正文由公开 HTML 提取；互动数未返回；评论由统一路由另取。"
    if o.with_comments:
        res.needs_paid.append("comments")
