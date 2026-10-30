# 实际界面截图

`host-setup-edge.png`：未安装本机组件的安装引导。
`settings-without-host-edge.png`：无 Host 时仍能维护自动勾选站点。

截图为 1280 × 800，来自隔离 Microsoft Edge 配置文件中加载的实际扩展页面。
为不连接用户的现有 Host，测试副本只将 Native Messaging 名称改为未注册的
`com.local.frame_video_downloader.releasecheck`；没有伪造浏览器 API 或 Host 响应。
弹窗内容与源码一致，未修改其 CSS 尺寸；右侧留白是浏览器页面背景。

截图证明无 Host 的 UI/设置路径，不证明签名安装或商店版端到端下载。
发布时建议补充两个正式商店版本和已连接组件后的真实下载截图，并确认商店当前图片要求。
