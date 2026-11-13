# Adapted from OmniScraper, Copyright (c) 2026 BeatAPI. MIT; see LICENSE-OmniScraper.
import ast
import html
import json
import re
from urllib.parse import urlsplit
from core import attempt, get_with_retry, meta_tag, strip_html, ts, Fail
NAME, MATCH = "wechat", r"mp\.weixin\.qq\.com/"

# WeChat message pages: 0 = text-only message, 8/10 = picture albums.
MESSAGE_TYPES = (0, 8, 10)
IMAGE_HOST = 'qpic.cn'
MAX_DATA_DEPTH = 40
ENCRYPTED = re.compile(r'U2FsdGVk[A-Za-z0-9+/=]{60,}')
CAPTCHA_MARKERS = re.compile(r'wappoc_appmsgcaptcha|环境异常|访问过于频繁|请完成.{0,4}验证|安全验证|验证码|verify you are human', re.I)
DELETED_MARKERS = re.compile(r'该内容已被发布者删除|该内容已被|内容已删除|该文章已被删除|此内容因违规无法查看|链接已过期|内容不存在|该公众号已迁移', re.I)
CONTENT_FIELDS = ('content_noencode', 'content_html', 'content_text')
BODY_FIELDS = CONTENT_FIELDS + ('article_content', 'content')
PICTURE_KEYS = ('cdn_url', 'url', 'img_url', 'pic_url', 'image_url', 'cdn_img_url', 'src')
COVER_KEYS = ('cover_url', 'share_cover_url', 'cover_img_url', 'cover', 'cdn_url')
AUTHOR_KEYS = ('nick_name', 'nickname', 'author', 'user_name', 'account_name')
TIME_KEYS = ('create_timestamp', 'ori_create_time', 'create_time', 'publish_time', 'publish_timestamp', 'timestamp')


def qpic_image(value):
    """Only public images served over HTTP(S) from the qpic.cn domain."""
    if not isinstance(value, str):
        return ''
    value = html.unescape(value.strip())
    if not value:
        return ''
    parsed = urlsplit(value)
    host = (parsed.hostname or '').lower()
    if parsed.scheme not in ('http', 'https'):
        return ''
    if host != IMAGE_HOST and not host.endswith('.' + IMAGE_HOST):
        return ''
    return value


def article_images(body):
    images = []
    for _, value in re.findall(r'\b(?:data-src|src)\s*=\s*([\x22\x27])(.*?)\1', body, re.S | re.I):
        url = qpic_image(value)
        if url and url not in images:
            images.append(url)
    return images


def _has_closing_quote(source, start, quote):
    pos = start
    while pos < len(source):
        ch = source[pos]
        if ch == '\\':
            pos += 2
            continue
        if ch == quote:
            return True
        pos += 1
    return False


