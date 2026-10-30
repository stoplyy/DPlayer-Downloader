#requires -Version 7.0
<# Builds a per-user Host installer; never installs or publishes it.
   Requires PowerShell 7, Python 3.12 x64, PyInstaller 6.20.0, Inno Setup 6. #>
param(
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$Iscc = 'ISCC.exe',
    [string]$SignTool = 'signtool.exe',
    [switch]$Unsigned
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $ProjectRoot
try {
    $PreflightArgs = @('-m', 'tools.build_release', 'preflight', '--target', 'host')
    if ($Unsigned) { $PreflightArgs += '--allow-unsigned' }
    & python @PreflightArgs
    if ($LASTEXITCODE -ne 0) { throw 'Release inputs incomplete. See release/config.json and vendor/README.md.' }
    $Config = Get-Content -LiteralPath 'release/config.json' -Raw | ConvertFrom-Json
    $Approval = Get-Content -LiteralPath 'vendor/approved-licenses.json' -Raw | ConvertFrom-Json
    $Iscc = (Get-Command $Iscc -ErrorAction Stop).Source
    $InstallerSignature = Get-AuthenticodeSignature -LiteralPath $Iscc
    if ($InstallerSignature.Status -ne 'Valid' -or $InstallerSignature.SignerCertificate.Subject -notlike '*Pyrsys B.V.*') { throw 'Inno Setup compiler must have the verified upstream publisher signature.' }
    $CompilerHelp = (& $Iscc '/?' 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or $CompilerHelp -notmatch 'Inno Setup 6 Command-Line Compiler') { throw 'The reviewed Inno Setup 6 compiler could not be verified.' }
    $Certificate = $null
    if (-not $Unsigned) {
        $SignTool = (Get-Command $SignTool -ErrorAction Stop).Source
        $Certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($Config.signingCertificateThumbprint)"
        if (-not $Certificate.HasPrivateKey -or $Certificate.NotAfter -le (Get-Date)) { throw 'Valid code-signing private key required.' }
        $CertPublisher = $Certificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
        if ($CertPublisher -ne $Config.publisher) { throw "Publisher must match certificate: $CertPublisher" }
    }
    $Runtime = (& python -c "import platform,struct,PyInstaller; print(platform.python_version()+'|'+str(struct.calcsize('P')*8)+'|'+PyInstaller.__version__)").Trim()
    if ($LASTEXITCODE -ne 0 -or $Runtime -notmatch '^3\.12\.\d+\|64\|6\.20\.0$') { throw "Requires Python 3.12 x64 / PyInstaller 6.20.0; found $Runtime" }
    $YtVersion = (& .\vendor\yt-dlp.exe --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $YtVersion -ne $Approval.ytDlp.version) { throw 'yt-dlp version mismatch' }
    foreach ($Tool in @('ffmpeg', 'ffprobe')) {
        $Version = (& (Join-Path $ProjectRoot "vendor/$Tool.exe") -version | Select-Object -First 1)
        if ($LASTEXITCODE -ne 0 -or $Version -notmatch [regex]::Escape($Approval.ffmpeg.version)) { throw "$Tool version mismatch" }
    }
    $Stage = Join-Path $ProjectRoot ('.build-host/' + [guid]::NewGuid().ToString('N'))
    $Payload = Join-Path $Stage 'payload'
    $Output = Join-Path $Stage 'output'
    New-Item -ItemType Directory -Path $Payload, $Output, (Join-Path $Payload 'tools'), (Join-Path $Payload 'licenses') -Force | Out-Null
    & python -m PyInstaller --noconfirm --clean --onefile --name native-host --distpath $Payload --workpath (Join-Path $Stage 'work') --specpath (Join-Path $Stage 'spec') --paths $ProjectRoot (Join-Path $ProjectRoot 'host/native_host.py')
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed' }
    foreach ($Tool in @('yt-dlp', 'ffmpeg', 'ffprobe')) {
        Copy-Item -LiteralPath (Join-Path $ProjectRoot "vendor/$Tool.exe") -Destination (Join-Path $Payload "tools/$Tool.exe")
    }
    foreach ($Material in $Approval.redistributionReview.materials) {
        $Destination = Join-Path $Payload $Material.path
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $ProjectRoot "vendor/$($Material.path)") -Destination $Destination
    }
    Copy-Item -LiteralPath 'vendor/ffmpeg-source.tar.xz', 'vendor/yt-dlp-source.tar.gz' -Destination (Join-Path $Payload 'licenses')
    Copy-Item -LiteralPath 'docs/privacy-policy.md', 'docs/installation.md' -Destination $Payload
    function Assert-Signed([string]$Path) {
        $Signature = Get-AuthenticodeSignature -LiteralPath $Path
        if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Thumbprint -ne $Config.signingCertificateThumbprint -or -not $Signature.TimeStamperCertificate) { throw "Signature/timestamp validation failed: $Path" }
    }
    $Files = @()
    foreach ($Executable in Get-ChildItem -LiteralPath $Payload -Filter '*.exe' -Recurse -File) {
        $OriginalHash = (Get-FileHash -LiteralPath $Executable.FullName -Algorithm SHA256).Hash
        $SignatureStatus = 'unsigned'
        $SignerThumbprint = ''
        if (-not $Unsigned) {
            & $SignTool sign /sha1 $Config.signingCertificateThumbprint /fd SHA256 /tr $Config.timestampUrl /td SHA256 $Executable.FullName
            if ($LASTEXITCODE -ne 0) { throw "Signing failed: $($Executable.Name)" }
            Assert-Signed $Executable.FullName
            $SignatureStatus = 'valid'
            $SignerThumbprint = $Certificate.Thumbprint
        }
        $Files += @{ path = [IO.Path]::GetRelativePath($Payload, $Executable.FullName); originalSha256 = $OriginalHash; sha256 = (Get-FileHash -LiteralPath $Executable.FullName -Algorithm SHA256).Hash; signature = $SignatureStatus; signer = $SignerThumbprint }
    }
    $Metadata = @{ product = $Config.productName; hostVersion = $Config.hostVersion; extensionVersion = $Config.extensionVersion; protocolVersion = $Config.protocolVersion; edgeExtensionId = $Config.edgeExtensionId; chromeExtensionId = $Config.chromeExtensionId; runtime = $Runtime; installerCompiler = @{ product = 'Inno Setup 6'; binarySha256 = (Get-FileHash -LiteralPath $Iscc -Algorithm SHA256).Hash }; dependencies = $Approval; files = $Files; sourceCommit = (& git rev-parse HEAD); sourceDirty = [bool](& git status --porcelain); builtAt = (Get-Date).ToUniversalTime().ToString('o') }
    $Metadata | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $Payload 'release-manifest.json') -Encoding utf8
    $Defines = @{
        ProductName = $Config.productName; HostVersion = $Config.hostVersion; Publisher = $(if ($Unsigned) { 'Frame Video Downloader' } else { $Config.publisher })
        HostName = $Config.nativeHostName; EdgeId = $Config.edgeExtensionId; ChromeId = $Config.chromeExtensionId
        SupportUrl = $Config.supportUrl; ReleaseUrl = $Config.releaseUrl
    }
    $Include = Join-Path $Stage 'release.iss'
    ($Defines.GetEnumerator() | ForEach-Object { '#define ' + $_.Key + ' "' + $_.Value + '"' }) | Set-Content -LiteralPath $Include -Encoding utf8
    $InnoArgs = @("/DConfigInclude=$Include", "/DPayloadDir=$Payload", "/DOutputDir=$Output")
    if ($Unsigned) { $InnoArgs += '/DUnsignedBuild' }
    else { $SignCommand = '"' + $SignTool + '" sign /sha1 ' + $Config.signingCertificateThumbprint + ' /fd SHA256 /tr ' + $Config.timestampUrl + ' /td SHA256 $f'; $InnoArgs += "/Sframe=$SignCommand" }
    $InnoArgs += (Join-Path $PSScriptRoot 'host.iss')
    & $Iscc @InnoArgs
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation/signing failed' }
    $Installer = Get-Item -LiteralPath (Join-Path $Output "frame-video-downloader-host-$($Config.hostVersion)-windows-x64.exe")
    if (-not $Unsigned) { Assert-Signed $Installer.FullName }
    $Metadata.installer = @{ file = $Installer.Name; sha256 = (Get-FileHash -LiteralPath $Installer.FullName -Algorithm SHA256).Hash; signature = $(if ($Unsigned) { 'unsigned' } else { 'valid' }); publisher = $(if ($Unsigned) { '' } else { $Config.publisher }); signer = $(if ($Unsigned) { '' } else { $Certificate.Thumbprint }) }
    $Metadata | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $Output 'release-manifest.json') -Encoding utf8
    $Destination = Join-Path $ProjectRoot "dist/release/host-$($Config.hostVersion)"
    if (Test-Path -LiteralPath $Destination) { throw "Output already exists: $Destination. Review before rebuilding." }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -LiteralPath $Installer.FullName, (Join-Path $Output 'release-manifest.json') -Destination $Destination
    Write-Host "Installer built: $Destination. Signature: $(if ($Unsigned) { 'unsigned' } else { 'valid' }). Perform clean-account acceptance before publication."
} finally { Pop-Location }
