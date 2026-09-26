# 参与贡献

欢迎在 [Issues](https://github.com/baibaiyizi/model-roundtable/issues) 报告可复现的问题、提出使用体验建议，或提交范围明确的 Pull Request。

1. 阅读 README、docs/user-guide.md 和第三方声明，在 Windows x64 上按文档准备 Node.js 24 与 Git for Windows。
2. 分别运行根目录和 vscode-extension 的 `npm ci`，准备所需固定组件；不要提交本机组件、密钥、账号资料或测试数据库。
3. 先说明问题与完成判定，再进行最小相关改动。不要附带无关格式化、迁移框架或兼容层。
4. 执行 `npm run typecheck`、相关 Vitest 测试及受影响的桌面/伴随扩展测试。涉及安装、数据、网络或许可的修改，应附对应验收记录。
5. 应用与伴随扩展版本一致。新增依赖前核对现有依赖能力，并补充固定来源、许可原文和真实分发范围。

通过 Pull Request 提交时，请确认你有权按项目 MIT 许可贡献这些原创改动；第三方代码必须保留其自身版权和许可，并明确来源。提交不表示把第三方内容重新许可为 MIT。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。公开 Issue 中请只使用脱敏后的最小样例；不要粘贴 API Key、订阅链接、日志中的令牌或未授权的工作资料。
