"""离线测试：不联网、不花钱、不需要钥匙。运行：python3 -B tests/test_offline.py

测试数据全部是编的，只保留各平台返回的字段形状。
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.mkdtemp(prefix='sourceboard-test-')
os.environ['SOURCEBOARD_HOME'] = TMP + '/home'
os.environ['SOURCEBOARD_CONFIG_DIR'] = TMP + '/cfg'
os.environ.pop('TIKHUB_API_KEY', None)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'lib'))
sys.dont_write_bytecode = True

import board  # noqa: E402
import core  # noqa: E402
import paid  # noqa: E402
import sbconfig  # noqa: E402
import search  # noqa: E402
import tikhub  # noqa: E402

SAMPLES = {
    'douyin': {'data': {'business_data': [{'data': {'aweme_info': {
        'aweme_id': '7000000000000000001', 'desc': '示例视频 #话题', 'create_time': 1790000000,
        'author': {'nickname': '示例作者', 'follower_count': 1200},
        'statistics': {'digg_count': 18, 'comment_count': 1, 'share_count': 5, 'collect_count': 9, 'play_count': 0},
        'video': {'cover': {'url_list': ['https://example.com/c.jpg']}}}}}]}},
    'xiaohongshu': {'data': {'items': [{'note': {
        'id': 'aaaa000000000000000000aa', 'desc': '示例笔记正文', 'liked_count': 9, 'collected_count': 4, 'comments_count': 34, 'shared_count': 0,
        'user': {'nickname': '示例博主'}, 'images_list': [{'url': 'https://example.com/n.jpg'}], 'timestamp': 1790000000}}]}},
    'bilibili': {'data': {'result': [{'bvid': 'BV1xx411c7mD', 'title': '示例<em class="keyword">视频</em>', 'description': '简介', 'author': 'UP主',
                                      'play': 231, 'like': 6, 'favorites': 7, 'review': 3, 'video_review': 0, 'pubdate': 1790000000, 'pic': '//example.com/p.jpg'},
                                     {'bvid': '', 'title': '不是视频的卡片'}]}},
    'weibo': {'cards': [{'mblog': {'mid': '5000000000000001', 'text': '示例<a href="#">微博</a>', 'reposts_count': 2, 'comments_count': 3, 'attitudes_count': 4,
                                   'created_at': 'Thu Oct 29 15:27:36 +0800 2026', 'user': {'screen_name': '示例用户'}}},
                        {'mblog': {'mid': '5000000000000002', 'text': '推广', 'reposts_count': 0, 'ad_marked': True}}]},
    'zhihu': {'data': [{'object': {'id': 389388174, 'title': '示例<em>文章</em>', 'url': 'https://api.zhihu.com/articles/389388174', 'voteup_count': 65,
                                   'comment_count': 12, 'zfav_count': 140, 'created_time': 1626178473, 'content': '<p>正文</p>', 'author': {'name': '示例答主'}}}]},
    'wechat': {'items': [{'title': '示例<em class="highlight">文章</em>', 'desc': '摘要', 'docID': '140', 'doc_url': 'http://mp.weixin.qq.com/s?__biz=xx&mid=1',
                          'source': {'title': '示例公众号'}, 'timestamp': '1785297604', 'thumbUrl': 'https://example.com/t.jpg'}]},
    'youtube': {'videos': [{'video_id': 'abcdefghijk', 'title': 'Sample video', 'view_count': '1.2M views', 'published_time': '2 weeks ago', 'author': 'Sample Channel',
                            'thumbnails': [{'url': 'https://example.com/a.jpg'}, {'url': 'https://example.com/b.jpg'}], 'description_snippet': 'snippet'}]},
    'reddit': {'posts': [{'id': 't3_abc', 'postTitle': 'Sample post', 'permalink': '/r/sample/comments/abc/sample_post/', 'url': 'https://www.reddit.com/r/sample/comments/abc/sample_post/',
                          'content': {'markdown': 'body'}, 'authorInfo': {'name': 'sample_user'}, 'subreddit': {'prefixedName': 'r/sample'},
                          'score': 10, 'commentCount': 6, 'upvoteRatio': 0.9, 'createdAt': '2025-06-02T20:28:06.123000+0000'}]},
    'tiktok': {'data': [{'aweme_info': {'aweme_id': '7600000000000000001', 'desc': 'sample clip', 'create_time': 1790000000,
                                        'author': {'unique_id': 'sample_handle', 'nickname': 'Sample'},
                                        'statistics': {'play_count': 789277, 'digg_count': 15651, 'comment_count': 162, 'share_count': 2544, 'collect_count': 1571},
                                        'video': {'cover': {'url_list': ['https://example.com/tt.jpg']}}}}]},
    'x': {'timeline': [{'type': 'tweet', 'tweet_id': '1900000000000000001', 'screen_name': 'sample', 'text': 'sample post', 'favorites': 5, 'replies': 1,
                        'retweets': 2, 'quotes': 0, 'views': '225', 'bookmarks': 0, 'created_at': 'Mon Sep 29 04:47:35 +0000 2025', 'media': []}]},
}


class Parsers(unittest.TestCase):
    def test_every_platform_reads_one_item(self):
        for platform in search.ORDER:
            items = search.unique(search.ROUTES[platform][3](SAMPLES[platform]))
            self.assertEqual(len(items), 1, platform)
            it = items[0]
            self.assertTrue(it['title'] and it['url'].startswith('https://'), platform)
            self.assertNotIn('<', it['title'], platform)

    def test_missing_numbers_stay_empty_not_zero(self):
        dy = search.douyin_parse(SAMPLES['douyin'])[0]
        self.assertNotIn('views', dy['stats'])  # 搜索里的播放 0 不当真
        self.assertEqual(search.wechat_parse(SAMPLES['wechat'])[0]['stats'], {})

    def test_numbers_and_links(self):
        self.assertEqual(search.youtube_parse(SAMPLES['youtube'])[0]['stats']['views'], 1200000)
        self.assertEqual(search.zhihu_parse(SAMPLES['zhihu'])[0]['url'], 'https://zhuanlan.zhihu.com/p/389388174')
        self.assertEqual(search.num('3.4万'), 34000)
        self.assertIsNone(search.num('没有数字'))

    def test_required_params(self):
        from types import SimpleNamespace
        o = SimpleNamespace(page=1, sort='default', region='US')
        self.assertTrue({'keyword', 'order', 'page', 'page_size'} <= set(search.ROUTES['bilibili'][2]('x', o)))  # 缺 order 会报 422

    def test_card_prefixes_unique(self):
        self.assertEqual(len(set(search.PREFIX.values())), len(search.ORDER))
        self.assertEqual(set(search.PREFIX), set(search.ORDER))

    def test_platform_names(self):
        self.assertEqual(search.pick_platforms('抖音, 小红书，B站 twitter'), ['douyin', 'xiaohongshu', 'bilibili', 'x'])
        with self.assertRaises(ValueError):
            search.pick_platforms('不存在的平台')


class Board(unittest.TestCase):
    def data(self):
        items = []
        for p in search.ORDER:
            items += search.ROUTES[p][3](SAMPLES[p])
        items[0]['title'] = '</script><script>alert(1)</script>'
        return {'title': '测试看板', 'query': '测试', 'created_at': core.now(), 'items': items, 'conclusion_md': '## 结论\n- **要点** <b>不该生效</b>',
                'sources': [{'platform': 'weibo', 'name': '微博', 'status': 'rate_limited', 'count': 0, 'channel': 'TikHub', 'note': '被限流', 'cost_usd': 0},
                            {'platform': 'douyin', 'name': '抖音', 'status': 'success', 'count': 1, 'channel': 'TikHub', 'note': '', 'cost_usd': 0.01}]}

    def test_render_is_one_safe_file(self):
        page = board.render(self.data(), Path(TMP) / 'b' / 'board.html')
        text = page.read_text(encoding='utf-8')
        self.assertEqual(text.count('</script>'), 2)  # 只有页面自己的两个脚本标签
        self.assertNotIn('<script>alert(1)', text)
        self.assertIn('&lt;b&gt;不该生效', text)
        self.assertIn('有 1 个渠道没搜到', text)
        self.assertLess(text.index('被限流'), text.index('搜到了'))  # 失败的排在前面
        for bad in ('<link ', 'src="http', '@import'):
            self.assertNotIn(bad, text)  # 样式和脚本都在文件里


class GrabBoard(unittest.TestCase):
    def test_grab_board_lists_failures_on_top(self):
        data = {'title': 't', 'kind': 'grab', 'sources': [], 'items': [
            {'platform': 'bilibili', 'title': '示例视频', 'caps': {'content': 'success', 'subtitles': 'connector_failed'}},
            {'platform': 'x', 'title': '好的那条', 'caps': {'content': 'success', 'comments': 'success'}}]}
        text = board.render(data, Path(TMP) / 'grab-board.html').read_text(encoding='utf-8')
        top = text[:text.index('id="data"')]
        self.assertIn('其中 1 条有部分内容没拿到', top)
        self.assertIn('字幕：接口出错', top)
        self.assertNotIn('好的那条', top)


class Guards(unittest.TestCase):
    def test_key_only_goes_to_tikhub(self):
        sbconfig.check_base('https://api.tikhub.io')
        sbconfig.check_base('https://api.tikhub.dev')
        for bad in ('http://api.tikhub.io', 'https://example.com', 'https://api.tikhub.io.evil.com'):
            with self.assertRaises(ValueError):
                sbconfig.check_base(bad)

    def test_key_not_forwarded_on_redirect(self):
        # 本机起两个服务：第一个回跳转，第二个记录收到的请求头。钥匙只能出现在第一个。
        import http.server
        import threading
        seen = {}

        class Target(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen['target'] = self.headers.get('Authorization')
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *a):
                pass

        target = http.server.HTTPServer(('127.0.0.1', 0), Target)

        class Jump(Target):
            def do_GET(self):
                seen['first'] = self.headers.get('Authorization')
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{target.server_port}/x')
                self.end_headers()

        jump = http.server.HTTPServer(('127.0.0.1', 0), Jump)
        for server in (target, jump):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            rc, _ = tikhub.http_json('GET', f'http://127.0.0.1:{jump.server_port}/', 'FAKEKEY', None, 5)
        finally:
            for server in (jump, target):
                server.shutdown()
                server.server_close()
        self.assertEqual(rc, 0)
        self.assertEqual(seen.get('first'), 'Bearer FAKEKEY')
        self.assertIsNone(seen.get('target'))

    def test_wrong_key_is_not_cooled_down(self):
        self.assertEqual(tikhub.failure_ttl('{"ok": false, "error": "HTTP 401:{\\"detail\\": \\"bad key\\"}"}'), 0)
        self.assertEqual(tikhub.failure_ttl('网络请求失败:URLError'), 30)
        self.assertEqual(tikhub.failure_ttl('HTTP 429:slow down'), 600)

    def test_direct_api_respects_daily_budget(self):
        from datetime import datetime
        today = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        rows = [{'ts': today, 'est_usd': 0.99}]
        old = {k: os.environ.get(k) for k in ('SOURCEBOARD_DAILY_BUDGET_USD', 'SOURCEBOARD_BUDGET_CHECKED', 'TIKHUB_BUDGET_USD')}
        try:
            os.environ.pop('TIKHUB_BUDGET_USD', None)
            os.environ.pop('SOURCEBOARD_BUDGET_CHECKED', None)
            os.environ['SOURCEBOARD_DAILY_BUDGET_USD'] = '1'
            self.assertIn('预算不足', tikhub.over_daily_budget(rows, 0.02))
            self.assertEqual(tikhub.over_daily_budget(rows, 0.005), '')
            os.environ['SOURCEBOARD_BUDGET_CHECKED'] = '1'  # search/grab 已经自己拦过
            self.assertEqual(tikhub.over_daily_budget(rows, 0.02), '')
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_post_is_read_only(self):
        env = {'TIKHUB_API_KEY': 'k' * 40}
        rc, out, _ = tikhub.run_post(['post', '--path', '/api/v1/douyin/app/v3/delete_something', '--json', '{}'], env)
        self.assertEqual(rc, 2)
        self.assertIn('只放行读取类接口', out)
        rc, out, _ = tikhub.run_post(['post', '--path', '/api/v1/x/fetch_y', '--base-url', 'https://example.com'], env)
        self.assertEqual(rc, 2)

    def test_no_paid_never_calls_tikhub(self):
        from cli import Context
        ctx = Context(Path(TMP) / 'np', 15, True)
        token = core.CURRENT.set(ctx)
        try:
            with self.assertRaises(core.Fail) as e:
                paid.call('/api/v1/douyin/search/fetch_video_search_v2', {'keyword': 'x'}, 'post')
            self.assertEqual(e.exception.status, 'not_attempted')
        finally:
            core.CURRENT.reset(token)

    def test_config_file_is_private(self):
        sbconfig.save({'SOURCEBOARD_DAILY_BUDGET_USD': '1'})
        self.assertEqual(oct(sbconfig.ENV_FILE.stat().st_mode & 0o777), '0o600')
        self.assertEqual(sbconfig.get('SOURCEBOARD_DAILY_BUDGET_USD'), '1')

    def test_prices_cover_search_routes(self):
        table = json.loads((sbconfig.LIB / 'prices.json').read_text(encoding='utf-8'))['endpoints']
        for platform, route in search.ROUTES.items():
            self.assertTrue(any(route[0].startswith(k) for k in table), platform)


if __name__ == '__main__':
    unittest.main(verbosity=1)
