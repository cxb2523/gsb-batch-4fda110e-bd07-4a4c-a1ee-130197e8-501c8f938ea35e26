"""YouTube 官方 Data API v3 的只读小客户端（免费额度）。

只用到三个接口：videos（视频详情）、channels（频道资料）、playlistItems（上传列表）。
钥匙从本机配置的 YOUTUBE_API_KEY 读取，不打印、不写进任何输出。没配钥匙时抛出
not_attempted，调用方会自动改走下一条路线（yt-dlp 或 TikHub）。
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

import sbconfig
from core import Fail

API = 'https://www.googleapis.com/youtube/v3/'


def seconds(iso):
    m = re.fullmatch(r'P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?', iso or '')
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def number(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class Official:
    def __init__(self, quota_dir=None):
        self.key = sbconfig.get('YOUTUBE_API_KEY')

    def transport(self, endpoint, params):
        if not self.key:
            raise Fail('没配 YouTube 官方钥匙（YOUTUBE_API_KEY），这条免费路线跳过', 'not_attempted')
        url = API + endpoint + '?' + urllib.parse.urlencode({**params, 'key': self.key})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'Accept': 'application/json'}), timeout=20) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', errors='replace')[:300].replace(self.key, '[REDACTED]')
            status = 'rate_limited' if e.code in (403, 429) and 'quota' in detail.lower() else 'auth_failed' if e.code in (400, 401, 403) else 'connector_failed'
            raise Fail(f'YouTube 官方接口 HTTP {e.code}: {detail}', status) from None
        except Exception as e:
            raise Fail(f'YouTube 官方接口连接失败：{type(e).__name__}') from None

    def videos(self, ids):
        found, errors = {}, []
        ids = [i for i in ids if i]
        for start in range(0, len(ids), 50):
            batch = ids[start:start + 50]
            data = self.transport('videos', {'part': 'snippet,statistics,contentDetails', 'id': ','.join(batch), 'maxResults': 50})
            for item in data.get('items') or []:
                sn, st = item.get('snippet') or {}, item.get('statistics') or {}
                found[item['id']] = {
                    'ok': True, 'title': sn.get('title', ''), 'description': sn.get('description', ''),
                    'channel': sn.get('channelTitle', ''), 'channel_id': sn.get('channelId', ''),
                    'published_at_utc': sn.get('publishedAt', ''),
                    'views': number(st.get('viewCount')), 'likes': number(st.get('likeCount')), 'comments': number(st.get('commentCount')),
                    'duration_seconds': seconds((item.get('contentDetails') or {}).get('duration')),
                }
            errors += [i for i in batch if i not in found]
        return {'found': found, 'errors': errors}

    def channels(self, ids):
        found, errors = {}, []
        data = self.transport('channels', {'part': 'snippet,statistics,contentDetails', 'id': ','.join(ids), 'maxResults': 50})
        for item in data.get('items') or []:
            sn, st = item.get('snippet') or {}, item.get('statistics') or {}
            found[item['id']] = {
                'title': sn.get('title', ''),
                'subscribers': None if st.get('hiddenSubscriberCount') else number(st.get('subscriberCount')),
                'uploads_playlist': ((item.get('contentDetails') or {}).get('relatedPlaylists') or {}).get('uploads', ''),
            }
        errors += [i for i in ids if i not in found]
        return {'found': found, 'errors': errors}

    def playlist_items(self, playlist, max_results=50, page_token=None):
        params = {'part': 'snippet,contentDetails', 'playlistId': playlist, 'maxResults': max_results}
        if page_token:
            params['pageToken'] = page_token
        try:
            data = self.transport('playlistItems', params)
        except Fail as e:
            return {'ok': False, 'error': str(e), 'items': []}
        items = []
        for item in data.get('items') or []:
            sn, cd = item.get('snippet') or {}, item.get('contentDetails') or {}
            vid = cd.get('videoId') or (sn.get('resourceId') or {}).get('videoId')
            if vid:
                items.append({'video_id': vid, 'title': sn.get('title', ''), 'published_at': cd.get('videoPublishedAt') or sn.get('publishedAt', '')})
        return {'ok': True, 'items': items, 'next_page_token': data.get('nextPageToken')}