def js_literal(source, start):
    """Read WeChat's data literal only; never evaluate page JavaScript."""
    pos = start

    def value(depth=0):
        nonlocal pos
        if depth > MAX_DATA_DEPTH:
            raise ValueError('page data nesting exceeds limit')

        def space():
            nonlocal pos
            while pos < len(source) and source[pos].isspace():
                pos += 1

        space()
        if pos >= len(source):
            raise ValueError('truncated page data')
        ch = source[pos]
        if ch in '{[':
            pos += 1
            result = {} if ch == '{' else []
            end = '}' if ch == '{' else ']'
            while True:
                space()
                if pos >= len(source):
                    raise ValueError('truncated page data')
                if source[pos] == end:
                    pos += 1
                    return result
                if ch == '{':
                    if source[pos] in ('"', "'"):
                        key = value(depth + 1)
                        if not isinstance(key, str):
                            raise ValueError('invalid page data key')
                    else:
                        m = re.match(r'[A-Za-z_$][\w$]*', source[pos:])
                        if not m:
                            raise ValueError('invalid page data key')
                        key = m[0]
                        pos += len(key)
                    space()
                    if pos >= len(source) or source[pos] != ':':
                        raise ValueError('missing colon')
                    pos += 1
                    result[key] = value(depth + 1)
                else:
                    result.append(value(depth + 1))
                space()
                if pos >= len(source):
                    raise ValueError('truncated page data')
                if source[pos] == ',':
                    pos += 1
                elif source[pos] != end:
                    raise ValueError('invalid page data separator')
        if ch in ('"', "'"):
            m = re.match(r'(?:\'(?:\\.|[^\'\\])*\'|"(?:\\.|[^"\\])*")', source[pos:], re.S)
            if not m:
                # No closing quote before the end of the page: the data was cut off.
                if not _has_closing_quote(source, pos + 1, ch):
                    raise ValueError('truncated page data')
                raise ValueError('invalid page string')
            try:
                result = ast.literal_eval(m[0])
            except (SyntaxError, ValueError, MemoryError, RecursionError):
                raise ValueError('invalid page string') from None
            if not isinstance(result, str):
                raise ValueError('invalid page string')
            # JSON-escaped slashes appear inside WeChat's quoted literals.
            result = result.replace('\\/', '/')
            pos += len(m[0])
            space()
            # The template coerces literal numeric strings with `* 1`.
            m = re.match(r'\*\s*1\b', source[pos:])
            if m:
                pos += len(m[0])
                try:
                    return float(result or 0) if '.' in result else int(result or 0)
                except (TypeError, ValueError):
                    raise ValueError('invalid numeric page data') from None
            return result
        m = re.match(r'-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true\b|false\b|null\b|undefined\b', source[pos:])
        if not m:
            raise ValueError('nonliteral page data')
        token = m[0]
        pos += len(token)
        if token in ('true', 'false', 'null', 'undefined'):
            return {'true': True, 'false': False, 'null': None, 'undefined': None}[token]
        try:
            return json.loads(token)
        except ValueError:
            raise ValueError('invalid numeric page data') from None

    return value()


def page_data(h, status=None):
    """Page data as literals only; truncated or too-deep data counts as a parse failure."""
    status = status if status is not None else {}
    data = {}
    m = re.search(r'(?:window\.|var\s+)cgiDataNew\s*=\s*(?=\{)', h)
    if m:
        try:
            parsed = js_literal(h, m.end())
        except (ValueError, SyntaxError, TypeError, IndexError, RecursionError, OverflowError, MemoryError) as e:
            status['parse_error'] = True
            status['truncated'] = 'truncated' in str(e)
        else:
            if isinstance(parsed, dict):
                data = parsed
    # Older picture pages use a separate literal array; ignore later computed assignments.
    for m in re.finditer(r'(?:window\.|var\s+)picture_page_info_list\s*=\s*(?=\[)', h):
        try:
            pictures = js_literal(h, m.end())
        except (ValueError, SyntaxError, TypeError, IndexError, RecursionError, OverflowError, MemoryError) as e:
            status['parse_error'] = True
            status['truncated'] = status.get('truncated', False) or 'truncated' in str(e)
            continue
        if isinstance(pictures, list) and pictures:
            if not data.get('picture_page_info_list'):
                data['picture_page_info_list'] = pictures
            data.setdefault('item_show_type', 8)
            break
    # A picture list inside the page data is itself an album marker.
    if isinstance(data.get('picture_page_info_list'), list) and data.get('item_show_type') is None \
            and data.get('real_item_show_type') is None:
        data['item_show_type'] = 8
    return data


def _meta_sources(data, text_info):
    """Metadata dictionaries in the page data; never avatar or UI image fields."""
    sources = [data, text_info]
    for key in ('user_info', 'userinfo'):
        value = data.get(key)
        if isinstance(value, dict):
            sources.append(value)
    return sources


def _from_sources(sources, keys):
    for source in sources:
        for key in keys:
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value
            if key in TIME_KEYS and isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
    return ''


def _message_body(data, text_info):
    # Message bodies sit in text_page_info first, then on the page-data root.
    for source in (text_info, data):
        for key in BODY_FIELDS:
            value = source.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ''


def _album_images(data, text_info):
    images = []
    containers = (
        data.get('picture_page_info_list'),
        text_info.get('picture_info'),
        data.get('picture_info'),
    )
    for container in containers:
        if not isinstance(container, list):
            continue
        for item in container:
            if isinstance(item, str):
                url = qpic_image(item)
            elif isinstance(item, dict):
                # Each entry's top-level URL is the original; nested share-cover
                # and watermark URLs are not the page's pictures.
                url = ''
                for key in PICTURE_KEYS:
                    candidate = qpic_image(item.get(key))
                    if candidate:
                        url = candidate
                        break
            else:
                url = ''
            if url and url not in images:
                images.append(url)
    return images


