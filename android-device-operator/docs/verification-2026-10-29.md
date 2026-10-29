# 实测记录 · 2026-10-29

环境：macOS（Apple Silicon）+ Android 模拟器 `cola-capture-20261008`（SDK 34，arm64）
+ Chrome for Android 124（自带 `chrome_devtools_remote`，无需任何人工开闸）。
Node v26.5.0，adb 来自 Android SDK platform-tools。

> 目的：验证两条通道在真实浏览器 / 真实 `uiautomator` 上都能跑通，
> 而不是只在假 CDP 服务器上自洽。

## 结果

| 项 | 结果 |
|---|---|
| `preflight` | `channels: [webview, device]`，自动 forward 成功 |
| `pages` | 72 ms（元数据） |
| `pages --live` | 62 ms / 2 个 target（并行探测） |
| `snapshot`（webview） | 56 ms，正确读出 example.com 正文 |
| `snapshot`（device） | 读到桌面所有 App 名与坐标 |
| `act --op click`（device） | 点中 Chrome 图标，坐标 `(664,1971)` |
| `act --op click`（webview） | 点中 `Learn more`，URL 跳到 iana.org |
| `expect --timeout 3` | 实测 3.3 s（单位是秒，非毫秒） |
| **三步流程 `run --flow`** | **457 ms 跑完**：读页面 → 点击跳转 → 校验新页文本 |

三步流程的逐步耗时：`2 ms / 94 ms / 361 ms`。整个流程只调用一次 CLI。

## 真机上发现并修掉的问题

这些都是纸面设计看不出来、只有接真机才暴露的：

1. **`/json/list` 的 URL 会滞后**
   点击跳转后列表里仍是旧地址。只看元数据会选错页。
   → 连上后读 `location.href` 复核；`pages --live` 暴露 `urlStale`。

2. **一台机器上会有多个 debugger socket**
   空的 `webview_devtools_remote_<pid>` 也会响应 `/json/version`，
   盲取第一个会一直读到 0 个页面。
   → 逐个 socket 试，按「有没有页面 / 有没有命中 URL」打分。

3. **`expect` 把秒当毫秒用**
   `--timeout 5` 实际 365 ms 就返回失败（循环只跑一次）。
   → 统一为秒，并加了一条防止回归的测试（断言 1.2 s 真的等约 1.2 s）。

4. **`Page.navigate` 会开新标签**
   Chrome/Android 上导航后当前会话仍停在旧页，表现为 30 秒 `ExpectTimeout`。
   → 3 秒内 `location.href` 没变就报 `NavigateNewTab`，附「用 pages 看新页面」。

5. **串行探测 target 太慢**
   两个 target 时 `pages` 要 7.6 秒（后台标签页不响应）。
   → 改并行 + 短超时（open 2.5 s / eval 0.8 s），降到 72 ms。

6. **指定 `--url` 却找不到页面时不该静默降级到 device**
   否则会在「不知道当前是什么页」的情况下按坐标点。
   → `NoTarget` / `TargetAmbiguous` 直接上报，错误里列出真实 URL。

---

# 真机：Pixel 6 Pro（Android 16）

环境：同一台 Mac + Pixel 6 Pro，Chrome 147，微信 8.0.79。

## 结果

| 项 | 结果 |
|---|---|
| `preflight` | 全绿，`preferred: webview`，识别出 23 个页面 |
| `pages` | 85 ms |
| `pages --live` | 3.1 s / 23 个页面（并行探测） |
| `snapshot`（真实 H5：个人中心） | 3.2 s，正确读出「100 分 / 耗时 237 秒」 |
| `snapshot`（真实 H5：抽奖页） | 正确读出活动时间与中奖播报 |
| `snapshot`（device 通道） | 2.8 s，102 个无障碍节点 |
| **`act --op click` + 校验** | **成功**：点中 `Learn more` → 2271 ms 后新页出现 `Example Domains` |

## 真机上暴露的第 7、8 个问题

7. **后台标签页会被 Chrome 冻结**
   23 个标签里 19 个不响应 JS。原来的行为是 `Runtime.evaluate` 挂满 25 秒，
   然后被当成普通失败。现在探测阶段就会识别，报 `PageFrozen` 并提示「切到前台」，
   2 秒出结果。

8. **`pages --live` 串行探测太慢**
   23 个页面 × 3 秒 = 57 秒。改成并行后 3.1 秒。

附带的发现：

- 这台机器上还有 `stetho_com.google.android.apps.messaging_devtools_remote`
  （Google Messages 的调试 socket）。打分逻辑能正确跳过它们。
