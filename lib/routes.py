"""URL detection and platform routes; host comparisons never use substring matches."""
import re
from urllib.parse import urlsplit, urlunsplit, parse_qs, urlencode

PROFILES = {
    'douyin': ('/api/v1/douyin/app/v3/handler_user_profile', '/api/v1/douyin/app/v3/fetch_user_post_videos', 'sec_user_id'),
    'xiaohongshu': ('/api/v1/xiaohongshu/app_v2/get_user_info', '/api/v1/xiaohongshu/app_v2/get_user_posted_notes', 'user_id'),
    'bilibili': ('/api/v1/bilibili/app/fetch_user_info', '/api/v1/bilibili/web/fetch_user_post_videos', 'user_id'),
    'tiktok': ('/api/v1/tiktok/app/v3/handler_user_profile', '/api/v1/tiktok/app/v3/fetch_user_post_videos_v3', 'unique_id'),
    'instagram': ('/api/v1/instagram/v2/fetch_user_info', '/api/v1/instagram/v2/fetch_user_posts', 'username'),
    'x': ('/api/v1/twitter/web/fetch_user_profile', '/api/v1/twitter/web/fetch_user_post_tweet', 'screen_name'),
}


def profile_id(platform, url):
    u = urlsplit(url)
    parts = [x for x in u.path.split('/') if x]
    if platform == 'douyin' and len(parts) == 2 and parts[0] == 'user' and not parse_qs(u.query).get('modal_id'):
        return parts[1]
    if platform == 'xiaohongshu' and parts[:2] == ['user', 'profile'] and len(parts) == 3:
        return parts[2]
    if platform == 'bilibili' and u.hostname == 'space.bilibili.com' and parts and parts[0].isdigit():
        return parts[0]
    if platform == 'youtube' and parts:
        if parts[0].startswith('@') and len(parts) <= 2:
            return parts[0]
        if parts[0] in ('channel', 'c', 'user') and len(parts) >= 2:
            return parts[1]
    if platform == 'tiktok' and len(parts) == 1 and parts[0].startswith('@'):
        return parts[0][1:]
    if platform in ('instagram', 'x') and len(parts) == 1 and parts[0].lower() not in ('p', 'reel', 'tv', 'reels', 'explore', 'search', 'home', 'i', 'intent', 'settings', 'notifications', 'messages', 'accounts'):
        return parts[0]
    return ''

HOSTS = {
    'douyin': ('douyin.com', 'iesdouyin.com'), 'xiaohongshu': ('xiaohongshu.com', 'xhslink.com'),
    'bilibili': ('bilibili.com', 'b23.tv'), 'wechat': ('mp.weixin.qq.com',),
    'x': ('x.com', 'twitter.com'), 'youtube': ('youtube.com', 'youtu.be'),
    'tiktok': ('tiktok.com',), 'instagram': ('instagram.com',), 'threads': ('threads.com', 'threads.net'),
    'linkedin': ('linkedin.com',), 'bluesky': ('bsky.app',), 'reddit': ('reddit.com', 'redd.it'),
    'telegram': ('t.me', 'telegram.me'), 'medium': ('medium.com',), 'substack': ('substack.com', 'noahpinion.blog'),
    'pinterest': ('pinterest.com', 'pinterest.co.uk', 'pin.it'), 'facebook': ('facebook.com', 'fb.watch'),
    'weibo': ('weibo.com', 'weibo.cn'), 'zhihu': ('zhihu.com',), 'wechat_channels': ('channels.weixin.qq.com', 'weixin.qq.com'),
}
# All public comment interfaces present in the local TikHub OpenAPI, 2026-11-01.
COMMENTS = {
    'douyin': ('/api/v1/douyin/app/v3/fetch_video_comments', 'aweme_id'),
    'xiaohongshu': ('/api/v1/xiaohongshu/app_v2/get_note_comments', 'note_id'),
    'bilibili': ('/api/v1/bilibili/app/fetch_video_comments', 'bv_id'),
    'x': ('/api/v1/twitter/web/fetch_post_comments', 'tweet_id'),
    'reddit': ('/api/v1/reddit/app/fetch_post_comments', 'post_id'),
    'tiktok': ('/api/v1/tiktok/app/v3/fetch_video_comments', 'aweme_id'),
    'instagram': ('/api/v1/instagram/v2/fetch_post_comments', 'code_or_url'),
    'youtube': ('/api/v1/youtube/web_v2/get_video_comments', 'video_id'),
    'threads': ('/api/v1/threads/web/fetch_post_comments', 'post_id'),
    'linkedin': ('/api/v1/linkedin/web_v2/get_post_comments', 'urn'),
    'telegram': ('/api/v1/telegram/web/fetch_post_comments', 'post_id'),
    'wechat': ('/api/v1/wechat_mp/v2/fetch_article_comments', 'url'),
    'weibo': ('/api/v1/weibo/app/fetch_status_comments', 'status_id'),
    'zhihu': ('/api/v1/zhihu/web/fetch_comment_v5', 'answer_id'),
}
DETAIL = {
    'douyin': ('/api/v1/douyin/app/v3/fetch_one_video_v3', 'aweme_id'),
    'xiaohongshu': ('/api/v1/xiaohongshu/app_v2/get_image_note_detail', 'note_id'),
    'bilibili': ('/api/v1/bilibili/web/fetch_video_detail', 'aid'),
    'x': ('/api/v1/twitter/web/fetch_tweet_detail', 'tweet_id'),
    'reddit': ('/api/v1/reddit/app/fetch_post_details', 'post_id'),
    'tiktok': ('/api/v1/tiktok/app/v3/fetch_one_video_v3', 'aweme_id'),
    'instagram': ('/api/v1/instagram/v2/fetch_post_info', 'code_or_url'),
    'youtube': ('/api/v1/youtube/web_v2/get_video_info_v2', 'video_id'),
    'threads': ('/api/v1/threads/web/fetch_post_detail_v2', 'url'),
    'linkedin': ('/api/v1/linkedin/web_v2/get_post_detail', 'url'),
    'wechat': ('/api/v1/wechat_mp/v2/fetch_article_detail_h5', 'url'),
    'weibo': ('/api/v1/weibo/app/fetch_status_detail', 'status_id'),
    'zhihu': ('/api/v1/zhihu/web/fetch_answer_detail', 'answer_id'),
    'wechat_channels': ('/api/v1/wechat_channels/v2/fetch_video_detail', 'share_url'),
}


