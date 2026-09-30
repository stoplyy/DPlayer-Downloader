# Edge HLS 视频下载器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 上交付 Edge MV3 扩展、Native Messaging Host 和 yt-dlp/ffmpeg 下载桥接，允许用户扫描/勾选当前页媒体、对 HLS 断线后续传，并通过一个安装包安装所有组件。

**Architecture:** 扩展仅在用户操作时扫描当前标签页并通过 Native Messaging 发送有限任务协议。PyInstaller 将 Python Host 打包为独立 exe，不依赖目标机 Python；Host 对协议、路径和 URL 作校验，启动带受限本机 egress 代理的 yt-dlp worker；连接断开时终止 worker，但保留 HLS 分片与任务状态供用户重新确认恢复。PowerShell 安装脚本注册 HKCU Native Host；单个 ZIP 包含扩展、Host exe、经许可审查的工具二进制及安装/卸载脚本。

**Tech Stack:** Edge Manifest V3、原生 JavaScript/HTML/CSS、Python 3.12 标准库、Node `node:test`、yt-dlp、ffmpeg/ffprobe、PyInstaller、PowerShell、ZIP。

---

## 文件结构

以下所有路径均相对于项目根 `DPlayer-Downloader/`。

- Create: `extension/manifest.json` — MV3 权限与入口。
- Create: `extension/popup.html` — A 资源清单弹窗骨架。
- Create: `extension/popup.css` — 紧凑的扩展弹窗样式。
- Create: `extension/popup.js` — 扫描、选择、队列和状态 UI。
- Create: `extension/service_worker.js` — 当前标签页扫描及 Native Messaging 生命周期。
- Create: `extension/scanner.js` — DOM/播放器配置媒体候选解析与去重。
- Create: `host/native_host.py` — Native Messaging framing、任务路由与进程生命周期。
- Create: `host/proxy.py` — 拒绝非公网目标的 HTTP CONNECT/HTTP egress proxy。
- Create: `host/downloader.py` — yt-dlp 命令构建、Cookie 临时文件、进度和中断恢复。
- Create: `host/task_store.py` — 当前用户任务原子持久化、DPAPI URL 加密及敏感字段脱敏。
- Create: `tests/test_scanner.mjs` — 资源发现纯函数 Node 测试。
- Create: `tests/test_protocol.py` — Native Messaging framing/协议测试。
- Create: `tests/test_proxy.py` — 公网 IP 校验、DNS 固定与私网拒绝测试。
- Create: `tests/test_downloader.py` — yt-dlp 参数、恢复和 Cookie 不落盘测试。
- Create: `tests/test_task_store.py` — DPAPI、任务状态、删除/保留及敏感数据测试。
- Create: `installer/native-host-manifest.template.json` — 固定 host name、stdio 与扩展 ID 模板。
- Create: `installer/install.ps1` — 安装到当前用户目录、生成 Host manifest、注册 Native Host 并打开 Edge 扩展管理页。
- Create: `installer/uninstall.ps1` — 移除程序和注册项，下载/任务数据默认保留。
- Create: `installer/build.ps1` — PyInstaller 构建 Host exe，验证依赖版本/哈希/许可证材料并生成单一 ZIP 安装包。
- Create: `README.md` — 开发加载、构建、权限和限制说明。

## Task 1: 资源扫描逻辑（TDD）

**Files:** `extension/scanner.js`, `tests/test_scanner.mjs`

- [ ] 写资源候选纯函数测试：HTTP(S) HLS/MP4/WebM 被识别，重复 URL 去重，`blob:`/`data:`/脚本 URL 被排除，签名 query 不进入展示 label。
- [ ] 执行 `node --test tests/test_scanner.mjs`，确认因导出函数缺失而失败。
- [ ] 实现只接受来源对象数据的候选规范化与去重，不触网、不解析任意脚本内容。
- [ ] 重跑同一命令并确认通过后再接入 popup/service worker。

## Task 2: Edge MV3 扩展与 A 资源清单界面

**Files:** `extension/manifest.json`, `extension/popup.html`, `extension/popup.css`, `extension/popup.js`, `extension/service_worker.js`, `extension/scanner.js`

