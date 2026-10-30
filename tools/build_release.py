"""Offline, allowlisted store packaging and fail-closed release validation.

python -m tools.build_release extension --browser edge [--release]
python -m tools.build_release preflight --target host
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ["popup.html", "popup.css", "popup.js", "service_worker.js",
           "scanner.mjs", "cookie_authorization.mjs", "task_actions.mjs",
           "size_display.mjs", "probe_queue.mjs", "settings.mjs",
           "bridge_status.mjs", "media_identity.mjs", "release_config.mjs", "i18n.mjs"]
PERMISSIONS = ["activeTab", "scripting", "nativeMessaging", "storage", "alarms"]
DEV_ID = "mcpnbecppicmobinpgiiomjihgcfikdl"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def config_errors(config, target, release=True, allow_unsigned=False):
    errors = []
    if not config.get('productName') or any(c in config['productName'] for c in '\r\n"{}'):
        errors.append('Invalid productName')
    for key in ("extensionVersion", "hostVersion", "minimumHostVersion"):
        value = config.get(key, "")
        if value == '0.0.0' or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", value) or any(int(n) > 65535 for n in value.split(".") if n.isdigit()):
            errors.append(f"Invalid {key}")
    if not re.fullmatch(r"[a-z0-9_]+(?:\.[a-z0-9_]+)+", config.get("nativeHostName", "")):
        errors.append("Invalid nativeHostName")
    if config.get("architecture") != "x64" or config.get("windowsMinimum") != "10.0":
        errors.append("This installer supports Windows 10+ x64 only")
    if not re.fullmatch(r"\d+", str(config.get("minimumBrowserVersion", ""))):
        errors.append("Invalid minimumBrowserVersion")
    for key in ("releaseUrl", "supportUrl", "privacyUrl", "timestampUrl"):
        url = urlsplit(config.get(key, ""))
        if url.scheme != "https" or not url.hostname or url.username or url.password or any(c in config.get(key, "") for c in '\r\n"{} '):
            errors.append(f"{key} must be a public HTTPS URL without credentials")
    if not release:
        return errors
    if not errors and tuple(map(int, config['hostVersion'].split('.'))) < tuple(map(int, config['minimumHostVersion'].split('.'))):
        errors.append('Host version is below the minimum required by this extension')
    browsers = ("edge", "chrome") if target == "host" else (target,)
    for browser in browsers:
        value = config.get(f"{browser}ExtensionId", "")
        if target == "host" and browser == "chrome" and not value:
            continue  # The Host registers only stores with a confirmed public ID.
        if not re.fullmatch(r"[a-p]{32}", value) or value == DEV_ID:
            errors.append(f"Set the confirmed {browser}ExtensionId (not the development ID)")
    if target == "host" and config.get("chromeExtensionId") and config.get("storeIdsConfirmed") is not True:
        errors.append("Confirm both store IDs before registering Chrome: storeIdsConfirmed")
    if config.get("publicPagesVerified") is not True:
        errors.append("Publish and verify the release/support/privacy URLs: publicPagesVerified")
    if target == "host":
        if not allow_unsigned:
            if not re.fullmatch(r"[A-Fa-f0-9]{40}", config.get("signingCertificateThumbprint", "")):
                errors.append("Set signingCertificateThumbprint for a trusted code-signing certificate")
            if not config.get("publisher") or any(c in config["publisher"] for c in '\r\n"{}'):
                errors.append("Set publisher to the certificate publisher name")
        review = config.get('installerCompilerReview', {})
        if review.get('approved') is not True or not review.get('reviewedBy') or not review.get('reviewedAt'):
            errors.append('Review and record the Inno Setup 6 distribution license for this project')
    return errors


def dependency_errors(root=ROOT):
    approval = read_json(root / "vendor/approved-licenses.json")
    errors = []
    pairs = [("yt-dlp.exe", approval["ytDlp"].get("sha256")),
             ("yt-dlp-source.tar.gz", approval["ytDlp"].get("sourceArchiveSha256")),
             ("ffmpeg.exe", approval["ffmpeg"].get("sha256")),
             ("ffprobe.exe", approval["ffmpeg"].get("ffprobeSha256")),
             ("ffmpeg-source.tar.xz", approval["ffmpeg"].get("sourceArchiveSha256"))]
    for filename, digest in pairs:
        path = root / "vendor" / filename
        if not digest or not re.fullmatch(r"[a-fA-F0-9]{64}", digest):
            errors.append(f"Missing reviewed SHA-256: {filename}")
        elif not path.is_file() or sha256(path) != digest.lower():
            errors.append(f"Missing or mismatched dependency: {filename}")
    review = approval.get("redistributionReview", {})
    if review.get("approved") is not True or not review.get("reviewedBy") or not review.get("reviewedAt"):
        errors.append("Complete the corresponding-source and redistribution review")
    materials = review.get("materials", [])
    required = {"licenses/yt-dlp.txt", "licenses/ffmpeg-GPL-3.0.txt", "licenses/THIRD-PARTY-NOTICES.txt",
                "licenses/Python.txt", "licenses/PyInstaller.txt"}
    if not required.issubset({item.get("path") for item in materials}):
        errors.append("Pin all license/NOTICE materials including Python and PyInstaller")
    for item in materials:
        path = (root / "vendor" / item.get("path", "")).resolve()
        if not item.get('path', '').startswith('licenses/') or not path.is_relative_to((root / "vendor/licenses").resolve()) or not path.is_file() or sha256(path) != item.get("sha256"):
            errors.append(f"Missing or mismatched review material: {item.get('path')}")
    return errors


def check_generated(root=ROOT):
    subprocess.run(["node", str(root / "tools/sync-release.mjs"), "--check"], check=True)
    subprocess.run(["node", str(root / "extensions/edge/sync-shared.mjs"), "--check"], check=True)
    config = read_json(root / "release/config.json")
    from host.protocol_version import PROTOCOL_VERSION
    if config["protocolVersion"] != PROTOCOL_VERSION:
        raise ValueError("Protocol version differs between release config and host")
    return config


def validate_payload(files):
    manifest = json.loads(files["manifest.json"])
    if manifest["manifest_version"] != 3 or manifest.get("permissions") != PERMISSIONS:
        raise ValueError("Unexpected manifest version or permissions")
    if manifest.get("optional_permissions") != ["cookies"] or manifest.get("optional_host_permissions") != ["http://*/*", "https://*/*"]:
        raise ValueError("Unexpected optional permissions")
    allowed_keys = {"manifest_version", "name", "version", "description", "default_locale", "permissions", "optional_permissions", "optional_host_permissions", "action", "background", "icons", "minimum_chrome_version", "content_security_policy"}
    if set(manifest) - allowed_keys:
        raise ValueError("Unexpected manifest capability (key/update URL/content scripts etc.)")
    expected_csp = "script-src 'self'; object-src 'none'; img-src 'self' data: http: https:; media-src 'self' http: https:"
    if manifest.get('content_security_policy') != {'extension_pages': expected_csp}:
        raise ValueError('Unexpected extension content security policy')
    if manifest.get("default_locale") != "en" or manifest.get("name") != "__MSG_extensionName__" or manifest.get("description") != "__MSG_extensionDescription__":
        raise ValueError("Extension metadata must use the default-locale message references")
    references = [manifest["action"]["default_popup"], manifest["background"]["service_worker"], *manifest["icons"].values(), *manifest["action"]["default_icon"].values()]
    if manifest["background"].get("type") != "module":
        raise ValueError("The worker must be an ES module")
    for name, content in files.items():
        if name.endswith((".js", ".mjs", ".html", ".css")):
            text = content.decode("utf-8")
            if re.search(r"\beval\s*\(|\bnew\s+Function\s*\(|importScripts\s*\(|import\s*\(", text):
                raise ValueError(f"Dynamic executable code is not allowed: {name}")
            references += re.findall(r"(?:from\s*|import\s*)['\"]([^'\"]+)['\"]", text) if name.endswith((".js", ".mjs")) else []
            references += re.findall(r"(?:src|href)=[\"']([^\"']+)[\"']", text) if name.endswith(".html") else []
            references += re.findall(r"url\(['\"]?([^)'\"]+)", text) if name.endswith(".css") else []
    for ref in references:
        if ref.removeprefix("./") not in files:
            raise ValueError(f"Missing or nonlocal runtime resource: {ref}")
    for size, name in manifest["icons"].items():
        data = files[name]
        if data[:8] != b"\x89PNG\r\n\x1a\n" or int.from_bytes(data[16:20], "big") != int(size) or int.from_bytes(data[20:24], "big") != int(size):
            raise ValueError(f"Invalid icon dimensions: {name}")
    locale_files = [name for name in files if name.startswith("_locales/") and name.endswith("/messages.json")]
    if set(locale_files) != {"_locales/en/messages.json", "_locales/zh_CN/messages.json"}:
        raise ValueError("Both English and Simplified Chinese locale resources are required")
    locale_keys = []
    for name in locale_files:
        messages = json.loads(files[name])
        locale_keys.append(set(messages))
        for key, value in messages.items():
            if not re.fullmatch(r"[A-Za-z0-9_]+", key) or not isinstance(value, dict) or not isinstance(value.get("message"), str):
                raise ValueError(f"Invalid locale message: {name}:{key}")
    if locale_keys[0] != locale_keys[1]:
        raise ValueError("Locale message keys differ between English and Simplified Chinese")


def build_extension(browser, release=False, root=ROOT):
    config = check_generated(root)
    errors = config_errors(config, browser, release)
    if errors:
        raise ValueError("\n".join(errors))
    source = root / "extensions/edge"
    manifest = read_json(source / "manifest.json")
    manifest.pop("key", None)  # Store IDs are assigned by each store, never inferred.
    manifest["version"] = config["extensionVersion"]
    if not release:
        manifest["name"] = config["productName"] + " (DEVELOPMENT)"
    manifest["minimum_chrome_version"] = config["minimumBrowserVersion"]
    files = {name: (source / name).read_bytes() for name in RUNTIME}
    for locale in ("en", "zh_CN"):
        name = f"_locales/{locale}/messages.json"
        files[name] = (source / name).read_bytes()
    for size in (16, 32, 48, 128):
        name = f"icons/icon-{size}.png"
        files[name] = (source / name).read_bytes()
    files["NOTICE.txt"] = (root / "release/extension-NOTICE.txt").read_bytes()
    files["manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    validate_payload(files)
    output = root / "dist" / ("release" if release else "development")
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"frame-video-downloader-{browser}-{config['extensionVersion']}{'' if release else '-DEVELOPMENT'}.zip"
    temporary = path.with_suffix(".zip.tmp")
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, content in sorted(files.items()):
                info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED)
        with zipfile.ZipFile(temporary) as archive:
            validate_payload({name: archive.read(name) for name in archive.namelist()})
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    metadata = {"artifact": path.name, "sha256": sha256(path), "browser": browser,
                "version": config["extensionVersion"], "channel": "release" if release else "development",
                "storeExtensionId": config[f"{browser}ExtensionId"], "protocolVersion": config["protocolVersion"]}
    path.with_suffix(".json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("extension", "preflight"))
    parser.add_argument("--browser", choices=("edge", "chrome"), default="edge")
    parser.add_argument("--target", choices=("edge", "chrome", "host"), default="host")
    parser.add_argument("--release", action="store_true")
    parser.add_argument("--allow-unsigned", action="store_true", help="Allow an unsigned Host build; redistribution checks still apply")
    args = parser.parse_args()
    try:
        if args.command == "extension":
            print(build_extension(args.browser, args.release))
        else:
            config = check_generated()
            errors = config_errors(config, args.target, allow_unsigned=args.allow_unsigned)
            if args.target == "host":
                errors += dependency_errors()
            if errors:
                raise ValueError("\n".join(errors))
            print("Release inputs validated; signing and clean-machine acceptance are still required.")
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Build refused:\n{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
