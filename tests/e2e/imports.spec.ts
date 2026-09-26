import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { crc32 } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import * as XLSX from 'xlsx'
import { startMockAPI } from '../helpers/mock-api'
import { componentTestEnv, testComponents } from '../helpers/components'
import { runMedia } from '../../src/main/knowledge/parsers'
import type { AppAPI, SourceChunk } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

// Small, valid documents built locally with the same fixture methods as the
// parser tests; the application must parse them in its real utility process.
function zipFixture(files: Record<string, string>): Buffer {
  const body: Buffer[] = [], directory: Buffer[] = []; let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text), crc = crc32(data)
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    body.push(local, filename, data); directory.push(central, filename); offset += local.length + filename.length + data.length
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, central, end])
}

function pdfFixture(jpeg?: Buffer): Buffer {
  const stream = jpeg ? 'q 160 0 0 160 10 10 cm /Im1 Do Q' : 'BT /F1 10 Tf 10 100 Td (Local solar energy document with enough text for reliable extraction.) Tj ET'
  const objects: (string | Buffer)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << ${jpeg ? '/XObject << /Im1 5 0 R >>' : '/Font << /F1 5 0 R >>'} >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    jpeg ? Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]) : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const buffers = [Buffer.from('%PDF-1.4\n')], offsets = [0]
  let size = buffers[0].length
  objects.forEach((object, index) => {
    const data = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), typeof object === 'string' ? Buffer.from(object) : object, Buffer.from('\nendobj\n')])
    offsets.push(size); buffers.push(data); size += data.length
  })
  buffers.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`))
  return Buffer.concat(buffers)
}

async function createFixtures(directory: string, ffmpeg: string): Promise<string[]> {
  const canvas = createCanvas(64, 64), context = canvas.getContext('2d')
  context.fillStyle = '#f5f5f0'; context.fillRect(0, 0, 64, 64)
  context.fillStyle = '#26775a'; context.fillRect(8, 8, 48, 25)
  context.fillStyle = '#000'; context.font = '10px sans-serif'; context.fillText('Solar', 12, 50)
  const files = ['文字资料.pdf', '扫描资料.pdf', '中文报告.docx', '预算表.xlsx', '资料图片.png', '中文音频.wav', '无音轨视频.mp4', '演示资料.pptx'].map(name => join(directory, name))
  await writeFile(files[0], pdfFixture())
  await writeFile(files[1], pdfFixture(canvas.toBuffer('image/jpeg')))
  await writeFile(files[2], zipFixture({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>太阳能和储能政策资料。</w:t></w:r></w:p></w:body></w:document>'
  }))
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, { A1: { t: 's', v: '太阳能预算' }, B1: { t: 'n', v: 120 }, A2: { t: 's', v: '未缓存公式' }, B2: { t: 'n', f: 'SUM(B1:B1)' }, '!ref': 'A1:B2' }, '预算')
  await writeFile(files[3], XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  await writeFile(files[4], canvas.toBuffer('image/png'))
  await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:a', 'pcm_s16le', files[5]], AbortSignal.timeout(10000))
  await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1', '-t', '2', '-an', '-c:v', 'mpeg4', files[6]], AbortSignal.timeout(10000))
  await promisify(execFile)((await testComponents.resolve('documents')).executable, ['-I', '-B', '-X', 'utf8', '-c', "from pptx import Presentation; from pptx.util import Inches; import sys; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); g=s.shapes.add_group_shape().shapes.add_group_shape(); g.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='太阳能演示资料：嵌套组合原文'; t=s.shapes.add_table(2,2,0,0,Inches(2),Inches(1)).table; t.cell(1,1).text='储能预算 120'; p.save(sys.argv[1])", files[7]], { windowsHide: true, encoding: 'utf8', timeout: 20000 })
  return files
}

test('all supported document families import through the desktop worker and persist searchable citations', async ({}, testInfo) => {
  test.setTimeout(180000)
  const root = resolve('.'), executablePath = process.env.ROUNDTABLE_EXECUTABLE ? resolve(process.env.ROUNDTABLE_EXECUTABLE) : undefined
  const directory = join(root, '.test-data', `imports-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const mediaRoot = executablePath ? join(dirname(executablePath), 'resources', 'media') : join(root, 'resources', 'media')
  const files = await createFixtures(directory, join(mediaRoot, 'bin', 'ffmpeg.exe'))
  const mock = await startMockAPI(), pageErrors: string[] = []
  let desktop: ElectronApplication | undefined
  const launch = async (): Promise<Page> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [root] }), cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, ...componentTestEnv, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow()
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.waitForFunction(() => Boolean(window.roundtable))
    expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true)
    return page
  }
  try {
    let page = await launch()
    const kb = await page.evaluate(async url => {
      const provider = await window.roundtable.saveProvider({ name: '本机资料验收', baseUrl: `${url}/v1`, modelIds: ['embedding', 'vision', 'transcribe'], apiKey: 'local-import-test', tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 30000 })
      await window.roundtable.saveSettings({ vision: { providerId: provider.id, modelId: 'vision' }, transcription: { providerId: provider.id, modelId: 'transcribe' } })
      return window.roundtable.createKnowledgeBase({ name: '多格式桌面验收', embedding: { providerId: provider.id, modelId: 'embedding' } })
    }, mock.url)
    expect((await page.evaluate(() => window.roundtable.bootstrap())).mediaReady).toBe(true)
    await desktop!.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }) }, files)
    const imported = await page.evaluate(async input => {
      const filePaths = await window.roundtable.selectFiles()
      const files = await window.roundtable.importSources({ knowledgeBaseId: input.id, filePaths })
      const web = await window.roundtable.importSources({ knowledgeBaseId: input.id, url: `${input.url}/article-redirect` })
      return [...files, ...web]
    }, { id: kb.id, url: mock.url })
    expect(imported).toHaveLength(9)
    await expect.poll(async () => page.evaluate(async id => {
      const sources = (await window.roundtable.bootstrap()).sources.filter(source => source.knowledgeBaseId === id)
      return sources.length === 9 && sources.every(source => ['ready', 'failed', 'cancelled'].includes(source.status))
    }, kb.id), { timeout: 90000, intervals: [100, 250, 500] }).toBe(true)
    const sources = (await page.evaluate(() => window.roundtable.bootstrap())).sources
    await testInfo.attach('import-results', { body: JSON.stringify(sources.map(source => ({ title: source.title, status: source.status, error: source.error, chunkCount: source.chunkCount })), null, 2), contentType: 'application/json' })
    for (const source of sources) expect(source.status, `${source.title}: ${source.error ?? source.progress}`).toBe('ready')
    const chunks = await page.evaluate(async ids => Object.fromEntries(await Promise.all(ids.map(async id => [id, await window.roundtable.getSourceChunks(id)]))), sources.map(source => source.id)) as Record<string, SourceChunk[]>
    const get = (title: string) => chunks[sources.find(source => source.title === title)!.id]
    expect(get('文字资料.pdf').some(chunk => chunk.kind === 'text' && chunk.locator === '第 1 页')).toBe(true)
    expect(get('扫描资料.pdf').some(chunk => chunk.kind === 'ocr' && chunk.locator.includes('第 1 页'))).toBe(true)
    expect(get('中文报告.docx')[0].locator).toContain('段落')
    expect(get('预算表.xlsx').some(chunk => chunk.locator.includes('B2') && chunk.text.includes('未计算'))).toBe(true)
    expect(get('资料图片.png').map(chunk => chunk.kind)).toEqual(['ocr', 'vision'])
    expect(get('中文音频.wav')[0]).toMatchObject({ kind: 'transcript', locator: expect.stringContaining('00:00:00–00:00:02') })
    expect(get('无音轨视频.mp4').some(chunk => chunk.kind === 'vision' && chunk.locator.includes('无音轨'))).toBe(true)
    expect(get('演示资料.pptx').some(chunk => chunk.text.includes('嵌套组合原文') && chunk.locator.includes('第 1 张幻灯片'))).toBe(true)
    expect(get('演示资料.pptx').some(chunk => chunk.text.includes('储能预算 120') && chunk.locator.includes('表格第 2 行'))).toBe(true)
    const web = sources.find(source => source.url === `${mock.url}/article-redirect`)!
    expect(chunks[web.id][0]).toMatchObject({ kind: 'web', url: `${mock.url}/article-redirect`, locator: expect.stringContaining('段落') })
    expect(mock.calls.filter(call => call.path === '/v1/audio/transcriptions')).toHaveLength(1)
    const evidence = await page.evaluate(id => window.roundtable.searchKnowledge({ knowledgeBaseIds: [id], query: '太阳能资料' }), kb.id)
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence.every(item => item.sourceId && sources.some(source => source.id === item.sourceId) && item.locator.length > 0)).toBe(true)
    if (executablePath) {
      const mainPid = await desktop!.evaluate(() => process.pid)
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); (Get-Process -Id ${mainPid}).Modules | Where-Object { $_.ModuleName -ieq 'vcruntime140.dll' } | Select-Object -ExpandProperty FileName`], { windowsHide: true, timeout: 10000, encoding: 'utf8' })
      // Node loads native dependencies beside the addon, not beside the app EXE.
      const component = (await page.evaluate(() => window.roundtable.listComponents())).find(item => item.id === 'lancedb')!
      expect(component.phase).toBe('ready')
      expect(resolve(stdout.trim()).toLowerCase()).toBe(join(component.directory!, 'node_modules', '@lancedb', 'lancedb-win32-x64-msvc', 'VCRUNTIME140.dll').toLowerCase())
    }

    for (const target of [
      { title: '文字资料.pdf', locator: '第 1 页', fragment: '#page=1', type: 'pdf' },
      { title: '资料图片.png', locator: '原图', fragment: '', type: 'image' },
      { title: '中文音频.wav', locator: '00:00:01–00:00:02', fragment: '#t=1', type: 'audio' }
    ]) {
      const source = sources.find(source => source.title === target.title)!
      const [viewer] = await Promise.all([
        desktop!.waitForEvent('window'),
        page.evaluate(input => window.roundtable.openSource(input), { sourceId: source.id, locator: target.locator })
      ])
      try {
        await expect.poll(() => viewer.url()).toBe(`${pathToFileURL(source.originalPath! + (target.type === 'audio' ? '.preview.html' : '')).toString()}${target.fragment}`)
        const response = await desktop!.evaluate(async ({ net }, url) => {
          const response = await net.fetch(url)
          return { status: response.status, contentType: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength }
        }, pathToFileURL(source.originalPath!).toString())
        expect(response.status).toBe(200)
        expect(response.bytes).toBeGreaterThan(0)
        if (target.type === 'pdf') {
          expect(response.contentType).toContain('application/pdf')
          const cdp = await viewer.context().newCDPSession(viewer)
          await expect.poll(async () => JSON.stringify(await cdp.send('DOM.getDocument', { depth: -1, pierce: true }))).toContain('application/pdf')
          await cdp.detach()
        } else if (target.type === 'image') {
          await expect.poll(() => viewer.locator('img').evaluateAll(images => images.some(element => { const image = element as HTMLImageElement; return image.complete && image.naturalWidth > 0 }))).toBe(true)
        } else {
          await expect.poll(() => viewer.locator('audio, video').evaluateAll(media => media.some(element => {
            const player = element as HTMLMediaElement
            return !player.error && player.readyState >= 1 && player.currentTime >= 0.9
          }))).toBe(true)
        }
      } finally { await viewer.close() }
    }
    await desktop!.close(); desktop = undefined

    page = await launch()
    expect((await page.evaluate(() => window.roundtable.bootstrap())).sources.filter(source => source.status === 'ready')).toHaveLength(9)
    const restored = await page.evaluate(id => window.roundtable.searchKnowledge({ knowledgeBaseIds: [id], query: '太阳能资料' }), kb.id)
    expect(restored.length).toBeGreaterThan(0)
    expect(restored.every(item => item.sourceId && chunks[item.sourceId].some(chunk => chunk.id === item.id && chunk.locator === item.locator))).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    await desktop?.close()
    await mock.close()
  }
})