def parse_input(text):
    m = re.search(r'https?://[^\s<>\"\x27]+', text)
    if not m:
        raise ValueError('需要 HTTP(S) 链接或包含链接的分享文案')
    url = m.group(0).rstrip('。，；、！）)]}》」.,;!')
    u = urlsplit(url)
    if not u.hostname or u.username or u.password:
        raise ValueError('链接主机无效，或包含不允许的认证信息')
    host = u.hostname.lower().rstrip('.')
    platform = next((p for p, domains in HOSTS.items() if any(host == d or host.endswith('.'+d) for d in domains)), 'generic')
    # Custom Substack domains: identify by returned page, never by an arbitrary /p/ path.
    return platform, urlunsplit((u.scheme, u.netloc, u.path, u.query, ''))


def identify(platform, url):
    u = urlsplit(url)
    q = parse_qs(u.query)
    patterns = {
        'douyin': r'/(?:video|note)/(\d+)', 'xiaohongshu': r'/(?:explore|discovery/item|item)/([0-9a-f]{24})',
        'bilibili': r'(BV[A-Za-z0-9]{10}|av\d+)', 'x': r'/status/(\d+)', 'tiktok': r'/video/(\d+)',
        'instagram': r'/(?:p|reel|tv)/([^/]+)', 'threads': r'/post/([^/]+)', 'linkedin': r'(?:activity-|urn:li:activity:)(\d+)',
        'reddit': r'/comments/([a-z0-9]+)', 'bluesky': r'/post/([^/]+)', 'telegram': r'/(\d+)/?$',
        'pinterest': r'/pin/(\d+)', 'zhihu': r'/(?:answer|p|pin)/(\d+)', 'weibo': r'/(?:detail/)?([A-Za-z0-9]+)/?$',
    }
    if platform == 'youtube':
        return q.get('v', [''])[0] or (u.path.strip('/').split('/')[-1] if u.hostname == 'youtu.be' or '/shorts/' in u.path or '/live/' in u.path else '')
    if platform == 'douyin' and q.get('modal_id'):
        return q['modal_id'][0]
    if platform == 'wechat':
        if q.get('mid'):
            return q.get('__biz', [''])[0] + '-' + q['mid'][0] + '-' + q.get('idx', ['1'])[0]
        return u.path.removeprefix('/s/').strip('/')
    if platform == 'facebook':
        return q.get('v', [''])[0] or (re.search(r'/(?:videos|posts)/(\d+)', u.path) or [None, ''])[1]
    if platform == 'substack':
        return (re.search(r'/p/([^/]+)', u.path) or [None, ''])[1]
    m = re.search(patterns.get(platform, r'(?!)'), url)
    return m.group(1) if m else ''


def canonical(platform, url, item_id):
    if platform == 'douyin' and item_id:
        return 'https://www.douyin.com/video/' + item_id
    if platform == 'youtube' and item_id:
        return 'https://www.youtube.com/watch?v=' + item_id
    if platform == 'xiaohongshu' and item_id:
        return 'https://www.xiaohongshu.com/explore/' + item_id
    if platform == 'bilibili' and item_id:
        return 'https://www.bilibili.com/video/' + item_id
    return url


def bv_to_av(bvid):
    # Bilibili current 58-base conversion, supports new larger BV identifiers.
    table = 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf'
    chars = list(bvid)
    chars[3], chars[9] = chars[9], chars[3]
    chars[4], chars[7] = chars[7], chars[4]
    value = 0
    for c in chars[3:]:
        value = value*58 + table.index(c)
    return str((value & ((1 << 51)-1)) ^ 23442827791579)


def comment_params(platform, res):
    if platform not in COMMENTS:
        return None
    path, key = COMMENTS[platform]
    value = res.id
    if key in ('url', 'code_or_url'):
        value = res.url
    if platform == 'linkedin':
        value = res.id  # OpenAPI explicitly requires the numeric part, not the urn prefix.
    if platform == 'threads' and res.id:
        alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        n = 0
        for c in res.id:
            n = n*64 + alphabet.index(c)
        value = str(n)
    if platform == 'zhihu':
        if '/pin/' in res.url:
            path, key = '/api/v1/zhihu/web/fetch_pin_comments', 'pin_id'
        elif '/answer/' not in res.url:
            return None
    if not value:
        return None
    params = {key: value}
    if platform == 'telegram':
        params['channel'] = urlsplit(res.url).path.strip('/').split('/')[-2]
    if platform == 'reddit':
        params[key] = 't3_' + res.id
        params['need_format'] = 'true'
    return path, params
