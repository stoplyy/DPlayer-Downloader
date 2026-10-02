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

Run `uninstall.ps1` to remove the app files and Native Messaging registration. Task state and downloaded media are kept under `%LOCALAPPDATA%\FrameVideoDownloader\state` and `%USERPROFILE%\Downloads\FrameVideos`. The download directory can be changed from the popup settings panel; the choice is persisted in `%LOCALAPPDATA%\FrameVideoDownloader\settings.json`.

Each task row includes an “打开目录” action that opens its dedicated folder under `%USERPROFILE%\Downloads\FrameVideos\<taskId>`.

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

## Bridge self-recovery

The extension keeps the local download service running on its own. It connects
to the Native Messaging host on browser startup, on install/upgrade, and again
after any disconnect, retrying with a bounded backoff (1s, 2s, 5s). A pending
retry is also registered as an alarm so it still fires if Edge suspends the MV3
service worker.

The handshake compares a protocol version (`host/protocol_version.py` and
`extensions/shared/bridge_status.mjs`). An older host that answers `ping` but
rejects newer messages is reported as a version mismatch with a reinstall
action, instead of failing later on an unrelated action.

If the host is unavailable, the popup shows the exact failure code and a
concrete action instead of a generic "disconnected" label:

- **未安装或未注册** – run `installer\install.ps1` as the current Windows user, then click 启动服务.
- **版本不一致** – rebuild/reinstall so host and extension match, then reload the extension.
- **权限被拒绝** – verify `native-host.exe` exists and is executable.
- **进程已退出** – click 启动服务 to relaunch the process.

Click **启动服务** to start it manually at any time, or **停止服务** to stop it.
Click the status text for a diagnostics popup listing yt-dlp/ffmpeg availability
and whether the download directory is writable. On host startup, any task still
marked queued/downloading/finalizing (left over from an abrupt exit) is marked
`interrupted` so the queue never shows a task that is stuck forever.

### Rebuilding after a source change

After editing anything under `host/` or `extensions/`, run:

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
- Cookie access is off by default. When enabled, the extension requests optional permission for each selected media host from that click; it reads cookies only after all requested hosts are approved. A denial stops the login-state operation. Cookie files are scoped to each authorized URL's exact hostname, use a current-user-only ACL on Windows, are not logged or persisted in task JSON, and are deleted when the worker ends.
- The page may not reveal CDN or redirect hosts before download. Cookies are deliberately not broadened to parent domains or unknown CDN hosts. A source that requires a separate CDN login cookie may fail; authorize and scan that host explicitly if it is surfaced as a candidate.
- Signed media URLs are encrypted with Windows DPAPI in task state. The extension UI displays URLs without query strings.
- The popup settings panel stores two user preferences. "自动允许访问的站点" is a list of hostnames whose media candidates are pre-selected after a scan; matching covers the hostname and its subdomains only. "下载保存路径" sets the absolute folder that the Native Host uses for task output; it is validated and created by the host, and an invalid path is rejected with an error instead of falling back to a default.
- The local egress proxy rejects non-public DNS answers and forwards HTTP requests through pinned addresses. Current tests cover local HTTP HLS routes, private-address refusal, and interrupted native-HLS continuation. HTTPS `CONNECT` exposes only the tunnel authority, not encrypted internal redirect/segment paths; this is not a claim of a full network sandbox against a compromised downloader.
- Do not use this tool to bypass access controls or download material without permission. No real-site download has been used as a test.
