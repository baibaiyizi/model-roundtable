# 正式发布

应用及独立 VSIX 版本必须一致。生产标识和固定用户数据目录不得随发布版本改变。所有动作从项目独立 Git 根目录执行。

## 构建与核验

1. 按 README 安装锁定依赖、构建同版本 VSIX，并准备媒体、网络和按需测试组件。
2. 运行类型检查、单元、桌面及伴随扩展测试；`npm run licenses` 离线校验固定原生许可并重新生成完整声明。需要更新原生许可时才显式运行维护收集脚本，不能在普通构建时静默接受新版本。
3. `npm run release:verify` 检查跟踪文件、版本和常见秘密/个人路径。人工核对命中项和实际发布素材；扫描通过不代表可以跳过来源审查。
4. `npm run dist` 生成安装器。安装到隔离目录后执行 `node scripts/verify-packaged.mjs <安装目录>` 和 `node scripts/verify-publication.mjs --packaged <安装目录>`，并用 `ROUNDTABLE_EXECUTABLE` 跑安装版桌面测试。隐私检查覆盖实际编译的应用代码与资源，不只检查开发源码。
5. 覆盖升级使用显式提供的旧安装包及隔离数据，不删除日常用户资料；测试后清理自己创建的安装目录，并恢复受影响的本机安装登记与快捷方式。
6. `npm run source` 使用 Git 跟踪清单与固定哈希的对应源码白名单打包，排除未跟踪个人文件。标签的源码与最终构建材料一起交付，不依赖 GitHub 自动生成 ZIP 补齐被忽略的第三方源码。

Windows CI 从干净检出执行核心构建、伴随扩展、安装检查和测试；仅上传明确列出的安装器、源码、VSIX及声明，不上传组件缓存、账号目录、VC DLL或工作资料。

## 交付目录

在 `release/.staging/<版本>/` 放入：

- `Model-Roundtable-<版本>-win-x64.exe`（及 electron-builder 的 blockmap）
- `Model-Roundtable-<版本>-source.zip`
- `model-roundtable-companion-<版本>.vsix`
- `model-roundtable-<版本>-media-kit.zip`
- `RELEASE_NOTES.md`、`THIRD_PARTY_NOTICES.md`、`ACKNOWLEDGMENTS.md`、`LICENSE`
- `validation.json`：记录当前版本真实测试、安装体积、限制和证据；所有必需检查通过才可设 `accepted: true`

运行 `node scripts/checksums.mjs` 生成清单，分别对源码、VSIX和宣传素材 ZIP 运行 `node scripts/verify-publication.mjs --archive <文件>`。核对图片、视频、字幕、账号字段及所有下载链接。

运行 `npm run release:finalize` 只会创建新的 `release/<版本>/`，不会覆盖已有发布；完整检查通过后才更新本机 `latest.json`。

## GitHub

推送经过检查的源码和相应版本标签，等同一提交的 Windows CI 成功。建立草稿 Release 并上传完整交付清单，验证远端文件的大小和 SHA-256，再发布并设为 Latest。源代码内保留第三方版权头与许可。

为仓库启用私密漏洞报告。社交平台宣传由维护者自行发布；仓库内有可编辑文案与版式，大视频和录制缓存只放 Release 素材包，不放 Git。

首版没有自动更新服务、商业代码签名或未实测环境认证。公开验收记录只写本次实际运行的结果，不沿用旧版测试数量。
