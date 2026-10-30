# Frame Video Downloader

Scan DPlayer-style media from the active browser tab. **Phase 1 downloading is
supported only on Windows 10/11 x64 with Microsoft Edge or Google Chrome 120+**;
the browser extension alone is not a cross-platform downloader.

The project ships Edge and Chrome store extensions, a local Native Messaging host, and a
download engine built on `yt-dlp` + `ffmpeg`. Downloads run locally, HLS tasks
resume from completed fragments, and every task is persisted so it can be
resumed after a browser restart.

On macOS, Linux, and ChromeOS, the Edge/Chrome extension may be installed for
page scanning and candidate selection, but Phase 1 has no local download host
for those systems. Downloading, size probing, and local task management require
the Windows x64 Host. Windows ARM64 and 32-bit Windows are not supported targets.

## Repository layout

```
DPlayer-Downloader/
├─ extensions/
│   ├─ shared/          # Browser-agnostic ES modules (single source of truth)
│   │   ├─ scanner.mjs              # media candidate normalization + de-duplication
│   │   ├─ size_display.mjs         # byte-size formatting for candidate rows
│   │   ├─ probe_queue.mjs          # bounded-concurrency size probe queue
│   │   ├─ task_actions.mjs         # task action message validation
│   │   ├─ settings.mjs             # user settings (allowed sites, download directory)
│   │   ├─ bridge_status.mjs        # bridge failure classification + reconnect backoff
│   │   ├─ media_identity.mjs       # signature-free media identity for duplicate detection
│   │   └─ cookie_authorization.mjs # per-host cookie permission + retrieval
│   └─ edge/            # Microsoft Edge (MV3) extension
│       ├─ manifest.json
│       ├─ popup.html / popup.css / popup.js
│       ├─ service_worker.js
│       └─ sync-shared.mjs          # copies extensions/shared into this directory
├─ host/                # Native Messaging host (Python 3.12, browser-agnostic)
├─ installer/           # build + per-browser install/uninstall scripts
├─ tests/               # Python unittest + Node test runner suites
├─ tools/               # standalone DPlayer CLI helper and sample fixture
├─ vendor/              # reviewed third-party binaries and license inputs
└─ docs/                # design notes, implementation plan, popup preview
```

### Why `extensions/shared` is copied, not imported

Chrome/Edge MV3 `chrome.scripting.executeScript` cannot inject an ES module, so
the shared modules must exist as physical files inside each browser extension
directory. `extensions/shared` is the single source of truth; run

```powershell
node extensions/edge/sync-shared.mjs
```

after editing anything under `extensions/shared`. The release build runs
`sync-shared.mjs --check` and fails if a browser copy is stale.

### Adding another browser

1. Create `extensions/<browser>/` with its own `manifest.json`, `popup.*`, and
   background script.
2. Copy `extensions/edge/sync-shared.mjs` into it (the script resolves
   `../shared` relative to its own location, so no edits are required).
3. Run `node extensions/<browser>/sync-shared.mjs`.
4. Add the browser's Native Messaging registration to `installer/host.iss`
   (Edge uses `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts`,
   Chrome uses `HKCU:\Software\Google\Chrome\NativeMessagingHosts`).

## Development checks

Run from the repository root:

```powershell
node --test tests/*.mjs
python -m unittest discover -s tests -t . -v
```

The HLS integration test uses locally generated media and a loopback HTTP
server only. It requires local `ffmpeg` and `yt-dlp` on PATH. It does not access
external media URLs.

## Install and remove

The supported Phase 1 download distribution is **Microsoft Edge Add-ons / Chrome
Web Store + a separate signed Windows Host installer**. Complete downloading
requires Windows 10/11 x64 and Edge or Chrome 120+. Store listings are pending;
no store ID or signing identity is invented in this repository.

1. Install [Frame Video Downloader from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/0RDCKF2Z9NKQ).
   Scanning and candidate selection work without the Host.
