<#
.SYNOPSIS
    Rebuild the Native Messaging host from source and install the current
    extension into the user's app directory.

.DESCRIPTION
    Development helper. The release build (installer/build.ps1) is intentionally
    fail-closed and requires reviewed vendor binaries with pinned hashes; this
    script is for the local edit/rebuild/test loop.

    It rebuilds native-host.exe from host/, copies the current extension, writes
    the Native Messaging manifest, and registers it for the current Windows user
    so the already-loaded (unpacked) extension picks it up after a reload.

    After running this, reload the extension at edge://extensions.
#>
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.local.frame_video_downloader'
$ExtensionId = 'mcpnbecppicmobinpgiiomjihgcfikdl'
$BaseDirectory = Join-Path $env:LOCALAPPDATA 'FrameVideoDownloader'
$AppDirectory = Join-Path $BaseDirectory 'app'
$ManifestPath = Join-Path $AppDirectory "$HostName.json"
$RegistryPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"

Push-Location $ProjectRoot
try {
    $BuiltHost = Join-Path $ProjectRoot '.devbuild/native-host.exe'
    if (-not $SkipBuild) {
        # Keep the shared copies in step before packaging the extension.
        & node (Join-Path $ProjectRoot 'extensions/edge/sync-shared.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Failed to sync shared extension modules.' }

        $Stage = [IO.Path]::GetFullPath((Join-Path $ProjectRoot '.devbuild'))
        $ExpectedStage = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\.devbuild'
        if ($Stage -ne $ExpectedStage) { throw 'Build directory is outside the project.' }
        if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $Stage | Out-Null

        Write-Host 'Building native-host.exe from host/ ...'
        & python -m PyInstaller --noconfirm --clean --onefile --name native-host `
            --distpath $Stage --workpath (Join-Path $Stage 'work') --specpath (Join-Path $Stage 'spec') `
            --paths $ProjectRoot (Join-Path $ProjectRoot 'host/native_host.py')
        if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed.' }
    }
    # -SkipBuild reuses the previous build, so the artefact must still exist.
    if (-not (Test-Path -LiteralPath $BuiltHost -PathType Leaf)) {
        throw "No built host found at $BuiltHost. Run again without -SkipBuild."
    }

    New-Item -ItemType Directory -Force -Path $AppDirectory | Out-Null

    # A host process spawned by Edge keeps native-host.exe locked. Refuse to
    # proceed while a download is in flight, otherwise stop the idle hosts.
    $Downloads = @(Get-Process -Name 'yt-dlp*', 'ffmpeg*' -ErrorAction SilentlyContinue)
    if ($Downloads.Count -gt 0) {
        throw "A download is in progress ($($Downloads.Count) worker process(es)). Stop it before updating, or partial files may be left behind."
    }
    $RunningHosts = @(Get-Process -Name 'native-host' -ErrorAction SilentlyContinue)
    if ($RunningHosts.Count -gt 0) {
        Write-Host "Stopping $($RunningHosts.Count) idle host process(es) to release the binary lock ..."
        $RunningHosts | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 800
    }

    Copy-Item $BuiltHost (Join-Path $AppDirectory 'native-host.exe') -Force

    # Always refresh the extension copy so source edits reach the loaded version.
    $ExtensionTarget = Join-Path $AppDirectory 'extension'
    $ExtensionTarget = [IO.Path]::GetFullPath($ExtensionTarget)
    $ExpectedExtension = [IO.Path]::GetFullPath($AppDirectory).TrimEnd('\') + '\extension'
    if ($ExtensionTarget -ne $ExpectedExtension) { throw 'Extension directory is outside the app.' }
    if (Test-Path -LiteralPath $ExtensionTarget) { Remove-Item -LiteralPath $ExtensionTarget -Recurse -Force }
    Copy-Item (Join-Path $ProjectRoot 'extensions/edge') $ExtensionTarget -Recurse -Force

    $Manifest = Get-Content (Join-Path $PSScriptRoot 'native-host-manifest.template.json') -Raw | ConvertFrom-Json
    $Manifest.path = Join-Path $AppDirectory 'native-host.exe'
    $Manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding utf8
    New-Item -Path $RegistryPath -Force | Out-Null
    Set-Item -Path $RegistryPath -Value $ManifestPath

    $ProtocolVersion = (& python -c "from host.protocol_version import PROTOCOL_VERSION; print(PROTOCOL_VERSION)").Trim()

    # Fail loudly if the installed binary did not change: silently keeping a
    # stale host is what makes the UI fail with errors the host never knew.
    $Installed = Get-Item (Join-Path $AppDirectory 'native-host.exe')
    $SourceHash = (Get-FileHash $BuiltHost -Algorithm SHA256).Hash
    $InstalledHash = (Get-FileHash $Installed.FullName -Algorithm SHA256).Hash
    if ($SourceHash -ne $InstalledHash) {
        throw 'Installed native-host.exe does not match the build output; the update did not take effect.'
    }

    Write-Host ''
    Write-Host "Installed host + extension to $AppDirectory (protocol v$ProtocolVersion)."
    Write-Host "native-host.exe: $($Installed.LastWriteTime)  sha256 $($InstalledHash.Substring(0, 16))..."
    Write-Host 'Now open edge://extensions and click "重新加载" on the extension.'
} finally {
    Pop-Location
}
