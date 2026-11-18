#!/usr/bin/env python3
"""Detect/install cover skills using only Python 3's standard library.

The ten dependency skills ship inside this package, so the default path is
fully offline: a bundled copy under vendor/<folder> is verified in place, or
installed from vendor/cola-skills-bundle.zip. The pinned GitHub download stays
as a last-resort fallback for a package whose vendor payload is missing.

--check is strictly offline/read-only with respect to the skills directory
(temporary extraction is only used to verify bundled files). Explicit
--skills-dir isolates discovery unless --search-dir is supplied. No existing
skill, asset or settings is edited. Resource checks certify packaged core
files, not external runtimes/API access.
"""
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path, PurePosixPath
import re
import socket
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = PACKAGE_ROOT / "references" / "dependencies.json"
VENDOR_ROOT = PACKAGE_ROOT / "vendor"
# One archive ships the same ten skills for package layouts that cannot carry
# nested SKILL.md files (Skill Hub zips allow exactly one).
VENDOR_BUNDLE = VENDOR_ROOT / "cola-skills-bundle.zip"
BUNDLE_ROOT = "cola-skills-bundle"
BUNDLE_PREFIX = "deps"
BUNDLED_MESSAGE = "Bundled with this skill; no network required."
USER_AGENT = "Mozilla/5.0 (compatible; CoverWorkflowDependencyInstaller/1.0)"
MAX_DOWNLOAD = 128 * 1024 * 1024
MAX_EXTRACTED = 512 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_MEMBERS = 20000
STATUSES = ("installed", "existing", "incomplete", "disabled", "error")


class DependencyError(Exception):
    pass


def absolute(path):
    # Keep symlink spelling: ../.. in an existing SKILL.md is relative to it.
    return Path(os.path.abspath(os.path.expanduser(str(path))))


def default_skills_dir(package_root=PACKAGE_ROOT, environ=None, home=None):
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    package_root = absolute(package_root)
    configured = absolute(environ["COLA_SKILLS_DIR"]) if environ.get("COLA_SKILLS_DIR") else None
    # A wrapper inside a collection still belongs to the enclosing skills root.
    for parent in package_root.parents:
        if parent.name == "skills" or (configured and parent == configured):
            return parent
    return configured or home / ".cola" / "skills"


def safe_relative(value, allow_empty=False):
    if value == "" and allow_empty:
        return ""
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise DependencyError("Unsafe relative path: {!r}".format(value))
    raw = value.rstrip("/")
    parts = raw.split("/")
    if raw.startswith("/") or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise DependencyError("Unsafe relative path: {!r}".format(value))
    return str(PurePosixPath(raw))


def identities(dep):
    return set([dep["id"], dep["folder"]] + dep.get("aliases", []))


def expand_disabled(disabled, dependencies):
    """Skip all folder/slug aliases before opening disabled SKILL.md files."""
    expanded = set(disabled)
    for dep in dependencies:
        names = identities(dep)
        if names & disabled:
            expanded.update(names)
    return expanded


def load_manifest(path=MANIFEST):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or not isinstance(data.get("dependencies"), list):
        raise DependencyError("Unsupported dependency manifest")
    seen = set()
    for dep in data["dependencies"]:
        if not re.fullmatch(r"[a-z0-9-]+", dep["id"]) or dep["id"] in seen:
            raise DependencyError("Invalid or duplicate dependency ID")
        seen.add(dep["id"])
        safe_relative(dep["folder"])
        if "/" in dep["folder"]:
            raise DependencyError("Install folder must be a single component")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", dep["repo"]):
            raise DependencyError("Invalid GitHub repository")
        if not re.fullmatch(r"[0-9a-f]{40}", dep["ref"]):
            raise DependencyError("Source ref must be an immutable commit SHA")
        safe_relative(dep["subdir"], allow_empty=True)
        for value in dep.get("required", []) + dep.get("patch_files", []):
            safe_relative(value)
        for group in dep.get("required_any", []):
            if not group:
                raise DependencyError("Empty required_any group")
            for value in group:
                safe_relative(value)
        for resource in dep.get("copy_resources", []):
            safe_relative(resource["source"])
            safe_relative(resource["target"])
    return data["dependencies"]