- [ ] 建立 MV3 manifest，固定扩展公钥/ID，基础权限采用 `activeTab`、`scripting`、`nativeMessaging`；登录态在 `optional_permissions` 中声明 `cookies`，并通过用户手势请求对应媒体主机的 `optional_host_permissions`。
- [ ] 先新增 Node 测试覆盖纯消息校验/候选去重逻辑，再执行并确认红灯；避免在 Node 测试中假装可调用真实 Chrome API。
- [ ] 实现 MV3 service worker：用户点击后通过 `activeTab`+`scripting.executeScript` 扫描 DOM video/source、播放器 data-config 与 Performance resource entries；不申请全站 `webRequest` 监听权限。
- [ ] 用扩展 API mock 测试 popup → worker → Native Messaging 协议；模拟断连后验证任务状态标记 interrupted 并保留 task id。
- [ ] 为暂停、恢复、取消、删除编写 popup/worker 消息路由测试并先确认失败；逐项断言：暂停后状态为 paused、worker 及其完整子进程树退出、`.part`/`.ytdl` 保留、Cookie 临时文件删除；恢复后先重新授权并获取新 Cookie（不复用旧凭据），同一 task ID 启动新 worker 且完整进程树运行、状态为 downloading、相同部分文件继续增长且不重新下载已完成片段，任务再次停止/结束后 Cookie 临时文件删除；取消后状态为 cancelled、worker 及完整子进程树退出、部分媒体文件和任务记录保留、Cookie 临时文件删除；删除确认对话框选择“否”时任务状态/记录/文件/凭据/进程均完全不变，选择“删除”后先确认 worker 和全部子进程均已退出，再移除记录、部分文件和临时凭据。
- [ ] 为 Cookie 主机权限编写扩展权限 mock 测试并先确认失败：媒体主机和每个 CDN/重定向主机逐个请求授权；拒绝某主机授权后不得读取该域 Cookie，并明确停止该任务登录态下载。
- [ ] 实现弹窗：桥接状态、扫描按钮、候选复选框、按任务登录态显式授权、下载队列和错误提示；签名参数从界面隐藏；提供暂停、恢复、取消、删除操作，其中删除须二次确认。
- [ ] 用本地 mock bridge 测试扫描、勾选、创建任务及关闭弹窗后状态可重连；人工加载扩展检查 manifest 可解析。明确扫描不保证回溯未知 `blob:` 源；仅展示页面可访问到的真实源 URL。

## Task 3: Native Messaging Host 与状态存储（TDD）

**Files:** `host/native_host.py`, `host/task_store.py`, `tests/test_protocol.py`, `tests/test_task_store.py`

- [ ] 写 4 字节 little-endian length-prefixed JSON 编解码测试、消息长度上限、非法 JSON/schema拒绝和固定 extension origin allowlist 测试。
- [ ] 确认测试按预期失败，再实现 framing 与严格 schema 校验。
- [ ] 通过 `pyinstaller --onefile` 将 Host 构建为自包含 exe；测试 exe 在没有 Python PATH 的干净 Windows 用户下能启动/读写协议。
- [ ] 写任务状态迁移、atomic persistence、DPAPI round-trip 测试，并检查原始 task JSON 不含签名 query 明文；明文 Cookie 不写任务库。
- [ ] 实现 queued/downloading/paused/interrupted/finalizing/completed/failed/cancelled 状态以及 Edge 断连时停止子进程并保留 yt-dlp 状态。
- [ ] 实现暂停保留部分文件、取消保留到用户删除、删除二次确认后清除任务/部分文件/临时凭据；启动时清除异常退出遗留 Cookie 临时文件，并以测试验证。
- [ ] 同一 Host 通过参数数组启动 worker，禁止 shell 字符串执行；只接受 UUID task id 和固定输出根目录。

## Task 4: 受限网络代理和下载续传（TDD）

**Files:** `host/proxy.py`, `host/downloader.py`, `tests/test_proxy.py`, `tests/test_downloader.py`

