# 安装、更新与卸载

**一期完整下载仅支持 Windows 10/11 x64 + Microsoft Edge 或 Google Chrome 120+**（建议使用浏览器当前受支持版本）。一期不提供 macOS、Linux、ChromeOS、Windows ARM64 或 32 位 Windows 下载 Host。下载引擎不支持 DRM；只处理你有权下载的媒体。

在 macOS、Linux 或 ChromeOS 上，若相应版本的 Edge/Chrome 商店允许安装，扩展可用于扫描当前页和选择候选资源；由于没有这些系统的本机 Host，下载、大小探测和本机任务管理不可用。仅安装扩展不等于安装下载器。

## 普通用户

1. 在 Microsoft Edge Add-ons 或 Chrome Web Store 安装 **Frame Video Downloader**。正式商店链接将在首次上架后放入项目 README；尚未上架时不要把开发 ZIP 当成商店版。
2. 点击扩展图标，选择“扫描此页”。无需本机组件即可扫描和勾选媒体。
3. 下载时按弹窗中的“安装 / 更新本机组件”进入[官方 Releases](https://github.com/stoplyy/DPlayer-Downloader/releases)。下载 Windows x64 Host 安装器，核对版本、发布者签名和 SHA-256 后运行。
4. 安装器将 Host、yt-dlp、FFmpeg/ffprobe、许可证及对应源码安装到 `%LOCALAPPDATA%\FrameVideoDownloader\app`，仅注册当前用户 Edge 和 Chrome 的 Native Messaging。无需管理员权限、Python 或开发者模式。
5. 回到扩展点击“重试连接”。只有协议与最低 Host 版本握手通过才会启用下载。默认不读取 Cookie；需要登录态时由你按任务选择并授权。

## 更新与排错

扩展通过各自商店更新。本机组件通过同一官方发布页下载安装新版本；不运行后台自动更新服务。升级/同版本修复前暂停所有任务并停止扩展内的本机服务。安装器拒绝覆盖仍在下载的工具，仅停止本安装目录中的空闲 Host。重新连接后，中断任务由你确认恢复，不自动重新下载。

- 未安装：安装 Host 后重试，扫描无需刷新。
- 不兼容：更新 Host；若 Host 协议更高，也需要更新商店扩展。
- 启动失败：重试、同版本修复或查看浏览器/组织策略及安全软件限制。[支持入口](https://github.com/stoplyy/DPlayer-Downloader/issues)。诊断信息不要包含 Cookie 或完整签名 URL。
- 两个浏览器使用同一份任务数据；同时只允许一个 Host 会话。先在另一浏览器点击“停止服务”，再在本浏览器重试。

## 卸载与数据保留

浏览器扩展分别在 Edge/Chrome 扩展管理页卸载。本机组件在 Windows“已安装的应用”中卸载 **Frame Video Downloader Host**，也可运行安装目录的 `unins000.exe`。这两项互不代替。

卸载默认保留 `%LOCALAPPDATA%\FrameVideoDownloader\state`、`settings.json` 及下载目录。需要清理数据时，先停止任务、退出浏览器、卸载组件，再确认删除 `state`、`secrets`、`settings.json`；单独检查并删除不再需要的视频。安装器不会递归删除用户数据目录。

## 从旧开发版迁移

停止旧版任务与 Host，移除浏览器中旧的 unpacked 扩展，再安装商店版和新 Host。新安装器沿用旧的 `app` 程序目录和同级数据目录，替换 Native Messaging 来源为两个正式商店 ID。旧 `app/extension` 目录不会被当作商店扩展加载，也不自动删除；确认不再使用后可手动删除。不要再运行旧安装/卸载脚本，它们会覆盖正式注册；仓库脚本会拒绝操作安装器管理的目录。
