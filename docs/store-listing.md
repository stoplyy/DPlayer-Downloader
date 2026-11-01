# Edge / Chrome 商店提交材料

状态：Microsoft Edge Add-ons 上架版本为 0.2.1；Chrome Web Store 尚未发布。以下仍保留商店资料和审核复现信息，供维护者核对及后续商店使用。

## 公共信息

- 名称：Frame Video Downloader
- 中文短描述：扫描当前页媒体并在本机下载；下载需另装 Windows x64 组件。
- English short description: Scan page media and download locally. Downloads require a separate Windows x64 component.
- 平台范围：一期完整下载仅支持 Windows 10/11 x64 + Edge/Chrome 120+。macOS、Linux 和 ChromeOS 上，即使浏览器允许安装扩展，也只能扫描、查看可用预览和选择资源，不能下载、探测大小或管理本机任务。Windows ARM64 与 32 位 Windows 不属于支持目标。
- 单一用途：用户主动扫描当前页、选择媒体并在自己的 Windows 设备上下载和管理任务。
- 支持/隐私/发布页：以 `release/config.json` 为准，提交前确认未登录也可访问。Edge listing 主要面向 Edge，Chrome listing 主要面向 Chrome。

## 已发布商店

- Microsoft Edge Add-ons： [Frame Video Downloader](https://microsoftedge.microsoft.com/addons/detail/frame-video-downloader/eiengekfcedlijhhlgaalfmoicmchfcm)（版本 0.2.1，Edge 扩展 ID：`eiengekfcedlijhhlgaalfmoicmchfcm`，Store ID：`0RDCKF2Z9NKQ`）。
- 如果刚上架时按名称暂时搜不到，可先使用上述官方直达链接；README 和安装指南也提供了该链接。
- Chrome Web Store：尚未发布。

## 详细描述

Frame Video Downloader 帮助你发现当前网页中的 HLS、MP4 和其他可识别媒体链接，用视频海报或首帧小图辅助辨认资源，再批量勾选、下载并管理本机任务。**一期完整下载仅支持 Windows 10/11 x64，并需另行安装 Windows 本机组件；macOS、Linux 和 ChromeOS 上的扩展仅提供扫描、预览和候选选择。**支持可恢复的 HLS 分片下载、MP4 封装及重复任务检查。仅在你点击扫描时读取当前页媒体信息。

扫描无需安装本机组件。下载、文件大小探测和任务管理需要通过扩展中的直达链接另外下载安装 Windows 10/11 x64 组件（Host、yt-dlp、FFmpeg/ffprobe）。安装不需要管理员权限或 Python，安装完成后扩展会自动连接。本机组件更新仍需运行安装器。卸载扩展不会卸载本机组件；卸载组件保留视频和任务记录。

预览以匿名跨域请求加载，不使用网站登录状态；下载登录态默认关闭，仅在你按任务选择并授权后读取所选媒体主机 Cookie。没有广告或遥测。预览、文件大小探测与下载会访问媒体服务器；不支持匿名预览的格式或受保护资源会显示占位状态。数据处理详见隐私政策。只下载你有权保存的内容；不支持 DRM，不保证兼容所有网站或播放器，blob 地址本身不可下载。

## 权限与数据问卷依据

| 权限 | 实际用途 |
| --- | --- |
| activeTab | 你打开扩展并扫描时访问当前标签页 |
| scripting | 注入打包在扩展内的扫描函数，读取媒体 DOM/配置/资源计时 |
| nativeMessaging | 与你独立安装的 Windows 下载组件通信 |
| storage | 自动勾选站点、组件连接/停止状态；不保存 Cookie |
| alarms | Host 意外断线时有限重连；缺失/不兼容等待手动重试 |
| cookies（可选） | 显式选择登录态的任务读取目标 URL Cookie |
| HTTP(S) host（可选） | 动态请求所选媒体主机，不能预知用户将下载哪个站点；不自动申请全站授权 |

问卷不能简单填写“不处理任何数据”：页面 URL/媒体元数据和可选 Cookie 确实在设备上处理，并随用户操作发送至本机组件和媒体服务器。维护者不收集这些数据，不出售、不用于广告/信用评估；没有远程可执行代码。按各商店字段定义如实填报本地处理、网站内容、登录信息和接收方。

## 图标、截图与审核复现

包内图标：16/32/48/128 PNG，源生成器 `tools/generate_icons.py`。截图必须使用实际 UI，不使用设计稿；从 `docs/store-assets` 选取已核实的实机截图，按目标商店尺寸要求上传。

审核者测试不需要账号或真实受限媒体：

1. 安装目标商店扩展，暂不安装 Host。弹窗出现组件引导，设置仍可打开；点击安装/隐私/支持链接。
2. 在源码目录运行 `python tools/browser_fixture.py`（先查看该文件的启动方式），打开输出的 loopback URL。点击扫描，验证媒体候选出现。生产下载代理拒绝私网地址；不要把本地页面下载失败当成联通失败，也不要为审核关闭过滤。
3. 在干净 Windows 测试账户安装签名 Host，点击重试验证 ready；暂停/停止后运行同版本修复，再卸载并检查数据保留。分别在 Edge 与 Chrome 验证。
4. 下载/续传回归使用 `python -m unittest tests.test_hls_resume -v`，本地 HTTP fixture 在测试中显式注入允许规则，不修改生产网络边界。
5. 商店审核如需点击式端到端下载，应在发布者控制的公网 HTTPS 域部署自产测试视频，并将精确测试地址、授权说明补充到审核备注。该地址未配置前不要声称已提供此项实测。

提交前检查每个浏览器权限弹窗、Cookie 拒绝路径、关闭弹窗/浏览器后行为及任务恢复。安装器签名、下载地址和审核备注必须指向同一版本。
