# 视频大小快速探测设计

## 目标
扫描出媒体候选后，尽快显示可供比较的文件大小；探测不得启动下载，也不得读取或发送登录 Cookie。

## 用户体验
- 扫描结果立即显示，大小字段先显示“正在探测大小…”，不等待所有探测结束。
- MP4/WebM 若服务器提供有效 `Content-Length`，显示精确大小。
- HLS 若能从主播放列表取得码率，并从对应媒体播放列表取得总时长，按 `码率 × 时长 ÷ 8` 显示估算大小，明确标记“约”。
- 服务器不提供所需元数据时显示“无法估算”；网络/协议错误显示“探测失败”，不得把错误伪装成成功或未知值。

## 架构与数据流
1. Popup 触发现有扫描流程，候选列表先渲染。
2. Popup 为每个候选发出 `probeSize` Native Messaging 请求，最多同时发出 3 个，并在该候选行异步更新大小状态。`replyTo` 将每个结果关联回对应候选，单项失败不阻断其他候选。
3. Native Host 在最多 3 个探测工作线程中并行处理请求，主消息循环继续接收其他操作；Host 校验 URL 只允许无凭据、长度不超过 8192 字符的 HTTP(S) 地址，再通过现有 `EgressProxy` 发起只读请求。HTTP 经受限转发，HTTPS 使用 `CONNECT` 隧道，代理在每次目标连接时执行公网 DNS/IP 校验。
4. MP4/WebM 使用 HEAD；HLS 最多读取两个播放列表：若首个是 master playlist，按 `AVERAGE-BANDWIDTH`（缺失时用 `BANDWIDTH`）选择有效带宽最高的 rendition 并读取其 media playlist；若首个已是 media playlist 且没有带宽数据，返回无法估算。
5. 探测专用代理的上游连接超时和 HTTP 请求超时均为 3 秒，候选总时限为 8 秒；现有下载代理的 10 秒默认值保持不变。探测客户端最多跟随 3 次重定向，且每个重定向目标仍须是无凭据 HTTP(S) 公网地址，并经代理重新校验。每个 HLS 播放列表最多读取 256 KiB；不请求任何媒体分片、不附加 Cookie。
6. Native Messaging 请求类型为 `probeSize`，仅接受 `id`、`type`、`url` 字段；响应包含 `replyTo`、`status` (`exact`、`estimated`、`unavailable`、`failed`) 和可选 `sizeBytes`。UI 根据状态格式化字节值，不接收原始媒体 URL 或服务器响应正文作为错误文案。

## 边界与错误处理
- 候选扫描不得因为单个大小探测失败而失败。
- `Content-Length` 缺失、无效或为负数时标记 unavailable。
- HLS 缺失带宽或有效时长、播放列表超限、编码/格式无法解析时标记 unavailable；超时、HTTP 错误或重定向越限标记 failed，并显示简洁原因。
- 探测 HTTP 请求不构造或附加 Cookie、Referer、Authorization 等页面凭据；不改变共享代理对下载请求的转发行为。签名 URL 仅用于本地请求，不回传到 UI 日志/错误文案。
- 仅对用户点击“扫描此页”发现的 HTTP(S) 候选发起有限只读请求。

## 测试策略
- 用单元测试覆盖字节大小解析与格式化、HLS master/media playlist 的估算、缺少元数据和非法/超限输入。
- 用 Host 协议测试覆盖 `probeSize` 消息的 URL 验证与结构化响应。
- 用 Popup/扩展测试验证扫描结果先显示、探测状态逐项更新且失败不影响其他候选。
- 完成后运行全部 Python/Node 测试及打包 Host 冒烟测试；部署前检查活动下载，避免中断任务。

## 明确不做
- 不遍历或 HEAD 所有 HLS 分片，不承诺 HLS 估算值等于最终 remux 文件大小。
- 不使用 Cookie 进行探测，不下载媒体内容。
- 不对非 HTTP(S) 候选、页面 HTML 或任意用户输入地址开放通用代理能力。
