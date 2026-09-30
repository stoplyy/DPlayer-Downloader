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
