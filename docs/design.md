# Edge HLS 视频下载器设计说明

## 状态

待用户审阅。本文仅定义设计，不代表已开始实现或验证下载兼容性。

## 目标

交付一个 Windows 安装包，包含 Edge Manifest V3 扩展、本机 Native Messaging 桥接程序、yt-dlp 和 ffmpeg。扩展能识别当前标签页可见/已加载的媒体候选，供用户勾选并下载；HLS 任务应能在网络中断或 Edge 重启后恢复已完成片段，并封装为 MP4。

只处理用户有权下载且未受 DRM 保护的媒体。不绕过访问控制、付费墙或 DRM。

## 非目标

- 不保证识别任意网站、任意播放器或加密/DRM 流。
- 不承诺普通个人版 Edge 可由安装器静默安装扩展。首次安装需用户在 Edge 扩展管理页开启开发人员模式并加载已打包目录；企业策略/商店分发另行考虑。
- 不安装 Windows service。Native Host 为每个已确认任务启动本机 worker；Native Messaging 连接断开（包括 Edge 关闭）时停止 worker 并保留续传状态，重新打开 Edge 后由用户确认恢复。
- 不在日志、任务列表或诊断信息中输出完整签名 URL 或 Cookie。

## 用户流程

1. 用户主动点击工具栏扩展图标。
2. 扩展检查当前标签页并显示 A「资源清单」弹窗，列出视频、HLS 播放列表及可识别的清晰度/编码信息；`blob:` 本身不是可下载来源，应尽可能回溯到页面配置或已观察的媒体请求。无法解析的项目标为不可下载，不伪装成有效链接。
3. 用户勾选候选资源，可选择“使用当前站点登录态”。默认关闭。显示本机桥接连接状态。
4. 用户确认下载后，扩展经 Native Messaging 发送任务；桥接程序建立任务 ID、目录和状态，将进度事件回传。
5. 用户可在弹窗/扩展任务页查看队列、速度、阶段、失败原因，并恢复、重试或删除任务。关闭弹窗不影响后台任务；关闭 Edge、Native Messaging 连接断开、系统关机或 worker 崩溃会中断任务，但已写入磁盘的分片和状态保留。

## 架构

### Edge 扩展

- Manifest V3；弹窗采用已选定的 A「资源清单」视觉布局。
- Service worker 负责当前 tab 生命周期、媒体候选汇总、Native Messaging 生命周期和任务事件路由。弹窗关闭不应取消任务；后台保持 Native Messaging 连接并定期交换心跳，连接断开时任务中断并持久化续传状态。若 MV3 service worker 被系统回收，扩展重连并由用户恢复任务。
- Content script 只在用户触发扫描时检查 DOM 中的 `<video>`、`<source>` 和播放器配置；扩展可选地监听当前 tab 的媒体请求元数据，以捕捉页面发起的 HLS 请求。
- 使用最小权限；基础权限限于 `activeTab`、`scripting`、`nativeMessaging`。用户明确勾选某任务的登录态后，才在用户手势下请求 `cookies` 与覆盖该媒体主机的可选 host permission；权限请求被拒绝时取消该任务的登录态模式并解释原因，不自动改用其他 Cookie 来源。需要读取 CDN/重定向主机 Cookie 时按主机逐个征求授权，不扩大为全站常驻权限。
- 不尝试直接读取跨域页面内存，不执行页面注入代码去绕过站点访问控制。

### Native Messaging 桥接

- 一个小型本机可执行程序作为 Native Messaging Host，通过 stdin/stdout 的长度前缀 JSON 协议与扩展通信；stdout 只输出协议消息，诊断日志写入 stderr/本地轮转日志。
- 校验消息 schema、大小、任务状态转换和允许的 HTTP(S) URL；不调用 shell 拼接命令。下载器以参数数组启动。收到任务后先原子写入持久任务记录，再启动 worker；Host 与 Edge 断连时向 worker 发出停止信号，保存 yt-dlp 中间状态并标记 interrupted。重连时扩展按 task ID 查询状态，用户确认后再恢复。
- Native Host 注册表项限定当前 Windows 用户；`allowed_origins` 限定固定扩展 ID。扩展包使用固定公钥/ID，避免安装路径导致 ID 漂移。
- Windows 安装器一次性安装扩展目录、桥接程序及依赖，并写入/卸载 Native Messaging 注册项。首次打开 Edge 扩展管理页指导用户手动加载扩展目录。