def _cover_image(data, text_info):
    """A real cover field only; avatars, UI images and album entries never stand in."""
    for source in (data, text_info):
        for key in COVER_KEYS:
            value = source.get(key)
            if isinstance(value, dict):
                value = next((value[k] for k in PICTURE_KEYS if value.get(k)), '')
            url = qpic_image(value)
            if url:
                return url
    return ''


def message_kind(data):
    if not isinstance(data, dict):
        return None
    kind = data.get('item_show_type')
    if kind is None:
        kind = data.get('real_item_show_type')
    if kind is None:
        return None
    try:
        return int(kind)
    except (TypeError, ValueError):
        return kind


def _image_list(data, text_info, body):
    images = _album_images(data, text_info)
    for url in article_images(body):
        if url not in images:
            images.append(url)
    return images


def _fill_article_fields(res, data, text_info, body, text=None):
    """Shared normalization of title/author/time/text/images for message pages."""
    res.title = strip_html(html.unescape(_from_sources(_meta_sources(data, text_info), ('title',))))
    res.text = strip_html(html.unescape(body)) if text is None else text
    res.author = strip_html(html.unescape(_from_sources(_meta_sources(data, text_info), AUTHOR_KEYS)))
    published = _from_sources(_meta_sources(data, text_info), TIME_KEYS)
    res.published = ts(published) if published != '' else ''
    res.images = _image_list(data, text_info, body)
    cover = _cover_image(data, text_info)
    if cover:
        res.extra['cover_url'] = cover


def message_content(res, data):
    """Normalize text/picture messages (types 0/8/10) into ordinary article fields."""
    if not isinstance(data, dict):
        return False
    kind = message_kind(data)
    if kind is None:
        return False
    res.extra['wechat_item_show_type'] = kind
    if kind not in MESSAGE_TYPES:
        # Other types are ordinary articles: the caller goes on to #js_content.
        return False
    text_info = data.get('text_page_info')
    if not isinstance(text_info, dict):
        text_info = {}
    body = _message_body(data, text_info)
    text = strip_html(html.unescape(body))
    images = _image_list(data, text_info, body)
    if ENCRYPTED.search(body):
        # Ciphertext is never presented as text; an album's pictures still count.
        if not images:
            raise Fail('quality_gate: 加密块：页面数据正文含 U2FsdGVk 加密块，不能作为正文')
        text = ''
    # A message with neither words nor pictures is not a usable body.
    if not text and not images:
        return False
    _fill_article_fields(res, data, text_info, body, text)
    return True


def article_from_data(res, data, h):
    """Other types that still ship an in-page body: same fields as an ordinary article."""
    if not isinstance(data, dict):
        return False
    text_info = data.get('text_page_info')
    if not isinstance(text_info, dict):
        text_info = {}
    body = next((source[k] for source in (text_info, data)
                 for k in CONTENT_FIELDS if isinstance(source.get(k), str) and source[k].strip()), '')
    if not body:
        return False
    text = strip_html(html.unescape(body))
    if ENCRYPTED.search(body):
        # Ciphertext is never presented as text; album pictures can still count.
        if not _image_list(data, text_info, body):
            raise Fail('quality_gate: 加密块：页面数据正文含 U2FsdGVk 加密块，不能作为正文')
        text = ''
    _fill_article_fields(res, data, text_info, body, text)
    _html_fallbacks(res, h)
    return True


def _html_title(h):
    return strip_html(meta_tag(h, 'og:title'))


def _html_fallbacks(res, h):
    """Fill fields the page data did not carry from ordinary HTML tags."""
    if not res.title:
        res.title = _html_title(h)
    if not res.author:
        m = re.search(r'var nickname = htmlDecode\("([^"]*)"', h) or re.search(r'id="js_name">\s*([^<]+)', h)
        if m:
            res.author = strip_html(html.unescape(m.group(1)))
    if not res.published:
        t = re.search(r"var ct = \"(\d+)\"", h) or re.search(r"create_time\s*[:=]\s*['\"]?(\d+)", h)
        if t:
            res.published = ts(t.group(1))


