$ErrorActionPreference = 'Stop'
$HostName = 'com.local.frame_video_downloader'
$ExtensionId = 'mcpnbecppicmobinpgiiomjihgcfikdl'
$BaseDirectory = Join-Path $env:LOCALAPPDATA 'FrameVideoDownloader'
$AppDirectory = Join-Path $BaseDirectory 'app'
$ManifestPath = Join-Path $AppDirectory "$HostName.json"
$RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
$PackageDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path (Join-Path $PackageDirectory 'native-host.exe'))) {
    throw 'Package is incomplete: native-host.exe is missing.'
}
if (-not (Test-Path (Join-Path $PackageDirectory 'extension\manifest.json'))) {
    throw 'Package is incomplete: extension manifest is missing.'
}
if (-not (Test-Path (Join-Path $PackageDirectory 'tools\yt-dlp.exe'))) {
    throw 'Package is incomplete: yt-dlp.exe is missing.'
}
if (-not (Test-Path (Join-Path $PackageDirectory 'tools\ffmpeg.exe'))) {
    throw 'Package is incomplete: ffmpeg.exe is missing.'
}
if (-not (Test-Path (Join-Path $PackageDirectory 'tools\ffprobe.exe'))) {
    throw 'Package is incomplete: ffprobe.exe is missing.'
}

New-Item -ItemType Directory -Force -Path $AppDirectory | Out-Null
Copy-Item -Path (Join-Path $PackageDirectory 'native-host.exe') -Destination $AppDirectory -Force
Copy-Item -Path (Join-Path $PackageDirectory 'extension') -Destination $AppDirectory -Recurse -Force
Copy-Item -Path (Join-Path $PackageDirectory 'tools') -Destination $AppDirectory -Recurse -Force
Copy-Item -Path (Join-Path $PackageDirectory 'licenses') -Destination $AppDirectory -Recurse -Force

$Manifest = Get-Content (Join-Path $PackageDirectory 'native-host-manifest.template.json') -Raw | ConvertFrom-Json
$Manifest.path = Join-Path $AppDirectory 'native-host.exe'
$Manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
$Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding utf8
New-Item -Path $RegistryPath -Force | Out-Null
Set-Item -Path $RegistryPath -Value $ManifestPath

Write-Host "Native host installed for the current Windows user: $ManifestPath"
Write-Host 'Open edge://extensions, enable Developer mode, and choose Load unpacked.'
Start-Process 'msedge.exe' 'edge://extensions' -ErrorAction SilentlyContinue
