#!/usr/bin/env python3
"""Pack vendor/<folder> into vendor/cola-skills-bundle.zip + manifest, deterministically.

The Skill Hub package layout must contain exactly one root SKILL.md, so the ten
bundled dependency skills cannot ship as loose vendor/<folder> directories.
This script turns them into a single offline archive that
scripts/ensure_dependencies.py installs from without any network access.

Usage:
    python3 scripts/build_vendor_bundle.py [--check]
    python3 scripts/build_vendor_bundle.py --output-dir ../staging
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor"
BUNDLE_NAME = "cola-skills-bundle.zip"
MANIFEST_NAME = "cola-skills-bundle.manifest.json"
PREFIX = "deps"
BUNDLE_ROOT = "cola-skills-bundle"
EXCLUDED = {".git", "__pycache__", "__MACOSX", ".DS_Store", ".pytest_cache", "node_modules"}
FIXED_TIME = (2026, 11, 18, 0, 0, 0)


def shipped_files(folder):
    vendor = folder.parent
    for path in sorted(folder.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(vendor)
        if any(part in EXCLUDED for part in relative.parts) or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise SystemExit("Symlink cannot be bundled: " + str(relative))
        yield relative


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vendor-dir", type=Path, default=VENDOR,
                        help="Source vendor/ tree holding the ten skill folders (default: vendor/)")
    parser.add_argument("--output-dir", type=Path, default=None,
                        help="Where to write the archive and manifest (default: same as --vendor-dir)")
    parser.add_argument("--check", action="store_true", help="Only verify the existing bundle is current")
    args = parser.parse_args()
    vendor = args.vendor_dir.resolve()
    args.output_dir = (args.output_dir or vendor).resolve()
    folders = sorted(p for p in vendor.iterdir() if p.is_dir() and p.name != "__pycache__") \
        if vendor.is_dir() else []
    if not folders and not args.check:
        raise SystemExit("No vendor/<folder> directories found under " + str(vendor))
    entries = []
    for folder in folders:
        for relative in shipped_files(folder):
            entries.append((relative, (vendor / relative).read_bytes()))
    if not entries and not args.check:
        raise SystemExit("Vendor payload is empty")

    manifest = {
        "schema_version": 1,
        "generated": "2026-11-18",
        "layout": "{}/{}/<folder>/...".format(BUNDLE_ROOT, PREFIX),
        "folders": [folder.name for folder in folders],
        "file_count": len(entries),
        "size_bytes": sum(len(data) for _, data in entries),
        "files": [{"path": "{}/{}/{}".format(BUNDLE_ROOT, PREFIX, rel.as_posix()),
                   "size": len(data),
                   "sha256": hashlib.sha256(data).hexdigest()} for rel, data in entries],
    }
    archive_path = args.output_dir / BUNDLE_NAME

    if args.check:
        if not archive_path.is_file():
            raise SystemExit("Bundle missing: " + str(archive_path))
        with zipfile.ZipFile(archive_path) as archive:
            names = sorted(n for n in archive.namelist() if not n.endswith("/"))
        if folders:
            expected = sorted("{}/{}/{}".format(BUNDLE_ROOT, PREFIX, rel.as_posix()) for rel, _ in entries)
            if names != expected:
                raise SystemExit("Bundle file list is stale; rebuild it")
        else:
            # A published package ships the archive without the vendor tree:
            # validate it against its own manifest instead.
            manifest_path = args.output_dir / MANIFEST_NAME
            if not manifest_path.is_file():
                raise SystemExit("Bundle manifest missing: " + str(manifest_path))
            recorded = json.loads(manifest_path.read_text(encoding="utf-8"))
            expected = sorted(item["path"] for item in recorded["files"])
            digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
            if names != expected:
                raise SystemExit("Bundle does not match its manifest file list")
            if digest != recorded.get("bundle_sha256"):
                raise SystemExit("Bundle sha256 does not match its manifest")
        print(json.dumps({"bundle": str(archive_path), "current": True, "file_count": len(names),
                          "folders": len(folders)}, ensure_ascii=False, indent=2))
        return

    args.output_dir.mkdir(parents=True, exist_ok=True)
    temporary = archive_path.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, data in entries:
            info = zipfile.ZipInfo("{}/{}/{}".format(BUNDLE_ROOT, PREFIX, relative.as_posix()),
                                   date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    temporary.replace(archive_path)

    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    manifest["bundle"] = BUNDLE_NAME
    manifest["bundle_size_bytes"] = archive_path.stat().st_size
    manifest["bundle_sha256"] = digest
    (args.output_dir / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Bundle failed its CRC check")
    print(json.dumps({"bundle": str(archive_path), "folders": len(folders),
                      "files": len(entries), "size_bytes": archive_path.stat().st_size,
                      "sha256": digest, "manifest": str(args.output_dir / MANIFEST_NAME)},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
