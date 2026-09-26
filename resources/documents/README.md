# 文档运行时

应用通过固定 CPython 子进程提供所有执行后端共用的结构化文档工具。在组件中心准备“文档编辑”后即可使用；DOCX/PPTX 的 PDF 预览另需“Office 文档预览”组件。用户不需要自行安装 Python、pip 或 Microsoft Office。

统一组件清单为 `../components/manifest.json`。`node scripts/setup-components.mjs --component documents,libreoffice` 下载并验证锁定的官方 Python 发行包、PyPI wheels、Noto 中文字体和 LibreOffice，保存在独立组件缓存；也可通过 `--import` 导入同样的官方原始包。MSI 仅管理解包，不向系统安装 LibreOffice。运行 `node scripts/verify-components.mjs --component documents,libreoffice` 校验并执行真实运行时。

`worker.py` 是应用 MIT 代码；运行时和依赖保留各自许可。CPython 的 LICENSE.txt、wheel 的 .dist-info 许可、Noto 的 OFL.txt、LibreOffice 安装目录中的 LICENSE/NOTICE 保留在准备后的组件中。LibreOffice 对应源码来自 https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.6.3/src/ ，其 MPL/LGPL 等完整授权和源码材料见 https://www.libreoffice.org/licenses/ 。不将这些组件重新许可为 MIT。

PPTX 知识库导入使用独立的只读 `extract-pptx` 操作，完整提取幻灯片文本、递归组合形状和表格行，并保留幻灯片序号。它不复用检查界面的 2000 对象 / 20000 字符预览，也不执行 OCR、宏、外部加载、动画或 SmartArt 理解。安全上限为 50 MB 原件、1000 张幻灯片、20000 个形状、100000 个表格单元格、2097152 个文字字符及 8 MB 返回结果；任何上限触发时整个提取失败，不交付截断内容。没有文字的图片演示稿明确报错。取消会等待 Python 进程树结束后释放组件租约。

Office 可修改范围是普通 DOCX/XLSX/PPTX 的正文、表格、单元格和普通幻灯片。旧格式、宏、嵌入对象、签名、透视结构及无法验证保真的复杂对象明确拒绝编辑。公式只保存字符串、不重算；Excel 不进入 LibreOffice Calc。LibreOffice 仅把 Word/PPT 副本转换为预览 PDF，预览不代表 Microsoft Office 排版完全一致。

每次编辑先保留原文件版本，检查 SHA256 冲突，验证临时输出后原子替换项目路径；日志记录操作、备份、差异和预览状态。预览失败不会伪报完整成功，取消后不发布未验证的临时输出。

## 工具接口与能力

`DocumentService({runtimeDir,stateDir,components}).callTool(projectRoot,name,args,signal)` 是 UI 和执行者共用入口。`DOCUMENT_TOOLS` 导出 MCP 标准 `name/description/inputSchema`，无需为每个模型重新实现文档逻辑。全部项目路径必须是相对路径；文件及祖先目录的真实路径必须仍位于项目内，拒绝通过目录联接或符号链接越界。

1. `document_inspect({path})` 返回 SHA256、正文段落及 run、表格、工作表单元格、幻灯片和 shape ID、PDF 页及字段。索引从 0 开始，PPT shape 是文件内对象 ID。长检查结果明确标记截断。
2. `document_create({path,content})` 创建新文件，拒绝覆盖。TXT/MD/JSON/CSV 使用 `text`；DOCX/PDF 使用 `title/blocks`（段落、标题、表格、PNG/JPEG 图片）；XLSX 使用 `sheets`；PPTX 使用 `slides`（标题、正文、表格、图片及普通图表）。与格式不匹配的内容字段会失败，不静默丢弃。
3. `document_edit({path,expectedHash,edits})` 支持如下定点操作。要求刚才检查得到的 SHA256，原文操作也必须匹配。
4. `document_preview({path,expectedHash?})` 返回可打开的 `previewPath`；DOCX/PPTX 为转换后的 PDF，XLSX 为原件并配合 `inspection.units` 网格展示，其他格式返回原件路径。

