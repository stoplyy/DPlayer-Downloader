# Vendor Inputs

The release build deliberately fails until every reviewed input is present.

Required files:

- `yt-dlp.exe` matching the exact version and SHA-256 in `approved-licenses.json`.
- `yt-dlp-source.tar.gz` containing the corresponding source for the exact release.
- `ffmpeg.exe` and `ffprobe.exe` matching the recorded hashes and version.
- `ffmpeg-source.tar.xz` containing the corresponding complete source for commit `38b88335f9`.
- `licenses/yt-dlp.txt` and `licenses/ffmpeg-GPL-3.0.txt`.
- `licenses/THIRD-PARTY-NOTICES.txt` covering all bundled FFmpeg external libraries and PyInstaller/runtime notices.

Both `ytDlp.sourceArchiveSha256` and `ffmpeg.sourceArchiveSha256` are intentionally empty. Do not fill them from unreviewed downloads: independently verify each archive corresponds to the exact binary and source release, then pin the hashes only after review. The local Gyan FFmpeg build enables GPLv3 and many external libraries; a copy of the GPL text alone is not a sufficient release audit.