2. To download, follow the popup's installation link to
   [GitHub Releases](https://github.com/stoplyy/DPlayer-Downloader/releases) and
   download the signed Windows x64 Host installer. Follow the
   [installation guide](docs/installation.md); the installer is per-user and
   does not need administrator rights, Python, Developer mode or unpacked
   extension loading.
3. Return to the extension and click **重试连接**. Downloads require a compatible
   Host handshake. Edge updates come from the store; Host updates are installed
   manually from the official release page. Chrome Web Store publication is
   pending.

Remove the extension in browser settings. Remove **Frame Video Downloader Host**
in Windows Installed apps. Host uninstall preserves downloads, task state and
settings. See [installation and migration](docs/installation.md) and
[privacy policy](docs/privacy-policy.md) for data locations and optional cleanup.
Only one browser Host session may manage a user's task state at a time; stop the
service in the other browser before switching.

## Release build

See [release checklist](docs/release-checklist.md). Public metadata belongs in
`release/config.json`; fill store IDs and signing identity when publishing.
Private keys and passwords never belong in that file. Each store ZIP contains
only the allowlisted extension runtime, icons and notice, with manifest.json at
its root. Both use the canonical source in `extensions/edge`.

```powershell
node tools/sync-release.mjs
node extensions/edge/sync-shared.mjs
# Inspectable development ZIPs, distinctly named; no credentials needed.
python -m tools.build_release extension --browser edge
python -m tools.build_release extension --browser chrome
# Formal store packages: requires confirmed store IDs and public URLs.
python -m tools.build_release extension --browser edge --release
python -m tools.build_release extension --browser chrome --release
# Signed Host installer: also requires reviewed vendor inputs and signing tools.
pwsh -File installer/build.ps1 -Iscc 'C:\path\ISCC.exe' -SignTool 'C:\path\signtool.exe'
```

The Host installer includes yt-dlp, FFmpeg/ffprobe, corresponding source and
license materials; it registers both browsers under HKCU with exactly the two
confirmed store IDs. The build checks hashes, versions, publisher signatures
and timestamps and emits a release manifest. Missing inputs block official
artifacts. Review Inno Setup's distribution license before commercial use.
It never uploads a package. Development ZIPs go to `dist/development`; formal
outputs go to `dist/release`.

## Select all downloads

After scanning, click **全选** above the media list, then **下载已选** to queue
all selected videos. Click the checkbox again to clear the selection, or
uncheck individual videos. The checkbox shows a mixed state when only some
videos are selected; the footer always shows the selected count.

## Duplicate downloads

A URL alone is not a reliable identity: these sites rotate the signed CDN path
between page loads, and expose one video under several renditions (`video` and
`video_h265`) with completely different paths. Deduplication therefore uses two
keys, checked in order:

1. **`contentKey`** – a hash of the page hostname plus the player's own video id
   (`data-video_id` and similar attributes). This is stable across reloads, path
   rotation, and renditions, so the same video is recognized no matter which URL
   the page hands out.
2. **`mediaKey`** – a hash of the media URL with volatile signing parameters
   removed (`auth_key`, `token`, `expires`, `X-Amz-*`, and similar). Used as a
   fallback for pages that expose no video id.

Before starting a task, the popup and the host both check for an existing task
matching either key. A match in `queued`, `downloading`, `paused`, `interrupted`,
`finalizing`, or `completed` is refused and reported as a skipped duplicate.
`cancelled` and `failed` tasks are intentionally excluded so the user can retry
them. Selecting two renditions of one video in a single batch also queues only
the first.

## Host connection and recovery

A bounded handshake reports checking, ready, not installed, incompatible or
failed. Missing/incompatible components wait for a manual retry rather than
repeatedly launching processes. Unexpected disconnections use bounded backoff;
state is persisted across worker suspension. Scan and local site preferences
remain available while the Host is unavailable. Automatic size probes only run
when the component is ready; the popup discloses these media-server requests.

The handshake checks both protocol and minimum Host version. The install/update
panel points to fixed project HTTPS URLs, never downloads or executes an
installer automatically, and does not mistake an opened release page for a
successful installation. Active downloads are marked interrupted on recovery
and require a user action to resume.

### Development installation / rebuilding after a source change

Developer-only unpacked loading is supported for local testing. Do not use it
as the public installation flow. The helper refuses to overwrite an installation
managed by the official installer. After editing source, run:

```powershell
.\installer\rebuild-dev.ps1
```

It rebuilds `native-host.exe` from source, refreshes the installed extension
copy, re-registers the Native Messaging manifest, and prints the protocol
version. Then click **重新加载** at `edge://extensions`. Skipping this step is
what makes the UI fail with errors the host never understood.

To check which message types an installed binary actually supports:

```powershell
python tools\probe_native_host.py
```

This probe is read-only; it never changes settings or starts a download.

## Privacy and limitations

- Scanning only runs after the user clicks the popup action. It reads media-like HTTP(S) URLs visible in video/source elements, player JSON configuration, and the page's resource timing entries. A `blob:` URL is not treated as a downloadable source.
- After a scan, the popup attempts to display a page-provided poster or an anonymous cross-origin MP4/WebM frame preview. It does not read website cookies for previews; media servers receive the preview request directly from the browser. Unsupported formats, protected streams, and servers without anonymous CORS support show a placeholder instead.
- Cookie access is off by default. When enabled, the extension requests optional permission for each selected media host from that click; it reads cookies only after all requested hosts are approved. A denial stops the login-state operation. Cookie files are scoped to each authorized URL's exact hostname, use a current-user-only ACL on Windows, are not logged or persisted in task JSON, and are deleted when the worker ends.
- The page may not reveal CDN or redirect hosts before download. Cookies are deliberately not broadened to parent domains or unknown CDN hosts. A source that requires a separate CDN login cookie may fail; authorize and scan that host explicitly if it is surfaced as a candidate.
- Signed media URLs are encrypted with Windows DPAPI in task state. The extension UI displays URLs without query strings.
- The popup settings panel stores two user preferences. "自动勾选资源的站点" is a list of hostnames whose media candidates are pre-selected after a scan; matching covers the hostname and its subdomains only. "下载保存路径" sets the absolute folder that the Native Host uses for task output; it is validated and created by the host, and an invalid path is rejected with an error instead of falling back to a default.
- The local egress proxy rejects non-public DNS answers and forwards HTTP requests through pinned addresses. Current tests cover local HTTP HLS routes, private-address refusal, and interrupted native-HLS continuation. HTTPS `CONNECT` exposes only the tunnel authority, not encrypted internal redirect/segment paths; this is not a claim of a full network sandbox against a compromised downloader.
- Do not use this tool to bypass access controls or download material without permission. No real-site download has been used as a test.