### 下载引擎

- 桥接程序调用随包提供的 yt-dlp 和 ffmpeg，不依赖用户全局 PATH。
- 对 HLS 显式选择 yt-dlp 的原生 m3u8 downloader，并启用继续下载和片段重试。准确 CLI 参数、进度恢复行为及不同 HLS playlist 的边界需在实现阶段用本地样例实测；不能把“单次片段重试”当作“进程重启续传”。升级 yt-dlp 版本时必须重新跑强制中断/重启测试。
- 任务使用固定且可恢复的输出路径与 yt-dlp 中间状态。完成后由 ffmpeg remux 为 MP4；只有最终封装成功后才标记完成。失败时保留可恢复状态，用户显式删除任务时才清理。
- 扩展与 Native Host 通过协议版本号握手（`host/protocol_version.py` 与 `extensions/shared/bridge_status.mjs` 必须一致）。版本不匹配时明确报告为“版本不一致”并给出重装指引，而不是让后续功能以无关错误失败。
- 任务目录默认位于用户 Downloads 下的专用子目录；用户可在扩展设置中改为任意绝对路径，由 Native Host 校验并创建，非法路径显式报错而不回退到默认值。禁止静默覆盖同名文件。
- 每个任务持久化两个去重键：`contentKey`（页面主机名 + 播放器视频 ID 的哈希，跨刷新、跨 CDN 路径轮换、跨清晰度稳定）与 `mediaKey`（媒体 URL 去除易变签名参数后的哈希，作为无视频 ID 页面时的回退）。启动任务前，扩展与 Host 均按 `contentKey` 优先、`mediaKey` 回退的顺序检查是否已存在 queued/downloading/paused/interrupted/finalizing/completed 状态的任务；命中则拒绝并提示已跳过重复下载。cancelled/failed 任务不参与去重，允许用户重试。同一批次中选择同一视频的多个清晰度只入队第一个。
- 扩展设置支持维护“自动允许访问的站点”列表（仅匹配该域名及其子域名），扫描后自动勾选匹配的媒体候选。默认列表为空，不内置任何站点。

## 登录态和敏感数据

- 默认不使用登录 Cookie。每个任务独立显示并要求用户勾选“使用当前站点登录态”。
- 用户确认后，扩展使用 `chrome.permissions.request`（用户手势）请求 `cookies` 权限及与媒体主机匹配的可选 host permission，再以 `chrome.cookies` API 获取限定主机的 Cookie。目标 Edge 版本与 API 权限行为作为实现前置探针；拒绝权限或 API 不可用时显式拒绝登录态下载。
- 不调用 `yt-dlp --cookies-from-browser edge`，不读取整个 Edge Cookie 数据库。Cookie 仅限已授权媒体主机；跨域 CDN 或重定向主机需逐个请求对应权限，第三方/分区 Cookie 可能不可用，界面明确展示支持边界。
- Cookie 只在该任务存活期间通过 Native Messaging 传递给桥接，不写普通日志、任务数据库或命令行参数；若 yt-dlp 只能从文件读取，则创建仅当前用户可读的临时 Netscape cookie 文件，worker 退出后清理，并对异常退出遗留文件提供启动时清理机制。
- 登录态可能受站点绑定、加密/DRM、Cookie 属性及 URL 重定向影响；界面必须说明不保证每站可用。
- 带签名参数的 URL 和 Cookie 不在日志、错误通知、任务列表显示；任务恢复数据须保护敏感 URL（首选 Windows DPAPI 加密），且限制文件 ACL。若签名过期，提示重新扫描，不伪造或刷新授权。

## 任务状态与恢复

任务状态最少包括 queued、downloading、paused、interrupted、finalizing、completed、failed、cancelled。每个状态变更持久化任务 ID、来源页面、输出名、媒体类型、恢复所需的受保护 URL/yt-dlp 状态引用和错误类别；不持久化明文 Cookie。签名 URL 使用 Windows DPAPI 加密后保存，日志、错误及普通任务字段只使用去查询参数后的展示 URL。

