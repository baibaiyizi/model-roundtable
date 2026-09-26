# Mihomo 网络组件

模型圆桌使用未修改的官方 Mihomo v1.19.31 Windows amd64-compatible 独立程序，通过本机 HTTP 代理及官方控制接口通信。内核以 GPLv3 分发，见本目录 LICENSE。应用原创代码的许可见项目根目录。

manifest.json 记录官方来源与 SHA-256；运行 `npm run network:setup` 准备、`npm run network:verify` 校验。内核压缩包随安装程序提供，不需要用户自行安装 Clash。内核只在使用订阅线路时启动，不设置系统代理、TUN 或管理员服务。

对应源码位于本版本配套源码包中的 `resources/network/sources/`，也可通过 manifest.json 的来源及摘要恢复。它包含 Mihomo 标签源码、固定 Go 依赖及补丁工具链的完整源码。`build-info/` 保留原 EXE 的 Go buildinfo、实际内嵌 CA 快照及构建依据；`licenses/` 保留 Go 依赖、标准库和证书数据的许可原文并随安装包分发。详细构建步骤和材料范围见 [BUILD.md](BUILD.md)。

原内核的 buildinfo 标为 `vcs.modified=true`，上游工作流编译前会注入系统 CA；工具链也使用上游定制版本。因此本发行保留官方二进制原样，同时补齐相应输入，不把标签源码描述为未经构建处理的全部输入，也不声称已实现字节级可复现构建。

首次准备的内核副本存放于用户数据目录的 components/mihomo；应用升级不删除订阅或模型配置。订阅地址与节点凭据不会包含在本文件、发行源码或常规诊断中。