| 格式 | 实际实现的修改 |
| --- | --- |
| TXT/MD/JSON/CSV | 唯一原文替换；JSON 必须在修改后仍可解析 |
| DOCX | 段落局部原文替换，普通表格单元格，追加段落/标题/表格/图片，段落或指定 run 的粗体、斜体、字体、字号、颜色、段落对齐与既有样式，插入内嵌图片 |
| XLSX | 修改单元格值或公式字符串，新建工作表，范围字体/填充/对齐/数字格式；保存为手动计算，不执行宏或重算公式 |
| PPTX | 既有普通文本框和表格值，新增页和 PNG/JPEG 图片，修改普通柱形、条形、折线、饼图的分类和系列数据 |
| PDF | 页面选择与重排、旋转、中文水印/页下注记、普通文本/选项 AcroForm 字段、合并本项目内其他 PDF |

图片和合并源先做与主文件相同的路径检查，并复制到当前任务的固定输入快照，再交给 Python。图片限制为 PNG/JPEG、4000 万像素内；单文件 50 MiB、请求 4 MiB、PDF 500 页、表格检查 10 万单元格，超过时明确失败。

## 不支持事项

不是任意 Office 无损编辑器。DOC/DOT/XLS/PPT、宏格式、签名、ActiveX/OLE、SmartArt、修订、Word 动态域和浮动图片、复杂透视和外部链接、PPT 动画/转场等不进入修改流程。普通 PPT 分类图表使用的内嵌 XLSX 是支持的专门结构，不等于允许任意 OLE。含绘图对象的外来 XLSX 禁止重写，以免 openpyxl 丢失对象。普通 PPT 组合、散点、雷达等图表没有数据修改接口。PDF 不能任意改写既有正文，也不把白块遮盖当真正删除；加密文件及数字签名不能修改。合并源含交互表单时明确拒绝，避免无声丢字段或重命名。

Word 正文替换保留未修改 run 的格式；跨超链接等特殊文字结构不能安全定位时拒绝。PPT 文本替换保持段落数；复杂内容需明确编辑结构，不能靠替换全文重建。LibreOffice 字体和排版可能与 Microsoft Office 不同，输出预览用于检查，不承诺二者像素相同。包含需要自动加载的外部资源时不自动转换；普通超链接文字可保留。

## 保存与失败状态

修改前复制 `before.<扩展名>` 到任务历史目录；所有输出先写目标所在目录的临时文件，再用真实解析器重新打开校验。再次检查原件 SHA256 和真实路径后才替换原路径。新建使用同卷硬链接的排他创建，不会覆盖后来出现的文件。预览副本独立放在 `preview-source/`，不会与备份、任务日志或输入资料碰撞。

任务日志包含项目、路径、前版本哈希、备份、改动和产物。冲突、处理失败和发布前取消均不会覆盖原件。已发布文件之后若预览失败或被取消，返回 `status: preview-failed` 和原因，明确文件已生成但预览验收未完成；不能把它当完整成功。取消会终止 Python/LibreOffice 进程树，退出不会重放任务。嵌入 Python 是固定文档处理器，不把来自模型或资料的文本当 Python 代码执行。

## 实际验证

`npx vitest run tests/documents.test.ts` 使用统一缓存中准备好的真实 Python 和 LibreOffice，包含外来混合 run DOCX、表格和样式、图片、XLSX 缺失缓存公式与样式、新工作表、PPT 表格/图片/图表、中文 PDF、AcroForm、页面和多个来源合并。覆盖中文路径、备份内容、`before.docx` 名称碰撞、SHA 冲突、路径越界、不支持对象和运行中取消。测试会真正重新读取输出、转换 Office PDF，而不是只断言 mock 成功。

本次组件实际原始包与安装体积见 `../components/SIZES.json`。每个已启用组件的 `active.json` 记录完整文件哈希；核心安装包不携带大型运行时。用户准备组件不需要设置开发环境，也不调用系统 Python 或已安装的 Office。
