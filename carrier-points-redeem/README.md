# 三网积分兑换 · Cola 预装版

将三个运营商流程收进一个 `carrier-points-redeem` 入口，作为 Cola 新手引导的第一个来财任务（`onboarding` 活动）运行，目标是最少轮次办完。

| 运营商 | Cola 中的做法 |
|---|---|
| 移动 | Cola 浏览器打开登录页 → 本人登录 → 选面额 → 本人短信确认 → 核对结果；现有 AI 豆兑本机话费，现金 0 |
| 联通 | 直接输出 10010 短信领取方式，不开浏览器、不要手机号；用户要流量/语音/影音才走积分商城 |
| 电信 | Cola 浏览器无法模拟手机 UA，直接给手机办理入口和步骤，不开浏览器 |

## 为速度做的取舍

- 移动办理流程、联通短信领取文字（原 `phonefee-text.md` 并入入口）和电信手机入口都写在 `SKILL.md` 里，正常路径**不读任何其他文件**。
- 不要手机号：号码由本人在官网登录时填写，登录后读页面脱敏号码核对。认不出运营商时只问一句运营商。
- `browser` 在 Cola 中是延迟加载工具：入口写明先 `tool_search select:browser` 再 `tool_call`，避免被发现门拦回一轮；不开子会话、不先 status/start/tabs。
- 不写断点文件、不跑状态脚本；本对话就是这笔交易的记录，恢复时用对话里的 `targetId` 只读核对。
- 登录交接时顺带请用户报面额，省掉一轮；已给面额不再确认。
- 安全底线不放宽：只兑本机、现金 0、验证码只由本人在官网填、按钮只点一次、结果不明不重提。

## 浏览器能力边界

- 使用 Cola 内置 `browser`、`profile="cola"`（有界面的独立 Chrome 窗口，用户在里面登录和填验证码）。
- 不抢前台、不导出 Cookie、不复制浏览器配置；登录与验证原页交接，等待本人确认。
- 电信移动 UA 能力的细节见 [浏览器适配](references/browser.md#电信移动环境)；Cola 暴露设备模拟后可以改回浏览器办理。

## 阅读路径

| 本次业务 | 读取 |
|---|---|
| 移动 / 联通话费 / 电信 | 只有 `SKILL.md`（已内联） |
| 联通商城流量、语音、影音 | 联通 GUIDE；选品再加类别规则 |
| 电信在电脑上查余额 | 电信 GUIDE |
| 异常或复杂恢复 | 对应 GUIDE、browser-flow、`references/browser.md` / `observe.md` |

## 使用

```text
帮我领取这个福利：三网积分兑话费（新手引导卡片发出的任务）
移动，兑 10 元话费
联通话费怎么换
电信积分能换话费吗
继续刚才那笔，验证填好了
```

先使用当前任务已有信息；只在认不出运营商时问一句，不要手机号。用途不明先查，不能自行扣分。广电或虚拟运营商不硬路由，也不按号段猜实际运营商。

只办本机、现金 0、无自动续订。已指定面额或商品不重复选；实际成本或条件变化时说明。状态不明先查原订单，不重复下单。报告区分提交、平台完成、用户确认到账及独立权益记录。

## 目录

```text
SKILL.md                   唯一运行入口
references/browser.md      Cola 接口、能力失败及电信移动环境（按需）
references/observe.md      安全摘要调用及字段解释（按需）
scripts/observe.js         可复用的只读函数
skills/*/GUIDE.md          三家流程，按分支读取
skills/*/references/      类别规则、异常恢复和可选状态脚本说明
agents/openai.yaml         支持该格式的宿主展示信息
install.sh / uninstall.sh  维护者安装工具
tests/                    离线校验与摘要测试
```

子流程使用 GUIDE.md，避免被发现为三个额外技能。README、来源记录、测试和安装脚本只供维护，运行时不读。

## 其他安装方式

保留原有兼容入口；这些是维护者操作，不是预装 skill 的运行步骤：

```sh
./install.sh --target cola       # 用户技能 ~/.cola/skills
./install.sh --target codex
./install.sh --target claude
./install.sh --target ~/my-skills
```

不传目标时沿用原安装器的 Codex / Cola / Claude 检测与静默安装；无匹配时回落到 Codex。其他数据目录请传实际 skills 目录，不把 `--target cola` 当作所有地区/配置的路径解析器。

独立安装的三家技能默认保留；需要归档时显式加 `--archive-standalone`，旧目录移到同级归档目录，恢复时先卸载入口再移回。卸载用 `./uninstall.sh --target 实际skills目录`。

手动安装（含 Windows）：将本技能目录完整复制到宿主实际 skills 目录下的 `carrier-points-redeem/`，保留 references、scripts、skills、agents 和根 SKILL.md，不复制 .git。Windows 使用 Git Bash 时也可运行安装脚本；本机预装目录由目标项目决定。

## 验证

```sh
bash tests/test_install.sh
python3 -m unittest discover -s tests -p 'test_skill_contract.py' -v
node --test tests/test_observe.cjs
```

离线检查覆盖安装/重复安装/卸载、唯一技能发现、引用有效性、阅读字符预算、文档号码脱敏，以及摘要对零余额、敏感输入、网址参数、长度限制的处理。Python 检查也运行两份未改动的状态脚本测试。测试需要 Python 3、Node 和 Bash；这些不成为普通兑换流程的安装要求。

静态检查包含入口的 Cola 快速路径（移动登录直达、联通短信文字原文、电信手机入口、`tool_search select:browser`、`laicai_task_done`）及三家 GUIDE 的登录直达路由与回跳参数。网页验收关注：移动新任务一次 open 即见登录表单、一次登录交接、联通与电信不开浏览器、超时恢复不重提、流程结束调用 `laicai_task_done`。真实兑换另需本人授权；文档阅读量不代表实测网页耗时。

## 来源

上游提交、许可及本地修改见 [THIRD_PARTY.md](THIRD_PARTY.md)。整合层和新增摘要函数采用本仓库 MIT License，子流程沿用各自许可状态。
