# 现成骨架

## 1. 只读：把页面内容取回来

不需要点击时，`snapshot` 一次就够。

```bash
node "$SKILL/scripts/cli.mjs" snapshot --url <片段> --pretty
```

然后从 `page.lines` 里读。**不要截图**——截图还得再上一次视觉模型，慢而且会漏字。

## 2. 单次交互：点一下并确认

```bash
node "$SKILL/scripts/cli.mjs" act --op click --ref 'css:#agree' --expect-text '下一步'
```

`--expect-text` 是必须项，不是可选项。没有它，`act` 只能告诉你「事件投递了」。

## 3. 填表

```bash
node "$SKILL/scripts/cli.mjs" act --op type --ref 'css:#name'  --text '张三'
node "$SKILL/scripts/cli.mjs" act --op type --ref 'css:#phone' --text '13800000000'
node "$SKILL/scripts/cli.mjs" act --op click --ref 'css:#submit' --expect-text '提交成功'
```

三条命令三次往返。**如果能连成 flow 就连**，见下。

## 4. 多步流程（推荐）

```bash
node "$SKILL/scripts/cli.mjs" run --flow ./my-flow.json
```

一次调用跑完，返回每步耗时和失败点。

最小可用 flow：

```json
{
  "name": "领取",
  "target": { "urlPart": "example.com/activity" },
  "steps": [
    { "act": { "op": "click", "ref": "css:#start" }, "expect": { "text": "开始" } },
    { "act": { "op": "click", "ref": "css:#confirm" }, "expect": { "text": "已领取" } }
  ]
}
```

## 5. 分页 / 列表遍历

```json
{
  "name": "逐页采集",
  "steps": [
    { "expect": { "text": "第 1 页" } },
    { "act": { "op": "swipe", "dy": 900 }, "expect": { "text": "第 2 页" } }
  ]
}
```

每页保存 `snapshot` 的结果，最后一次性整理。
**不要在遍历里截图**——那是把最贵的通道用在最不需要精度的地方。

## 6. 需要登录的场景

登录永远交给人。

```
1. preflight → 发现未登录
2. 明确告诉用户：请在这台手机上完成登录，完成后回复「好了」
3. 用户确认后再继续
```

不要尝试自动化短信验证码、扫码、人脸。也不要让用户把验证码发到对话里。

## 7. 调试一个不熟的页面

```bash
# 1. 看有哪些页面
node "$SKILL/scripts/cli.mjs" pages

# 2. 看结构
node "$SKILL/scripts/cli.mjs" snapshot --url <片段> --pretty --full

# 3. 试一个动作 + 后置条件
node "$SKILL/scripts/cli.mjs" act --op click --ref 'text:下一步' --expect-text '2/'

# 4. 稳定后写成 flow
```

## 8. 判断「到底走哪条通道」

```bash
node "$SKILL/scripts/cli.mjs" channel
```

- `preferred: webview` → 直接用，别降级
- `preferred: device` → 能跑但会慢 5 倍，考虑先修调试开关
- `preferred: null` → 什么都没通，先 `preflight`

## 一个反模式

```
❌ snapshot → 让模型读 → 点 → snapshot → 让模型读 → 点 ...
```

每一步都回到模型，等于把脚本退化成人工。正确做法是把稳定的部分写成 flow，
模型只在「第一次探索」和「流程失败后判断怎么修」这两个时刻出现。