- `adb forward` 到一个**存在但没有响应**的 socket 会成功返回，
  连接却一直挂着。所以「端口通了」不等于「能用」，必须真的读一次页面。
- 这台真机的 Chrome 页面**会**暴露到无障碍树里（模拟器上不会），
  所以 device 通道在这里是可用的降级方案。

---

# 微信（XWeb）：真机跑通

前提：在微信里打开 `debugxweb.qq.com/?inspector=true` 点「确定」。
之后 `/proc/net/unix` 出现 `@webview_devtools_remote_<微信 pid>`。

| 项 | 结果 |
|---|---|
| `preflight` | `preferred: webview`，识别出 `webview_devtools_remote_<pid>` |
| `pages` | 1 个页面：目标 H5 的答题引导页 |
| `snapshot` | **90 ms**，读出完整规则正文 + 4 个可交互元素 |
| `expect`（轮询） | 10 ms 命中「开始答题」 |
| `act --op eval` | 返回 `{title, readyState, links:5, btn:true}` |
| **连续 10 次读 DOM** | **87 ms（8.7 ms/次）**，一次 CLI 调用 |

XWeb 内核 `XWEB/1500145`（Chromium 150），UA 带 `wv` 标记。

关键元素：`css:#ksdt` = 「开始答题」按钮，`document.readyState` 为 `complete`。

对比原项目：截图 + OCR + 视觉模型时每步 8–12 秒，10 题 6 分 24 秒。
现在单次读 DOM 是 8.7 毫秒 —— 剩下的时间全在等页面转场，不在感知。

---

# 端到端：完整答完 10 题并领奖

用户授权后，在微信里完整跑了一遍一个真实的 H5 答题活动（10 题 + 抽奖）。

## 结果

| 项 | 结果 |
|---|---|
| 完成度 | 10 题全部作答、交卷、抽奖、领取成功 |
| 页面计时 | **00:01:16**（1 分 16 秒） |
| 抽奖 | 中奖并领取成功 |
| 总命令数 | 约 30 次 CLI 调用（每题 1 次读 + 1～4 次点 + 1 次校验） |

其中一题（多选）漏选了一个选项：给出的匹配词和选项原文差一个字，没点中。
这是操作者的失误，不是工具。

## 这一轮暴露的第 9、10、11 个问题

9. **`text~:` 会点到外层容器**
   某个选项文本在 DOM 里有 7 个祖先元素都包含它，
   原来的 `includes` 取第一个命中，点到了最外层 `div`，页面毫无反应 ——
   这正是原项目「按钮怎么点都没反应」的同一个根因。
   现在优先选表单控件/链接，其次取**面积最小**的那个（最具体），并返回 `matches` 数量。

10. **有些 H5 只认 touch 事件**
    抽奖轮盘的 `.luck_btn` 是 `div`，绑的是 `touchstart/touchend`。
    `el.click()` 完全没有反应（点完「次数:1」纹丝不动）。
    现在 `act --op click` 在后置条件不成立时会自动补一次 touch 序列，并在结果里标 `retriedWithTouch: true`。

11. **无 class、无 cursor:pointer 的 div 按钮在快照里不可见**
    抽奖页原来 `elements: []` —— 整页一个可交互元素都看不到。
    现在元素少于 5 个时，会退一步扫描 `cursor:pointer` 或 class 命中 `/btn|button|tap|click|luck|draw/` 的元素。

顺带把 `ref` 的生成规则改了：**唯一的样式类优先**（`css:.luck_btn`），
原来一律生成 `#app > div > div:nth-of-type(1) > div` 这种路径，不可读也不稳定。

## 还没验证的

| 项 | 为什么 | 怎么补 |
|---|---|---|
| 微信里连续多天的稳定性 | 只跑了 1 次 | 明后天再跑一次看页面回收与答题次数限制 |
| 微信切后台后的页面回收 | 需要长时间挂机才能复现 | 观察 `NoTarget` 是否按预期报错 |
| Windows | 当前只有 macOS 环境 | 在 Windows 上跑 `preflight` + `smoke-device.json` |
| 中文输入（device 通道） | 设计上就不支持 | 走 webview 通道 `type` |
| 小程序 | 独立 devtools 体系 | 不在范围内 |

## 复现

```bash
node scripts/cli.mjs preflight
node scripts/cli.mjs run --flow assets/flows/smoke-device.json
node scripts/cli.mjs open --to https://example.com/
node scripts/cli.mjs snapshot --url example.com
```
