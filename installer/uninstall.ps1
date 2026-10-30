$ErrorActionPreference = 'Stop'
$HostName = 'com.local.frame_video_downloader'
$AppDirectory = Join-Path (Join-Path $env:LOCALAPPDATA 'FrameVideoDownloader') 'app'
$RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
if (Test-Path -LiteralPath (Join-Path $AppDirectory 'unins000.exe')) {
    throw 'Use Windows Installed apps or app/unins000.exe to uninstall the store Host.'
}
$ResolvedApp = [IO.Path]::GetFullPath($AppDirectory)
$ExpectedApp = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'FrameVideoDownloader/app'))
if ($ResolvedApp -ne $ExpectedApp) { throw 'Refusing to remove a directory outside the expected app path.' }

if (Test-Path $RegistryPath) {
    Remove-Item -Path $RegistryPath -Recurse -Force
}
if (Test-Path $AppDirectory) {
    Remove-Item -LiteralPath $ResolvedApp -Recurse -Force
}

Write-Host 'The extension host application and registration were removed.'
Write-Host 'Task state and downloaded files were preserved.'
