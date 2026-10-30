import copy
import json
from pathlib import Path
import tempfile
import unittest
from tools.build_release import ROOT, config_errors, dependency_errors, read_json, validate_payload
from host.instance_lock import host_session_lock


class ReleaseTests(unittest.TestCase):
    def test_missing_store_ids_block_release_but_allow_development(self):
        config = read_json(ROOT / "release/config.json")
        config.update(edgeExtensionId="", chromeExtensionId="", storeIdsConfirmed=False)
        self.assertTrue(config_errors(config, "host"))
        self.assertEqual(config_errors(config, "host", release=False), [])

    def test_formal_ids_do_not_accept_development_or_wildcards(self):
        config = read_json(ROOT / "release/config.json")
        for value in ("mcpnbecppicmobinpgiiomjihgcfikdl", "*", "https://example.com", "z" * 32):
            config["edgeExtensionId"] = value
            self.assertTrue(any("edgeExtensionId" in error for error in config_errors(config, "edge")))

    def test_release_needs_both_browser_ids_and_signing_identity(self):
        config = read_json(ROOT / "release/config.json")
        config.update(edgeExtensionId="a" * 32, chromeExtensionId="b" * 32, storeIdsConfirmed=True,
                      publicPagesVerified=True, publisher="Test Publisher", signingCertificateThumbprint="C" * 40,
                      installerCompilerReview={"approved": True, "reviewedBy": "Test Reviewer", "reviewedAt": "2026-10-30"})
        self.assertEqual(config_errors(config, "host"), [])
        config["chromeExtensionId"] = ""
        self.assertTrue(any("chromeExtensionId" in error for error in config_errors(config, "host")))

    def test_urls_cannot_carry_executable_schemes_or_credentials(self):
        config = read_json(ROOT / "release/config.json")
        for value in ("http://example.com", "javascript:alert(1)", "https://user:secret@example.com"):
            config["releaseUrl"] = value
            self.assertTrue(config_errors(config, "edge", release=False))

    def test_missing_reviewed_inputs_are_never_approved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "vendor").mkdir()
            (root / "vendor/approved-licenses.json").write_text(json.dumps({"ytDlp": {}, "ffmpeg": {}}), encoding="utf-8")
            errors = dependency_errors(root)
        self.assertTrue(any("review" in error for error in errors))
        self.assertTrue(any("SHA-256" in error for error in errors))

    def test_payload_rejects_remote_script_missing_import_and_permissions(self):
        from tools.build_release import RUNTIME
        source = ROOT / "extensions/edge"
        files = {name: (source / name).read_bytes() for name in RUNTIME}
        manifest = read_json(source / "manifest.json")
        manifest.pop("key")
        files["manifest.json"] = json.dumps(manifest).encode()
        for name in manifest["icons"].values():
            files[name] = (source / name).read_bytes()
        validate_payload(files)
        for code in (b'<script src="https://example.com/evil.js"></script>', b'<script src="missing.js"></script>'):
            broken = {**files, "popup.html": code}
            with self.assertRaises(ValueError):
                validate_payload(broken)
        manifest["permissions"].append("debugger")
        with self.assertRaises(ValueError):
            validate_payload({**files, "manifest.json": json.dumps(manifest).encode()})

    def test_single_session_lock_prevents_cross_browser_state_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            with host_session_lock(directory) as first:
                self.assertTrue(first)
                with host_session_lock(directory) as second:
                    self.assertFalse(second)
            with host_session_lock(directory) as recovered:
                self.assertTrue(recovered)
