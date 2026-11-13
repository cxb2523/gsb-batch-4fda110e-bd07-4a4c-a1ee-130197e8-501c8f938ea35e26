"""sourceboard setup — 第一次使用的引导：先把话说清楚，再带着配 TikHub。

钥匙由用户自己在终端里粘贴（输入时不显示），只写进本机配置文件，程序不打印它。
"""
import argparse
import getpass
import json
import subprocess
import sys

import sbconfig

INTRO = '''
SourceBoard 能做什么
  · 按关键词搜 10 个平台：抖音、小红书、B站、微博、知乎、公众号、YouTube、Reddit、TikTok、X
  · 给一个链接，抓回正文、作者、点赞评论等数据、第一页评论、现成字幕（20 个平台加普通网页）
  · 看 7 个平台的账号主页：简介、粉丝数、最近作品
  · 每次搜完或抓完，自动生成一张本机网页看板

要花什么钱
  · 搜索和大部分平台的数据走 TikHub（tikhub.io），这是一个按次收费的数据接口，需要你自己注册、充值。
    每次调用约 $0.001–0.01：搜一次抖音或小红书约 $0.01，搜一次 B站、微博、X 约 $0.001。
    十个平台各搜一遍约 $0.04。充几美元可以用很久。
  · 能免费拿的先走免费：公开网页、YouTube 官方接口的免费额度、知乎官方工具。
  · 同一个请求 24 小时内不重复扣费；可以设每日预算上限；加 --no-paid 就完全不花钱。
  · 本工具本身免费、开源，不经手你的钱，也不上传你的钥匙和数据。

要配置什么
  · 必须：TikHub 钥匙（下一步带你配）。没有它，搜索用不了，只有少数平台能免费抓单条。
  · 可选，用到时再配：YouTube 官方钥匙（免费）、知乎官方工具（免费额度）、yt-dlp、ffmpeg。
'''

TIKHUB_STEPS = '''
第 1 步：拿到 TikHub 钥匙（TikHub 官方快速上手：https://tikhub.io/zh/getting-started）
  1. 打开 https://user.tikhub.io/register 注册，去邮箱点确认链接激活。
     新账号有 $0.05 的试用额度（约 50 次请求），但一部分接口只认充值余额。
  2. 在控制台充值。支持支付宝、PayPal、USDT。先充几美元就够用很久。
  3. 在控制台的 API Keys 页面新建一个钥匙，权限全选，复制下来。
'''


