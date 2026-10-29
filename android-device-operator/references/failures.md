# 错误码 → 处置

退出码先看这个：

| 退出码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | 继续或汇报 |
| 2 | **需要人** | 把 `hint` 原样转述给用户，然后停 |
| 3 | 失败但环境正常 | 最多重试一次；两次一样就上报 |

**退出码 2 不要重试。** 那是「缺一步人工操作」，重试一百次也是同一个结果。

## 环境类

| code | 含义 | 处置 |
|---|---|---|
| `NoAdb` | 找不到 adb | macOS：`brew install --cask android-platform-tools`；Windows：装 SDK Platform-Tools 并加进 PATH，或设 `ADB` 环境变量 |
| `NoDevice` | 没连设备 | 插线 + 手机开 USB 调试 |
| `Unauthorized` | 未授权 | 手机上点「允许 USB 调试」，注意勾「一律允许」 |
| `DeviceNotReady` | 设备状态异常（offline 等） | 拔插数据线；必要时 `adb kill-server && adb start-server` |
| `AdbTimeout` | adb 命令超时 | 设备卡住或线材问题；重试一次，仍失败就让人看设备 |
| `UiDumpFail` | 拿不到无障碍树 | 确认屏幕已解锁；确认没有 Appium/另一个 dump 占着 UiAutomation |

## 通道类

| code | 含义 | 处置 |
|---|---|---|
| `GateClosed` | 调试开关没开 | 微信：让用户开 `debugxweb.qq.com/?inspector=true` 并点确定 |
| `NoCdp` | 端口不通 | 换 `--port`；确认 9222/9223 没被本机其它程序占用 |
| `NoTarget` | 调试列表为空，或没有页面匹配 `--url` | 页面被回收 —— 让用户重新打开那一页；**指定了 `--url` 时不会自动降级到 device**（避免在不知道屏幕上是什么的情况下按坐标点） |
| `TargetAmbiguous` | 多个页面都匹配 | 加更长的 `--url`；错误里会列出**真实**的 URL，照着挑 |
| `NavigateNewTab` | 导航后当前会话还停在旧页 | 浏览器把新页开在了新标签：`pages` 看新页面，再用 `--url` 指定 |
| `NoPort` | 端口没有映射 | `adb forward` 没做；跑 `preflight` |
| `CdpClosed` | 连接被对端关闭 | 页面跳转或崩溃；重新开上下文 |

## 定位类

| code | 含义 | 处置 |
|---|---|---|
| `RefNotFound` | 找不到元素 | 重新 `snapshot`；页面可能已经变了；换更宽的 ref（`text~:`） |
| `ExpectTimeout` | 条件没成立 | 看返回的 `last.text` 判断停在哪；点了没反应通常是点到了外层容器 |
| `JsError` | 页面里执行 JS 抛错 | 选择器写错或页面结构变了；看 `message` 里的首行 |

## 输入类

| code | 含义 | 处置 |
|---|---|---|
| `NonAsciiInput` | 纯 adb 不能输中文 | 改走 webview 通道 `type`；或请用户自己输入 |

**中文输入的正确解法**：H5 页面用 webview 通道（直接写 `value` + 派发事件，中文无压力）；
原生输入框则交给人手输入。不要为了填一个中文框去装输入法 APK —— 收益太小。

## 流程类

| code | 含义 | 处置 |
|---|---|---|
| `FlowSchema` | 流程文件结构不对 | 常见是某步缺 `expect`；这是故意的硬约束 |
| `FlowLoad` / `FlowParse` | 读不到 / 不是合法 JSON | 检查路径与 JSON 语法 |

## 一次命令等多久

`--timeout` 和 flow 里的 `timeout` **单位都是秒**，不是毫秒。
默认 8 秒；模拟器、低端机、冷启动的页面建议 25–30 秒。

## 重试的正确姿势

只有这三类值得重试：

1. `AdbTimeout` / `StaleRef` —— 环境抖动
2. 单步 `ExpectTimeout` 且 `retries` 还没用完 —— 页面可能慢了一拍
3. 通道切换后重跑同一段 —— 带宽换了

**不要**重试：`GateClosed`、`TargetAmbiguous`、`NonAsciiInput`、`FlowSchema`。
这些重试不会变好，只会拖长失败时间。

## 上报模板

给用户的失败说明要有三样东西：

```
发生了什么：<一句话，用人话>
卡在哪：<命令 + 页面/元素>
下一步：<一条可执行的指令，最好是复制粘贴就能用>
```

不要只贴 JSON。
