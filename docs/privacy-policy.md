# Frame Video Downloader 隐私政策 / Privacy Policy

## 一期平台支持范围

一期本机下载组件仅支持 Windows 10/11 x64，并与 Microsoft Edge 或 Google Chrome 120+ 配合使用。macOS、Linux 和 ChromeOS 没有对应的本机组件；在这些系统上，即使浏览器允许安装扩展，也只能扫描当前页、查看可用预览和选择候选资源，不能下载、探测大小或管理本机任务。Windows ARM64 与 32 位 Windows 不属于一期支持目标。

更新日期：2026-10-30。适用于 Microsoft Edge 与 Google Chrome 商店扩展，以及用户单独安装的 Windows 本机下载组件。

## 用途与处理时机

本产品的单一用途是帮助用户发现当前网页中的媒体，并在本机下载用户有权保存的内容。只有点击“扫描此页”后，扩展才读取当前页标题、页面地址、video/source 元素、播放器配置中的媒体地址/视频标识和资源计时条目。它不收集其他标签页或浏览历史，不持续监视浏览活动。

扫描结果在弹窗内存中显示。扫描后，扩展会尝试从页面提供的海报图或媒体地址加载小型预览；预览以匿名跨域请求加载，不通过扩展 Cookie API 读取网站登录状态，因此部分 HLS、受保护、或不允许匿名跨域加载的资源无法显示首帧。预览请求由浏览器直接发送至对应媒体服务器，服务器可能收到你的 IP 地址和媒体请求。若本机组件已连接，候选媒体 URL 还会交给本机组件向媒体服务器探测文件大小。点击下载后，媒体地址、页面地址、视频标识、任务选项和文件名会经浏览器 Native Messaging 传给本机组件。仅安装扩展就可以扫描和尝试预览；下载、大小探测和本机任务管理需要另行安装组件。

## 可选登录态与权限

登录态默认关闭。只有你在本次任务中选择“使用当前站点登录态”后，扩展才请求 cookies 权限和所选媒体主机的可选站点权限，并读取该 URL 对应的 Cookie。浏览器可能记住先前授权，不一定每次再次显示权限弹窗；每个新任务仍需你的显式选择，恢复登录态任务会重新获取授权 Cookie。拒绝权限会中止该操作，不会转用浏览器数据库或其他 Cookie 来源。

Cookie 通过 Native Messaging 传给本机下载器，并用于向被授权的媒体主机请求媒体。不会扩大到未授权的 CDN 或重定向主机。临时 Cookie 文件置于 `%LOCALAPPDATA%\FrameVideoDownloader\secrets`，使用当前用户 ACL；工作进程结束时删除，崩溃遗留文件在后续 Host 启动时清理。Cookie 不写入任务 JSON、遥测或项目服务器。

基础权限用途：activeTab 和 scripting 用于用户主动扫描；nativeMessaging 用于本机通信；storage 保存自动勾选站点及组件状态；alarms 用于有限的断线重试。自动勾选站点只改变选中状态，不是 Cookie 授权，也不会自动下载。

## 本地保存与网络接收方

任务状态保存在 `%LOCALAPPDATA%\FrameVideoDownloader\state`；任务中的媒体 URL 使用 Windows DPAPI 加密。任务标识、状态、文件路径以及不含查询参数的展示地址等元数据保留在本地。Host 设置保存在同级 `settings.json`。视频及可续传片段保存在你选择的下载目录（默认 `%USERPROFILE%\Downloads\FrameVideos`）。浏览器扩展设置和桥接状态保存在对应浏览器配置文件的扩展本地存储中。

本产品没有账号系统、广告、分析 SDK 或遥测，不向项目维护者服务器上传媒体、浏览信息或 Cookie，不出售用户数据。网络请求发生于用户访问的媒体服务器及其资源主机。你主动打开商店、GitHub 官方发布页、支持页或隐私政策页时，这些网站会按各自政策处理通常的网页访问数据。提交公开 Issue 时请勿附上 Cookie、签名 URL、个人路径或敏感日志。

## 保留、删除与卸载

任务和视频保留至你主动删除。扩展中的“删除任务”会在确认后删除该任务及其文件。删除扩展会移除其本地设置，但不会卸载本机组件或删除下载。通过 Windows“已安装的应用”卸载本机组件，只移除程序和 Native Messaging 注册，保留任务、设置和视频。

完全清除时，先停止任务、关闭浏览器并卸载组件；再自行确认删除 `%LOCALAPPDATA%\FrameVideoDownloader` 下的 `state`、`secrets`、`settings.json`，以及你需要清理的视频目录。请先备份希望保留的下载。可在浏览器扩展详情中撤销已授予的站点与 Cookie 权限。

## 联系与变更

维护与反馈：[项目支持](https://github.com/stoplyy/DPlayer-Downloader/issues)。政策更新在本文件发布并更新日期；若新增数据处理用途，产品提示和商店披露将同步调整。

## English summary

Frame Video Downloader supports Microsoft Edge and Google Chrome 120+. Phase 1 local downloading requires the separately installed Windows 10/11 x64 component. On macOS, Linux and ChromeOS, the extension may scan and select candidates where installation is available, but downloading, size probing and local task management are unavailable. Windows ARM64 and 32-bit Windows are not supported targets. Scanning is user initiated and reads only the active page's media metadata. When connected, the local component probes media sizes; downloading sends requests to media servers. Native Messaging carries task details to the separately installed Windows component. Optional login-state access is off by default, requires a deliberate user action, and is limited to authorized media hosts. Browsers may retain prior permissions. Temporary cookies are deleted after work finishes, with crash leftovers cleaned on a later host startup. Signed media URLs are encrypted in local task storage using Windows DPAPI. There is no developer-operated collection endpoint, telemetry, advertising or sale of data. Removing the extension and uninstalling the local component are separate actions; local tasks and downloads are retained unless explicitly deleted. Contact the project support link above. The detailed sections above describe permissions, retention and deletion.
