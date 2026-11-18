#!/usr/bin/env bash
set -euo pipefail

# Project-owned acceptance wrapper for the agent-harness verifier.
# The verifier is only allowed to run this wrapper, not arbitrary commands.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:---check}"

# Locate the published package layout (vendor/ holds only the bundle archive,
# which is exactly what users receive).
published_dir() {
  local candidate
  for candidate in \
    "${COVER_PUBLISHED_DIR:-}" \
    "/Users/tangguorong/Project/cover-bundle-build/staging/cover-brief-router" \
    "$ROOT/../staging/cover-brief-router"
  do
    if [ -n "$candidate" ] && [ -d "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "error: published package directory not found (set COVER_PUBLISHED_DIR)" >&2
  return 1
}

run_published() {
  local staging out status
  staging="$(published_dir)" || exit 1
  staging="$(cd "$staging" && pwd)"

  # Assert the published layout: exactly one top-level SKILL.md and a vendor/
  # directory with no unpacked skill folders (zip + manifest only).
  python3 -B - "$staging" <<'PY'
import os, sys
from pathlib import Path

root = Path(sys.argv[1])
skill_files = sorted(p for p in root.iterdir() if p.name == "SKILL.md")
if len(skill_files) != 1:
    sys.exit("error: published layout: expected exactly 1 top-level SKILL.md, found {}".format(len(skill_files)))
vendor = root / "vendor"
if not vendor.is_dir():
    sys.exit("error: published layout: vendor/ directory is missing")
dirs = sorted(p.name for p in vendor.iterdir() if p.is_dir())
if dirs:
    sys.exit("error: published layout: vendor/ must not contain directories, found: " + ", ".join(dirs))
if not (vendor / "cola-skills-bundle.zip").is_file():
    sys.exit("error: published layout: vendor/cola-skills-bundle.zip is missing")
PY

  echo "published package: $staging"

  rm -rf /tmp/_verify_published

  set +e
  out_file="$(mktemp "${TMPDIR:-/tmp}/cover-published-report.XXXXXX")"
  env \
    -u http_proxy -u https_proxy -u all_proxy \
    -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    python3 -B "$staging/scripts/ensure_dependencies.py" \
      --skills-dir /tmp/_verify_published --json >"$out_file" 2>&1
  status=$?
  set -e

  # Assert install results and the on-disk layout, printing failure items.
  python3 -B - "$out_file" "$status" <<'PY'
import json, sys
from pathlib import Path

out_file = Path(sys.argv[1])
status = int(sys.argv[2])
raw = out_file.read_text(encoding="utf-8", errors="replace")
out_file.unlink()
try:
    report = json.loads(raw)
except ValueError:
    sys.stderr.write(raw if raw.endswith("\n") else raw + "\n")
    sys.exit("error: ensure_dependencies output is not valid JSON (exit {})".format(status))

counts = report.get("counts") or {}
failures = [d for d in report.get("dependencies", []) if d.get("status") not in ("installed",)]
problems = []
if status != 0:
    problems.append("ensure_dependencies exit {}".format(status))
if counts.get("installed") != 10:
    problems.append("counts.installed={} (expected 10)".format(counts.get("installed")))
if report.get("network_downloads") != 0:
    problems.append("network_downloads={} (expected 0)".format(report.get("network_downloads")))
if report.get("ok") is not True:
    problems.append("ok={} (expected true)".format(report.get("ok")))

print("counts: " + json.dumps(counts, ensure_ascii=False))
print("network_downloads: {}".format(report.get("network_downloads")))
print("ok: {}".format(json.dumps(report.get("ok"))))

if problems or failures:
    for item in failures:
        print("FAILED: {id} [{status}] {path}: {message}".format(
            id=item.get("id"), status=item.get("status"), path=item.get("path"),
            message=item.get("message") or "; ".join(item.get("missing_resources") or [])))
    for problem in problems:
        print("FAILED: " + problem)
    sys.exit(1)
PY

  # The installed tree must expose all ten skills with non-empty SKILL.md.
  python3 -B - "$staging" <<'PY'
import json, sys
from pathlib import Path

manifest = json.loads((Path(sys.argv[1]) / "references" / "dependencies.json").read_text(encoding="utf-8"))
missing = []
for dep in manifest["dependencies"]:
    path = Path("/tmp/_verify_published") / dep["folder"] / "SKILL.md"
    if not path.is_file() or path.stat().st_size == 0:
        missing.append(str(path))
if missing:
    for path in missing:
        print("FAILED: missing or empty " + path)
    sys.exit(1)
print("installed skills verified: {} SKILL.md files".format(len(manifest["dependencies"])))
PY
}

case "$MODE" in
  --check)
    exec python3 -B scripts/ensure_dependencies.py --check --json
    ;;
  --published|--isolated)
    # --isolated is a legacy alias: it used to run against the repository tree,
    # where vendor/<folder> short-circuited the bundle install path. Always
    # exercise the published package layout instead.
    run_published
    ;;
  *)
    echo "usage: bash scripts/verify.sh [--check|--published]" >&2
    exit 2
    ;;
esac
