# 依赖自动检测与安装

## 安装范围

七个技能家族，共十个子技能：

| 家族 | 子技能 |
|---|---|
| GBro | gbro-cover-design |
| Punk | punk-cover、punk-avatar |
| 归藏 | guizang-social-card-skill |
| 宝玉 | baoyu-cover-image、baoyu-image-gen、baoyu-xhs-images |
| 喜茶风 | heytea-doodle-poster（常见目录heytea-style） |
| 萌粒IP | ip-illustration-character-system（常见目录ip-illustration-for-yourself） |
| 一稿多发 | article2media |

只检测以上技能，不下载整个宝玉合集或与封面无关的其他几十个子技能。默认补齐缺失的清单项，实际生成时只调用选定路线；辅助技能不是默认增加的成品。一稿多发当前官方版本的入口还会调用抓取、转写、长图等其他同仓库子技能，清单会报告这层额外依赖；这十项安装完成不等于一稿多发整套功能已就绪，它也不在本包默认封面选项中。

这十项都已随包附带，不需要联网，也不需要管理员密钥：

| 包内形式 | 用途 |
|---|---|
| `vendor/<技能目录>/` | 仓库里可读、可校验的完整副本（含 SKILL.md、样式资源、许可证） |
| `vendor/cola-skills-bundle.zip` | 发布包内的同一份副本（外层包只允许一个根 SKILL.md，无法放十个嵌套技能目录） |
| `vendor/cola-skills-bundle.manifest.json` | 逐文件清单、体积与 sha256，用于核对包内副本 |

`scripts/build_vendor_bundle.py` 由 `vendor/<技能目录>/` 重新生成 bundle 与 manifest，产物可重复（固定条目时间戳，内容不变则 sha256 不变）。官方来源、固定 commit 与必要资源由 `dependencies.json` 指定。Skill Hub的slug与本机文件夹名可能不同，因此同时识别SKILL.md的name与安装别名；不凭文件夹字符串判定缺失。

## 启动命令

首次制作前离线装配（推荐先跑这个）：

```bash
python3 "$SKILL_ROOT/scripts/ensure_dependencies.py" --json
```

只读复核（不落盘、不联网，只读包内副本与已装目录）：

```bash
python3 "$SKILL_ROOT/scripts/ensure_dependencies.py" --check --json
```

其他本地Agent或自定义安装位置：

```bash
python3 "$SKILL_ROOT/scripts/ensure_dependencies.py" \
  --skills-dir /目标skills目录 \
  --search-dir /另一个已有skills目录 \
  --json
```

仅处理具体路线时：

```bash
python3 "$SKILL_ROOT/scripts/ensure_dependencies.py" --only punk-cover --json
```

查找顺序固定三层：`vendor/<技能目录>/` 真实副本 → 包内 `vendor/cola-skills-bundle.zip` → 原 GitHub 归档（仅兜底）。前两层都不联网，`network_downloads` 为 0。

`--check`不下载、不创建技能目录、不解压：它用 `zipfile` 读包内清单，核对必需文件、`SKILL.md` 的 name 与 Punk 的 styles 目录。安装模式才把单个技能解包到目标目录，并复用同一套路径穿越、符号链接与体积限制校验，最后原子改名落盘。运行时在标准skills目录内定位到本包则默认同级安装；开发目录运行则回退到 `COLA_SKILLS_DIR` 或 `~/.cola/skills`。不能因为开发目录存在就把其他依赖散落在项目根。

## 结果处理

读取JSON中每项的状态和真实路径：

- 已存在：复用，不联网更新。`message` 为 `Bundled with this skill; no network required.` 时表示用的是随包副本。
- 新安装：从包内副本解包并通过校验后，再读对应SKILL.md，按流程选择时使用。
- 缺失：随包副本与已装目录都没有时，检测模式用incomplete且exists=false记录；安装模式先试包内 bundle，都没有才按固定 commit 联网兜底。
- 明确关闭：不重新启用、不改关闭配置、不另名绕过；该路线暂不调用，按实际需求说明。
- 已存在但不完整：incomplete且exists=true，不覆盖。标明缺什么资源，继续其他路线；修复旧目录属于另一步，不能伪称自动安装成功。
- 装配/校验失败：保留成功项，只说明失败项；不能把总失败说成全部安装成功。

退出码不代替逐项状态；即使有一项失败，其余成功项仍可用。包内副本完整时全程不需要联网；随包副本缺失又无网络时仍可展示随包案例，但要确认所选路线可用。

## Punk资源补齐

官方技能位于仓库的skills子目录，视觉资源在仓库根的styles目录。只复制单一SKILL.md会丢失这套资源。新安装器把完整styles放到新技能目录内，并使相对引用与真实路径一致；只暴露所选META.md允许的封面/海报风格。

若旧技能目录已经有styles但仍使用仓库级相对引用，不改旧文件；依据检测结果和真实目录加载风格。没有风格资源则标为不完整，不能冒充可执行。

## 安全约束

- 安装模式从包内归档解压，同样先做路径与压缩包安全检查，再暂存、校验、创建新目录；联网兜底时才下载官方公开仓库归档。
- 拒绝目录越界、绝对路径或符号链接等不安全归档；限制归档及解压体积。
- 不执行下载的安装脚本，不读取或复制使用者自己的密码、头像、账号配置。
- 不覆盖任何已有技能或目录，不改明确禁用记录。网络中断不会留下伪装成成功的半成品技能。
- 自定义代理通过标准环境变量配置，不硬编码开发机器代理（正常装配路径不使用网络）。
- 包内第三方副本放在 `vendor/` 下，发布包用 bundle 归档承载，因此压缩包根仍只有一个 SKILL.md；解包到目标 skills 目录才出现十个技能目录。

## 图片服务与软件依赖

下载技能不等于具备生成服务：

- 图像型：检查当前Agent可调用的图像生成/编辑能力与引用素材能力；能用原生能力就不强迫配置另一家的密钥。
- 归藏等HTML排版型：检查浏览器渲染、所需Node.js及本地库，缺失时说明；不擅自改全局环境。
- 素材型：使用用户已确认的照片、截图或IP锚点，不把作者案例中的人物当成用户。
- 只有文件读写、没有图像或渲染能力：可完成需求确认与提示词包，明确不是成品。

## 验证范围

装配器的单元测试（含离线 bundle 路径）与干净目录实测记录见 `verification.md`。它们验证检测、离线装配与落盘，不代替所有风格在不同图像服务上的实跑，也不承诺案例风格100%复现。
