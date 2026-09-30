param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$OutputZip = (Join-Path (Join-Path $ProjectRoot 'dist') 'frame-video-downloader-windows-x64.zip')
)

$ErrorActionPreference = 'Stop'
$Vendor = Join-Path $ProjectRoot 'vendor'
$ApprovalPath = Join-Path $Vendor 'approved-licenses.json'
$Stage = Join-Path $ProjectRoot '.build'
$Package = Join-Path $Stage 'package'
$SourceArchive = Join-Path $Vendor 'ffmpeg-source.tar.xz'

function Assert-File([string]$Path, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Release input is missing: $Description ($Path)"
    }
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Description) {
    if ($Expected -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "No reviewed SHA-256 is pinned for $Description. Release build refused."
    }
    $Actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($Actual -ne $Expected.ToUpperInvariant()) {
        throw "SHA-256 mismatch for $Description. Expected $Expected, got $Actual."
    }
}

Assert-File $ApprovalPath 'approved dependency manifest'
$Approval = Get-Content -LiteralPath $ApprovalPath -Raw | ConvertFrom-Json
$YtDlp = Join-Path $Vendor 'yt-dlp.exe'
$YtDlpSource = Join-Path $Vendor 'yt-dlp-source.tar.gz'
$Ffmpeg = Join-Path $Vendor 'ffmpeg.exe'
$Ffprobe = Join-Path $Vendor 'ffprobe.exe'
$YtLicense = Join-Path $Vendor $Approval.ytDlp.licenseFile
$FfmpegLicense = Join-Path $Vendor $Approval.ffmpeg.licenseFile
$ThirdPartyNotices = Join-Path $Vendor 'licenses/THIRD-PARTY-NOTICES.txt'

Assert-File $YtDlp 'yt-dlp executable'
Assert-File $YtDlpSource 'corresponding yt-dlp source archive'
Assert-File $Ffmpeg 'ffmpeg executable'
Assert-File $Ffprobe 'ffprobe executable'
Assert-File $SourceArchive 'corresponding FFmpeg source archive'
Assert-File $YtLicense 'yt-dlp license text'
Assert-File $FfmpegLicense 'FFmpeg GPL license text'
Assert-File $ThirdPartyNotices 'third-party notices for all bundled components'

Assert-Sha256 $YtDlp $Approval.ytDlp.sha256 'yt-dlp'
Assert-Sha256 $YtDlpSource $Approval.ytDlp.sourceArchiveSha256 'yt-dlp source archive'
Assert-Sha256 $Ffmpeg $Approval.ffmpeg.sha256 'ffmpeg'
Assert-Sha256 $Ffprobe $Approval.ffmpeg.ffprobeSha256 'ffprobe'
Assert-Sha256 $SourceArchive $Approval.ffmpeg.sourceArchiveSha256 'FFmpeg source archive'

$YtVersion = (& $YtDlp --version).Trim()
if ($LASTEXITCODE -ne 0 -or $YtVersion -ne $Approval.ytDlp.version) {
    throw "yt-dlp version mismatch: expected $($Approval.ytDlp.version), got $YtVersion."
}
$FfmpegVersion = (& $Ffmpeg -version | Select-Object -First 1).Trim()
if ($FfmpegVersion -notmatch [regex]::Escape($Approval.ffmpeg.version)) {
    throw "ffmpeg version mismatch: expected $($Approval.ffmpeg.version), got $FfmpegVersion."
}

$PyInstaller = & python -c "import PyInstaller; print(PyInstaller.__version__)" 2>$null
if ($LASTEXITCODE -ne 0 -or $PyInstaller -ne '6.20.0') {
    throw "PyInstaller 6.20.0 is required; found '$PyInstaller'."
}

$Extension = Join-Path $ProjectRoot 'extensions/edge'
foreach ($Required in @('manifest.json', 'popup.html', 'popup.css', 'popup.js', 'service_worker.js', 'scanner.mjs', 'cookie_authorization.mjs', 'task_actions.mjs', 'size_display.mjs', 'probe_queue.mjs')) {
    Assert-File (Join-Path $Extension $Required) "extensions/edge/$Required"
}

& node (Join-Path $Extension 'sync-shared.mjs') --check
if ($LASTEXITCODE -ne 0) {
    throw 'extensions/edge contains out-of-date copies of extensions/shared. Run: node extensions/edge/sync-shared.mjs'
}
Assert-File (Join-Path $PSScriptRoot 'native-host-manifest.template.json') 'Native Messaging manifest template'
Assert-File (Join-Path $PSScriptRoot 'install.ps1') 'installer script'
Assert-File (Join-Path $PSScriptRoot 'uninstall.ps1') 'uninstaller script'
Assert-File (Join-Path $ProjectRoot 'README.md') 'release README'

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Package, (Join-Path $Package 'tools'), (Join-Path $Package 'licenses') | Out-Null
Push-Location $ProjectRoot
try {
    & python -m PyInstaller --noconfirm --clean --onefile --name native-host --distpath $Package --workpath (Join-Path $Stage 'work') --specpath (Join-Path $Stage 'spec') --paths $ProjectRoot (Join-Path $ProjectRoot 'host/native_host.py')
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed.' }
} finally {
    Pop-Location
}

Copy-Item $Extension (Join-Path $Package 'extension') -Recurse
Copy-Item $YtDlp (Join-Path $Package 'tools/yt-dlp.exe')
Copy-Item $Ffmpeg (Join-Path $Package 'tools/ffmpeg.exe')
Copy-Item $Ffprobe (Join-Path $Package 'tools/ffprobe.exe')
Copy-Item $YtLicense (Join-Path $Package 'licenses/yt-dlp.txt')
Copy-Item $FfmpegLicense (Join-Path $Package 'licenses/ffmpeg-GPL-3.0.txt')
Copy-Item $ThirdPartyNotices (Join-Path $Package 'licenses/THIRD-PARTY-NOTICES.txt')
Copy-Item $SourceArchive (Join-Path $Package 'licenses/ffmpeg-source.tar.xz')
Copy-Item $YtDlpSource (Join-Path $Package 'licenses/yt-dlp-source.tar.gz')
Copy-Item (Join-Path $PSScriptRoot 'native-host-manifest.template.json'), (Join-Path $PSScriptRoot 'install.ps1'), (Join-Path $PSScriptRoot 'uninstall.ps1'), (Join-Path $ProjectRoot 'README.md') -Destination $Package

$RequiredPackageFiles = @(
    'native-host.exe',
    'tools/yt-dlp.exe',
    'tools/ffmpeg.exe',
    'tools/ffprobe.exe',
    'licenses/yt-dlp.txt',
    'licenses/ffmpeg-GPL-3.0.txt',
    'licenses/THIRD-PARTY-NOTICES.txt',
    'licenses/ffmpeg-source.tar.xz',
    'licenses/yt-dlp-source.tar.gz'
)
foreach ($RelativePath in $RequiredPackageFiles) {
    Assert-File (Join-Path $Package $RelativePath) "staged package/$RelativePath"
}

$OutputDirectory = Split-Path -Parent $OutputZip
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
if (Test-Path $OutputZip) { Remove-Item $OutputZip -Force }
Compress-Archive -Path (Join-Path $Package '*') -DestinationPath $OutputZip -CompressionLevel Optimal
Assert-File $OutputZip 'built ZIP package'
Write-Host "Built release package: $OutputZip"