def parse_skill_name(text):
    match = re.match(r"\A---\s*\r?\n(.*?)\r?\n---(?:\s|$)", text, re.S)
    if not match:
        return None
    name = re.search(r"^name:[ \t]*(?:\"([^\"]+)\"|'([^']+)'|([^\s#]+))[ \t]*(?:#.*)?$", match.group(1), re.M)
    return next((part for part in name.groups() if part), None) if name else None


def skill_name(path):
    try:
        with (path / "SKILL.md").open(encoding="utf-8-sig") as stream:
            lines = [stream.readline(16384)]
            if lines[0].strip() != "---":
                return None
            size = len(lines[0])
            while size < 16384:
                line = stream.readline(16384 - size)
                if not line:
                    break
                lines.append(line)
                size += len(line)
                if line.strip() == "---":
                    break
            text = "".join(lines)
    except (OSError, UnicodeError):
        return None
    return parse_skill_name(text)


def read_disabled(settings_path):
    path = Path(settings_path)
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        disabled = data.get("disabled", [])
        if not isinstance(disabled, list) or any(not isinstance(v, str) for v in disabled):
            raise ValueError("disabled must be a list of skill names")
        return set(disabled)
    except (OSError, ValueError, AttributeError) as exc:
        # Fail closed: malformed preferences must not accidentally enable skills.
        raise DependencyError("Cannot read disabled choices from {}: {}".format(path, exc))


def scan_skills(roots, disabled):
    """Bounded collection-aware scan; do not descend into personal assets."""
    entries, visited = [], set()
    pruned = {".git", "node_modules", "assets", "references", "scripts", "engine", "styles", "examples", "tests", "__pycache__"}
    pending = [(absolute(root), 0) for root in reversed(roots)]
    while pending:
        path, depth = pending.pop()
        if not path.is_dir():
            continue
        try:
            resolved = path.resolve()
            if resolved in visited:
                continue
            visited.add(resolved)
            if len(visited) > 10000:
                raise DependencyError("Skill scan limit exceeded; use narrower --search-dir roots")
            has_skill = (path / "SKILL.md").is_file()
            # A disabled folder's body is never read.
            name = None if path.name in disabled else skill_name(path) if has_skill else None
            entries.append({"path": path, "name": name, "has_skill": has_skill,
                            "parents": set(p.name for p in path.parents if p in visited or p == absolute(roots[0]))})
            if path.name in disabled:
                continue
            if depth < 5:
                with os.scandir(path) as items:
                    children = sorted((Path(item.path) for item in items
                                       if item.name not in pruned and not item.name.startswith(".")
                                       and item.is_dir()), key=str)
                # A skill's resources aren't collection children. 'skills/' is.
                if has_skill:
                    children = [p for p in children if p.name == "skills"]
                pending.extend((child, depth + 1) for child in reversed(children))
        except OSError as exc:
            raise DependencyError("Cannot inspect {}: {}".format(path, exc))
    return entries


def nonempty_file(path):
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def check_styles(style_root, catalog):
    if not style_root.is_dir():
        return [str(style_root) + " (missing styles directory)"]
    pairs = list(style_root.glob("*/META.md"))
    missing = []
    if not pairs:
        missing.append(str(style_root) + "/*/META.md")
    for meta in pairs:
        for filename in ("META.md", "STYLE.md"):
            if not nonempty_file(meta.parent / filename):
                missing.append(str(meta.parent / filename))
    if catalog.is_file():
        text = catalog.read_text(encoding="utf-8")
        # Check every concrete catalog link, including style-specific references.
        links = set(re.findall(r"(?:\.\./)*styles/([a-z0-9-]+/(?:META\.md|STYLE\.md|references/[a-z0-9-]+\.md))", text))
        for link in sorted(links):
            if not nonempty_file(style_root / link):
                missing.append(str(style_root / link))
    return missing


