#!/usr/bin/env python3
"""Offline stdlib tests: python3 -B scripts/test_dependencies.py -v."""
import copy
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
import urllib.error
import zipfile

import ensure_dependencies as deps


def dependency(name="fixture", repo="owner/repository", subdir="skill"):
    return {"id": name, "family": "fixture", "folder": name,
            "aliases": ["hub-" + name], "repo": repo, "ref": "a" * 40,
            "subdir": subdir, "required": ["SKILL.md", "references/core.md"]}


def archive_bytes(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return stream.getvalue()


def fixture_archive(dep, extra=None):
    prefix = "repository-" + dep["ref"] + "/" + (dep["subdir"] + "/" if dep["subdir"] else "")
    files = {prefix + "SKILL.md": "---\nname: {}\ndescription: fixture\n---\n# Fixture\n".format(dep["id"]),
             prefix + "references/core.md": "core resource"}
    files.update(extra or {})
    return archive_bytes(files)


def populate(path, dep, name=None):
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text("---\nname: {}\ndescription: test\n---\nBody".format(name or dep["id"]))
    for value in dep.get("required", []):
        if value != "SKILL.md":
            file = path / value
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("core")
    return path


class DependenciesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cover-installer-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.skills = self.root / "skills"
        self.settings = self.root / "settings.json"
        self.settings.write_text('{"disabled": []}')
        self.dep = dependency()

    def run_deps(self, dependencies=None, downloader=None, **kwargs):
        return deps.run(dependencies or [self.dep], self.skills,
                        settings_path=self.settings,
                        downloader=downloader or self.no_network, **kwargs)

    def no_network(self, *args, **kwargs):
        raise AssertionError("Network must not be used")

    def downloader(self, payload, calls):
        def download(url, destination, **kwargs):
            calls.append(url)
            Path(destination).write_bytes(payload)
        return download

    def test_manifest_all_ten_seven_families_and_pinned_refs(self):
        manifest = deps.load_manifest()
        self.assertEqual(len(manifest), 10)
        self.assertEqual(len({d["family"] for d in manifest}), 7)
        for dep in manifest:
            self.assertRegex(dep["ref"], r"^[0-9a-f]{40}$")
        self.assertEqual(next(d for d in manifest if d["id"] == "article2media")["subdir"], "skills/article2media")

    def test_clean_install_and_idempotent_offline_second_pass(self):
        calls = []
        payload = fixture_archive(self.dep, {"repository-" + "a" * 40 + "/other/SKILL.md": "not requested"})
        report = self.run_deps(downloader=self.downloader(payload, calls))
        self.assertEqual(report["counts"]["installed"], 1)
        self.assertEqual(len(calls), 1)
        target = self.skills / "fixture"
        before = {str(p.relative_to(target)): p.read_bytes() for p in target.rglob("*") if p.is_file()}
        self.assertEqual(list(target.rglob("SKILL.md")), [target / "SKILL.md"])
        report = self.run_deps()
        self.assertEqual(report["counts"]["existing"], 1)
        self.assertEqual(report["network_downloads"], 0)
        self.assertEqual(before, {str(p.relative_to(target)): p.read_bytes() for p in target.rglob("*") if p.is_file()})

    def test_subtree_preserves_root_notices_without_overwriting_child(self):
        prefix = "repository-" + "a" * 40 + "/"
        names = [base + suffix for base in ("LICENSE", "LICENCE", "NOTICE")
                 for suffix in ("", ".md", ".txt")]
        extra = {prefix + name: "root " + name for name in names}
        extra[prefix + "skill/LICENSE"] = "child license takes precedence"
        extra[prefix + "notice.TXT"] = extra.pop(prefix + "NOTICE.txt")
        extra[prefix + "README.md"] = "not a legal notice"
        report = self.run_deps(downloader=self.downloader(fixture_archive(self.dep, extra), []))
        self.assertEqual(report["counts"]["installed"], 1)
        target = self.skills / self.dep["folder"]
        self.assertEqual((target / "LICENSE").read_text(), "child license takes precedence")
        for name in names:
            if name == "LICENSE":
                continue
            installed_name = "notice.TXT" if name == "NOTICE.txt" else name
            self.assertEqual((target / installed_name).read_text(), "root " + name)
        self.assertFalse((target / "README.md").exists())
        self.assertEqual(len(list(target.rglob("SKILL.md"))), 1)

    def test_existing_personal_assets_preserved_no_network(self):
        path = populate(self.skills / "fixture", self.dep)
        (path / "config.md").write_text("personal preferences")
        (path / "assets").mkdir()
        (path / "assets/my-face.png").write_bytes(b"personal face")
        report = self.run_deps()
        self.assertEqual(report["counts"]["existing"], 1)
        self.assertEqual((path / "assets/my-face.png").read_bytes(), b"personal face")
        self.assertEqual((path / "config.md").read_text(), "personal preferences")

    def test_frontmatter_name_in_collection_and_alias(self):
        for folder, name in [("collection/skills/unexpected-folder", "fixture"), ("hub-fixture", "fixture")]:
            with self.subTest(folder=folder):
                root = self.root / folder.replace("/", "-")
                populate(root / folder, self.dep, name)
                report = self.run_deps(search_dirs=[root])
                self.assertEqual(report["counts"]["existing"], 1)
                self.assertEqual(report["dependencies"][0]["path"], str(root / folder))

    def test_quoted_frontmatter_and_body_name_ignored(self):
        p = self.root / "named"
        p.mkdir()
        for quote in ("'fixture'", '"fixture"', "fixture # inline"):
            (p / "SKILL.md").write_text("---\nname: " + quote + "\ndescription: test\n---\nname: body-not-name")
            self.assertEqual(deps.skill_name(p), "fixture")
        (p / "SKILL.md").write_text("# no frontmatter\nname: fixture")
        self.assertIsNone(deps.skill_name(p))

    def test_disabled_existing_and_missing_preserved(self):
        self.settings.write_text('{"disabled": ["fixture"]}')
        before = self.settings.read_bytes()
        report = self.run_deps()
        self.assertEqual(report["counts"]["disabled"], 1)
        self.assertFalse(self.skills.exists())
        populate(self.skills / "fixture", self.dep)
        with mock.patch.object(deps, "skill_name", side_effect=AssertionError("Disabled skill body read")):
            report = self.run_deps()
        self.assertEqual(report["counts"]["disabled"], 1)
        self.assertEqual(self.settings.read_bytes(), before)

    def test_disabled_slug_alias(self):
        self.settings.write_text('{"disabled": ["hub-fixture"]}')
        path = populate(self.skills / "hub-fixture", self.dep)
        before = (path / "SKILL.md").read_bytes()
        report = self.run_deps()
        self.assertEqual(report["counts"]["disabled"], 1)
        self.assertEqual(before, (path / "SKILL.md").read_bytes())

    def test_canonical_disabled_alias_folder_never_reads_skill(self):
        self.settings.write_text('{"disabled": ["fixture"]}')
        path = populate(self.skills / "hub-fixture", self.dep)
        before = (path / "SKILL.md").read_bytes()
        with mock.patch.object(deps, "skill_name", side_effect=AssertionError("Disabled alias SKILL.md read")):
            report = self.run_deps()
        self.assertEqual(report["counts"]["disabled"], 1)
        self.assertEqual(report["network_downloads"], 0)
        self.assertEqual(before, (path / "SKILL.md").read_bytes())

    def test_malformed_settings_fail_closed(self):
        self.settings.write_text('{"disabled": "fixture"}')
        with self.assertRaises(deps.DependencyError):
            self.run_deps()
        self.assertFalse(self.skills.exists())

    def test_check_missing_read_only(self):
        report = self.run_deps(check=True)
        self.assertEqual(report["counts"]["incomplete"], 1)
        self.assertFalse(report["dependencies"][0]["exists"])
        self.assertFalse(self.skills.exists())
        self.assertEqual(report["network_downloads"], 0)

    def test_incomplete_folder_never_overwritten(self):
        target = self.skills / "fixture"
        target.mkdir(parents=True)
        (target / "personal.txt").write_text("keep")
        report = self.run_deps()
        self.assertEqual(report["counts"]["incomplete"], 1)
        self.assertEqual((target / "personal.txt").read_text(), "keep")
        self.assertFalse((target / "SKILL.md").exists())
        self.assertEqual(report["network_downloads"], 0)

    def test_complete_match_preferred_to_incomplete_duplicate(self):
        (self.skills / "fixture").mkdir(parents=True)
        other = self.root / "other"
        populate(other / "fixture", self.dep)
        report = self.run_deps(search_dirs=[other])
        self.assertEqual(report["counts"]["existing"], 1)

    def test_only_repeatable_alias_selection_and_unknown_rejected(self):
        second = dependency("second")
        report = self.run_deps([self.dep, second], check=True, only=["hub-fixture"])
        self.assertEqual([r["id"] for r in report["dependencies"]], ["fixture"])
        with self.assertRaises(deps.DependencyError):
            self.run_deps(only=["typo"])

    def test_shared_repository_cached_once(self):
        second = dependency("second", subdir="second")
        calls = []
        prefix = "repository-" + "a" * 40 + "/"
        payload = fixture_archive(self.dep, {prefix + "second/SKILL.md": "---\nname: second\n---\nbody",
                                            prefix + "second/references/core.md": "core"})
        report = self.run_deps([self.dep, second], self.downloader(payload, calls))
        self.assertEqual(report["counts"]["installed"], 2)
        self.assertEqual(report["network_downloads"], 1)
        self.assertEqual(len(calls), 1)

    def test_failing_download_isolated_and_failure_cached(self):
        shared = dependency("shared")
        good = dependency("good", repo="owner/good")
        calls = []
        def download(url, destination, **kwargs):
            calls.append(url)
            if "/repository/" in url:
                raise deps.DependencyError("fixture download failed")
            Path(destination).write_bytes(fixture_archive(good))
        report = self.run_deps([self.dep, shared, good], download)
        self.assertEqual(report["counts"]["error"], 2)
        self.assertEqual(report["counts"]["installed"], 1)
        self.assertEqual(len(calls), 2)
        self.assertIn("fixture download failed", report["dependencies"][0]["message"])

    def test_zip_traversal_absolute_backslash_and_drive_blocked(self):
        for name in ("repo/skill/../../escape", "/escape", "repo/skill/..\\escape", "C:/escape", "repo//escape"):
            with self.subTest(name=name):
                calls = []
                payload = fixture_archive(self.dep, {name: "unsafe"})
                report = self.run_deps(downloader=self.downloader(payload, calls))
                self.assertEqual(report["counts"]["error"], 1)
                self.assertFalse((self.skills / "fixture").exists())
                self.assertFalse((self.root / "escape").exists())

    def test_selected_zip_symlink_blocked(self):
        stream = io.BytesIO(fixture_archive(self.dep))
        with zipfile.ZipFile(stream, "a") as archive:
            info = zipfile.ZipInfo("repository-" + "a" * 40 + "/skill/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "/outside")
        report = self.run_deps(downloader=self.downloader(stream.getvalue(), []))
        self.assertEqual(report["counts"]["error"], 1)
        self.assertIn("Symlink", report["dependencies"][0]["message"])
        self.assertFalse((self.skills / "fixture").exists())

    def test_unrequested_article_plugin_symlinks_not_extracted(self):
        stream = io.BytesIO(fixture_archive(self.dep))
        with zipfile.ZipFile(stream, "a") as archive:
            info = zipfile.ZipInfo("repository-" + "a" * 40 + "/.claude/skills/fixture")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, "../../skill")
        report = self.run_deps(downloader=self.downloader(stream.getvalue(), []))
        self.assertEqual(report["counts"]["installed"], 1)
        self.assertFalse((self.skills / "fixture/.claude").exists())

    def test_nested_skill_and_size_limits_blocked(self):
        payload = fixture_archive(self.dep, {"repository-" + "a" * 40 + "/skill/nested/SKILL.md": "nested"})
        report = self.run_deps(downloader=self.downloader(payload, []))
        self.assertEqual(report["counts"]["error"], 1)
        with mock.patch.object(deps, "MAX_EXTRACTED", 10):
            report = self.run_deps(downloader=self.downloader(fixture_archive(self.dep), []))
        self.assertEqual(report["counts"]["error"], 1)

    def test_empty_destination_race_no_overwrite(self):
        source = self.root / "source"
        source.mkdir()
        (source / "file").write_text("staged")
        destination = self.root / "destination"
        destination.mkdir()
        with self.assertRaises(FileExistsError):
            deps.atomic_no_replace(source, destination)
        self.assertTrue(source.is_dir())
        self.assertEqual(list(destination.iterdir()), [])

    def test_install_race_preserves_new_personal_folder(self):
        original = deps.atomic_no_replace
        def race(source, destination):
            destination.mkdir()
            (destination / "personal.txt").write_text("race winner")
            original(source, destination)
        with mock.patch.object(deps, "atomic_no_replace", side_effect=race):
            report = self.run_deps(downloader=self.downloader(fixture_archive(self.dep), []))
        self.assertEqual(report["counts"]["incomplete"], 1)
        self.assertEqual((self.skills / "fixture/personal.txt").read_text(), "race winner")
        self.assertFalse((self.skills / "fixture/SKILL.md").exists())
        self.assertFalse(list(self.skills.glob(".cover-dependency-stage-*")))

    def punk_fixture(self):
        dep = dependency("punk-cover", subdir="skills/punk-cover")
        dep["required"] = ["SKILL.md", "references/style-catalog.md", "references/cover-prompt-blueprint.md"]
        dep["copy_resources"] = [{"source": "styles", "target": "styles"}]
        dep["patch_files"] = ["SKILL.md", "references/style-catalog.md"]
        prefix = "repository-" + "a" * 40 + "/"
        files = {prefix + dep["subdir"] + "/SKILL.md": "---\nname: punk-cover\n---\nRead ../../styles/{style-id}/STYLE.md",
                 prefix + dep["subdir"] + "/references/style-catalog.md": "../../styles/pixel-avatar/META.md ../../styles/pixel-avatar/STYLE.md",
                 prefix + dep["subdir"] + "/references/cover-prompt-blueprint.md": "blueprint",
                 prefix + "styles/pixel-avatar/META.md": "metadata",
                 prefix + "styles/pixel-avatar/STYLE.md": "style"}
        return dep, archive_bytes(files)

    def test_punk_install_resource_closure_and_catalog_patch(self):
        dep, payload = self.punk_fixture()
        report = self.run_deps([dep], self.downloader(payload, []))
        self.assertEqual(report["counts"]["installed"], 1)
        target = self.skills / dep["folder"]
        missing, overrides = deps.verify_resources(dep, target, new=True)
        self.assertEqual(missing, [])
        self.assertEqual(overrides["styles_root"], str(target / "styles"))
        for filename in dep["patch_files"]:
            self.assertNotIn("../../styles", (target / filename).read_text())
        self.assertEqual(len(list(target.rglob("SKILL.md"))), 1)

    def test_existing_punk_override_does_not_patch(self):
        dep, payload = self.punk_fixture()
        self.run_deps([dep], self.downloader(payload, []))
        path = self.skills / dep["folder"]
        skill = path / "SKILL.md"
        skill.write_text(skill.read_text().replace("styles/", "../../styles/"))
        before = skill.read_bytes()
        report = self.run_deps([dep])
        self.assertEqual(report["counts"]["existing"], 1)
        self.assertEqual(report["dependencies"][0]["resource_overrides"]["../../styles"], str(path / "styles"))
        self.assertEqual(skill.read_bytes(), before)

    def test_punk_missing_catalog_style_is_incomplete(self):
        dep, payload = self.punk_fixture()
        self.run_deps([dep], self.downloader(payload, []))
        catalog = self.skills / dep["folder"] / "references/style-catalog.md"
        catalog.write_text("styles/missing-style/STYLE.md")
        report = self.run_deps([dep])
        self.assertEqual(report["counts"]["incomplete"], 1)

    def test_default_root_installed_vs_development_and_environment(self):
        home = self.root / "home"
        self.assertEqual(deps.default_skills_dir(self.root / "skills/router", {}, home), self.root / "skills")
        self.assertEqual(deps.default_skills_dir(self.root / "skills/collection/router", {}, home), self.root / "skills")
        self.assertEqual(deps.default_skills_dir(self.root / "development/router", {}, home), home / ".cola/skills")
        self.assertEqual(deps.default_skills_dir(self.root / "development/router", {"COLA_SKILLS_DIR": str(self.root / "custom")}, home), self.root / "custom")

    def test_download_browser_ua_bounded_retry_and_404_no_retry(self):
        url = "https://codeload.github.com/owner/repo/zip/" + "a" * 40
        error = urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        with mock.patch.object(deps.urllib.request, "urlopen", side_effect=error) as opener:
            with self.assertRaises(deps.DependencyError):
                deps.download_archive(url, self.root / "download.zip", attempts=3)
        self.assertEqual(opener.call_count, 1)
        request = opener.call_args[0][0]
        self.assertIn("Mozilla/5.0", request.get_header("User-agent"))
        transient = urllib.error.URLError("temporary network failure")
        with mock.patch.object(deps.urllib.request, "urlopen", side_effect=transient) as opener, mock.patch.object(deps.time, "sleep"):
            with self.assertRaises(deps.DependencyError):
                deps.download_archive(url, self.root / "download.zip", attempts=2, timeout=5)
        self.assertEqual(opener.call_count, 2)
        self.assertEqual(opener.call_args.kwargs["timeout"], 5)


if __name__ == "__main__":
    unittest.main()
