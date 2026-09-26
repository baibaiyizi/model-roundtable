import { readFile, mkdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ExtractedPart, ImportJob, ParserServices } from './protocol'
import { SUPPORTED_EXTENSIONS } from './protocol'

const IMAGES = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']
const MEDIA = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4', '.mkv', '.mov', '.webm', '.avi']

export function textParts(text: string, kind: ExtractedPart['kind'] = 'text'): ExtractedPart[] {
  return text.replaceAll('\r\n', '\n').split(/\n\s*\n/).map((text, index) => ({ text: text.trim(), locator: `段落 ${index + 1}`, kind })).filter(part => part.text)
}

function decodeText(data: Buffer): string {
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8'
  try { return new TextDecoder(encoding, { fatal: true }).decode(data) }
  catch { throw new Error('文本编码无效；请将文件保存为 UTF-8 或带 BOM 的 UTF-16 后重新导入') }
}

export async function extractSpreadsheet(filePath: string): Promise<ExtractedPart[]> {
  const XLSX = await import('xlsx')
  const data = await readFile(filePath)
  const workbook = extname(filePath).toLowerCase() === '.csv'
    ? XLSX.read(decodeText(data), { type: 'string', raw: true })
    : XLSX.read(data, { type: 'buffer', cellFormula: true, cellDates: true, bookVBA: false })
  const result: ExtractedPart[] = []
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    const rows = new Map<number, { address: string; column: number; text: string }[]>()
    for (const address of Object.keys(sheet).filter(key => !key.startsWith('!'))) {
      const cell = sheet[address], coordinate = XLSX.utils.decode_cell(address)
      if (cell.v === undefined && !cell.f) continue
      const display = cell.v === undefined ? '[公式无缓存结果，未计算]' : XLSX.utils.format_cell(cell)
      const text = `${address}: ${display}${cell.f ? `（公式: =${cell.f}；仅使用已有结果）` : ''}`
      const row = rows.get(coordinate.r) ?? []
      row.push({ address, column: coordinate.c, text }); rows.set(coordinate.r, row)
    }
    for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
      row.sort((a, b) => a.column - b.column)
      result.push({ text: row.map(cell => cell.text).join(' | '), locator: `工作表「${name}」!${row[0].address}:${row.at(-1)!.address}`, kind: 'text' })
    }
  }
  return result
}

async function extractHtml(html: string, url: string): Promise<ExtractedPart[]> {
  const [{ JSDOM }, { Readability }] = await Promise.all([import('jsdom'), import('@mozilla/readability')])
  // JSDOM's default disables script execution and remote subresource loading.
  const dom = new JSDOM(html, { url })
  try {
    const article = new Readability(dom.window.document).parse()
    if (!article?.textContent?.trim()) throw new Error('网页没有可提取的正文；需要登录或依赖脚本的页面请导出为 PDF 后导入')
    return textParts(article.textContent, 'web')
  } finally { dom.window.close() }
}

async function imageParts(dataUrl: string, locator: string, services: ParserServices): Promise<ExtractedPart[]> {
  services.signal.throwIfAborted()
  const answer = await services.vision(dataUrl)
  services.signal.throwIfAborted()
  const parts: ExtractedPart[] = []
  if (answer.ocr.trim()) parts.push({ text: answer.ocr, locator: `${locator} · 文字识别`, kind: 'ocr' })
  if (answer.description.trim()) parts.push({ text: `[模型画面描述，非原文]\n${answer.description}`, locator: `${locator} · 画面描述`, kind: 'vision' })
  if (!parts.length) throw new Error(`${locator}：视觉模型未返回文字或描述`)
  return parts
}

async function extractImage(path: string, locator: string, services: ParserServices): Promise<ExtractedPart[]> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(await readFile(path))
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height))
  const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)))
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
  return imageParts(canvas.toDataURL('image/png'), locator, services)
}

async function extractPdf(path: string, services: ParserServices): Promise<ExtractedPart[]> {
  const canvasLib = await import('@napi-rs/canvas')
  // PDF.js needs these geometry primitives in a Node utility process.
  Object.assign(globalThis, { DOMMatrix: canvasLib.DOMMatrix, ImageData: canvasLib.ImageData, Path2D: canvasLib.Path2D })
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  const assets = (folder: string) => join(pdfRoot, folder).replaceAll('\\', '/') + '/'
  const task = pdfjs.getDocument({ data, useSystemFonts: true, cMapUrl: assets('cmaps'), standardFontDataUrl: assets('standard_fonts'), wasmUrl: assets('wasm') })
  const abort = () => { void task.destroy() }
  services.signal.addEventListener('abort', abort, { once: true })
  const result: ExtractedPart[] = []
  try {
    const document = await task.promise
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      services.signal.throwIfAborted(); services.progress(`解析 PDF 第 ${pageNumber}/${document.numPages} 页`)
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
      if (text) result.push({ text, locator: `第 ${pageNumber} 页`, kind: 'text' })
      if (text.replace(/\s/g, '').length < 30) {
        services.progress(`视觉识别 PDF 第 ${pageNumber} 页`)
        const base = page.getViewport({ scale: 1 }), scale = Math.min(2, 2048 / Math.max(base.width, base.height))
        const viewport = page.getViewport({ scale })
        const canvas = canvasLib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport }).promise
        result.push(...await imageParts(canvas.toDataURL('image/png'), `第 ${pageNumber} 页`, services))
      }
      page.cleanup()
    }
    return result
  } finally { services.signal.removeEventListener('abort', abort); await task.destroy() }
}

