# 安卓真机操作 Skill

让具备 shell 能力的 AI Agent 用 ADB + WebView 调试协议直接操作一台安卓真机：读页面结构、点元素、填表单、跑可复现的多步流程。**不截图，不做图像识别。**

```
Mac / Windows ──adb forward──> WebView 调试 socket ──CDP──> 页面 DOM
                                                   └─ 失败则降到无障碍树 + 坐标
```

## 安装与使用

```sh
git clone --depth 1 https://github.com/marswaveai/cola-skills.git
cp -R cola-skills/android-device-operator ~/.agents/skills/
```

把目录放进 Agent 支持的技能目录即可（路径以宿主文档为准）。没有 Skill 加载机制时，可直接让 Agent 读 [SKILL.md](SKILL.md)。

前置只有一个：`adb`。

```sh
# macOS
brew install --cask android-platform-tools
# Windows：装 Android SDK Platform-Tools 并把 platform-tools 加进 PATH
```

## 第一次用

```sh
node scripts/cli.mjs preflight              # 缺什么、怎么补，一条命令说清
node scripts/cli.mjs run --flow assets/flows/smoke-device.json
node scripts/cli.mjs open --to https://example.com/
node scripts/cli.mjs snapshot --url example.com
```

`preflight` 会分别报告 adb、设备、解锁状态、调试 socket、可调试页面这五环，缺哪环就给哪环的修复命令。

## 为什么是它

| | 截图 + 视觉模型 | 本项目 |
|---|---|---|
| 感知 | 一张图 | DOM 全文 + 每个元素的选择器 |
| 点 | 坐标 | `el.click()`，走完整事件 |
| 单步 | 6–12 秒 | 30–300 毫秒 |
| 失败原因 | 「看错了」 | 错误码 + 具体元素 |
| 依赖 | 多模态模型 | 只要 adb + Node 22 |

## 设计约束

1. **动作必须带后置条件**：`expect` 缺了在加载期就报错，不给「点了就算成功」的机会
2. **多页面必须指定 `--url`**：命中多个直接报 `TargetAmbiguous`，绝不默默取第一个
3. **未知状态停下来**：报错带上现场（当前 URL + 文本），不猜
4. **零运行时依赖**：WebSocket 自己实现，只用 `node:http` + `node:crypto`

## 边界

- 只覆盖 macOS / Windows 桌面端
- 不覆盖 iOS、微信小程序
- 中文输入：webview 通道可以，device 通道不行（`input text` 只吃 ASCII）
- 调试开关可能随 App 版本失效，这是通道本身的属性
- 不含任何具体业务逻辑（题库、活动规则、账号数据）

## 结构

```
scripts/cli.mjs           唯一入口
scripts/lib/ws.mjs        最小 WebSocket（刻意不发 Origin，绕开 CDP 403）
scripts/lib/cdp.mjs       targets / 唯一性断言 / Runtime.evaluate
scripts/lib/adb.mjs       adb 原语 + 无障碍树解析
scripts/lib/channel.mjs   双通道统一接口 + 自动降级
scripts/lib/page.mjs      快照 / 指纹 / 条件判定
scripts/lib/flow.mjs      多步流程执行器
references/               通道边界、微信、选择器、错误码、骨架
tests/                    26 个测试（含假 CDP 服务器，不需要真机）
```

## 验证

```sh
node --test "tests/*.test.mjs"
```

真机实测数据（模拟器 + Pixel 6 Pro）见 [docs/verification-2026-10-29.md](docs/verification-2026-10-29.md)。

## 许可

MIT