def _missing_content_note(h, data, status=None):
    """Name the failure category while keeping the existing status vocabulary."""
    status = status or {}
    if DELETED_MARKERS.search(h):
        return '删除：公众号文章已被删除、违规或迁移，未取得正文'
    if CAPTCHA_MARKERS.search(h):
        return '验证码：微信返回验证/风控页，未取得正文；不重试验证码页'
    kind = message_kind(data)
    if status.get('truncated'):
        return '结构变化：页面数据被截断，window.cgiDataNew/picture_page_info_list 无法按字面量解析，而且没有 #js_content'
    if status.get('parse_error'):
        return '结构变化：页面数据无法按字面量解析，window.cgiDataNew/picture_page_info_list 结构变化，而且没有 #js_content'
    if kind in MESSAGE_TYPES:
        return f'结构变化：页面数据 item_show_type={kind} 缺少正文和图片，无法按字面量提取'
    if data:
        return '结构变化：页面数据结构变化，window.cgiDataNew/picture_page_info_list 里没有可识别的正文，而且没有 #js_content'
    return "no #js_content (deleted/blocked article or captcha)"


def _unsupported(res, data):
    """A type outside 0/8/10 without any in-page body is reported; returns its note."""
    kind = message_kind(data)
    if kind is None or kind in MESSAGE_TYPES:
        return ''
    import incidents
    incidents.unsupported_type('wechat', res.url, f'item_show_type={kind}')
    return f'公众号暂不支持的类型：item_show_type={kind}'


def _no_body(res, data, h, seen):
    """No #js_content and no usable page-data body: name why, in that precedence."""
    # Only a readable page holding a type outside 0/8/10 with no usable body is
    # unsupported. Captcha/deleted pages and broken page data are named as such
    # instead of being blamed on the type.
    if not (DELETED_MARKERS.search(h) or CAPTCHA_MARKERS.search(h) or seen['status'].get('parse_error')):
        note = _unsupported(res, data)
        if note:
            raise Fail(note)
    raise Fail(_missing_content_note(h, data, seen['status']))


def scrape(res, o):
    seen = {'status': {}}

    def page():
        # Avoid an unnecessary HTTP redirect; retry transient TLS/read failures
        # once before the existing paid fallback. Never retry a challenge body.
        response = get_with_retry(re.sub(r'^http:', 'https:', res.url), attempts=2)
        h = response.text
        if 'wappoc_appmsgcaptcha' in urlsplit(getattr(response, 'url', '')).path:
            raise Fail('验证码：微信游客请求被转至验证码页，未取得正文；不重试验证码页')
        data = page_data(h, seen['status'])
        kind = message_kind(data)
        if kind is not None:
            seen['kind'] = kind
        if message_content(res, data):
            _html_fallbacks(res, h)
            return
        m = re.search(r'id="js_content"[^>]*>(.*?)</div>\s*<script', h, re.S) or re.search(r'id="js_content"[^>]*>(.*)', h, re.S)
        if not m:
            # A non-message type can still carry its article body in page data.
            if article_from_data(res, data, h):
                return
            _no_body(res, data, h, seen)
        body = m.group(1)
        if ENCRYPTED.search(body):
            raise Fail('quality_gate: 加密块： #js_content 含 U2FsdGVk 加密块，不能作为正文')
        text = strip_html(body)
        if not text and not article_images(body):
            # An empty #js_content is no body at all; page data may still have one.
            if article_from_data(res, data, h):
                return
            _no_body(res, data, h, seen)
        res.title = meta_tag(h, "og:title")
        res.author = (re.search(r'var nickname = htmlDecode\("([^"]*)"', h) or re.search(r'id="js_name">\s*([^<]+)', h) or [0, ""])[1].strip()
        t = re.search(r"var ct = \"(\d+)\"", h) or re.search(r"create_time\s*[:=]\s*['\"]?(\d+)", h)
        res.published = ts(t.group(1)) if t else ""
        res.text = text
        cov = qpic_image(meta_tag(h, "og:image"))
        res.images = list(dict.fromkeys(([cov] if cov else []) + article_images(body)))
    ok = attempt(res, "content", [("article HTML #js_content", page)])
    if not ok and 'kind' in seen:
        # Keep the observed type in the package even when extraction failed.
        res.extra.setdefault('wechat_item_show_type', seen['kind'])
    res.extra["note"] = "正文由公开 HTML 提取；互动数未返回；评论由统一路由另取。"
    if o.with_comments:
        res.needs_paid.append("comments")
