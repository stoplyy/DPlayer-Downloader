# 手动发布清单

## 已确定的发布形式

Edge Add-ons 与 Chrome Web Store 各一个 MV3 ZIP，共用 `extensions/edge` 源码；一期完整下载仅支持 Windows 10/11 x64 + Edge/Chrome 120+，并需独立 Inno Setup Host 安装器，当前用户安装，无需 Python/管理员。macOS、Linux、ChromeOS 上扩展如可安装，也仅能扫描、显示可用预览和选择资源，不能下载、探测大小或管理本机任务；Windows ARM64 与 32 位 Windows 不支持。商店负责扩展更新，用户主动运行安装器更新 Host。不是一个 ZIP 加载未打包扩展的正式流程。

## 维护者在发布时填写

编辑 `release/config.json`：两个商店确认的 `edgeExtensionId` / `chromeExtensionId`（32 个 a-p 字符），并记录各商店条目 ID 供后台管理。Edge/Chrome 正式 ZIP 分别只要求对应商店确认的扩展 ID；`storeIdsConfirmed` 表示两个商店 ID 均已确认，Host 安装器发布前必须为 true。另需填写 `publisher` 和 `signingCertificateThumbprint`。发布者必须与签名证书 SimpleName 一致；证书/私钥留在当前用户证书库，不放仓库。分别管理扩展和 Host 版本及最低兼容版本。

先在商店后台创建草稿获得 ID。商店 ZIP 不依赖 Host 签名证书；Host 安装器同时需要两个 ID。若商店需要先上传包才分配 ID，可上传开发 ZIP 到**未发布的草稿**取得 ID，然后回填配置、生成正式 ZIP 替换草稿；绝不能公开 DEVELOPMENT 包。

将 `docs/privacy-policy.md` 发布到公开仓库稳定 URL（默认 GitHub main 分支页面；如默认分支不同请修改 URL），验证 Releases、支持页和隐私页面在未登录状态可访问，然后将 `publicPagesVerified` 设为 true。该开关是维护者验收声明，不是构建器替你进行了联网验证。没有要求部署新网站。

## 依赖审查

按 `vendor/README.md` 准备精确二进制、完整对应源码和许可。更新 `vendor/approved-licenses.json` 的源码哈希和 `redistributionReview`。`materials` 每项包含相对 vendor 的 `path` 和小写 `sha256`；覆盖依赖源码/构建材料及许可证。仅填写 approved=true 不会跳过文件/哈希检查。

使用 GPL FFmpeg 构建时，完整对应源码必须包括实际启用的外部库和重建所需材料。一个 FFmpeg 主仓库 tarball 加一份 GPL 文本不足以完成审查。Python、PyInstaller、Inno Setup 安装器运行时及其他传递依赖同样要在 NOTICE 中覆盖。先核对 Inno Setup 6 商业使用许可与项目实际发布情况，再填 `installerCompilerReview`；构建器验证上游签名的编译器并记录其哈希。当前空字段是明确阻断项，不应猜测填入。

## 构建

```powershell
node tools/sync-release.mjs
node extensions/edge/sync-shared.mjs
node --test tests/*.mjs
python -m unittest discover -s tests -t . -v
python -m tools.build_release preflight --target host
python -m tools.build_release extension --browser edge --release
python -m tools.build_release extension --browser chrome --release
pwsh -File installer/build.ps1 -Iscc 'C:\path\ISCC.exe' -SignTool 'C:\path\signtool.exe'
```

构建机器：PowerShell 7、Node、Python 3.12 x64、PyInstaller 6.20.0、经核验的 Inno Setup 6、Windows SDK SignTool、受信任代码签名证书。遵守构建工具自身许可。Host 构建只在所有输入检查通过后启动，不从网络临时下载依赖。原始依赖哈希在签名前验证；原始/签名后哈希分别写入清单。安装器和卸载器由同一签名命令签名，失败不复制到 dist/release。

开发检查使用不带 `--release` 的两个扩展打包命令；输出 `dist/development/*-DEVELOPMENT.zip`。不能把开发包当正式包发布。正式构建不会安装本机软件或上传任何制品。

## 干净账户验收（发布前必须实测）

| 场景 | 通过标准 |
| --- | --- |
| 无 Host | 两浏览器均可扫描/勾选/修改自动勾选站点；下载引导清楚，Cookie 不提前读取 |
| 非 Windows 环境 | 商店资料明确一期仅 Windows 提供下载；若扩展可安装，扫描可用但下载、大小探测和本机任务管理不可用，界面不得暗示可安装非 Windows Host |
| 安装 | 标准 Windows 用户、无 Python、含中文/空格用户目录；无 UAC 提权；两个 HKCU key 正确 |
| 身份 | allowed_origins 恰好两个正式 ID，开发/陌生 ID 被拒绝；不能用开发公钥推定 |
| 连接 | ping 返回 hostVersion / protocolVersion；旧版、超时、拒绝访问有恢复文案 |
| 修复/升级 | 活动下载阻止覆盖；空闲 Host 停止后更新；中断任务/视频/设置保留；禁止降级 |
| 取消/失败 | 注册与文件回滚验证；磁盘不足、文件锁、WMI 不可用可重试 |
| 双浏览器 | 第二个会话被安全拒绝；停止第一个后可在另一个连接，任务不损坏 |
| 卸载 | 注册/程序移除，下载/设置/状态保留；浏览器扩展单独卸载 |
| 隐私 | 无 Cookie/签名 URL 泄漏；权限请求与说明一致；拒绝授权不降级读取其他来源 |
| 实际媒体 | 本地自动化 fixture 完整/断线续传通过；商店审核演示使用自产且授权的素材 |
| 签名 | 安装器、卸载器和分发 exe 的签名链、时间戳和发布者正确 |

先按 store-listing.md 提交隐藏/未公开审核；人工上传正式 ZIP 和安装器时，把版本、SHA-256、签名发布者、对应源码、变更记录、系统要求与卸载说明一并放在发布页。仅单元测试通过不能替代此验收。

## GitHub Releases 发布

`.github/workflows/draft-release.yml` 在推送 `v<extensionVersion>` 标签后构建正式 Edge ZIP，并创建 GitHub Draft Release。也可在 Actions 手动运行此 workflow，输入已存在且对应版本的标签。它只打包扩展，不构建 Host 安装器。

正式发布前，在满足本清单的 Windows 发布机上运行 `installer/build.ps1`。确认该次构建的 `release-manifest.json` 中 `sourceDirty` 为 false，核对安装器签名、版本与 SHA-256；再上传安装器和清单到工作流创建的 Draft Release：

```powershell
$config = Get-Content release/config.json -Raw | ConvertFrom-Json
$tag = "v$($config.extensionVersion)"
$hostDir = "dist/release/host-$($config.hostVersion)"
gh release upload $tag "$hostDir/frame-video-downloader-host-$($config.hostVersion)-windows-x64.exe" "$hostDir/release-manifest.json"
```

检查 Draft Release 中包含正式 Edge ZIP、对应 JSON 校验文件、已签名 Host 安装器和安装器清单；完善发布说明后，再在 GitHub Releases 页面发布。扩展中的 Host 下载链接打开 Releases 页面，用户可在那里下载安装器。不要发布仅含 Edge ZIP 的 Draft，也不要把 DEVELOPMENT 包附加到正式 Release。

## 规范依据

- [Microsoft Native Messaging 分发与 ID](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)
- [Edge Add-ons 开发者政策](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)
- [Chrome Web Store 隐私政策要求](https://developer.chrome.com/docs/webstore/program-policies/privacy)
- [Inno Setup 当前用户权限](https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm)
