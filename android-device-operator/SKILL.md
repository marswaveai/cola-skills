---
name: android-device-operator
description: >
  用 ADB + WebView 调试协议（CDP）直接操作安卓真机：读页面结构、点元素、填表单、
  跑可复现的多步流程。不截图、不做图像识别、不依赖视觉模型；含通道自检、
  自动降级（CDP → 无障碍树 → 坐标）和结构化失败处置。macOS 与 Windows 通用。
  不含 iOS、微信小程序、短信验证码与支付验证。
  Use when the user asks to operate an Android phone, automate 微信/WeChat or in-app H5 pages,
  签到/填表/多步点击流程, click or read a mobile app UI, or says 帮我点手机 /
  自动操作安卓 / 手机自动化 / 真机跑一遍 / adb / 点一下手机上的按钮。
metadata:
  category: integration
  platforms: darwin, win32
---

# android-device-operator

把「操作一台安卓手机」变成可复现的命令，而不是一轮轮猜坐标。

**本文件所在目录就是 `$SKILL`。** 下面的命令都要把 `$SKILL` 换成它的绝对路径；
如果宿主给了 skill 目录变量就优先用它，不要假设固定在某个位置。

## 铁律

1. **动作必须带后置条件。** `act` 不带 `--expect-text` 只代表「已投递」，不代表生效。
   任何「点完了」的结论都要有 `expect` 或 `snapshot` 支撑。
2. **未知页面就停下来。** 不在预期页面、找不到元素、条件超时 —— 报给用户，不要猜着点。
3. **多页面必须指定 `--url`。** 工具会拒绝歧义（`TargetAmbiguous`），这是特性不是 bug。
4. **一次调用跑完整个流程。** 三步以上用 `run --flow`，不要每点一下都回来问模型。
5. **只做用户授权范围内的动作。** 付款、发送、删除、改账号权限、装来源不明的包 —— 先停下来问。

## 第一步：自检（永远先跑这个）

```bash
node "$SKILL/scripts/cli.mjs" preflight
```

返回 `channels` 告诉你哪条通道能用：

- `webview` — H5 页面，最快最准，首选
- `device` — 无障碍树 + 坐标，原生 UI 或没有调试端口时的兜底

`next` 数组里是给人看的修复步骤。**照抄给用户，不要自己发挥。**
退出码 2 表示需要人（插线、解锁、开调试开关），不是你需要重试。

## 第二步：看页面

```bash
node "$SKILL/scripts/cli.mjs" snapshot --url <页面URL片段>
```

返回 `page.text`（全文）、`page.lines`（分行）、`page.elements`（可交互元素及 `ref`）。

**先读 `text` 再决定点什么。** 不要靠截图猜。

## 第三步：动它

```bash
# 点一个元素（ref 来自 snapshot）
node "$SKILL/scripts/cli.mjs" act --op click --ref 'css:#submit' --expect-text '提交成功'

# 填输入框
node "$SKILL/scripts/cli.mjs" act --op type --ref 'css:#phone' --text '13800000000'

# 等某个状态（--timeout 单位是秒）
node "$SKILL/scripts/cli.mjs" expect --text '3/10' --timeout 8

# 打开一个网址
node "$SKILL/scripts/cli.mjs" open --to 'https://example.com/page'
```

`ref` 语法：

| 写法 | 含义 |
|---|---|
| `css:#id > div:nth-of-type(2)` | CSS 选择器，最精确 |
| `text:开始答题` | 文本完全相等 |
| `text~:开始` | 文本包含 |
| `ax:12` | 无障碍树节点序号（device 通道） |

## 第四步：固化流程

一次能跑完的，才值得重复。

```bash
node "$SKILL/scripts/cli.mjs" run --flow "$SKILL/assets/flows/example-h5-form.json"
```

流程文件里每一步都必须有 `expect`，缺了会在加载期直接拒绝。
格式见 `references/selectors.md`，骨架见 `assets/flows/`。

## 浏览器标签会越开越多

页面跳转时浏览器可能开新标签，几次之后同一个站点会有好几个页面，
`--url` 就会报 `TargetAmbiguous`（这是对的，不能猜）。

```bash
node "$SKILL/scripts/cli.mjs" pages              # 看有哪些（快，读元数据）
node "$SKILL/scripts/cli.mjs" pages --live       # 读真实地址（元数据会滞后）
node "$SKILL/scripts/cli.mjs" close --url 片段    # 关掉多余标签
```

## 通道怎么选

| 情况 | 用哪条 |
|---|---|
| 微信 / App 里的 H5 页面 | webview |
| 原生界面、系统弹窗、App 外壳 | device |
| webview 报 `GateClosed` / `NoTarget` | 先让用户开调试开关；开不了就 device |
| 需要读 href 参数、localStorage、一次性 token | 只有 webview 能做 |
| 需要安装 App、看日志、读崩溃 | device（`adb`） |

细节和边界：`references/channels.md`。

## 失败时

按 `error.code` 走 `references/failures.md` 的处置表。
**不要把错误码翻译成「再试一次」** —— 大部分错误重试三次也是一样的结果。

三个最常见的：

- `GateClosed` — 微信调试开关没开，必须人手点一次
- `NoTarget` — 页面被回收，或指定的 `--url` 已经不在任何标签里
- `TargetAmbiguous` — 同一站点开了多个标签，用 `close` 清理或给更长的 `--url`
- `NonAsciiInput` — 纯 adb 输不了中文，请用户自己输入，或者改用 webview 通道

## 不要做的事

- 不要截图 + 视觉模型判断页面 —— 这条通道存在就是为了不这么做
- 不要把 `bank.json` 这类业务数据放进 skill，业务留在用户自己的流程里
- 不要在没有 `expect` 的情况下连续点多个元素
- 不要对 `TargetAmbiguous` 的多个页面「随便选一个」
- 不要在 FLAG_SECURE 页面（银行、支付）上尝试绕过截图限制

## 已知边界

- 微信小程序不走这条链（独立 devtools 体系）
- iOS 不覆盖（另需 Web Inspector / XCUITest）
- 中文输入在 device 通道不可用，webview 通道可以（直接写 value）
- 调试开关可能随 App 版本失效，这是通道本身的属性

## 参考

| 文件 | 什么时候读 |
|---|---|
| `references/channels.md` | 需要理解降级逻辑、403、端口冲突 |
| `references/wechat.md` | 目标是微信里的页面 |
| `references/selectors.md` | 写 flow、挑 ref、处理同名元素 |
| `references/failures.md` | 拿到错误码不知道怎么办 |
| `references/recipes.md` | 想找现成的任务骨架 |