def tikhub_account():
    """用刚存好的钥匙查一次账户（免费）。返回 (是否成功, 文字说明, 数据)。"""
    cli = [sys.executable, '-B', str(sbconfig.LIB / 'tikhub.py'), '--no-cache', 'account']
    try:
        p = subprocess.run(cli, capture_output=True, text=True, timeout=90)
        doc = json.loads(p.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return False, f'没有连上 TikHub（{type(e).__name__}）。检查网络后重试：sourceboard account', {}
    if not doc.get('ok'):
        error = str(doc.get('error') or doc)[:300]
        hint = '钥匙不对或已失效，请回后台重新复制。' if '401' in error or '403' in error else '请检查网络；国内网络可重新运行 setup 并加 --base-url https://api.tikhub.dev'
        return False, f'TikHub 没有通过：{error}\n  {hint}', doc
    user = doc.get('user_data') or {}
    scopes = (doc.get('api_key_data') or {}).get('api_key_scopes') or {}
    plats = scopes.get('平台') if isinstance(scopes, dict) else None
    text = f'TikHub 已连通。余额 ${user.get("balance")}，赠送额度 ${user.get("free_credit")}'
    if plats is not None:
        text += f'，钥匙可用平台 {len(plats)} 个'
    return True, text, doc


def ask(prompt, default=''):
    try:
        value = input(prompt).strip()
    except EOFError:
        value = ''
    return value or default


def main(argv=None):
    ap = argparse.ArgumentParser(prog='sourceboard setup', description='第一次使用的引导：说清能做什么、花什么钱，带着配好 TikHub。')
    ap.add_argument('--key-stdin', action='store_true', help='从标准输入读 TikHub 钥匙（给脚本用）；默认是交互式输入，输入时不显示')
    ap.add_argument('--youtube-key-stdin', action='store_true', help='从标准输入读 YouTube 官方钥匙（可选项）')
    ap.add_argument('--budget', help='每日预算上限（美元）。到了就不再发起付费调用。默认 1')
    ap.add_argument('--platforms', help='常用平台，逗号分隔，search 不写平台时就搜这些')
    ap.add_argument('--home', help='数据目录，默认 ~/SourceBoard')
    ap.add_argument('--base-url', help='TikHub 接口地址，国内网络用 https://api.tikhub.dev')
    ap.add_argument('--yes', action='store_true', help='不提问，没给的选项用默认值（给脚本用）')
    a = ap.parse_args(argv)
    interactive = sys.stdin.isatty() and not a.yes and not a.key_stdin and not a.youtube_key_stdin
    values = {}
    try:
        if a.base_url:
            sbconfig.check_base(a.base_url.rstrip('/'))
            values['TIKHUB_BASE_URL'] = a.base_url.rstrip('/')
        if a.youtube_key_stdin:
            key = (getpass.getpass('把 YouTube 官方钥匙粘贴到这里后回车（输入时不显示）：') if sys.stdin.isatty() else sys.stdin.readline()).strip()
            if not key:
                print('没有读到 YouTube 钥匙。', file=sys.stderr)
                return 2
            sbconfig.save({'YOUTUBE_API_KEY': key})
            print('YouTube 官方钥匙已存到本机配置。')
            return 0

        print(INTRO)
        have = bool(sbconfig.get('TIKHUB_API_KEY'))
        key = ''
        if a.key_stdin:
            key = sys.stdin.readline().strip()
        elif interactive:
            if have:
                print('本机已经存过 TikHub 钥匙。直接回车沿用，或粘贴新钥匙替换。')
            else:
                print(TIKHUB_STEPS)
            key = getpass.getpass('第 2 步：把 TikHub 钥匙粘贴到这里后回车（输入时不显示）：').strip()
        if key:
            if len(key) < 20 or ' ' in key:
                print('这看起来不像 TikHub 钥匙（太短或有空格），没有保存。', file=sys.stderr)
                return 2
            values['TIKHUB_API_KEY'] = key
        elif not have:
            print(TIKHUB_STEPS)
            print('还没有钥匙。拿到之后在你自己的终端里运行：sourceboard setup\n（钥匙请自己粘贴，不要发到聊天里。）')
            return 1

        budget = a.budget
        if budget is None and interactive:
            budget = ask(f'第 3 步：每日预算上限，单位美元（直接回车用 {sbconfig.get("SOURCEBOARD_DAILY_BUDGET_USD") or "1"}）：')
        budget = budget or sbconfig.get('SOURCEBOARD_DAILY_BUDGET_USD') or '1'
        try:
            if float(budget) <= 0:
                raise ValueError
        except ValueError:
            print('预算要写成大于 0 的数字，例如 1 或 0.5。', file=sys.stderr)
            return 2
        values['SOURCEBOARD_DAILY_BUDGET_USD'] = str(budget)

        platforms = a.platforms
        if platforms is None and interactive:
            import search
            print('第 4 步：你常搜哪些平台？可选：' + '、'.join(search.NAMES.values()))
            platforms = ask('  用逗号隔开写平台名（直接回车表示全部）：')
        if platforms:
            import search
            values['SOURCEBOARD_PLATFORMS'] = ','.join(search.pick_platforms(platforms))
        if a.home:
            values['SOURCEBOARD_HOME'] = a.home
    except ValueError as e:
        print('sourceboard setup: ' + str(e), file=sys.stderr)
        return 2

    sbconfig.save(values)
    print(f'\n配置已写入 {sbconfig.ENV_FILE}（只有你能读）。数据目录：{sbconfig.home()}')
    ok, text, _ = tikhub_account()
    print(('✓ ' if ok else '✗ ') + text)
    if not ok:
        return 1
    print(f'每日预算上限 ${values["SOURCEBOARD_DAILY_BUDGET_USD"]}（按估算花费计，到了就停止付费调用；改它再运行一次 setup --budget 数字）')
    print('\n配好了。现在可以试：\n  sourceboard search "你想查的题目" --plan      先看会花多少\n  sourceboard search "你想查的题目" --open      搜索并打开看板\n  sourceboard doctor                            看可选组件装了哪些')
    return 0


if __name__ == '__main__':
    sys.exit(main())
