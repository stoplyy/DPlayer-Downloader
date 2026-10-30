# Frame Video Downloader

**语言：** [English（默认）](README.md) | 简体中文

扫描当前浏览器标签页中的 DPlayer 风格媒体。**Edge 首发版仅支持 Windows 10/11 x64 和 Microsoft Edge 120+ 下载**；仅安装浏览器扩展并不能跨平台下载。

项目包含 Edge 商店扩展、本机 Native Messaging Host，以及基于 `yt-dlp` 和 `ffmpeg` 的下载引擎。首版 Host 安装器仅注册已确认的 Edge 商店 ID。下载在本机运行；HLS 任务可从已完成的分片继续；每个任务都会持久化，以便浏览器重启后恢复。

在 macOS、Linux 和 ChromeOS 上，如果相应浏览器商店允许安装，可使用 Edge/Chrome 扩展扫描页面并选择候选资源；第一阶段没有这些系统的本机下载 Host，因此无法下载、探测大小或管理本机任务。完整下载需要 Windows x64 Host。不支持 Windows ARM64 和 32 位 Windows。

## 仓库结构

```
DPlayer-Downloader/
├─ extensions/
│  ├─ shared/          # 与浏览器无关的 ES 模块（唯一源文件）
│  │  ├─ scanner.mjs              # 媒体候选项规范化与去重
│  │  ├─ size_display.mjs         # 候选项中的字节大小格式化
│  │  ├─ probe_queue.mjs          # 有并发上限的大小探测队列
│  │  ├─ task_actions.mjs         # 任务操作消息校验
│  │  ├─ settings.mjs             # 用户设置（允许站点、下载目录）
│  │  ├─ bridge_status.mjs        # 桥接故障分类与重连退避
│  │  ├─ media_identity.mjs       # 用于重复检测的无签名媒体标识
│  │  └─ cookie_authorization.mjs # 按主机授权 Cookie 并读取
│  └─ edge/            # Microsoft Edge (MV3) 扩展
│     ├─ manifest.json
│     ├─ popup.html / popup.css / popup.js
│     ├─ service_worker.js
│     └─ sync-shared.mjs          # 将 extensions/shared 复制到此目录
├─ host/                # 本机消息 Host（Python 3.12，与浏览器无关）
├─ installer/           # 构建及各浏览器安装/卸载脚本
├─ tests/               # Python unittest 与 Node 测试
├─ tools/               # 独立 DPlayer 命令行辅助工具与样例
├─ vendor/              # 已审阅的第三方二进制文件与许可证材料
└─ docs/                # 设计说明、实施计划、弹窗预览
```

### 为什么复制 `extensions/shared`，而不是直接导入

Chrome/Edge MV3 的 `chrome.scripting.executeScript` 无法注入 ES 模块，因此共享模块必须作为实际文件存在于每个浏览器扩展目录中。`extensions/shared` 是唯一源目录；修改其中内容后运行：

```powershell
node extensions/edge/sync-shared.mjs
```

发布构建会运行 `sync-shared.mjs --check`；如果浏览器目录中的副本过期，构建会失败。

### 添加其他浏览器

1. 创建 `extensions/<browser>/`，包含自己的 `manifest.json`、`popup.*` 和后台脚本。
2. 将 `extensions/edge/sync-shared.mjs` 复制到该目录（脚本会相对于自身位置解析 `../shared`，无需修改）。
3. 运行 `node extensions/<browser>/sync-shared.mjs`。
4. 在 `installer/host.iss` 中添加该浏览器的 Native Messaging 注册信息（Edge 使用 `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts`，Chrome 使用 `HKCU:\Software\Google\Chrome\NativeMessagingHosts`）。

## 开发检查

在仓库根目录运行：

```powershell
node --test tests/*.mjs
python -m unittest discover -s tests -t . -v
```

HLS 集成测试使用本地生成的媒体和 loopback HTTP 服务器，只需本机 PATH 中有 `ffmpeg` 和 `yt-dlp`。测试不会访问外部媒体 URL。

## 安装与卸载

Edge 首发版由 **Microsoft Edge Add-ons 扩展和单独签名的 Windows Host 安装器**组成。完整下载需要 Windows 10/11 x64 和 Edge 120+。Chrome Web Store 支持将在商店 ID 确认后添加。

