# Vendor Inputs

The release build deliberately fails until every reviewed input is present.

The public distribution is now a signed Windows **Host-only Inno Setup installer**.
No extension or developer PowerShell installer is bundled. Edge and Chrome store
ZIPs are built separately and contain no vendor binaries.

Required files:

- `yt-dlp.exe` matching the exact version and SHA-256 in `approved-licenses.json`.
- `yt-dlp-source.tar.gz` containing the corresponding source for the exact release.
- `ffmpeg.exe` and `ffprobe.exe` matching the recorded hashes and version.
- `ffmpeg-source.tar.xz` containing the corresponding complete source for commit `38b88335f9`.
- `licenses/yt-dlp.txt` and `licenses/ffmpeg-GPL-3.0.txt`.
- `licenses/THIRD-PARTY-NOTICES.txt` covering all bundled FFmpeg external libraries and PyInstaller/runtime notices.
- `licenses/Python.txt` and `licenses/PyInstaller.txt`, plus all transitive dependency licenses and corresponding-source/build materials required by the reviewed binaries.

Set `redistributionReview.approved`, `reviewedBy`, `reviewedAt` only after review.
Pin every reviewed license/source/build material in `redistributionReview.materials`
as `{ "path": "licenses/...", "sha256": "<lowercase SHA-256>" }`. Paths are relative
to vendor; files are copied into the Host installer. Main source archive hashes
remain in the ytDlp/ffmpeg fields. A main FFmpeg repository archive is not the
complete corresponding source for a full GPL build with external libraries.
The pipeline cannot prove legal sufficiency; the recorded review is required.

The build validates original executable hashes before signing staged copies.
Original and signed hashes are both recorded in the release manifest. It never
silently downloads/replaces dependencies. Runtime/installer signing is separate
from the license review and does not imply upstream endorsement.

Both `ytDlp.sourceArchiveSha256` and `ffmpeg.sourceArchiveSha256` are intentionally empty. Do not fill them from unreviewed downloads: independently verify each archive corresponds to the exact binary and source release, then pin the hashes only after review. The local Gyan FFmpeg build enables GPLv3 and many external libraries; a copy of the GPL text alone is not a sufficient release audit.
