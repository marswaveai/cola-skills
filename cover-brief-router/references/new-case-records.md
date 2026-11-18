# 三张新制封面记录｜2026-11-18

用户明确授权：归藏、宝玉、萌粒IP三家各补一张完整封面，并更新案例库。本次统一独立示例标题「把周末还给自己」，不使用用户此前的视频主题。仅三张成品入库，均1080×1440、3:4。

## 10｜归藏摄影杂志

- 依据：guizang-social-card-skill 的 SKILL.md、style-system.md 与 layout-recipes.md 中 Editorial Magazine × E-ink / M16。
- 制作方式：按照视觉规范生成完整摄影杂志样张；没有调用原生HTML/CSS种子模板渲染。因此只能作为风格参考，不列为归藏原生工作流跑通证据。
- 图片：`assets/style-samples/10-摄影杂志-归藏新制样张.webp`。
- 完整提示词：`assets/sample-prompts/10-归藏.md`。
- 检查：七字标题准确，无额外文字/水印，摄影主视觉＋宋体标题完整，标题不压住书、杯和椅，无清单/PPT内页。

## 11｜宝玉暖色绘画隐喻

- 依据：baoyu-cover-image 的提示词模板、metaphor类型、warm调色板与painterly渲染规则。
- 组合：metaphor × warm × painterly × title-only × balanced，手写标题。
- 图片：`assets/style-samples/11-暖色绘画-宝玉新制样张.webp`。
- 完整提示词：`assets/sample-prompts/11-宝玉.md`。
- 检查：七字标题准确，大书页化成阅读小岛，暖色绘画笔触，无多余文字、遮挡或裁切。它是社媒封面，不是出版书封面，不需要补作者名/出版社标志。

## 12｜萌粒角色阅读

- 依据：ip-illustration-character-system 的 core-style-and-identity.md、article-illustrations.md、infographics.md；按本次单张封面要求改编，不使用默认5张插画/角色锚点/三视图产出数量。
- 角色：本次原创文字身份锁——栗棕短圆发、三个小刘海、点眼、湖蓝上衣、白短裤、黄鞋、小豆子比例；不代表用户，不复制作者参考角色。
- 初版黑线与填色过于平滑，未入库。修正版加入作者指定的两张笔法参考，只借鉴线条/比例，不借身份或配色。
- 风格参考：
  - https://raw.githubusercontent.com/EverettFish/ip_illustration_for_yourself/main/references/style/style_ref_01_user_docs_reader.png
  - https://raw.githubusercontent.com/EverettFish/ip_illustration_for_yourself/main/references/style/style_ref_02_user_searcher.png
- 图片：`assets/style-samples/12-角色阅读-萌粒IP新制样张.webp`。
- 完整提示词：`assets/sample-prompts/12-萌粒IP.md`。
- 检查：七字标题准确，人物穿搭和阅读动作符合设定，黑线有手绘起伏，领口与书页边缘有细微露白，手脚未裁切，无多余文字/水印。
- 验证边界：只做单张原创角色封面，没有额外生成并确认独立锚点，不能据此声称跨图角色一致性已验证。

## 尺寸处理

生成原图均1792×2400；缩放导出1080×1440入库版。原图比例与3:4略有偏差，导出时约0.45%的比例修正，没有裁掉标题或重绘文字。原图与初版留在项目工作区；案例库只放三张最终版。

## 项目制作记录

对应项目制作目录：`案例补齐-20261118/新制封面/`，三家各有提示词和图像文件。以上路径均以技能根目录为基准，项目制作目录不作为技能执行依赖。
