# 致谢与来源说明

感谢下列开源项目、作者与维护者。模型圆桌的原创源码采用 [MIT](LICENSE)；第三方作品继续适用其自身许可证。产品参考、实际依赖和可选扩展分开记录，致谢不能替代复制或分发授权。

## 产品与流程参考

| 项目 / 作者或维护组织 | 参考范围 | 上游许可 |
| --- | --- | --- |
| [RoundTable](https://github.com/entropyvortex/roundtable) / Marcelo Ceccon、entropyvortex | 独立首轮、交叉评议、分阶段讨论的流程调研 | MIT |
| [agent-roundtable](https://github.com/erickong/agent-roundtable) / erickong | 中文主持流程与搜索资料组织的调研 | MIT |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) / CherryHQ | 模型设置、桌面交互与知识库的产品调研 | AGPL-3.0 |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) / SillyTavern contributors | 点名、静音、群聊发言顺序的交互调研 | AGPL-3.0 |
| [ChatALL](https://github.com/ai-shifu/ChatALL) / Sun Zhigang、ai-shifu contributors | 多模型流式回答及比较展示的调研 | Apache-2.0 |
| [LLM Council](https://github.com/karpathy/llm-council) / Andrej Karpathy | 独立回答、互评与主席总结的流程调研 | 核查时未发现明确许可证，仅列研究参考，不作为获授权的代码底座 |
| [AionUi](https://github.com/iOfficeAI/AionUi) / iOfficeAI contributors | 多 Agent 桌面工作流的早期调研 | Apache-2.0 |
| [CloudCLI](https://github.com/siteboon/claudecodeui) / siteboon contributors | 项目、多聊天与 CLI 后台组织的早期调研 | AGPL-3.0 及其附加条款 |

以上记录来自项目设计记录与公开源码核查，不表示已经取得这些项目的品牌许可或官方合作。当前初始公开快照之前的所有设计过程无法仅由 Git 追溯，因此不以代码片段比对结果作绝对的原创保证。若发现遗漏的来源，请通过仓库 Issue 提供具体文件、片段及原始链接，以便核实和更正。

## 实际使用与分发的依赖

逐包版本、来源和许可原文见 [第三方声明](THIRD_PARTY_NOTICES.md) 与 [机器可读清单](resources/licenses/inventory.json)。以下是功能层面的索引，不代替完整清单：

| 组件 | 使用方式与用途 | 许可材料 |
| --- | --- | --- |
| Electron / Chromium / Node.js | 桌面、浏览器、后台运行环境 | 安装目录的 LICENSE.electron.txt、LICENSES.chromium.html 及上游声明 |
| React / React DOM、Lucide、React Markdown / remark-gfm | 界面、图标与 Markdown 展示 | resources/licenses；分别保留上游版权与许可 |
| OpenAI JavaScript SDK、官方 MCP SDK、OpenCode SDK | 模型 API、工具通道及执行后台适配 | resources/licenses |
| Mozilla Readability、PDF.js、Mammoth、SheetJS CE | 网页、PDF、Word 和表格解析 | resources/licenses；PDF.js 自带字体的声明也保留 |
| @napi-rs/canvas、Skia 及其原生依赖 | 扫描页与图片渲染 | resources/native-licenses 与最终 resources/licenses 中的固定版本声明 |
| Mihomo / MetaCubeX contributors | 随包独立代理程序，不设置系统代理或 TUN | [GPLv3、来源与构建材料](resources/network/README.md)；对应源码随正式源码包提供 |
| FFmpeg / FFmpeg developers | 随包的独立媒体程序与共享库 | [LGPL 构建、匹配源码和校验记录](resources/media/SOURCE.txt) |
| OpenCode / Anomaly、ripgrep / Andrew Gallant | 按需下载的 API 执行后台及文件搜索工具 | resources/components 中锁定官方来源与许可 |
| Codex / OpenAI、Claude Code / Anthropic | 按需下载、保持原版的官方后台 | 分别适用官方软件许可与服务条款；不由应用 MIT 许可覆盖 |
| LanceDB、Apache Arrow | 按需准备的知识库向量运行环境 | 原始包声明及组件清单 |
| CPython、python-docx、openpyxl、python-pptx、pypdf、ReportLab、lxml、Pillow、defusedxml、XlsxWriter 等锁定依赖 | 按需准备的文档处理环境 | 原始 Python 分发包与 wheel 中的许可、resources/documents 构建记录 |
| LibreOffice / The Document Foundation | 按需下载，独立进程生成预览 | 原始分发包许可证及固定来源 |
| Noto Sans SC / Google 与字体贡献者 | 文档和宣传中文排版 | SIL Open Font License，保留原文与字体来源 |
| Node.js / npm、MinGit、uv、Vercel Skills CLI | 按需准备扩展安装与运行环境 | 原始分发声明和锁定来源 |
| Microsoft Visual C++ Runtime | 由组件流程从官方来源按需准备 | [Microsoft 运行库说明](resources/runtime/README.md)，不适用应用 MIT 许可 |

字体与图像底层库的声明也属于分发材料。感谢 FreeType 项目；相关字体渲染部分使用 FreeType，并按 FTL 保留声明。图像处理部分使用 Independent JPEG Group 的工作；libjpeg-turbo 的完整 IJG 声明随原生许可材料保留。

## 仅推荐或由用户另外安装

商店中的 [Context7](https://github.com/upstash/context7)、[Brave Search MCP](https://github.com/brave/brave-search-mcp-server)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)，以及 [Anthropic Frontend Design](https://github.com/anthropics/skills)、[Vercel Web Design Guidelines / React Best Practices](https://github.com/vercel-labs/agent-skills)，属于可选扩展。推荐不代表应用已安装、已授权或对其安全性作保证；安装时保留具体版本的来源和许可。

[VS Code](https://code.visualstudio.com/) 由用户自行安装。应用原创伴随扩展以独立 VSIX 提供；[Draw.io Integration](https://github.com/hediet/vscode-drawio) 和 [vscode-pdf](https://github.com/tomoki1207/vscode-pdfviewer) 仅提供介绍入口，不随应用分发，也不暗示官方背书。

## 宣传素材

图标来源于本项目的原创 SVG。概念主视觉通过 imagegen 生成，界面图片来自真实应用的隔离演示数据。生成提示、字体和素材来源记录在 marketing 目录。宣传片没有配音或音乐；不使用第三方模型公司的标志冒充合作关系。
