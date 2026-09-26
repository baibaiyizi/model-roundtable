# 模型圆桌 1.0.0 宣传素材

面向中文社交平台的发布素材。内容围绕「多模型讨论 → 执行真实文件任务 → 多模型审阅」，不是模型能力评测。

## 可发布内容

- `copy.zh-CN.md`：短、中、长三版文案，三个标题、视频简介、置顶评论与 FAQ。
- `storyboard.json`、`captions.zh-CN.srt`：60 秒视频分镜及字幕。
- `design.json`：图卡和封面的可编辑文字、配色与版式参数。
- `assets/`：原创或有明确来源的主视觉、品牌资源与最终精选截图。
- `assets/licenses/NotoSansSC-OFL.txt`：实际使用字体的原始 OFL 许可，随宣传包以 `FONT-LICENSE.txt` 交付；不附字体二进制。

最终交付与打包入口是 `.cache/promo/delivery/`：6 张 1080×1440 图卡，1920×1080 横封面，1280×640 分享图，1920×1080 与 1080×1920 两版 60 秒 MP4。`.cache/promo/output/` 仅为制作中间目录；原始视频、临时数据、模型测试响应及工具也留在 `.cache/promo/`，不进入源码仓库。发布时只打包 `delivery/`，不塞入应用安装包。

## 复现制作

1. 先完成正式 1.0.0 构建。`node scripts/promo-record.mjs` 会检查实际运行版本；不是 1.0.0 则停止。可用 `PROMO_EXECUTABLE` 指向安装版 EXE。
2. 录制依赖当前项目 Playwright 的 FFmpeg。需要时在制作缓存安装：`$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/promo/playwright"; npx playwright install ffmpeg`。
3. 运行 `node scripts/promo-record.mjs`。演示用独立配置、独立项目和本机受控服务；真实执行后台修改 `index.html`，生成读书清单网页，并在浏览器实际验证阅读状态按钮。不会读取日常账号或调用收费模型。
4. 主视觉位于 `marketing/assets/roundtable-hero.png`，来源记录在 `assets/SOURCES.md`。运行 `node scripts/promo-render.mjs` 生成图片及视频版式。
5. 设置 `PROMO_FFMPEG` 为本机制片 FFmpeg 完整构建，运行 `node scripts/promo-video.mjs`。它需支持 `libopenh264`、VP8 解码、`overlay` 和 libass 的 `ass` 滤镜。脚本将 SRT 转为对应分辨率的 ASS，在预留字幕区烧录，再输出 H.264；不修改产品随包 FFmpeg。
6. 运行 `node scripts/promo-verify.mjs`，逐张检查图片、按分镜检查视频。`node scripts/promo-review.mjs` 会让浏览器连续播放两版至结束并检查解码。完成画面与隐私复核后，加 `--approve-visual` 记录验收；未经检查不要使用该参数。
7. `node scripts/promo-contact.mjs` 生成八图及横竖视频的复核拼图，位于 `.cache/promo/review/`。这些是质检材料，不加入宣传图卡序列。

## 展示约束

- 只截录正式版本真实界面，不绘制不存在的产品控件。演示数据持续标明，模型名使用 `demo-*`，不冒充真实供应商响应。
- 实际等待在视频中经过剪辑；保留「等待已剪辑」说明，不将演示速度当作真实模型性能。
- 不显示真实凭据、订阅、账号、私人聊天、个人路径或工作文件。仅使用专用演示项目。
- 宣传的「免费开源」指应用原创源码；模型、搜索及资料处理费用由各服务自行收取。第三方组件保留各自许可。
- 不承诺全离线、百分百正确、完全自动、安全沙箱或支持所有 VPN / VS Code 插件。
- GitHub 地址固定为 `https://github.com/baibaiyizi/model-roundtable`；仅在仓库与 Release 公开并验证后发布宣传文案。
- 无配音、无音乐。竖版使用真实界面局部和完整画面组合，保留内容语义，不将界面重排冒充移动版。

## 验收记录

实际录制与编码结果写入 `.cache/promo/output/validation.json`。可发布成品由校验脚本筛选到 `.cache/promo/delivery/`，只打包该目录，不打包原始录制、账户目录或中间版式。素材未生成或未检查时不标记为通过。原始 WebM 与时间段清单保留在制作缓存，便于核对剪辑来源。
