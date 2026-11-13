# 给 Agent 的安装引导

这份文件是写给 Agent（Claude Code、Codex、Kimi 等）看的。用户把本仓库链接发给你、让你安装 SourceBoard 时，照这里一步步做。

## 你要怎么带

这是引导式安装：**你来推进，不是等用户来问。** 每一步都主动告诉用户三件事：

1. 现在是第几步、一共几步，这一步在做什么；
2. 需要他做什么（没有就说“这步不用你动手”）；
3. 做完之后下一步是什么。

用用户看得懂的话，不要丢一堆命令和术语给他。需要他判断或动手的地方，停下来等他，不要替他决定。

一共 7 步。第 1 步只说话不动手，第 3 步需要用户自己操作，其余你来做。

## 硬规矩

- **钥匙不过你的手。** TikHub 钥匙由用户在他自己的终端里粘贴。不要让他发到对话里，不要读、不要打印 `~/.config/sourceboard/config.env`，不要把钥匙写进任何命令行参数。如果用户已经把钥匙发到了对话里，告诉他：装完之后去 TikHub 后台把这个钥匙删掉、换一个新的。
- **花钱前先说。** 任何会调用 TikHub 的命令，先用 `--plan` 看预估花费，告诉用户，他同意了再跑。
- **不动用户已有的东西。** 不覆盖已有的同名目录和配置；发现已经装过，先问是更新还是重装。
- **不登录任何平台账号**，不读浏览器 Cookie，不替用户注册或充值。
- **装上不等于能用。** 只有真实搜索返回了结果、看板在用户面前打开了，才算装完。

## 第 1 步：先把话说清楚

动手之前，把下面这段原样告诉用户（可以调整语气，不要删内容），然后问他要不要继续：

> **SourceBoard 能做什么**
> - 按关键词搜 10 个平台：抖音、小红书、B站、微博、知乎、公众号、YouTube、Reddit、TikTok、X
> - 给一个链接，抓回正文、作者、点赞评论等数据、第一页评论、现成字幕（20 个平台加普通网页）
> - 看 7 个平台的账号主页：简介、粉丝数、最近作品
> - 每次搜完或抓完，自动生成一张本机网页看板
>
> **要花什么钱**
> - 工具本身免费。但平台数据大部分来自 TikHub，这是按次收费的数据接口，需要你自己注册、充值。
> - 每次调用约 $0.001–0.01：搜一次抖音或小红书约 $0.01，十个平台各搜一遍约 $0.04。充几美元可以用很久。
> - 能免费拿的会先走免费；同一个请求 24 小时内不重复扣费；可以设每日预算上限。
>
> **要配置什么**
> - 必须：TikHub 钥匙。接下来第 3 步我带你配，需要你自己注册、充值、粘贴钥匙，大概 5 分钟。
> - 可选：YouTube 官方钥匙、知乎官方工具、yt-dlp。以后用到再配，今天不用管。
>
> 整个安装 7 步，大概 10 分钟。要继续吗？

用户不想为 TikHub 花钱也没关系，如实告诉他：不配 TikHub 的话搜索用不了，只能加 `--no-paid` 免费抓少数平台的单条链接（公众号文章、X、Reddit、Bluesky、普通网页等）。愿不愿意由他定。

## 第 2 步：检查环境并安装

你来做，不用用户动手。

```sh
python3 -c 'import sys; print(sys.version); sys.exit(0 if sys.version_info >= (3, 9) else 1)'
git --version
```

- 系统要是 macOS 或 Linux，Python 3.9 以上。不满足就停下来告诉用户缺什么。
- 检查 `~/.sourceboard`（程序）、`~/SourceBoard`（数据）和 `~/.config/sourceboard`（配置）是否已存在。已存在就问用户：更新（`git pull`）还是换个目录。

```sh
git clone https://github.com/aaronyi97/sourceboard.git ~/.sourceboard
cd ~/.sourceboard && ./install.sh
sourceboard --help
```

`install.sh` 只做三件事：检查 Python 版本，把 `sourceboard` 命令链接到 `~/.local/bin`，跑一遍不联网的自检。自检必须全部通过。如果提示 `~/.local/bin` 不在 PATH 里，后面的命令就用完整路径 `~/.local/bin/sourceboard`，并告诉用户怎么加到 PATH。

## 第 3 步：带用户配好 TikHub（必须）

这一步需要用户自己动手，你一句一句带。

