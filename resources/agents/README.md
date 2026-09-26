# 执行后台

本目录保留后台的来源与组件声明。OpenCode、Codex 和 Claude Code 的实际程序由应用按需从固定官方来源准备，不将本机账号资料或程序缓存打入核心安装器。

当前组件版本、完整文件清单、来源和校验值以 `../components/manifest.json` 为准；本目录早期构建声明不作为另一套运行时安装逻辑。后台保持官方分发原样，并保留其自身许可及服务条款。

Codex 和 Claude Code 使用独立的本机账号目录。Claude 订阅与 Console 登录由原版 CLI 完成，用户自己的 API Key 仅注入明确选择该认证方式的服务子进程。应用不复制浏览器 Cookie，也不提取订阅 OAuth 令牌。
