"""离线测试：不联网、不花钱、不需要钥匙。运行：python3 -B tests/test_offline.py

测试数据全部是编的，只保留各平台返回的字段形状。
"""
import argparse
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
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


class WeChatMessages(unittest.TestCase):
    """公众号消息页（纯文字/图集）用自造页面数据解析，不联网。"""

    ARTICLE_URL = 'https://mp.weixin.qq.com/s?__biz=demo&mid=1&idx=1'

    def scrape(self, html):
        import platforms.wechat as wechat

        class Response:
            def __init__(self, text):
                self.text = text
                self.url = self.URL
                self.status_code = 200

        Response.URL = self.ARTICLE_URL
        res = core.Result('wechat', self.ARTICLE_URL)
        with unittest.mock.patch.object(wechat, 'get_with_retry', lambda *a, **k: Response(html)):
            wechat.scrape(res, argparse.Namespace(with_comments=False))
        return res

    def test_text_message(self):
        # 自造页面数据：纯文字消息（item_show_type = 0），正文在 text_page_info。
        html = '''<html><head><meta property="og:title" content="页面标题不该覆盖数据标题"></head>
<body><script>
window.cgiDataNew = {
  "item_show_type": 0,
  "title": "一条纯文字消息",
  "nick_name": "示例公众号",
  "create_timestamp": "1790000000",
  "cdn_url": "https://mmbiz.qpic.cn/cover/abc.jpg",
  "user_info": {"head_img": "https://mmbiz.qpic.cn/avatar/head.jpg"},
  "text_page_info": {"content_noencode": "<p>正文第一段</p><p>正文第二段</p><img data-src=\\"https://mmbiz.qpic.cn/body/pic1.jpg\\">"}
};
</script></body></html>'''
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'success')
        self.assertEqual(res.title, '一条纯文字消息')
        self.assertEqual(res.author, '示例公众号')
        self.assertTrue(res.published.startswith('2026-09-21'), res.published)
        self.assertIn('正文第一段', res.text)
        self.assertEqual(res.images, ['https://mmbiz.qpic.cn/body/pic1.jpg'])
        self.assertEqual(res.extra['cover_url'], 'https://mmbiz.qpic.cn/cover/abc.jpg')
        self.assertNotIn('https://mmbiz.qpic.cn/avatar/head.jpg', res.images)
        self.assertEqual(res.extra['wechat_item_show_type'], 0)

    def test_picture_message_merges_and_deduplicates_images(self):
        # 自造图集消息（item_show_type = 8、10）：条目图片 + 正文图片合并去重，
        # 非 qpic.cn 的地址、嵌套水印地址、头像都不收。
        template = '''<html><head><meta property="og:title" content="图集标题"></head>
<body><script>
window.cgiDataNew = {
  "item_show_type": %d,
  "title": "周末图集",
  "nick_name": "示例图集号",
  "create_timestamp": 1789000000,
  "user_info": {"head_img": "https://mmbiz.qpic.cn/avatar/head.jpg"},
  "picture_page_info_list": [
    {"cdn_url": "https://mmbiz.qpic.cn/album/one.jpg", "watermark_img": "https://mmbiz.qpic.cn/wm/one.jpg"},
    {"cdn_url": "https://mmbiz.qpic.cn/album/two.jpg"},
    {"cdn_url": "https://example.com/not-qpic.jpg"},
    {"cdn_url": "//mmbiz.qpic.cn/album/scheme-relative.jpg"},
    {"cdn_url": "https://mmbiz.qpic.cn/album/one.jpg"}
  ],
  "text_page_info": {"content_noencode": "<img data-src=\\"https://mmbiz.qpic.cn/album/two.jpg\\"><img data-src=\\"https://mmbiz.qpic.cn/album/three.jpg\\">"}
};
</script></body></html>'''
        for kind in (8, 10):
            res = self.scrape(template % kind)
            self.assertEqual(res.capabilities['content']['status'], 'success', kind)
            self.assertEqual(res.title, '周末图集', kind)
            self.assertEqual(res.author, '示例图集号', kind)
            self.assertTrue(res.published, res.published)
            self.assertEqual(res.images, ['https://mmbiz.qpic.cn/album/one.jpg',
                                          'https://mmbiz.qpic.cn/album/two.jpg',
                                          'https://mmbiz.qpic.cn/album/three.jpg'], kind)
            self.assertNotIn('https://example.com/not-qpic.jpg', res.images, kind)
            self.assertNotIn('https://mmbiz.qpic.cn/wm/one.jpg', res.images, kind)
            self.assertNotIn('https://mmbiz.qpic.cn/avatar/head.jpg', res.images, kind)
            self.assertNotIn('//mmbiz.qpic.cn/album/scheme-relative.jpg', res.images, kind)
            self.assertNotIn('cover_url', res.extra, kind)  # 没有封面字段时不拿头像或图集条目顶替
            self.assertEqual(res.extra['wechat_item_show_type'], kind)

    def test_truncated_page_data_is_a_parse_failure_not_an_exception(self):
        # 页面数据在字符串中间被截断，没有 #js_content：按结构变化失败，不抛到外层。
        html = ('<html><body><script>window.cgiDataNew = {"item_show_type": 8, '
                '"title": "被截断的图集", "nick_name": "示例号", "picture_page_info_list": ['
                '{"cdn_url": "https://mmbiz.qpic.cn/album/one.jpg"')
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'connector_failed')
        note = res.capabilities['content']['note']
        self.assertIn('截断', note)
        self.assertIn('结构变化', note)
        self.assertEqual(res.text, '')
        self.assertEqual(res.images, [])

    def test_too_deep_page_data_is_a_parse_failure_not_an_exception(self):
        # 页面数据嵌套过深：按结构变化失败，不抛到外层。
        deep = 'window.cgiDataNew = ' + '{' * 60 + '"a": 1' + '}' * 60
        res = self.scrape('<html><body><script>' + deep + ';</script></body></html>')
        self.assertEqual(res.capabilities['content']['status'], 'connector_failed')
        self.assertIn('结构变化', res.capabilities['content']['note'])

    def test_other_type_with_js_content_stays_an_article(self):
        # item_show_type 不是 0/8/10，但页面有 #js_content：照常提取普通文章。
        html = '''<html><head>
<meta property="og:title" content="一条普通图文">
<meta property="og:image" content="https://mmbiz.qpic.cn/cover/article.jpg">
</head><body>
<script>window.cgiDataNew = {"item_show_type": 1, "title": "页面数据标题"};</script>
<div id="js_content"><p>普通文章正文</p><img data-src="https://mmbiz.qpic.cn/body/article.jpg"></div>
<script>var nickname = htmlDecode("示例作者"); var ct = "1790000000";</script>
</body></html>'''
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'success')
        self.assertEqual(res.title, '一条普通图文')
        self.assertEqual(res.author, '示例作者')
        self.assertIn('普通文章正文', res.text)
        self.assertEqual(res.extra['wechat_item_show_type'], 1)
        self.assertEqual(res.images, ['https://mmbiz.qpic.cn/cover/article.jpg',
                                      'https://mmbiz.qpic.cn/body/article.jpg'])

    def test_other_type_with_page_data_body_without_js_content(self):
        # 没有 #js_content，但页面数据里有 content_noencode：仍按普通文章提取。
        html = '''<html><head><meta property="og:title" content="页面数据里的文章"></head>
<body><script>window.cgiDataNew = {
  "item_show_type": 1, "title": "页面标题", "nick_name": "示例作者",
  "create_timestamp": 1790000000, "content_noencode": "<p>页面数据正文</p>"
};</script></body></html>'''
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'success')
        self.assertEqual(res.title, '页面标题')
        self.assertEqual(res.author, '示例作者')
        self.assertIn('页面数据正文', res.text)

    def test_other_type_without_body_is_unsupported_and_records_type(self):
        # item_show_type 不是 0/8/10，页面也没有正文：报不支持并记下类型。
        html = '''<html><body><script>window.cgiDataNew = {
  "item_show_type": 3, "title": "不支持的消息", "nick_name": "示例号"
};</script></body></html>'''
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'connector_failed')
        self.assertIn('暂不支持的类型', res.capabilities['content']['note'])
        self.assertIn('item_show_type=3', res.capabilities['content']['note'])
        self.assertEqual(res.extra.get('wechat_item_show_type'), 3)
        self.assertEqual(res.images, [])

    def test_picture_list_without_cgi_data(self):
        # 老式图集页只有 window.picture_page_info_list；没有标题和正文也能拿到图片。
        html = '''<script>
window.picture_page_info_list = [
  {"cdn_url": "https://mmbiz.qpic.cn/old/one.jpg"},
  {"cdn_url": "https://mmbiz.qpic.cn/old/two.jpg"}
];
window.picture_page_info_list = computeGallery();  // 后续计算赋值不该被当成数据
</script>'''
        res = self.scrape(html)
        self.assertEqual(res.capabilities['content']['status'], 'success')
        self.assertEqual(res.images, ['https://mmbiz.qpic.cn/old/one.jpg', 'https://mmbiz.qpic.cn/old/two.jpg'])
        self.assertEqual(res.extra['wechat_item_show_type'], 8)

    def test_failure_reasons_name_captcha_deleted_and_encrypted(self):
        # 失败原因要能分清：验证码、删除、加密块、结构变化；状态词仍用原有集合。
        cases = {
            'captcha': ('<div>环境异常，请完成验证</div>', '验证码'),
            'deleted': ('<div>该内容已被发布者删除</div>', '删除'),
            'encrypted': ('<script>window.cgiDataNew={"item_show_type":0,"title":"t",'
                          '"text_page_info":{"content_noencode":"U2FsdGVk' + 'A' * 80 + '"}};</script>', '加密块'),
            'truncated': ('<script>window.cgiDataNew={"item_show_type":8,"title":"t","nick_name":"n",'
                          '"picture_page_info_list":[{"cdn_url":"https://mmbiz.qpic.cn/a.jpg"', '截断'),
        }
        for name, (html, marker) in cases.items():
            res = self.scrape(html)
            self.assertEqual(res.capabilities['content']['status'], 'connector_failed', name)
            self.assertIn(marker, res.capabilities['content']['note'], name)
            self.assertIn(res.capabilities['content']['status'], core.STATUSES, name)


if __name__ == '__main__':
    unittest.main(verbosity=1)
