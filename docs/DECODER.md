# 可核对的自解码器（LND decoder）

落地页 `index.html` 把真实页面切成 11 段 Base64，藏在 id 为
`lndoxffylyyj0` … `lndoxffylyyj10` 的 `<template>` 元素里。旧的页尾脚本
直接拼接、`atob`、XOR、UTF-8 解码并写回文档，任何一步出错要么静默乱码、
要么把异常抛到页面顶部，采集方拿不到任何结论。

`js/lnd-decoder.js` 替换了这段逻辑：一次解码必定产出一个**可程序读取的
状态对象**，并且在全部校验通过之前不触碰标题、head 或 body。

## 状态对象

解码结束后，以下两个位置内容一致，均可被采集脚本读取：

- `window.LND_DECODE_STATUS`（冻结对象，只读绑定）
- `<html data-lnd-decode-status="...">`（同一对象的 JSON 序列化，便于不支持
  JS 注入的采集器直接读属性）

字段（成功与失败时全部存在）：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `success` | boolean | 全部阶段是否成功 |
| `failureCategory` | string \| null | 失败类别，见下表；成功为 `null` |
| `pieces` | number[] | 涉及的片号；缺片/坏 Base64 为具体片号，密钥或 UTF-8 类为 0–10，成功为 `[]` |
| `restoredHtmlLength` | number | 还原 HTML 的字符数；失败为 `0` |
| `inlineScriptCount` | number | 成功时重放的内联脚本段数；失败为 `0` |
| `externalScriptCount` | number | 成功时重放的外链脚本段数；失败为 `0` |
| `reason` | string \| null | 可定位的人类可读诊断（含片号/字节偏移/底层错误信息） |

失败类别：

| `failureCategory` | 触发条件 | `pieces` 内容 |
| --- | --- | --- |
| `missing-piece` | 0–10 中任一片缺失或内容为空白 | 全部缺失片号（升序） |
| `invalid-base64` | 某片含非 Base64 字符、填充位置非法，或拼接流无法被 `atob` 接受 | 问题片号（拼接级问题记最后一片 10） |
| `empty-key` | 密钥为空字符串，或密钥 Base64 解码后为零字节 | `[0..10]` |
| `invalid-utf8` | XOR 还原出的字节不是合法 UTF-8（原因含首个坏字节偏移） | `[0..10]` |
| `unexpected-error` | 兜底：任何未预期的 DOM/运行时异常，保证不冒到页面顶部 | `[0..10]` |

## 解码流水线（顺序短路）

1. **取片**：按 0–10 读取 11 个 template；任一缺失/空白即返回
   `missing-piece`，不做拼接。
2. **逐片 Base64 校验**：检查字母表与 `=` 填充位置，再校验拼接后长度是
   4 的倍数；任何问题返回带片号与原因的 `invalid-base64`。
3. **密钥校验**：空密钥返回 `empty-key`，XOR 不执行。
4. **受控 `atob`**：外层仍包 `try/catch`，浏览器实现的额外严格性导致抛错
   时同样归类 `invalid-base64`，异常不会冒泡。
5. **逐字节 XOR**：固定密钥按 `i % key.length` 循环（与旧逻辑一致）。
6. **严格 UTF-8**：先手工校验定位坏字节偏移，再用 `TextDecoder` 解码；
   失败返回 `invalid-utf8`。

只有六步全过才进入 DOM 写入，因此失败时页面不会留下半截内容，
`document.title` 保持原样。

## 成功后的还原行为（与旧逻辑等价）

- 用还原 HTML 的 `<title>` 文本更新 `document.title`；
- head 中只追加 `STYLE` / `META` / `LINK` / `BASE`（`<title>` 与 head 内
  脚本等其他节点丢弃）；
- 先抽出 body 内全部 `<script>`（外链记 `src`，非空内联记文本，空内联
  忽略），再整体替换 `document.body.innerHTML`；
- 按原顺序逐个新建 `<script>` 挂回 body 重放，外链保留 `src`；
- 状态里的 `inlineScriptCount` / `externalScriptCount` 即实际重放段数。

## 配置（可选）

解码器默认内置原固定密钥。需要复现"空密钥"场景或更换密钥时，在引入
`lnd-decoder.js` 之前设置：

```html
<script>window.LND_DECODER_CONFIG = { keyBase64: '' };</script>
<script src="js/lnd-decoder.js"></script>
```

纯逻辑也可在 Node 中直接调用，不依赖 DOM：

```js
const Lnd = require('./js/lnd-decoder.js');
const { status, html } = Lnd.decode({ pieces: [...11 段...], keyBase64: '...' });
```

## 测试与样例

```bash
npm test                 # Node 单元测试（19 项，含真实载荷回归）
npm run samples:generate # 重新生成 samples/ 下五个样例页
npm run samples:verify   # 从样例页 HTML 抽片，核对预期状态
npm run check            # 上面三步一起跑
```

`samples/` 下五个页面均可直接用浏览器本地打开（`file://`），页面右下角有
SELF-CHECK 浮层，同时把完整状态打到 console：

| 文件 | 场景 | 预期 `failureCategory` | 预期 `pieces` |
| --- | --- | --- | --- |
| `01-missing-piece.html` | 删除第 7 片 | `missing-piece` | `[7]` |
| `02-bad-base64.html` | 第 4 片插入非法字符 `!` | `invalid-base64` | `[4]` |
| `03-empty-key.html` | 密钥配置为空串 | `empty-key` | `[0..10]` |
| `04-invalid-utf8.html` | 还原字节含 `FF FE E0 80` | `invalid-utf8` | `[0..10]` |
| `05-full-success.html` | 完整有效载荷 | `null`（成功） | `[]`，内联 2、外链 2 |

失败样例还会断言：标题保持 `LND sample — …`、fallback 内容仍在、还原
标记一个都没出现；成功样例断言标题切换、fallback 消失、两段内联与两段
外链脚本全部按序执行（页面上四个 marker 均变为 `… ran`）。

已用本机 headless Chrome 对 `index.html` 与五个样例逐一验证，状态对象与
上表一致；生产页解码结果为 `restoredHtmlLength=24024`、
`inlineScriptCount=1`、`externalScriptCount=0`。