- [ ] 先写 URL/IP 策略测试：拒绝 loopback、RFC1918、link-local、保留/多播地址与 IPv4-mapped IPv6；公网 DNS 解析结果固定到实际连接地址，避免二次解析绕过。
- [ ] 在本地 mock resolver/socket 上确认测试因实现缺失失败；再实现逐跳校验的 HTTP proxy、CONNECT 隧道和超时/大小限制。无法创建或探测代理时 worker 必须不启动。
- [ ] 先固定 yt-dlp 精确版本/哈希和许可材料，再写 downloader 命令测试：显式 `--downloader m3u8:native`、续接、片段重试、单并发、固定输出路径、HTTP proxy 参数、清除 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 的大小写变体后设置代理；同一个锁定二进制验证全部请求都到达代理。
- [ ] 让锁定版 yt-dlp 通过代理访问本地 HLS fixture；在代理记录每次 CONNECT/HTTP 请求，确认嵌套 playlist、分片和重定向均通过代理；配置代理失败时确认 yt-dlp 进程创建次数为零。
- [ ] 实现本地 worker 生命周期：Native Host 连接结束则终止 yt-dlp，原子标记 interrupted，保留 .part/.ytdl；用户重新确认后用相同 task id 恢复。
- [ ] Cookie 登录态默认关闭；用户授权后按每个获准媒体/CDN 域提供 Cookie。先写测试，验证 Cookie 不进入命令行、日志或任务数据库，临时文件在当前用户专属 LocalAppData 目录且 Windows ACL 仅允许当前用户；正常结束、取消、worker 被杀后均能清理残留凭据。恢复任务必须重新授权/获取，不复用旧 Cookie。
- [ ] 扩展在发现跨域 CDN/重定向主机时，逐个调用用户手势权限请求；拒绝任一必需主机权限则明确失败，不读取未授权域 Cookie、不静默降级。以扩展 API mock 验证每个 host permission 请求与 Cookie 查询域名一一对应。
- [ ] 本地 HLS 多片段 fixture：强制杀进程、重启相同任务，用服务器请求计数确认已完成片段不重下；此测试不得访问真实视频服务器。

## Task 5: Windows 单包安装交付

**Files:** `installer/native-host-manifest.template.json`, `installer/install.ps1`, `installer/uninstall.ps1`, `installer/build.ps1`, `README.md`, 构建所需 `vendor/` 输入文件

- [ ] 生成固定扩展公钥并写入 manifest；install.ps1 将 Native Host manifest 模板中的固定 host name、`stdio`、安装后的绝对 exe 路径及 `allowed_origins` 扩展 ID 替换后写入安装目录，并在 HKCU 注册该 manifest 的绝对路径。
- [ ] 安装测试解析 manifest 和注册表数据，验证 manifest 路径存在、ID/host name/type/path/registry 全部一致；卸载验证只移除程序状态、不误删视频任务数据。
- [ ] build.ps1 先用 PyInstaller 构建无 Python 依赖的 `native_host.exe`，再生成含扩展、Host、yt-dlp、ffmpeg/ffprobe、LICENSE/NOTICE、install.ps1/uninstall.ps1 的单一 ZIP。
- [ ] install.ps1 安装到 `%LOCALAPPDATA%`、注册当前用户 Native Host、打开 `edge://extensions` 指导 Load unpacked；uninstall.ps1 移除注册项和程序，下载与任务状态默认保留。
- [ ] build.ps1 对缺失二进制、版本、哈希或许可材料显式失败；禁止静默联网下载未审查依赖。
- [ ] 发布验收必须实际产出 ZIP，并在无 Python 的干净 Windows 用户账户执行安装、Host 启动、手动加载扩展、升级、卸载，验证升级保留任务数据；缺少工具/许可证/验证时明确判定未交付，不以构建指引替代安装包。

## Task 6: 集成与验收

- [ ] 执行 `python -m unittest discover -s tests -v` 和 `node --test tests/test_scanner.mjs`，均通过。
- [ ] 目标 Edge 实测弹窗关闭、service worker idle/recycle、Edge 退出三种情况；确认弹窗关闭任务继续、Native Messaging 断连时进程树（yt-dlp 及子进程）全部退出、状态持久化，恢复需用户确认且登录态重新授权。
- [ ] 对本地 HLS fixture 做完整 MP4 remux 与强制中断恢复，检查 ffprobe 元信息及 HTTP 请求次数。
- [ ] 验证代理过滤器无法启动时 yt-dlp 进程创建计数为零；覆盖初始 URL、重定向、子 playlist、片段、DNS rebinding。
- [ ] 检查 Edge manifest、Host 配置、ZIP 存在且可解压、扩展 ID/注册一致、依赖许可输入和构建哈希；不执行真实站点下载、不提交代码。

## 风险/发布门槛

- Edge 的 cookies API、可选 host permission 和 MV3 service worker/Native Messaging 生命周期必须在目标 Edge 版本实测。
- 续传仅在本地中断 fixture 通过后才可宣称支持；重试参数本身不足以证明重启恢复。
- 代理必须约束 yt-dlp 的全部出站网络请求。任一请求路径不能强制经过时，默认禁止启动下载。
- 必须锁定 yt-dlp/ffmpeg 构建、哈希及对应许可材料；许可核验未完成不得发布安装包。