def verify_resources(dep, path, new=False):
    missing = [value for value in dep.get("required", []) if not nonempty_file(path / value)]
    for group in dep.get("required_any", []):
        if not any(nonempty_file(path / value) for value in group):
            missing.append("one of: " + ", ".join(group))
    if skill_name(path) not in identities(dep):
        missing.append("SKILL.md YAML name must match " + dep["id"])
    overrides = {}
    if dep.get("copy_resources"):
        local = path / "styles"
        catalog = path / "references" / "style-catalog.md"
        local_missing = check_styles(local, catalog)
        # Prefer a complete packaged local library; preserve legacy instructions.
        if not local_missing:
            style_root = local
            text = (path / "SKILL.md").read_text(encoding="utf-8")
            if not new and "../../styles/" in text:
                overrides["../../styles"] = str(local)
        elif not new:
            shared = path / ".." / ".." / "styles"
            shared_missing = check_styles(shared, catalog)
            if not shared_missing:
                style_root = shared
            else:
                missing.extend(local_missing)
                style_root = local
        else:
            missing.extend(local_missing)
            style_root = local
        if new:
            for value in dep.get("patch_files", []):
                if "../../styles" in (path / value).read_text(encoding="utf-8"):
                    missing.append(value + " still refers outside the skill")
        overrides["styles_root"] = str(absolute(style_root))
    if new:
        nested = [str(p.relative_to(path)) for p in path.rglob("SKILL.md") if p != path / "SKILL.md"]
        missing.extend("unexpected nested skill: " + value for value in nested)
    return missing, overrides


def result(dep, status, path=None, **extra):
    item = {"id": dep["id"], "family": dep.get("family"), "status": status,
            "path": str(absolute(path)) if path else None}
    item.update(extra)
    return item


def detect(dep, entries, disabled):
    names = identities(dep)
    matches = [e for e in entries if e["name"] in names or e["path"].name in names]
    disabled_matches = [e for e in matches if (e["parents"] | {e["path"].name, e["name"]}) & disabled]
    if names & disabled or disabled_matches:
        found = disabled_matches or matches
        return result(dep, "disabled", found[0]["path"] if found else None,
                      message="Disabled choice preserved; not installed, enabled or modified.")
    if not matches:
        return None
    checked = []
    for entry in matches:
        missing, overrides = verify_resources(dep, entry["path"])
        checked.append((entry, missing, overrides))
        if not missing:
            return result(dep, "existing", entry["path"], resource_overrides=overrides,
                          message="Existing core resources preserved; no update or network required.")
    entry, missing, overrides = checked[0]
    return result(dep, "incomplete", entry["path"], missing_resources=missing,
                  resource_overrides=overrides, exists=True,
                  action="Existing folder was not changed. Restore its missing resources manually, or use another cover route. To install separately, choose a fresh --skills-dir.")


_SHIPPED = {}


def shipped_dependency(dep):
    """True only for a manifest entry at its pinned commit.

    Vendor/bundle copies are keyed by folder name, so a caller-supplied
    dependency that merely reuses a folder name must never be served from the
    shipped payload; it has to follow its own repo/ref.
    """
    key = (dep.get("repo"), dep.get("ref"), dep.get("folder"))
    if "entries" not in _SHIPPED:
        try:
            _SHIPPED["entries"] = {(d["repo"], d["ref"], d["folder"]) for d in load_manifest()}
        except (DependencyError, OSError, ValueError, KeyError, TypeError):
            _SHIPPED["entries"] = set()
    return key in _SHIPPED["entries"]


def vendor_path(dep):
    return VENDOR_ROOT / dep["folder"]


def detect_bundled(dep, disabled):
    """Tier 1: a verified copy shipped as vendor/<folder>."""
    path = vendor_path(dep)
    if not shipped_dependency(dep) or not path.is_dir():
        return None
    if identities(dep) & disabled:
        return result(dep, "disabled", path,
                      message="Disabled choice preserved; not installed, enabled or modified.")
    missing, overrides = verify_resources(dep, path)
    if missing:
        return result(dep, "incomplete", path, exists=True, missing_resources=missing,
                      resource_overrides=overrides,
                      action="Bundled copy is incomplete; restore vendor/{}/ from the released package."
                             .format(dep["folder"]))
    return result(dep, "existing", path, resource_overrides=overrides, bundled=True,
                  message=BUNDLED_MESSAGE)


def bundle_entries(dep):
    """Names of the bundled archive members that belong to one dependency."""
    if not shipped_dependency(dep) or not VENDOR_BUNDLE.is_file():
        return []
    prefix = "{}/{}/{}/".format(BUNDLE_ROOT, BUNDLE_PREFIX, dep["folder"])
    try:
        with zipfile.ZipFile(VENDOR_BUNDLE) as archive:
            return [name for name in archive.namelist() if name.startswith(prefix)]
    except (OSError, zipfile.BadZipFile):
        return []