Native Messaging 断连、Edge 关闭、Windows 关机或 worker 崩溃后任务标记 interrupted；扩展重连后向 Native Host 查询任务列表，须由用户明确选择“恢复”才重新启动 worker。若任务使用过登录态，恢复前再次提示授权并从 Edge cookies API 获取当前 Cookie，不持久化旧 Cookie。恢复前检查 URL 和 playlist 状态；URL 失效或 playlist 变化时明确失败并允许用户重新扫描/创建任务。暂停会停止 worker、标记 paused 并保留可续传片段；取消会停止 worker、标记 cancelled 但暂不删除部分文件；删除任务必须二次确认并移除任务状态、部分文件和临时凭据。worker 启动时清理由异常退出遗留的 Cookie 临时文件。上述行为在实现测试中固定。

## 安全边界

- 仅在用户明确动作后扫描并启动下载；下载前展示主机名和资源类型供确认。
- Native Messaging 入站长度限制、严格 schema 校验、子进程超时/资源限制、输出目录限制和日志脱敏。
- 不允许扩展任意指定本机路径或执行任意命令；桥接只接受有限的下载任务协议。
- 默认只接受 HTTP(S) URL，阻止 `file:`、`javascript:`、loopback 和私有网络目标，防止桥接被滥用为本地/内网请求代理。所有 yt-dlp 出站请求必须经过受限网络层：对初始 URL、每次 DNS 解析、重定向、HLS 子 playlist、分片及下载器探测请求逐跳校验；解析结果需固定到实际连接，避免 DNS rebinding。该网络层必须覆盖 yt-dlp 的全部网络栈，而不能只做入口预检；无法强制或验证约束时，桥接不得启动 yt-dlp。不得提供隐式私网例外。
- 下载前提示用户确认其拥有保存权限；不实现 DRM 解密或反盗版措施绕过。

## 安装与分发

- 采用单一 Windows 安装器，内含扩展、Native Host、yt-dlp、ffmpeg、第三方许可证/NOTICE 和卸载器。
- 安装器注册 Native Messaging Host 的当前用户注册表项，配置固定扩展 ID；卸载时移除注册项和程序文件，但默认保留已下载视频及任务数据，提供显式清理选项。
- 安装完成后打开 Edge 扩展管理页，给出加载 unpacked extension 的本地目录和步骤；不声称扩展已自动启用。
- 在选定具体 yt-dlp、ffmpeg 构建与安装技术后，核查再分发许可证、版本、哈希和更新策略；更新依赖需随新安装包明确发布。

## 测试与验收

1. 用本地 fixture 页面验证 DOM/播放器配置/媒体请求候选识别、去重、来源域展示、无效 `blob:` 排除和用户勾选。
2. 用本地无 DRM HLS VOD fixture（多片段）记录 HTTP 请求次数，验证 MP4 封装、片段失败重试、强制杀死 worker 后进程重启恢复、已完成片段不重下、签名失效/playlist 变化报错、目标文件不覆盖；固定并记录 yt-dlp 版本及实际 downloader 参数。
3. 验证 Native Messaging framing、schema 限制、扩展 ID 校验、关闭弹窗后任务继续、连接断开/Edge 关闭时 worker 停止并保留状态、Edge 重启后的用户确认恢复及系统重启后任务恢复。
4. 验证登录态默认关闭；无用户手势不能请求权限；仅当前获准主机的 Cookie 被读取；权限拒绝、CDN 跨域和分区 Cookie 不可用时明确失败；Cookie 不进入日志/持久任务文件/进程参数，并测试临时凭据清理。
5. 用本地 DNS/HTTP fixtures 验证初始 URL、重定向、m3u8 子清单、分片及下载器探测请求对 loopback/private IP 的拒绝，并测试 DNS rebinding 防护；模拟受限网络层不可用或覆盖不完整时，确认 yt-dlp 未被启动且任务明确失败。
6. 在干净 Windows 用户环境验证单安装包安装、HKCU Native Host 注册契约、手动加载扩展、扩展 ID 配对、升级、卸载和保留/清理行为。
7. 锁定 yt-dlp/ffmpeg 具体构建后核实版本、哈希和再分发许可证/NOTICE；许可证核验未通过不得发布安装包。
8. 全程使用本地模拟服务器，不向用户提供的真实媒体地址发请求，不触发外部副作用。

## 已确认的产品决策

- 扩展界面采用 A「资源清单」。
- 采用本机桥接，目标为 HLS 片段级续传和 MP4 封装。
- 桥接及运行依赖随同一个 Windows 安装包交付。
- 首次安装可接受在 Edge 手动加载扩展。
- 支持用户按任务显式授权使用当前 Edge 登录态；默认不启用。