1. 从 [Microsoft Edge Add-ons 安装 Frame Video Downloader](https://microsoftedge.microsoft.com/addons/detail/0RDCKF2Z9NKQ)。无需 Host 即可扫描和选择候选资源。
2. 如需下载，点击弹窗中的安装链接前往 [GitHub Releases](https://github.com/stoplyy/DPlayer-Downloader/releases)，下载签名的 Windows x64 Host 安装器。按[安装指南](docs/installation.md)操作；安装器仅为当前用户安装，无需管理员权限、Python、开发者模式或加载未打包扩展。
3. 返回扩展并点击 **重试连接**。下载需要通过兼容的 Host 握手。Edge 扩展由商店更新；Host 需要从官方发布页手动更新。Chrome Web Store 尚待发布。

在浏览器设置中移除扩展。在 Windows“已安装的应用”中卸载 **Frame Video Downloader Host**。Host 卸载会保留下载文件、任务状态和设置。数据位置及可选清理方式请见[安装与迁移](docs/installation.md)和[隐私政策](docs/privacy-policy.md)。同一时间只能由一个浏览器 Host 会话管理用户任务数据；切换前请先停止另一个浏览器中的服务。

## 发布构建

请参阅[发布检查清单](docs/release-checklist.md)。公开元数据位于 `release/config.json`；发布时填写商店 ID 和签名身份。该文件中不得存放私钥或密码。每个商店 ZIP 只包含许可名单中的扩展运行文件、图标和声明文件，且 `manifest.json` 位于 ZIP 根目录。两个浏览器包都以 `extensions/edge` 为规范源目录。

```powershell
node tools/sync-release.mjs
node extensions/edge/sync-shared.mjs
# 可检查的开发 ZIP，名称明确区分，无需凭证。
python -m tools.build_release extension --browser edge
python -m tools.build_release extension --browser chrome
# 正式商店包：需要已确认的商店 ID 和公开 URL。
python -m tools.build_release extension --browser edge --release
python -m tools.build_release extension --browser chrome --release
# 无代码签名证书的 Host 安装器（Windows 可能提示发布者未知）。
pwsh -File installer/build.ps1 -Iscc 'C:\path\ISCC.exe' -Unsigned
# 签名 Host 安装器：还需已审阅的供应商输入和签名工具。
pwsh -File installer/build.ps1 -Iscc 'C:\path\ISCC.exe' -SignTool 'C:\path\signtool.exe'
```

Host 安装器包含 yt-dlp、FFmpeg/ffprobe、对应源码和许可证材料；它会在 HKCU 下为两个浏览器注册 Host，且只使用两个已确认的商店 ID。构建会检查哈希、版本、发布者签名和时间戳，并生成发布清单。缺少所需输入时不会生成正式发布产物。用于商业用途前请审阅 Inno Setup 的分发许可证。构建不会上传任何包。开发 ZIP 输出到 `dist/development`，正式产物输出到 `dist/release`。

## 全选下载

扫描后，点击媒体列表上方的 **全选**，再点击 **下载已选**，即可将所有选中视频加入队列。再次点击复选框可清除选择，也可以单独取消某些视频。只有部分视频被选中时复选框会显示混合状态；页脚始终显示已选数量。

## 重复下载

URL 并不是可靠的媒体标识：网站可能在页面每次加载时轮换带签名的 CDN 路径，也可能通过不同路径提供同一视频的多种画质（如 `video` 和 `video_h265`）。因此去重按顺序使用两个键：

1. **`contentKey`**：由页面主机名和播放器自己的视频 ID（`data-video_id` 等属性）计算的哈希。它在页面重新加载、路径轮换和不同画质之间保持稳定，因此无论页面提供哪个 URL，都能识别同一视频。
2. **`mediaKey`**：对移除易变签名参数（如 `auth_key`、`token`、`expires`、`X-Amz-*`）后的媒体 URL 计算哈希。用于页面没有提供视频 ID 时的后备识别。

开始任务前，弹窗和 Host 都会检查是否存在匹配任一标识的任务。若匹配任务处于 `queued`、`downloading`、`paused`、`interrupted`、`finalizing` 或 `completed` 状态，会拒绝重复任务并报告已跳过。`cancelled` 和 `failed` 任务不参与去重，用户可以重试。同一批次中选择同一视频的多个画质时，也只会加入第一个。

## Host 连接与恢复

有上限的握手会报告检查中、就绪、未安装、不兼容或失败状态。缺失或不兼容的组件会等待用户手动重试，而不会反复启动进程。意外断开后会按有上限的退避策略重连；状态会在 Worker 挂起期间持久保存。Host 不可用时，扫描和本机站点偏好仍可使用。只有组件就绪时才会自动探测大小；弹窗会说明这些请求会发送到媒体服务器。

握手会同时检查协议和最低 Host 版本。安装/更新面板指向固定的项目 HTTPS URL，不会自动下载或执行安装程序，也不会把仅打开发布页误判为安装成功。恢复时，正在进行的下载会标记为中断，必须由用户操作继续。

### 开发安装 / 源码变更后重建

支持仅供开发者本地测试的未打包扩展加载，不要将其用作公开安装流程。辅助脚本会拒绝覆盖由正式安装器管理的安装。修改源码后运行：

```powershell
.\installer\rebuild-dev.ps1
```

该脚本会从源码重建 `native-host.exe`、刷新已安装的扩展副本、重新注册 Native Messaging 清单，并打印协议版本。随后在 `edge://extensions` 点击 **重新加载**。跳过此步骤会导致界面报错，而 Host 实际上并不认识新代码中的功能。

检查已安装二进制实际支持的消息类型：

```powershell
python tools\probe_native_host.py
```

此探测只读，不会更改设置或启动下载。

## 隐私与限制

- 只有用户点击弹窗操作后才会开始扫描。扫描会读取视频/来源元素、播放器 JSON 配置和页面资源计时条目中可见的类媒体 HTTP(S) URL。`blob:` URL 不会被视为可下载来源。
- 扫描后，弹窗会尝试显示页面提供的海报图，或匿名跨域 MP4/WebM 帧预览。预览不会读取网站 Cookie；媒体服务器会直接收到浏览器发出的预览请求。不支持的格式、受保护的流，以及不支持匿名 CORS 的服务器会显示占位内容。
- Cookie 访问默认关闭。启用后，扩展会针对所选媒体主机请求可选权限；只有全部主机权限获准后才读取 Cookie。任何拒绝都会中止登录态操作。Cookie 文件仅对应已授权 URL 的精确主机名，在 Windows 上使用仅当前用户可访问的 ACL；不会记录或写入任务 JSON，并会在 Worker 结束时删除。
- 页面可能不会提前展示 CDN 或重定向主机。Cookie 权限不会扩展到父域或未知 CDN 主机。若来源需要独立 CDN 登录 Cookie，下载可能失败；如果该主机作为候选项出现，请明确授权并扫描它。
- 带签名的媒体 URL 使用 Windows DPAPI 在任务状态中加密。扩展界面显示的 URL 不含查询参数。
- 弹窗设置面板保存两项用户偏好。“自动勾选资源的站点”是一个主机名列表，匹配范围仅包括该主机名及其子域；“下载保存路径”指定 Native Host 输出任务文件的绝对目录。Host 会校验并创建目录；路径无效时会报错，不会回退到默认目录。
- 本机出站代理会拒绝解析到非公开地址的 DNS 结果，并通过固定地址转发 HTTP 请求。当前测试覆盖本地 HTTP HLS 路由、拒绝私有地址，以及中断后的原生 HLS 续传。HTTPS `CONNECT` 只能看到隧道目标，不会看到加密连接内部的重定向/分片路径；这并不代表在下载器遭入侵时提供完整网络隔离。
- 请勿使用本工具绕过访问控制，也不要下载未经授权的内容。项目未使用真实站点下载进行测试。

# 独立 DPlayer 命令行辅助工具

`download_video.py` 是扩展之前提供的一个小型免依赖脚本。它解析保存的 DPlayer 页面，从播放器的 `data-config` 属性中提取 HLS 播放列表 URL，并将其交给 `yt-dlp`。

该脚本作为扩展扫描器所针对的 DPlayer `data-config` 结构的参考实现，也可用于无需安装扩展、快速验证页面媒体 URL。

```powershell
python tools/download_video.py --html tools/sample-dplayer.html --dry-run
python tools/download_video.py --html tools/sample-dplayer.html --source video_h265
```

- `--source` 选择播放器配置中的 `video`（默认）或 `video_h265`。
- `--dry-run` 打印去除查询参数后的 URL，不发起请求。
- 实际下载需要 PATH 中有 `yt-dlp` 和 `ffmpeg`。

`sample-dplayer.html` 是用于解析器测试的 DPlayer 标记片段。其签名 URL 已过期，仅用于验证解析功能。

运行其单元测试：

```powershell
python -m unittest discover -s tools -t . -v
```

## 本地浏览器验证夹具

`browser_fixture.py` 会生成两个 4 秒 MP4 文件、一个 8 秒 HLS 流，以及覆盖缺少视频 ID、多个播放器和同一视频多个画质的测试页面。它使用已安装下载器中的 FFmpeg，并通过 loopback 提供页面：

```powershell
python tools/browser_fixture.py serve
```

在隔离的 Edge 配置文件中打开 `http://127.0.0.1:8766/no-id.html`、`/multi.html` 或 `/renditions.html`。媒体使用保留名称 `media.fixture.test`。端到端下载测试应在单独的测试 Native Messaging Host 下注册脚本的 `native` 模式，并让隔离的扩展副本连接该 Host。不要替换生产注册。夹具 Host 使用生产协议和下载器，但任务状态单独保存，且只允许访问本地夹具媒体地址。生产网络检查保持不变。

生成的媒体、隔离状态、下载文件和浏览器证据保存在被忽略的 `output/playwright/` 目录中。测试重复检测、暂停/恢复、删除、服务停止/启动，以及任务暂停时更改输出目录；用 FFprobe 检查生成文件。关闭隔离浏览器后，移除临时测试 Host 注册项。