def extract_bundled(dep, destination):
    """Extract one dependency out of the bundled archive and verify it."""
    with zipfile.ZipFile(VENDOR_BUNDLE) as archive:
        index = archive_index(archive)
        extract_subtree(archive, index, "{}/{}".format(BUNDLE_PREFIX, dep["folder"]), destination)


def check_bundled(dep):
    """Offline verification of a bundled archive entry; reads the zip index only."""
    return verify_bundled(dep)


def install_bundled(dep, skills_dir):
    """Install one dependency from the bundled archive; no network involved."""
    target = skills_dir / dep["folder"]
    if os.path.lexists(target):
        raise FileExistsError("Destination exists: " + str(target))
    skills_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cover-dependency-stage-", dir=skills_dir) as stage:
        staged = Path(stage) / dep["folder"]
        staged.mkdir()
        extract_bundled(dep, staged)
        missing, _ = verify_resources(dep, staged, new=True)
        if missing:
            raise DependencyError("Bundled skill failed resource checks: " + "; ".join(missing))
        atomic_no_replace(staged, target)
    _, overrides = verify_resources(dep, target)
    return result(dep, "installed", target, resource_overrides=overrides, bundled=True,
                  message=BUNDLED_MESSAGE,
                  source={"bundle": str(VENDOR_BUNDLE), "folder": dep["folder"]})


def verify_bundled(dep):
    """Verify one dependency inside vendor/cola-skills-bundle.zip without extracting.

    Reads the archive member list only: required files, required_any groups, the
    SKILL.md YAML name, the packaged style library and its catalog links.
    """
    prefix = "{}/{}/{}/".format(BUNDLE_ROOT, BUNDLE_PREFIX, dep["folder"])
    if not shipped_dependency(dep):
        return None
    try:
        with zipfile.ZipFile(VENDOR_BUNDLE) as archive:
            members = {info.filename[len(prefix):]: info for info in archive.infolist()
                       if info.filename.startswith(prefix) and not info.is_dir()}
            if not members:
                return None

            def nonempty(relative):
                info = members.get(relative)
                return bool(info and info.file_size > 0)

            def text_of(relative):
                with archive.open(members[relative]) as stream:
                    return stream.read().decode("utf-8", "replace")

            missing = [value for value in dep.get("required", []) if not nonempty(value)]
            for group in dep.get("required_any", []):
                if not any(nonempty(value) for value in group):
                    missing.append("one of: " + ", ".join(group))
            name = parse_skill_name(text_of("SKILL.md")) if nonempty("SKILL.md") else None
            if name not in identities(dep):
                missing.append("SKILL.md YAML name must match " + dep["id"])
            if dep.get("copy_resources"):
                metas = sorted(value[:-len("/META.md")] for value in members
                               if value.startswith("styles/") and value.endswith("/META.md")
                               and value.count("/") == 2)
                if not metas:
                    missing.append("styles/*/META.md")
                for style in metas:
                    for filename in ("META.md", "STYLE.md"):
                        if not nonempty(style + "/" + filename):
                            missing.append(style + "/" + filename)
                if nonempty("references/style-catalog.md"):
                    links = set(re.findall(
                        r"(?:\.\./)*styles/([a-z0-9-]+/(?:META\.md|STYLE\.md|references/[a-z0-9-]+\.md))",
                        text_of("references/style-catalog.md")))
                    for link in sorted(links):
                        if not nonempty("styles/" + link):
                            missing.append("styles/" + link)
                for value in dep.get("patch_files", []):
                    if nonempty(value) and "../../styles" in text_of(value):
                        missing.append(value + " still refers outside the skill")
            nested = sorted(value for value in members
                            if value.endswith("SKILL.md") and value != "SKILL.md")
            missing.extend("unexpected nested skill: " + value for value in nested)
    except (OSError, zipfile.BadZipFile, KeyError, RuntimeError) as exc:
        return ["bundled archive unreadable: {}".format(exc)]
    return missing


