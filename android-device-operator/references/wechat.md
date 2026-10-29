# 微信（WeChat / 微信）

微信是混合应用：聊天外壳是原生，点开的 H5 用 XWeb（腾讯的 Chromium 分支）渲染。
**这条链只控后者**，控不了聊天列表、发消息、支付这些原生界面。

## 开调试开关（唯一必须人手的环节）

```
微信内打开  http://debugxweb.qq.com/?inspector=true
→ 弹框「是否打开微信浏览器调试能力？」→ 点「确定」
→ 页面本身会报 DNS 错误，不影响
```

这是腾讯官方留的调试入口，等效于 Android 的 `setWebContentsDebuggingEnabled(true)`。
**脚本绕不过它**，只能让用户点一次。

开关的存活期跟着微信进程走：微信被杀 → 需要重开一次。

## 确认链路

```bash
node "$SKILL/scripts/cli.mjs" channel
```

看三处：

- `sockets` 里有没有 `webview_devtools_remote_<pid>`
- `cdp.ok` 是否为 true
- `cdp.targets` 长度

缺 socket = 开关没开；socket 有但 targets 为空 = 页面被回收。

## 页面的三种状态

| 现象 | 含义 | 处置 |
|---|---|---|
| `/json/list` 为空 | WebView 进程被回收（退后台久了） | 让用户在微信里重新打开目标页 |
| 有多个 target | 同时开了多个 H5 | 必须给 `--url` 指定，工具会拒绝猜 |
| target 在但 `location.href` 变了 | 页面自己跳转了 | 重新 snapshot，别沿用旧 ref |

## 页面回收是常态

微信退到后台一段时间，WebView 就会被系统回收，`adb forward` 还挂着但列表空。
所以：

1. 每次开工先 `preflight`
2. 流程中途拿到 `NoTarget` 就停，让用户重新打开 —— **不要自动重开微信**
3. 长流程（> 2 分钟）要预期可能被打断

## 多 target 的真实场景

微信里开着「文件传输助手 + 活动页 + 另一个活动页」时，`/json/list` 会有 2–3 个页面。
`pages` 命令可以列全，然后：

```bash
node "$SKILL/scripts/cli.mjs" snapshot --url 'example.com/activity'
```

URL 片段要足够独特，能唯一定位。

## 小程序不在范围内

小程序的调试体系是 `appbrand`，不是 `webview_devtools_remote`，需要单独研究。
看到用户说「小程序」就明确告诉他这条链不支持，别硬试。

## 输入框

微信 H5 里的输入框优先走 webview 通道 `type` —— 直接写 `value` 并派发 `input`/`change`，
中文没问题。device 通道的 `input text` 只吃 ASCII。

## 合规提醒

自动化参与答题、抽奖、积分这类活动通常违反活动规则，账号风险由使用者承担。
只做用户明确授权的动作，不要替用户决定「多跑几遍」。
