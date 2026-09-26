# Microsoft Runtime 本地部署

本目录记录 LanceDB 的 Windows x64 原生模块对 `VCRUNTIME140.dll` 的直接依赖和已验证来源。核心安装包不带此 DLL；准备 LanceDB 组件时下载固定 Microsoft 原始包并本机提取到组件的 `node_modules/@lancedb/lancedb-win32-x64-msvc/`，紧邻原生模块。它仅依赖 Windows 10/11 已有的 Kernel32 和 Universal CRT API 集合，不安装全局运行库，不要求用户管理员权限。

Node 加载原生模块时按该模块所在目录查找依赖，仅将 DLL 放在应用 EXE 旁不足以保证使用本地副本。验收不仅检查文件存在，还读取已运行主进程的模块路径，确认实际载入组件目录内的 DLL。

当前运行库用于本机应用验证；没有向公共仓库上传 DLL，也没有公开发布包含它的安装包。源码归档不包含 `bin/`。原创应用代码的 MIT 许可不适用于 Microsoft DLL。

## 固定来源与复现

- 来源：Microsoft 官方 `vc_redist.x64.exe`，版本 **14.44.35211.0**。
- 官方入口：<https://aka.ms/vs/17/release/vc_redist.x64.exe>。构建使用 `manifest.json` 中固定的 `download.visualstudio.microsoft.com` 地址，**不跟随 latest 更新**。
- 安装包 SHA256：`cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b`。
- DLL SHA256：`d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066`。
- 安装包 Authenticode：`Valid`，签名者 `Microsoft Corporation`。
- DLL Authenticode：`Valid`，签名者 `Microsoft Windows Software Compatibility Publisher`（组织 Microsoft Corporation），版本 `14.44.35211.0`。

`node scripts/setup-components.mjs --component lancedb` 使用同一固定安装包 SHA256，通过 Windows 内置 Cabinet 解包工具提取并再次验证 DLL SHA256。组件安装不会执行 VC 安装程序或 MSI，也不从 System32 复制文件。上方签名与版本来自原始来源核查；更新版本需要明确更新清单并重新核验。

`licenses/LICENSE-en.rtf` 与 `LICENSE-zh-CN.rtf` 是官方安装包中未经修改的英文、简体中文条款。提取路径及所有哈希保存在 `manifest.json`。此应用不使用 LanceDB 的自动 Embedding，所以安装包排除了未使用的 Hugging Face、ONNX Runtime 模型运行时。

## 公开再分发条件

原始 Runtime 终端许可授权安装和使用，本身不授权将运行库公开发布或随应用再分发。Microsoft 的 [Visual Studio 2022 Distributable Code 清单](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution) 和 [Redistribute Visual C++ files 说明](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170) 规定，再分发须符合相应 Visual Studio 许可。

若公开发布包含 Microsoft DLL 的组件归档，发布者需要确认自己具有相应再分发权，并保留 Microsoft 声明及这些原始许可。当前目录及自动化脚本没有代替发布者取得该许可。核心安装包只携带固定官方来源和许可文本，不分发 DLL；将组件改为按需获取也不授予任何额外再分发权。公开构建仅上传明确列出的核心安装器、源码、VSIX 和说明，不上传本机组件缓存或 Microsoft DLL。

本地部署的 DLL 不由系统集中更新。维护者需定期检查官方安全更新，重新锁定版本、验证签名与哈希，然后发布新的组件清单与应用版本。