def download_archive(url, destination, timeout=30, attempts=2):
    """Default urllib opener honors HTTP(S)_PROXY/ALL_PROXY/NO_PROXY normally."""
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/zip"})
            deadline = time.monotonic() + timeout * 2
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if response.geturl().split("/")[2] != "codeload.github.com":
                    raise DependencyError("Unexpected archive redirect: " + response.geturl())
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_DOWNLOAD:
                    raise DependencyError("Archive exceeds download size limit")
                total = 0
                with Path(destination).open("wb") as stream:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        total += len(block)
                        if total > MAX_DOWNLOAD or time.monotonic() > deadline:
                            raise DependencyError("Archive exceeds download size/time limit")
                        stream.write(block)
            return
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            transient = not isinstance(exc, urllib.error.HTTPError) or exc.code in (408, 429, 500, 502, 503, 504)
            if attempt + 1 == attempts or not transient:
                raise DependencyError("Download failed for {}: {}. Check network/proxy; HTTPS_PROXY may be set explicitly.".format(url, exc))
            time.sleep(0.5 * (attempt + 1))


class ArchiveCache:
    def __init__(self, directory, timeout=30, attempts=2, downloader=download_archive):
        self.directory = Path(directory)
        self.timeout, self.attempts, self.downloader = timeout, attempts, downloader
        self.values = {}
        self.downloads = 0

    def get(self, dep):
        key = (dep["repo"], dep["ref"])
        if key not in self.values:
            url = "https://codeload.github.com/{}/zip/{}".format(*key)
            path = self.directory / ("repo-{}.zip".format(len(self.values)))
            try:
                self.downloads += 1
                self.downloader(url, path, timeout=self.timeout, attempts=self.attempts)
                self.values[key] = path
            except Exception as exc:
                self.values[key] = DependencyError(str(exc))
        value = self.values[key]
        if isinstance(value, Exception):
            raise value
        return value


def archive_index(archive):
    infos = archive.infolist()
    if not infos or len(infos) > MAX_MEMBERS:
        raise DependencyError("Empty archive or too many entries")
    roots, seen, total = set(), set(), 0
    for info in infos:
        name = safe_relative(info.filename)
        if name in seen:
            raise DependencyError("Duplicate archive member: " + name)
        seen.add(name)
        roots.add(name.split("/")[0])
        total += info.file_size
        if total > MAX_EXTRACTED or info.file_size > MAX_FILE:
            raise DependencyError("Archive exceeds extracted size limit")
        if info.flag_bits & 1:
            raise DependencyError("Encrypted archive members are not supported")
    if len(roots) != 1:
        raise DependencyError("Archive must have one repository root")
    prefix = roots.pop() + "/"
    return {info.filename[len(prefix):].rstrip("/"): info for info in infos if info.filename.startswith(prefix)}


def extract_subtree(archive, index, source, destination, allow_nested=False):
    source = safe_relative(source, allow_empty=True)
    prefix = source + "/" if source else ""
    selected = [(name[len(prefix):], info) for name, info in index.items()
                if name.startswith(prefix) and name != source]
    if not selected:
        raise DependencyError("Requested repository subtree is missing: " + (source or "/"))
    for relative, info in selected:
        relative = safe_relative(relative)
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode) or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise DependencyError("Symlink/special archive member rejected: " + info.filename)
        if not allow_nested and Path(relative).name == "SKILL.md" and relative != "SKILL.md":
            raise DependencyError("Nested SKILL.md rejected: " + relative)
    for relative, info in selected:
        target = destination / relative
        if info.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive create prevents collisions, including case-insensitive names.
        with archive.open(info) as src, target.open("xb") as dst:
            total = 0
            while True:
                block = src.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > info.file_size or total > MAX_FILE:
                    raise DependencyError("Extracted member exceeded declared size")
                dst.write(block)
        target.chmod(0o755 if (info.external_attr >> 16) & 0o111 else 0o644)


