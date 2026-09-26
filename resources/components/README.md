# 按需运行组件

核心安装包带组件清单、文档 worker、必要许可资料、FFmpeg 和 Mihomo。大型运行时准备到固定的 `userData/components`，与 `originals`、`vectors`、`accounts`、执行记录和文档备份分开。应用覆盖安装不会删除这些目录。组件移除只删除自己的版本目录，不删除用户知识库、项目文件或账号资料。

`manifest.json` 是唯一受信任的安装配方。所有 HTTP 来源锁定版本和 SHA-256 或 npm 原始 SHA-512 integrity；安装器不解析用户提供的清单、不跟随 latest、不运行 npm 安装脚本。`lock-components.mjs` 是维护者显式更新锁文件的工具，应用运行时不会调用它。来源已通过现有官方源清单、Node SHASUMS、GitHub 官方 release asset digest 或 npm 官方包元数据核对；2026-09-24 已实际准备并执行下表全部组件。

| 组件 | 固定版本 | 官方来源及内容 |
|---|---|---|
| 文档编辑 | Python 3.13.15，依赖按清单锁定 | python.org 嵌入式 Python、PyPI 原始 wheels、Google Fonts Noto Sans SC/OFL、本应用 worker |
| 扩展 Python | 3.13.15 | python.org 原始 ZIP；与文档 Python 独立 |
| Office 预览 | LibreOffice 26.2.6.3 | Document Foundation 原始 MSI，只进行管理解包；将 MSI 自带 System64 DLL 放到 program 旁 |
| API 执行 | OpenCode 1.18.32、ripgrep 15.1.0 | anomalyco/opencode、BurntSushi/ripgrep 官方 GitHub release ZIP |
| Codex | 0.156.1 | openai/codex 官方完整 Windows ZIP，保留配套 helper |
| Claude Code | 2.1.280 | downloads.claude.ai 官方 EXE |
| Node / npm | Node 24.21.0 / npm 11.19.0 | nodejs.org 官方 ZIP，按官方 SHASUMS256 锁定 |
| Git | MinGit 2.55.0.5 | git-for-windows/git 官方 ZIP |
| Python 环境管理 | uv 0.12.18 | astral-sh/uv 官方 Windows ZIP |
| 向量索引 | LanceDB 0.39.0 | npm 官方 tarballs，独立 JS wrapper / 完整实际依赖 / x64 native / Microsoft 原始 VC Runtime |
| Skill CLI | skills 1.7.0 | npm 官方 tarball 和锁定的 tar/yaml 依赖，由独立 Node 运行 |
| 内置代理 | Mihomo 1.19.31 | MetaCubeX 官方 windows-amd64-compatible 压缩包随核心安装器提供 |

在线与离线安装共用校验、解包和启用流程。离线选择该组件需要的全部官方原始包，可一次选择多个文件；已经校验过的下载缓存可以复用。内置 `resource:` 文件由应用提供，无需用户单独下载。压缩包路径越界、链接、错误哈希和缺失配套文件会拒绝启用。先写入独立版本树，全部校验后再原子切换 `active.json`；取消或退出不会自动续跑，更不会自动重放模型调用。

原生 LanceDB 在自己的目录通过 `createRequire` 加载，VC DLL 必须紧邻 `.node`，不设置全局 `NAPI_RS_NATIVE_LIBRARY_PATH`。已加载的原生组件不能在当前进程更新或移除，需重启应用。正在执行的程序通过租约阻止移除。

保留原始分发包及 npm 包自带的许可。OpenCode、Codex 和 uv 的原始二进制包未附完整顶层许可，因此还从对应固定版本 tag 保存原文；`licenses/SOURCES.json` 记录 URL、版本与 SHA-256，安装时按清单复制到组件的 `licenses/`。Codex 同时保留 NOTICE。准确来源链接见 manifest 的 `licenses`。组件使用第三方各自的许可，并未变成本应用 MIT。Microsoft VC Runtime 的原始条款、来源和公开再分发限制见 `../runtime/README.md`；将 DLL 改为按需下载不代替发布者取得再分发权。安装器下载官方固定原始 EXE，在本机提取校验过的 DLL，不从 System32 复制、不进行全局 VC 安装。Claude Code 使用 Anthropic 自己的条款和账号。

开发与验收：

```powershell
node scripts/setup-components.mjs --component node,skills,lancedb
node scripts/setup-components.mjs --component documents --import C:\官方原始包
node scripts/verify-components.mjs
node scripts/component-sizes.mjs
node scripts/verify-packaged.mjs C:\安装目录\模型圆桌.exe
```

这些命令默认使用 `.cache/components-runtime`，不会覆盖个人应用资料。`verify-components` 检查已安装文件的哈希，并在去掉开发环境 PATH 后真实执行运行时；LanceDB 还进行独立加载、建表和向量查询。`SIZES.json` 记录本次实际原始包与解包后字节数，不作为安装成功的替代证明。
