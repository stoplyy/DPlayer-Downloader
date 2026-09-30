# Frame Video Downloader

Scan and download DPlayer-style HLS/MP4 media from the active browser tab.

The project ships a browser extension, a local Native Messaging host, and a
download engine built on `yt-dlp` + `ffmpeg`. Downloads run locally, HLS tasks
resume from completed fragments, and every task is persisted so it can be
resumed after a browser restart.

## Repository layout

```
DPlayer-Downloader/
├─ extensions/
│   ├─ shared/          # Browser-agnostic ES modules (single source of truth)
│   │   ├─ scanner.mjs              # media candidate normalization + de-duplication
│   │   ├─ size_display.mjs         # byte-size formatting for candidate rows
│   │   ├─ probe_queue.mjs          # bounded-concurrency size probe queue
│   │   ├─ task_actions.mjs         # task action message validation
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
4. Add the browser's Native Messaging registry key to `installer/install.ps1`
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

## Release build

The release build is intentionally fail-closed. Prepare the reviewed inputs
described in `vendor/README.md`, including matching yt-dlp/FFmpeg binaries,
complete third-party notices, and the exact yt-dlp and FFmpeg source archives.
Review each source archive independently and pin its SHA-256 in
`vendor/approved-licenses.json`; those fields are blank until review. Then run:

```powershell
.\installer\build.ps1
```

A successful build creates `dist/frame-video-downloader-windows-x64.zip`. No
release ZIP is produced while any required binary, hash, source archive, or
license notice is missing.

## Install and remove

Extract the ZIP, then run `install.ps1` for the current Windows user. It installs the host under `%LOCALAPPDATA%\FrameVideoDownloader\app`, registers the Native Messaging manifest under the current user's Edge registry key, and opens `edge://extensions`. Enable Developer mode and load the installed `extension` directory as unpacked.

Run `uninstall.ps1` to remove the app files and Native Messaging registration. Task state and downloaded media are kept under `%LOCALAPPDATA%\FrameVideoDownloader\state` and `%USERPROFILE%\Downloads\FrameVideos`.

Each task row includes an “打开目录” action that opens its dedicated folder under `%USERPROFILE%\Downloads\FrameVideos\<taskId>`.

## Privacy and limitations

- Scanning only runs after the user clicks the popup action. It reads media-like HTTP(S) URLs visible in video/source elements, player JSON configuration, and the page's resource timing entries. A `blob:` URL is not treated as a downloadable source.
- Cookie access is off by default. When enabled, the extension requests optional permission for each selected media host from that click; it reads cookies only after all requested hosts are approved. A denial stops the login-state operation. Cookie files are scoped to each authorized URL's exact hostname, use a current-user-only ACL on Windows, are not logged or persisted in task JSON, and are deleted when the worker ends.
- The page may not reveal CDN or redirect hosts before download. Cookies are deliberately not broadened to parent domains or unknown CDN hosts. A source that requires a separate CDN login cookie may fail; authorize and scan that host explicitly if it is surfaced as a candidate.
- Signed media URLs are encrypted with Windows DPAPI in task state. The extension UI displays URLs without query strings.
- The local egress proxy rejects non-public DNS answers and forwards HTTP requests through pinned addresses. Current tests cover local HTTP HLS routes, private-address refusal, and interrupted native-HLS continuation. HTTPS `CONNECT` exposes only the tunnel authority, not encrypted internal redirect/segment paths; this is not a claim of a full network sandbox against a compromised downloader.
- Do not use this tool to bypass access controls or download material without permission. No real-site download has been used as a test.
