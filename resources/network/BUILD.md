# Mihomo 对应源码与构建材料

发行内核保持官方 `v1.19.31 windows-amd64-compatible` 压缩包原样。`manifest.json` 锁定压缩包、完整源码、Go 依赖、构建工具链及许可原文的 SHA-256。`npm run network:setup` 可从固定来源恢复缺少的压缩包；`npm run network:verify` 离线验证全部材料，缺少或校验不符时阻止发行。

## 原内核的构建事实

- `build-info/go-buildinfo.txt` 来自原 EXE 的 `go version -m`。源码提交为 `ab405bad5beeeac8b003bb01f60f134f6df54471`，`CGO_ENABLED=0`、`GOOS=windows`、`GOARCH=amd64`、`GOAMD64=v1`、`with_gvisor`。
- 原 EXE 记录 `vcs.modified=true`。固定提交中的 `.github/workflows/build.yml` 在编译前把 Ubuntu `/etc/ssl/certs/ca-certificates.crt` 写入源码；Git 标签内对应文件为空。不能把标签源码原封不动地描述为生成该 EXE 的完整输入。
- `build-info/ca-certificates.crt` 从原 EXE 中唯一最长的连续 PEM 区域提取：文件偏移 `52061376`，`182140` 字节，`121` 张通过 X.509 解析的证书。它是本发行对应的可编辑 PEM 源快照，构建时复制到 `component/ca/ca-certificates.crt`。不使用构建机器当日的信任库代替。Mozilla 证书数据适用的 MPL-2.0 文本和发行说明保存在 `licenses/certificates/`；其中 Debian 说明用于保留证书数据许可说明，不宣称已识别上游 Ubuntu 包的具体版本。
- 上游使用 MetaCubeX 的补丁 Go 1.26 工具链。固定保存的官方 `go1.26.linux-amd64.tar.gz` 包内 `VERSION` 为 `go1.26.8`，含完整 `src/`、许可证和编译工具；官方发布摘要为 `5f2c63d89fa1f10e0b9ce29ef166e16cdee6d7aca280e7f2fc27f3bf4945fab0`。另附同次官方 `go1.26.patch`。发布资产更新于 2026-09-02，早于该 Mihomo 构建。`build-info/toolchain-release.json` 保留来源及资产 ID。
- 上游工作流指向可更新的 `build` 发行资产；本发行以下载摘要固定留存的工具链源码和补丁，没有完成原 EXE 的逐字节可复现构建验证。

## Go 依赖与许可

`sources/go-modules/` 提供 176 个锁定依赖的原始 `.zip`、`.mod`、`.info`，包含完整源码及包内许可。收集时根据 `go.sum` 核对并重新计算每个 zip 的 Go `h1`；普通构建再核对固定 SHA-256。二进制列出的每个依赖必须匹配版本和 `h1`，包括 `google.golang.org/protobuf` 到 `github.com/metacubex/protobuf-go` 的 replace。

`licenses/go-modules/` 把上述包中的许可、版权、NOTICE、PATENTS 和 AUTHORS 原文单独保留，随二进制安装。`licenses/toolchain/` 同时保留 Go 标准库和其 vendored 依赖的许可原文。源材料是保守集合，含一些跨平台和开发依赖；不把全部条目描述为 Windows 二进制实际链接库。

`github.com/RyuaNerin/testingutil@v0.1.0` 只由依赖的 `_test.go` 文件导入，不在原 EXE 依赖清单中。其固定仓库提交没有许可，故不再分发该测试辅助包。构建 Mihomo 主程序不需要它；本源码包不承诺离线运行所有上游依赖的独立测试。

## 从发行源码材料重新构建

以下在 Linux 构建 Windows amd64-compatible 主程序；需要本机常规 shell、tar、Git（如需记录自有修改）。它不会修改模型圆桌的运行内核。

1. 解压 `sources/mihomo-v1.19.31.tar.gz` 到独立工作目录。
2. 解压 `sources/metacubex-go1.26.8-linux-amd64.tar.gz`，使用其中 `go/bin/go`；完整标准库源码在 `go/src`。
3. 把本目录 `build-info/ca-certificates.crt` 复制到源码的 `component/ca/ca-certificates.crt`。
4. 设置 `GOPROXY=file:///绝对路径/resources/network/sources/go-modules`，`GOSUMDB=off`，`GOTOOLCHAIN=local`。仅在所有材料通过 SHA-256 与 Go h1 校验后使用该离线来源。
5. 在源码根目录执行（按本机实际路径设置 PATH）：

```sh
export PATH="/absolute/path/to/patched-toolchain/go/bin:$PATH"
export GOOS=windows GOARCH=amd64 GOAMD64=v1 CGO_ENABLED=0 GOTOOLCHAIN=local
go build -buildvcs=false -tags with_gvisor -trimpath \
  -ldflags "-extldflags --static -X 'github.com/metacubex/mihomo/constant.Version=v1.19.31' -X 'github.com/metacubex/mihomo/constant.BuildTime=Mon Sep 14 13:20:49 UTC 2026' -w -s -buildid=" \
  -o mihomo-windows-amd64-compatible.exe .
```

这里关闭 VCS 自动标记是因为发行源码压缩包没有原构建目录的 `.git` 和 dirty 状态；它与 CA 来源、构建主机等差异一起明确限制字节级复现结论。上游原始构建定义完整保存在源码及 `build-info/upstream/`，修改者可按 GPLv3 使用、修改和重新构建。

## 维护收集

`scripts/prepare-network-sources.mjs` 是维护操作，读取已验证的官方 Go 下载记录、原内核和上游源码，在重新计算 Go 内容校验后生成清单。它不会运行上游源码。新增依赖、更新内核或更换工具链必须重新审查清单；不能通过修改版本名沿用旧材料。
