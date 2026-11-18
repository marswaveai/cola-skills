#!/usr/bin/env python3
"""Build a single-SKILL.md distributable ZIP, without local test/private assets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED = {'.git', '__pycache__', '__MACOSX', 'cases', 'local-tests', 'node_modules', '.pytest_cache'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Refusing to overwrite an existing archive; select a new output path.')
    files = sorted(p for p in ROOT.rglob('*') if p.is_file() and not any(x in EXCLUDED for x in p.relative_to(ROOT).parts) and p.name not in {'.DS_Store', '.cola-skill.json'} and p.suffix != '.pyc')
    paths = [p.relative_to(ROOT).as_posix() for p in files]
    assert [n for n in paths if n.endswith('SKILL.md')] == ['SKILL.md'], 'Expected exactly one SKILL.md at ZIP root'
    text = (ROOT / 'SKILL.md').read_text()
    assert text.startswith('---\n') and re.search(r'^name: cover-brief-router$', text, re.M)
    assert len(text.splitlines()) < 500
    for required in ['scripts/ensure_dependencies.py', 'scripts/test_dependencies.py', 'references/dependencies.json', 'references/dependency-installation.md', 'references/verification.md', 'README.md', 'NOTICE.md']:
        assert required in paths, 'Missing ' + required
    samples = [p for p in files if p.parent == ROOT / 'assets/style-samples']
    assert len(samples) == 12, 'Expected twelve final samples'
    index = (ROOT / 'references/style-samples.md').read_text()
    assert all(p.name in index for p in samples), 'Unindexed sample'
    for p in files:
        assert not p.is_symlink(), 'Symlink cannot be distributed: ' + str(p)
        assert not any(x in p.name.lower() for x in ['my-face', 'admin-token', '.env', 'config.md']), 'Potential private file: ' + str(p)
        if p.suffix in {'.md', '.json', '.py'}:
            content = p.read_text()
            assert str(Path.home()) + '/' not in content, 'Developer home path: ' + str(p)
            assert not re.search(r'[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}', content), 'Unreviewed email address: ' + str(p)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p, name in zip(files, paths):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 18, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, p.read_bytes())
    with zipfile.ZipFile(args.output) as archive:
        assert archive.testzip() is None
        assert [n for n in archive.namelist() if n.endswith('SKILL.md')] == ['SKILL.md']
    print(json.dumps({'file': str(args.output.resolve()), 'size_bytes': args.output.stat().st_size, 'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'file_count': len(files), 'sample_count': len(samples), 'source_directory': '', 'checks': 'passed'}, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
