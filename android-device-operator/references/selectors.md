# 选择器、快照与流程格式

## 快照长什么样

```json
{
  "ok": true,
  "channel": "webview",
  "page": {
    "url": "https://example.com/form",
    "title": "信息登记",
    "text": "请填写以下信息 姓名 手机号 提交",
    "lines": ["请填写以下信息", "姓名", "手机号", "提交"],
    "signature": "a1b2c3d4e5f60718",
    "elements": [
      {
        "ref": "css:form > input:nth-of-type(1)",
        "role": "input",
        "text": "",
        "value": "",
        "id": "name",
        "box": { "x": 40, "y": 300, "w": 280, "h": 44 }
      }
    ]
  }
}
```

- `text` / `lines` 用来看「现在是什么页面」
- `elements[].ref` 用来点
- `signature` 是页面指纹：**同一页面在两条通道下算出同一个值**，可以用来判断「还在不在这一页」

## ref 的四种写法

| 前缀 | 例子 | 适用 |
|---|---|---|
| `css:` | `css:#submit` / `css:div.list > a:nth-of-type(2)` | 最稳，优先 |
| `text:` | `text:提交` | 文本唯一时最快 |
| `text~:` | `text~:提交` | 文本会变（带数字、带空格） |
| `ax:` | `ax:17` | device 通道，来自无障碍树序号 |

**没有前缀的字符串按 `text:` 处理**，所以 `--ref 提交` 等价于 `--ref 'text:提交'`。

## 挑 ref 的顺序

1. 有 `id` → 用 `css:#id`
2. 没 `id` 但文本唯一 → 用 `text:`
3. 都不行 → 用快照里给的完整 `css:` 路径（已经做过 `nth-of-type` 消歧）

反面教材（原项目踩过的）：

> 按文字找「下一题」，命中的是外层 `div.answer_btn_row`，点了毫无反应。
> 因为两层都有同样的文本，而 DOM 上有 `.answer_btn_row` 这一层包着真正的 `a#btn_nexttopic`。

**判据**：点完必须 `expect` 到页面变化。变化不了就换更精确的 ref，别重复点。

## 流程文件格式

```json
{
  "name": "登记表单",
  "target": { "urlPart": "example.com/form" },
  "defaultTimeout": 8,
  "steps": [
    {
      "name": "填姓名",
      "act": { "op": "type", "ref": "css:#name", "text": "张三" },
      "expect": { "value": "张三", "ref": "css:#name" }
    },
    {
      "name": "提交",
      "act": { "op": "click", "ref": "css:#submit" },
      "expect": { "text": "提交成功" },
      "timeout": 10,
      "retries": 1
    }
  ]
}
```

### 步骤字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `act` | 否 | 动作；省略表示「只等状态」 |
| `expect` | **是** | 后置条件，缺了加载期直接报 `FlowSchema` |
| `timeout` | 否 | 覆盖默认超时 |
| `retries` | 否 | 失败后整步重试次数（含重做 act） |
| `name` | 否 | 出现在结果里，方便定位 |

### 条件类型

| 写法 | 含义 |
|---|---|
| `{"text":"3/10"}` | 页面文本包含 |
| `{"textMatches":"\\d+/10"}` | 正则 |
| `{"urlMatches":"/success"}` | URL 正则 |
| `{"ref":"css:#done"}` | 元素存在 |
| `{"gone":"css:#loading"}` | 元素消失（注意键名是 `gone`） |
| `{"value":"张三","ref":"css:#name"}` | 输入框的值等于 |
| `{"kind":"js","value":"document.readyState==='complete'"}` | 仅 webview |

## 动作类型

| `op` | 参数 | 说明 |
|---|---|---|
| `click` | `ref` | |
| `type` | `ref` + `text` | webview 直接写 value；device 走 `input text`（仅 ASCII） |
| `navigate` | `url` | |
| `swipe` | `dx` / `dy`（webview）或 `xy`（device） | |
| `press` | `key` | 按键码，如 `4` 返回、`26` 电源 |
| `eval` | `js` | 仅 webview |

## 写 flow 的三条经验

1. **一步一验证**，不要把三个点击串在一步里 —— 失败时你不知道是哪一下没生效。
2. **先写能跑通的最短路径**，再补异常分支；不要一开始就写 20 步。
3. **把容易变的文本放进 expect**（页码、结果提示），把不变的放进 ref。
