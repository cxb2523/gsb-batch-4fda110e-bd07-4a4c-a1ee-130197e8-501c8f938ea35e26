# SourceBoard

Give your local coding agent (Claude Code, Codex, Kimi, …) real access to content-platform data, and get every search back as a local web dashboard.

- **Keyword search** on 10 platforms: Douyin, Xiaohongshu, Bilibili, Weibo, Zhihu, WeChat Official Accounts, YouTube, Reddit, TikTok, X.
- **Grab a single link** (post text, author, engagement numbers, first page of comments, existing captions, media URLs) on 20 platforms plus generic web pages.
- **Account profiles** on 7 platforms.
- **A dashboard for every run**: what was searched and what failed, the agent's conclusion, and sortable, filterable cards you can mark keep/drop and send back to the agent.

## Cost and setup, up front

SourceBoard is free and open source (Apache-2.0), but most platform data comes from [TikHub](https://tikhub.io), a pay-per-call data API. **You need your own TikHub account, balance and API key.** Typical cost is $0.001–0.01 per call; searching all ten platforms once is about $0.04. Free routes (public pages, the YouTube Data API free quota, Zhihu's official CLI) are tried first where they work, identical requests are cached for 24 hours, and you can set a daily budget cap or pass `--no-paid`.

Requirements: macOS or Linux, Python 3.9+, no pip dependencies.

## Install

Send the repository link to your agent and ask it to follow `AGENT_INSTALL.md`. It will explain the cost, install the tool, walk you through creating a TikHub key (you paste the key yourself in your own terminal), verify it, and run a first real search.

Or manually:

```sh
git clone https://github.com/aaronyi97/sourceboard.git ~/.sourceboard
cd ~/.sourceboard && ./install.sh
sourceboard setup
sourceboard search "your topic" -p youtube,reddit,x --open
```

The documentation, CLI output and dashboard are in Chinese. Read-only by design: no platform logins, no browser cookies, no posting. Not affiliated with TikHub or any platform.