def atomic_no_replace(source, destination):
    """Publish a fully verified directory atomically, including empty-dir races."""
    if os.name == "nt":
        os.rename(str(source), str(destination))  # Windows never replaces a target.
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        call = getattr(libc, "renamex_np", None)
        if call is None:
            raise DependencyError("Atomic exclusive rename is unavailable")
        call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        call.restype = ctypes.c_int
        code = call(os.fsencode(source), os.fsencode(destination), 0x4)  # RENAME_EXCL
    else:
        call = getattr(libc, "renameat2", None)
        if call is None:
            raise DependencyError("Atomic exclusive rename is unavailable on this OS; no unsafe fallback used")
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        call.restype = ctypes.c_int
        code = call(-100, os.fsencode(source), -100, os.fsencode(destination), 1)  # RENAME_NOREPLACE
    if code != 0:
        error = ctypes.get_errno()
        if error in (errno.EEXIST, errno.ENOTEMPTY):
            raise FileExistsError(error, os.strerror(error), str(destination))
        raise OSError(error, os.strerror(error), str(destination))


def install(dep, skills_dir, cache):
    target = skills_dir / dep["folder"]
    if os.path.lexists(target):
        raise FileExistsError("Destination exists: " + str(target))
    archive_path = cache.get(dep)
    skills_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".cover-dependency-stage-", dir=skills_dir) as stage:
        staged = Path(stage) / dep["folder"]
        staged.mkdir()
        with zipfile.ZipFile(archive_path) as archive:
            index = archive_index(archive)
            extract_subtree(archive, index, dep["subdir"], staged)
            for resource in dep.get("copy_resources", []):
                extract_subtree(archive, index, resource["source"], staged / resource["target"])
            if dep["subdir"]:
                # Preserve public repository notices when installing a subtree.
                # Existing child notices take precedence; reuse safe extraction.
                notices = {name: info for name, info in index.items()
                           if re.fullmatch(r"(?:LICENSE|LICENCE|NOTICE)(?:\.(?:md|txt))?", name, re.I)
                           and not info.is_dir() and not os.path.lexists(staged / name)}
                if notices:
                    extract_subtree(archive, notices, "", staged)
        for value in dep.get("patch_files", []):
            path = staged / value
            text = path.read_text(encoding="utf-8")
            path.write_text(text.replace("../../styles", "styles"), encoding="utf-8")
        missing, _ = verify_resources(dep, staged, new=True)
        if missing:
            raise DependencyError("Downloaded skill failed resource checks: " + "; ".join(missing))
        atomic_no_replace(staged, target)
    _, overrides = verify_resources(dep, target)
    return result(dep, "installed", target, resource_overrides=overrides,
                  source={"repo": dep["repo"], "ref": dep["ref"], "subdir": dep["subdir"]})


