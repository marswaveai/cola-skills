# 通道：能力、边界、降级

## 两条通道

| | webview（CDP） | device（ADB） |
|---|---|---|
| 看到什么 | 完整 DOM、文本、属性、`value` | 无障碍树：文本 + 边界框 |
| 怎么点 | `el.click()`，走完整事件冒泡 | `input tap <x> <y>` |
| 速度 | 单步 30–120 ms | 单步 300–2000 ms（要 dump 树） |
| 定位稳定性 | 高（选择器） | 中（文本 + 坐标，转场会漂） |
| 能执行 JS | 能 | 不能 |
| 能读 href / 存储 / 一次性 token | 能 | 不能 |
| 覆盖范围 | 只有 WebView 里的 H5 | 所有界面 |
| 需要人工开闸 | 是（每个 App 不同） | 只要 USB 调试授权 |

**默认优先 webview，失败自动降到 device。** 用 `--channel webview|device` 强制。

## webview 通道怎么通

```
App 的 WebView 进程
   └── 调试 socket（webview_devtools_remote_<pid>，抽象 unix socket）
          └── adb forward tcp:9223 localabstract:<socket 名>
                 └── http://127.0.0.1:9223/json/list
                        └── webSocketDebuggerUrl → Runtime.evaluate
```

`preflight` 会把这条链的每一环单独报出来，缺哪环就返回哪环的修复步骤。

### 四个必须知道的坑（代码里已处理）

| 坑 | 现象 | 处理 |
|---|---|---|
| 带 `Origin` 头 | WebSocket 握手 403 `Rejected an incoming WebSocket connection from ... origin` | 客户端不发 Origin（`scripts/lib/ws.mjs` 刻意不加） |
| 走本机代理 | 连 `127.0.0.1` 被劫持 | 用 `node:http` + `agent:false`，不读代理环境变量 |
| 端口冲突 | 9222 常被本机 Chrome 占用 | 默认 9223，可用 `--port` 换 |
| `/json/list` 的 URL 会滞后 | 点击跳转后列表里仍是旧地址（实测 Chrome 上必定复现） | 连上后读一次 `location.href` 复核；`pages` 会标 `urlStale: true` |

## device 通道怎么通

只用 adb 原语，零依赖：

| 能力 | 命令 |
|---|---|
| 设备列表 | `adb devices -l` |
| 无障碍树 | `uiautomator dump` → `exec-out cat` |
| 点击 / 滑动 | `input tap` / `input swipe` |
| 输入（仅 ASCII） | `input text` |
| 按键 | `input keyevent` |
| 打开网址 | `am start -a android.intent.action.VIEW -d <url>` |
| 当前界面 | `dumpsys window` |

**限制**：`uiautomator dump` 会独占 UiAutomation。同一时刻不要和 Appium、另一个 dump 进程并发；
`preflight` 报 `UiDumpFail` 时先确认没有别的工具占着。

## 降级规则

只有「通道不可用」才降级；「通道说不行」不降级。

| 错误 | 降级？ | 理由 |
|---|---|---|
| `NoCdp` / `GateClosed` | 降 | 环境问题，换条路可能通 |
| `NoTarget`（**且指定了 `--url`**） | **不降** | 你点名要的那一页不在，换通道只会点到别的东西 |
| `NoTarget`（没指定 `--url`） | 降 | 只是想操作手机，device 仍然可用 |
| `TargetAmbiguous` | 不降 | 事实问题：页面确实有多个，换个通道问也不会更清楚 |
| `RefNotFound` | 不降 | 元素真的不在，降级只会点到别的地方 |
| `AdbTimeout` | 降 | 设备忙 |

## 机器上可能有多个 debugger socket

实测一台机器上同时存在 `chrome_devtools_remote` 和一个空的 `webview_devtools_remote_<pid>`。
空的 debugger 也会响应 `/json/version`，只看端口通不通会选错。

所以 `ensureCdp` 的做法是：**逐个 socket 试，按「有没有页面 / 有没有命中目标 URL」打分**，
选分数最高的。一个页面都没有时抛 `NoTarget`（页面被回收），而不是假装成功。

## 端口与并发

- 一个设备同时只能跑一个 `uiautomator dump`（UiAutomation 独占）
- CDP 不走 UiAutomation，**可以和 device 通道同时用**
- `adb forward` 是全局的：换设备或换 App 后要重新 forward
- 页面被回收后 forward 还在，但 `/json/list` 会变空 —— 判据是列表长度，不是端口通不通

## 什么时候别用这条链

- 目标 App 没有 WebView（纯原生）→ 只能 device
- 有反调试（检测 devtools、改写 `Function.prototype.toString`）→ 放弃 webview
- FLAG_SECURE 页面（银行、支付）→ 截图全黑是系统限制，不要绕过
- 一次性任务（< 20 次）→ 直接人工更快
- iOS → 不覆盖
