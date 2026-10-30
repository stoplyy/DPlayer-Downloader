## Downloads

- Microsoft Edge extension: `frame-video-downloader-edge-<version>.zip`
- Windows 10/11 x64 Host installer: attach the signed `frame-video-downloader-host-<version>-windows-x64.exe` before publishing this draft.

The Host installer is required for downloads. It is built and signed on the maintainer's Windows release machine; it is not produced by GitHub Actions. Follow the [installation and update guide](https://github.com/stoplyy/DPlayer-Downloader/blob/main/docs/installation.md): download the Windows x64 installer, run it for your Windows account, return to the extension, then choose **Retry connection / 重试连接**. No administrator rights or Python installation are required.

See `release-manifest.json` for installer signature, publisher, and SHA-256 details. See the extension JSON sidecar for the extension package SHA-256.

## Requirements

- Windows 10/11 x64 for local downloads
- Microsoft Edge 120 or later
- Install the Windows Host component, then restart the browser

## Source

This release was built from the tagged source commit. Review the repository's release checklist and bundled license notices before redistributing.
