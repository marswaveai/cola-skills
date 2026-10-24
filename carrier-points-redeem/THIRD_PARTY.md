# 上游项目与许可证

本仓库将以下三个公开 Skill 作为子流程收录，由统一入口处理分流、账户核对、浏览器约定及恢复。业务范围不扩大：现金 0、只兑本机、状态不明不重提、验证由本人完成。

## 本地修改说明

| 文件 | 本地调整 |
|---|---|
| 三家 GUIDE.md | 压缩重复通用说明，沿用入口共同规则；已明确用途/面额不重新选，未授权不扣分；保留各家积分适用、选品、验证、证据及验收边界 |
| 联通 GUIDE / browser-flow | 已知用途或商品直接筛选；文字话费可绕过商城；页面身份、弹页和恢复只按需补读 |
| 电信 GUIDE / phonefee / browser-flow | 直接打开完整 SSO 登录链接，区分 appCode=CALLS 与 channelCode=HGOKHD；移动 UA 与日期在登录后检查，能力缺口只阻止下单；不以链接过期为由重建订单；现金条件与额外 PC 登录按需核对 |
| 移动 GUIDE | 指定金额直接输入；自定义最小额按当前页面；验证接回后先查结果 |
| SKILL.md / references / scripts/observe.js | 面向 Cola 新手引导：入口内联移动话费快速流程、联通短信领取文字（原 `phonefee-text.md` 并入入口）与电信手机入口；不收手机号、不写断点文件；Cola `browser` 延迟加载调用方式、`laicai_task_done` 收尾、按需只读摘要和号码脱敏 |

子流程原有的两份 `scripts/transaction_state.py` 及其测试未修改。它们只保护同一记录，不提供网站级恰好一次保证；正常执行不运行它们。子流程文件改名为 GUIDE.md，避免作为额外独立技能发现；业务规则仍以当前官网为准。上游更新时需对照上述整合改动，不能直接覆盖 GUIDE。

## cmcc-points-redeem（中国移动）

- 仓库：https://github.com/huntingrin/cmcc-points-redeem
- 收录提交：`ae0e29b2d8801611565d2c9df2a7218eb9aa50d1`
- 许可证：MIT，见 `skills/cmcc-points-redeem/LICENSE`
- 保留内容：上游 SKILL.md（收录为 GUIDE.md）、README.md、LICENSE

## cucc-points-redeem（中国联通）

- 仓库：https://github.com/huntingrin/cucc-points-redeem
- 收录提交：`cc30fd46be01b99e015eae050efb77df0df216e7`
- 许可证：上游仓库未提供 LICENSE 文件，未声明许可证
- 保留内容：上游 SKILL.md（收录为 GUIDE.md）、README.md、agents、references、scripts、tests

## ct-points-redeem（中国电信）

- 仓库：https://github.com/huntingrin/ct-points-redeem
- 收录提交：`479b82e65936ba384cce9475067680a435da9c91`
- 许可证：上游仓库未提供 LICENSE 文件，未声明许可证
- 保留内容：上游 SKILL.md（收录为 GUIDE.md）、README.md、agents、references、scripts、tests

## 说明

- 未声明许可证的仓库，默认保留原作者全部权利。本仓库仅用于本地整合与个人使用；对外再分发、商用或打包发布前，请先向原作者确认授权。
- 三个子流程均为第三方社区项目，不是中国移动、中国联通或中国电信的官方产品。
- 积分规则、商品、面额、资格和到账时间以各运营商官方页面及客服答复为准。
