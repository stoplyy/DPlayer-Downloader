# Standalone DPlayer CLI helper

`download_video.py` is a small, dependency-free script that predates the
extension. It parses a saved DPlayer page, extracts the HLS playlist URL from
the player's `data-config` attribute, and hands it to `yt-dlp`.

It is kept as a reference implementation of the DPlayer `data-config` shape the
extension's scanner targets, and as a quick way to verify a page's media URL
without installing the extension.

```powershell
python tools/download_video.py --html tools/sample-dplayer.html --dry-run
python tools/download_video.py --html tools/sample-dplayer.html --source video_h265
```

- `--source` selects `video` (default) or `video_h265` from the player config.
- `--dry-run` prints the URL with query parameters stripped and makes no request.
- Requires `yt-dlp` and `ffmpeg` on PATH for an actual download.

`sample-dplayer.html` is a captured DPlayer markup fragment used as the parser
fixture. Its signed URLs are expired; it is only used to exercise parsing.

Run its unit test with:

```powershell
python -m unittest discover -s tools -t . -v
```

## Local browser verification fixtures

`browser_fixture.py` generates two four-second MP4 files, an eight-second HLS
stream, and pages covering missing video IDs, multiple players, and multiple
renditions of one video. It uses the installed downloader's FFmpeg and serves
the pages on loopback:

```powershell
python tools/browser_fixture.py serve
```

Open `http://127.0.0.1:8766/no-id.html`, `/multi.html`, or `/renditions.html`
in an isolated Edge profile. Media uses the reserved name `media.fixture.test`.
For end-to-end downloads, register the script's `native` mode under a separate
test Native Messaging host and point an isolated extension copy at that host.
Do not replace the production registration. The fixture host runs the production
protocol and downloader with separate task state and permits only its local
fixture media address. Production network checks remain unchanged.

Generated media, isolated state, download files, and browser evidence are kept
under the ignored `output/playwright/` directory. Exercise duplicate detection,
pause/resume, deletion, service stop/start, and changing the output directory
while a task is paused; verify resulting files with FFprobe. Remove the temporary
test-host registry entry when the isolated browser is closed.
