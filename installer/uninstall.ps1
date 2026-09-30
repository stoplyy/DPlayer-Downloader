$ErrorActionPreference = 'Stop'
$HostName = 'com.local.frame_video_downloader'
$AppDirectory = Join-Path (Join-Path $env:LOCALAPPDATA 'FrameVideoDownloader') 'app'
$RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

if (Test-Path $RegistryPath) {
    Remove-Item -Path $RegistryPath -Recurse -Force
}
if (Test-Path $AppDirectory) {
    Remove-Item -Path $AppDirectory -Recurse -Force
}

Write-Host 'The extension host application and registration were removed.'
Write-Host 'Task state and downloaded files were preserved.'