1. 让用户打开 https://user.tikhub.io/register 注册，去邮箱点确认链接。（官方上手说明：https://tikhub.io/zh/getting-started ）
2. 让用户在 TikHub 控制台充值。支持支付宝、PayPal、USDT。告诉他：一部分接口只认充值余额，不充值大部分搜索会失败；先充几美元就够用很久。充多少由他定。
3. 让用户在控制台的 API Keys 页面新建一个钥匙，权限全选，复制下来。
4. 让用户**在他自己的终端里**运行下面这条命令，按提示粘贴钥匙（输入时不显示）、设每日预算、选常用平台：

   ```sh
   ~/.local/bin/sourceboard setup
   ```

   要给他这条带完整路径的命令：刚装好时，`~/.local/bin` 多半还不在他终端的 PATH 里，只写 `sourceboard setup` 会提示找不到命令。顺便告诉他终端在哪：macOS 按 Command+空格 搜“终端”打开，Linux 打开系统自带的终端。粘贴命令、回车，照提示做。

   你不要替他运行这条命令，因为你没法替他输入钥匙。等他告诉你做完了。

5. 你来验证：

   ```sh
   sourceboard doctor
   ```

   看到 `"tikhub":"success"` 和余额才算通过。常见问题：
   - `auth_failed`：钥匙没存上或复制错了，请他重新运行 `sourceboard setup`。
   - `connector_failed` 或连不上：多半是网络。国内网络让他运行 `sourceboard setup --base-url https://api.tikhub.dev`。
   - 余额是 0：提醒他充值，否则大部分搜索会失败。

把余额和每日预算报给用户。

## 第 4 步：问两个问题

如果用户在第 3 步的 `setup` 里已经选过常用平台和预算，这步只确认一遍。没选的话问他：

1. 你主要做什么内容、常看哪几个平台？
2. 每天最多愿意花多少钱在搜索上？（默认 1 美元）

然后你来写进配置（这条命令不会动钥匙）：

```sh
sourceboard setup --yes --platforms 抖音,小红书,B站 --budget 1
```

## 第 5 步：用用户自己的题目跑第一次搜索

问用户：“给我一个你现在想查的题目。”拿到之后先看价：

```sh
sourceboard search "用户的题目" --plan
```

把会搜哪些平台、预估花多少告诉用户。他同意后：

```sh
sourceboard search "用户的题目" --json
```

读输出里的 `sources`：哪个平台搜到几条、哪个失败了、为什么。**有平台失败要明说**，不要只报成功的。全部平台都失败时不要往下走，回到第 3 步排查钥匙、余额和网络。

注意：中文平台搜索时，不要把几个近义词塞进一个搜索词里，会少搜到很多；宁可分几次搜。

## 第 6 步：写结论，打开第一张看板

读输出里 `results` 指向的 `results.json`，基于真实搜到的内容给用户写一份简短结论（Markdown）：这个题目各平台谁在做、哪几条数据最好、有什么共同点、你拿不准的是什么。每个判断带上卡片编号（如 `[dy03]`），方便用户对照。存成结果目录里的 `conclusion.md`，然后：

```sh
sourceboard board <结果目录> --conclusion <结果目录>/conclusion.md --open
```

看板会在用户的浏览器里打开。告诉他这页怎么看：上面是这次搜了什么，中间是你的结论，下面是资料卡片；想让你接着处理某几条，就点“留”，最后点“生成回复”，把文字贴回对话。

用户确认看到了看板，这一步才算过。

## 第 7 步：装上技能，交代以后怎么用

把仓库里的 `skill/` 目录装进你自己的技能目录（名字用 `sourceboard`），这样以后新对话里你也知道怎么用。例如 Claude Code 是 `~/.claude/skills/sourceboard/`，其他 Agent 用各自的技能目录；用软链接指向 `~/.sourceboard/skill` 即可，更新仓库时技能跟着更新。你的环境不支持技能的话，把 `skill/SKILL.md` 的要点记进你的长期说明里。

最后给用户一段交接，说清：

- 装在哪、数据存在哪（默认 `~/SourceBoard`）、钥匙存在哪；
- 第 3 步实测的余额、每日预算、常用平台；
- 以后怎么用：直接说“搜一下某某，出看板”“把这个链接抓回来”就行；
- 怎么看花了多少：`sourceboard usage --by day --since 7d`；
- 今天没配的可选项（YouTube 官方钥匙、知乎官方工具、yt-dlp）各自能省什么，用到时再找你配；
- 这次哪些平台实测通过、哪些没通过。

## 以后要配可选项时

- **YouTube 官方钥匙（免费）**：让用户在 Google Cloud Console 新建项目、启用 YouTube Data API v3、创建 API 密钥，然后在自己的终端运行 `~/.local/bin/sourceboard setup --youtube-key-stdin`，粘贴后回车。
- **知乎官方工具**：按知乎开放平台（https://developer.zhihu.com/ ）的官方说明安装和授权。装好后 SourceBoard 会自动找到它；找不到时在配置里设 `ZHIHU_CLI=工具的完整路径`。
- **yt-dlp**：`pipx install yt-dlp` 或 `brew install yt-dlp`。
- **ffmpeg**：`brew install ffmpeg` 或系统包管理器。只有下载 B站视频才需要。

装完任何一项，运行 `sourceboard doctor` 确认它被认出来了。