def run(dependencies, skills_dir, search_dirs=(), check=False, only=None,
        settings_path=None, downloader=download_archive, timeout=30, attempts=2):
    skills_dir = absolute(skills_dir)
    roots = list(dict.fromkeys([skills_dir] + [absolute(p) for p in search_dirs]))
    settings_path = Path(settings_path) if settings_path else Path.home() / ".cola" / "skills.json"
    selected = dependencies
    if only:
        requested = set(only)
        known = set().union(*(identities(d) for d in dependencies))
        if requested - known:
            raise DependencyError("Unknown --only ID(s): " + ", ".join(sorted(requested - known)))
        selected = [d for d in dependencies if identities(d) & requested]
    disabled = expand_disabled(read_disabled(settings_path), dependencies)
    entries = scan_skills(roots, disabled)
    results = []
    # Finish offline detection for every requested dependency before any download.
    pending = []
    for dep in selected:
        bundled = detect_bundled(dep, disabled)
        if bundled:
            results.append(bundled)
            continue
        found = detect(dep, entries, disabled)
        if found:
            results.append(found)
        elif check:
            missing = check_bundled(dep)
            if missing is None:
                results.append(result(dep, "incomplete", skills_dir / dep["folder"], exists=False,
                                      missing_resources=["skill not installed"],
                                      action="Run again without --check to install this missing dependency."))
            elif missing:
                results.append(result(dep, "incomplete", VENDOR_BUNDLE, exists=False,
                                      missing_resources=missing, bundled=True,
                                      action="Bundled archive copy is incomplete; reinstall this skill from the released package."))
            else:
                results.append(result(dep, "existing", VENDOR_BUNDLE, bundled=True,
                                      message=BUNDLED_MESSAGE,
                                      action="Run without --check to install it from the bundled archive (no network)."))
        else:
            pending.append(dep)
    downloads = 0
    if pending:
        with tempfile.TemporaryDirectory(prefix="cover-dependency-cache-") as cache_dir:
            cache = None
            for dep in pending:
                try:
                    # Recheck preferences/paths between installs (including aliases).
                    disabled = expand_disabled(read_disabled(settings_path), dependencies)
                    entries = scan_skills(roots, disabled)
                    found = detect(dep, entries, disabled)
                    if found:
                        results.append(found)
                    elif bundle_entries(dep):
                        results.append(install_bundled(dep, skills_dir))
                    else:
                        if cache is None:
                            cache = ArchiveCache(cache_dir, timeout, attempts, downloader)
                        results.append(install(dep, skills_dir, cache))
                except FileExistsError:
                    disabled = expand_disabled(read_disabled(settings_path), dependencies)
                    found = detect(dep, scan_skills(roots, disabled), disabled)
                    results.append(found or result(dep, "incomplete", skills_dir / dep["folder"], exists=True,
                                                  action="A destination appeared during installation; preserved without overwrite."))
                except (DependencyError, OSError, ValueError, zipfile.BadZipFile, RuntimeError) as exc:
                    results.append(result(dep, "error", skills_dir / dep["folder"], message=str(exc),
                                          action="Use another cover route, fix the reported source/network issue, then retry this ID."))
            downloads = cache.downloads if cache else 0
    order = {dep["id"]: n for n, dep in enumerate(selected)}
    results.sort(key=lambda item: order[item["id"]])
    # Surface transitive skill needs without installing unrequested children.
    for dep, item in zip(selected, results):
        if dep.get("external_skill_dependencies"):
            item["external_skill_dependencies"] = dep["external_skill_dependencies"]
            item["warnings"] = ["Only the requested article2media entry skill/engine is installed. Its workflow invokes additional sibling skills; these are not installed by this ten-skill manifest."]
    counts = {status: sum(r["status"] == status for r in results) for status in STATUSES}
    return {"schema_version": 1, "mode": "check" if check else "install", "skills_dir": str(skills_dir),
            "search_dirs": [str(p) for p in roots], "settings_path": str(absolute(settings_path)),
            "network_downloads": downloads, "counts": counts, "dependencies": results,
            "ok": not (counts["incomplete"] or counts["error"])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills-dir", help="Installation/discovery root (isolates default search roots)")
    parser.add_argument("--search-dir", action="append", default=[], help="Additional read-only search root; repeatable")
    parser.add_argument("--check", action="store_true", help="Offline read-only detection; do not create folders")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    parser.add_argument("--only", action="append", nargs="+", help="Only these IDs/aliases; repeatable, accepts comma-separated IDs")
    parser.add_argument("--timeout", type=float, default=30, help="Network timeout per operation (1..120 seconds)")
    parser.add_argument("--attempts", type=int, choices=(1, 2, 3), default=2, help="Bounded targeted download attempts")
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 120:
        parser.error("--timeout must be between 1 and 120")
    root = absolute(args.skills_dir) if args.skills_dir else default_skills_dir()
    search = list(args.search_dir)
    if not args.skills_dir:
        search += [str(Path.home() / ".cola" / "resources" / "skills"), str(Path.home() / ".agents" / "skills")]
    only = [part for group in args.only or [] for value in group for part in value.split(",") if part]
    try:
        report = run(load_manifest(), root, search, args.check, only,
                     timeout=args.timeout, attempts=args.attempts)
    except (DependencyError, OSError, ValueError, KeyError) as exc:
        report = {"schema_version": 1, "ok": False, "status": "error", "path": str(root),
                  "message": str(exc), "dependencies": [], "network_downloads": 0}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    elif "message" in report:
        print("error: " + report["message"], file=sys.stderr)
    else:
        for item in report["dependencies"]:
            print("{}: {} — {}".format(item["id"], item["status"], item["path"] or "not installed"))
            for key in ("message", "action"):
                if item.get(key):
                    print("  " + item[key])
            for warning in item.get("warnings", []):
                print("  Warning: " + warning)
            if item.get("resource_overrides"):
                print("  Resource paths: " + json.dumps(item["resource_overrides"], ensure_ascii=False))
        print("Counts: " + json.dumps(report["counts"]) + "; repository downloads: " + str(report["network_downloads"]))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