export async function runMedia(binary: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort)
      error ? reject(error) : resolve(stdout)
    }
    const abort = () => { child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', data => { stdout += data.toString(); if (stdout.length > 4 * 1024 * 1024) { child.kill(); finish(new Error('媒体元数据超过允许大小')) } })
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000) })
    child.once('error', error => finish(new Error(`媒体工具无法启动：${error.message}`)))
    child.once('close', code => finish(signal.aborted ? new Error('资料处理已取消') : code === 0 ? undefined : new Error(`媒体解析失败 (${code})：${stderr}`)))
  })
}

function timestamp(seconds: number): string {
  const rounded = Math.floor(seconds)
  const milliseconds = Math.floor((seconds - rounded) * 1000)
  return `${Math.floor(rounded / 3600).toString().padStart(2, '0')}:${Math.floor(rounded / 60 % 60).toString().padStart(2, '0')}:${(rounded % 60).toString().padStart(2, '0')}${milliseconds ? '.' + milliseconds.toString().padStart(3, '0') : ''}`
}

async function extractMedia(job: ImportJob, services: ParserServices): Promise<ExtractedPart[]> {
  const ffmpeg = join(job.mediaDir, 'bin', 'ffmpeg.exe'), ffprobe = join(job.mediaDir, 'bin', 'ffprobe.exe')
  const metadata = JSON.parse(await runMedia(ffprobe, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', job.originalPath], services.signal)) as { format?: { duration?: string }; streams?: { index: number; codec_type: string; duration?: string; disposition?: { attached_pic?: number } }[] }
  const duration = Number(metadata.format?.duration ?? metadata.streams?.find(stream => stream.duration)?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法确定音视频时长，不能建立可靠的时间引用')
  const parts: ExtractedPart[] = [], streams = metadata.streams ?? []
  const audioStream = streams.find(stream => stream.codec_type === 'audio')
  const videoStream = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  const hasAudio = Boolean(audioStream), hasVideo = Boolean(videoStream)
  if (!hasAudio && !hasVideo) throw new Error('文件没有可处理的音轨或视频流')
  services.progress(`时长 ${timestamp(duration)}；${hasAudio ? `转录 ${Math.ceil(duration / 300)} 个分片` : '无音轨'}${hasVideo ? `；抽样 ${Math.ceil(duration / Math.max(30, Math.ceil(duration / 120)))} 帧` : ''}`)
  await mkdir(job.scratchDir, { recursive: true })
  if (hasAudio) {
    for (let start = 0; start < duration; start += 300) {
      services.signal.throwIfAborted()
      const end = Math.min(start + 300, duration), wav = join(job.scratchDir, `audio-${start}.wav`)
      services.progress(`转录 ${timestamp(start)}–${timestamp(end)}（分片区间）`)
      await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', job.originalPath, '-t', String(end - start), '-map', `0:${audioStream!.index}`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], services.signal)
      const text = await services.transcribe(wav)
      if (text.trim()) parts.push({ text, locator: `${timestamp(start)}–${timestamp(end)}（转录分片区间，非逐字时间戳）`, kind: 'transcript' })
    }
  }
  if (hasVideo) {
    // Samples cover the entire duration; use at most 120 frames and show the spacing in every locator.
    const interval = Math.max(30, Math.ceil(duration / 120))
    for (let start = 0; start < duration; start += interval) {
      services.signal.throwIfAborted(); services.progress(`识别视频抽样帧 ${timestamp(start)}（间隔 ${interval} 秒）`)
      const imagePath = join(job.scratchDir, `frame-${start}.jpg`)
      await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', job.originalPath, '-map', `0:${videoStream!.index}`, '-frames:v', '1', '-vf', 'scale=1280:-2', imagePath], services.signal)
      parts.push(...await extractImage(imagePath, `${timestamp(start)} 视频抽样帧（间隔 ${interval} 秒${hasAudio ? '' : '，无音轨'}）`, services))
    }
  }
  return parts
}

export async function extractSource(job: ImportJob, services: ParserServices): Promise<ExtractedPart[]> {
  services.signal.throwIfAborted()
  if (job.url) {
    services.progress('提取已保存网页的正文')
    return extractHtml(await readFile(job.originalPath, 'utf8'), job.url)
  }
  const extension = extname(job.originalPath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error(`不支持的资料格式：${extension || '无扩展名'}`)
  if (extension === '.txt' || extension === '.md') {
    return textParts(decodeText(await readFile(job.originalPath)))
  }
  if (extension === '.html' || extension === '.htm') return extractHtml(await readFile(job.originalPath, 'utf8'), 'https://local-document.invalid/')
  if (extension === '.docx') {
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: job.originalPath })
    return textParts(result.value)
  }
  if (extension === '.pptx') {
    if (!services.extractPptx) throw new Error('PPTX 文档提取服务未连接，请重新启动应用后重试')
    services.progress('提取 PPTX 幻灯片文字和表格')
    const parts = await services.extractPptx(job.originalPath)
    services.signal.throwIfAborted()
    if (!parts.some(part => part.text.trim())) throw new Error('PPTX 没有可索引的文字或表格；纯图片幻灯片暂不执行 OCR')
    return parts
  }
  if (['.xlsx', '.xls', '.xlsm', '.csv'].includes(extension)) return extractSpreadsheet(job.originalPath)
  if (extension === '.pdf') return extractPdf(job.originalPath, services)
  if (IMAGES.includes(extension)) return extractImage(job.originalPath, '原图', services)
  if (MEDIA.includes(extension)) return extractMedia(job, services)
  throw new Error(`尚未实现的格式：${extension}`)
}
