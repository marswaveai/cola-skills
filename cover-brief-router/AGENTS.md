# cover-brief-router — Agent Guide

## 验收

依赖检查统一走项目 wrapper：

```bash
bash scripts/verify.sh --check      # 离线检查
bash scripts/verify.sh --published  # 发布包布局验收（必须跑）
```

`--published` 在 staging 发布包目录（`vendor/` 只有 `cola-skills-bundle.zip` + manifest，没有 `vendor/<folder>`）里安装到 `/tmp/_verify_published`，断言 `installed=10`、`network_downloads=0`、`ok=true`，并检查 10 个 `SKILL.md` 非空。这才是用户实际走的解包路径；仓库树里的 `--check` 会命中 `vendor/<folder>`，验证不到 bundle 解包。`--isolated` 保留为 `--published` 的别名。

发布包目录按以下顺序定位：`$COVER_PUBLISHED_DIR`、默认绝对路径、`$ROOT/../staging/cover-brief-router`。

不要直接调用：

```bash
python3 scripts/ensure_dependencies.py ...
```

orchestrator / verifier 的 shell 权限只放行 `scripts/verify.sh`。需要新增验收命令时，改 wrapper，不要改全局权限。

## 规则

- `scripts/verify.sh` 是验收契约；改动要单独 review。
- 不要为了通过检查去改 `--check` 的语义。
- 验收输出保留 `ok` 字段和失败项。
