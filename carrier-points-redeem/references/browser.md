# Cola 浏览器适配

仅在调用参数不清、能力报错或电信需要移动环境时读本文件。新任务默认未登录，直接打开登录直达 URL；不先检查登录态、UA 或日期。

**Cola 调用桥**：`browser` 是延迟加载工具，带使用守则，未经发现直接调用会被退回一次。先 `tool_search`（query `select:browser`），之后用 `tool_call`，`name` 为 `browser`、`arguments` 为下文 JSON。发现只需一次，本对话后续直接 `tool_call`。浏览器工具说明里建议放到子会话执行，本技能不这样做：登录与验证需要在本对话交接，开子会话只会更慢。

## 使用已启用的接口

遵循用户/宿主已有浏览器约定。若已指定 Ego，先读其已安装技能，复用本任务 TaskSpace、实际 spaceId 和页面标签；失败不自动切到 Cola 内置浏览器，不启用 legacy chrome_devtools。

Cola 已启用内置 `browser` 且无覆盖约定：

- 使用 `profile="cola"`；新业务在自己的页直接打开登录 URL，已有任务用原 `targetId`，每次显式带 profile/targetId。不默认使用 `user` profile 或接管用户标签。同笔验证、回跳与对账复用该页；不以旧会话作为新任务的起步条件，也不清 Cookie 或强制退出已有账户。
- `open` 会新建页，仅本任务无页时调用一次，立即保存返回的 `targetId`；已有页直接接续。首页、空白、超时均不重复 open，也不为同一次登录创建第二个 TaskSpace/Page。open 超时但可能已建页时先恢复本任务 targetId，不能盲目再开；tabs 列表不能证明页面所有权。
- 原页面丢失且已有提交尝试时，新建页只能去官方入口查原订单，不再下单。登录和验证在原页交接，等本人确认；无法展示该页供本人操作时报告交接限制，不调用 focus 抢占窗口。
- 需要用户继续查看时保留订单/成功页，结束时只清理自己的无关页。Ego 按其技能结束/交接 TaskSpace。

以下为 `browser` 参数示例；targetId 和 ref 用本次真实返回值。

仅本任务尚无页面时打开登录入口（URL 保留完整 hash/query）：

```json
{"action":"open","profile":"cola","targetUrl":"https://jf.10086.cn/#/loginPage?back=true"}
```

返回不代表登录页已就绪。移动若实际落到首页，用同一 targetId 快照并点击“登录”或“请登录”；等手机号、验证码输入框和登录按钮均可见才交接。不得用第二次 open 修复首页或慢加载。

一次快照读取业务字段和可操作 refs；`limit` 太小可能截断规则，缺什么再定向补读：

```json
{"action":"snapshot","profile":"cola","targetId":"本次返回的targetId","snapshotFormat":"ai","limit":100}
```

使用本次快照 ref 进行普通导航；DOM 或页面身份变化后重新取 refs。不要猜 selector，不批量连点：

```json
{"action":"act","profile":"cola","targetId":"本次返回的targetId","kind":"click","ref":"e1"}
```

已知需要等待的业务信号时，可用 `act/wait`，例如 `text="可用积分"`、`timeoutMs=8000`；这个文字出现不证明余额/面额已加载，仍要核对字段。不用固定 timeMs 或 networkidle 代替业务就绪。`act/evaluate` 需 fn 是函数源码字符串，详情见 [页面摘要](observe.md)。

`batch` 的数组在 `request.actions` 中，每项仍是 act 动作，不能塞 open/navigate/snapshot。仅当后续动作不需中间决策时合并；等待+只读摘要可合并，下单、扣分、短信请求逐步执行。整个批次包含开销应控制在工具约 20 秒的请求超时内。

## 能力失败

- `evaluate` 或函数条件等待被禁：不改配置，业务页退一次快照；验证页若快照不能排除输入值，就由本人确认非敏感状态，不采集整页输入。
- 页面字段不足：只补缺项；截图用于布局/图文规则，不凭模糊数字判断扣分或现金。
- 无浏览器工具或无法后台执行：明确缺少什么，提供官方入口和人工步骤，不安装工具、不切前台浏览器。本人完成后只读核对结果。
- 不复制浏览器配置、不导出 Cookie，不请求网页隐藏接口；已明确的工具错误不原样反复重试。

## 电信移动环境

2026-10-24 核对 Cola `fe8bb5d1b`：内置 `browser` 支持 resize、evaluate、wait 和 batch，未暴露 UA/设备模拟，所以入口默认把电信话费交给本人手机办理。以目标会话实际工具定义为准，不扫描源码或尝试不存在的 action。

**这些限制不能拦截打开登录页。** 电信直达登录表单已在桌面 UA 验证可见，先打开并交接；本人登录后、准备兑换前才检查移动环境。`resize` 或修改 navigator 不能代替真实请求 UA。缺少该能力时停在下单前，由本人手机完成后续兑换；不私连控制端口或改全局 UA。

若目标已提供设备模拟接口，登录后使用其真实参数设置手机 UA 和 390×844 移动视口，再导航或重新加载话费专区，保留本次会话。务必在点“兑换”建单前完成；新弹页确认配置是否继承。

已指定且可用的 Ego 支持页面级 CDP 时，在已归属本任务的 page 上执行：

```js
await page.cdp("Emulation.setUserAgentOverride", {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  acceptLanguage: "zh-CN,zh;q=0.9", platform: "iPhone",
});
await page.cdp("Emulation.setDeviceMetricsOverride", {
  width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
});
```

这不是 Cola `browser` 的调用参数；不要把 page.cdp 填入 browser/evaluate。设备就绪后继续电信兑换；登录始终优先，已建单后的回跳先查原订单。
