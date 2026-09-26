import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import * as XLSX from 'xlsx'
import { Store } from '../src/main/store'
import { KnowledgeService } from '../src/main/knowledge/service'
import { chunkParts, validateVectors } from '../src/main/knowledge/protocol'
import { extractSource, extractSpreadsheet } from '../src/main/knowledge/parsers'
import { VectorStore } from '../src/main/knowledge/vector-store'
import type { GatewayPort } from '../src/shared/ports'
import type { ModelRef } from '../src/shared/types'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'roundtable-knowledge-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })); return dir
}
async function setup(embed?: GatewayPort['embed'], extractor?: Parameters<typeof makeService>[4]) {
  const directory = await temp()
  const store = new Store(':memory:', { encrypt: async text => Buffer.from(text), decrypt: async data => Buffer.from(data).toString() })
  const provider = await store.saveProvider({ name: '测试网关', baseUrl: 'http://localhost:9999/v1', modelIds: ['embed'], tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 30000 })
  const model: ModelRef = { providerId: provider.id, modelId: 'embed' }
  const gateway: GatewayPort = { chat: vi.fn(), transcribe: vi.fn(), embed: embed ?? (async (_model, texts) => texts.map(text => text.includes('交通') || text.includes('地铁') ? [1, 0, 0] : [0, 1, 0])) }
  const service = makeService(store, gateway, directory, model, extractor)
  cleanups.push(async () => { await service.shutdown(); store.close() })
  return { store, gateway, service, directory, model }
}
function makeService(store: Store, gateway: GatewayPort, directory: string, _model: ModelRef, extractor?: (job: import('../src/main/knowledge/protocol').ImportJob, signal: AbortSignal, progress: (text: string) => void) => Promise<import('../src/main/knowledge/protocol').ExtractedPart[]>) {
  const component = async () => ({ id: 'lancedb' as const, version: '0.39.0', directory: resolve('.'), executable: resolve('node_modules/@lancedb/lancedb/dist/index.js') })
  return new KnowledgeService(store, gateway, directory, directory, () => {}, { components: { resolve: component, ensure: component }, extract: extractor ?? ((job, signal, progress) => extractSource(job, { signal, progress, vision: vi.fn(), transcribe: vi.fn() })) })
}
function fixtureZip(files: Record<string, string>): Buffer {
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

describe('知识库解析与引用', () => {
  it('分块不丢字符、不切断 Unicode，保留页码与识别类型', () => {
    const text = '甲'.repeat(31) + '🚇' + '乙'.repeat(35)
    const chunks = chunkParts([{ text, locator: '第 3 页', kind: 'ocr' }], 32)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(text)
    expect(chunks.every(chunk => chunk.locator.startsWith('第 3 页') && chunk.kind === 'ocr')).toBe(true)
    expect(chunks[0].text.endsWith('\ud83d')).toBe(false)
  })

  it('中文表格引用单元格，无缓存公式明确显示未计算', async () => {
    const dir = await temp(), path = join(dir, '中文工作簿.xlsx')
    const sheet: XLSX.WorkSheet = { A1: { t: 's', v: '预算' }, B1: { t: 'n', v: 120 }, A2: { t: 's', v: '未缓存公式' }, B2: { t: 'n', f: 'SUM(B1:B1)' }, '!ref': 'A1:B2' }
    const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, '财务')
    await writeFile(path, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const parts = await extractSpreadsheet(path)
    expect(parts[0].locator).toBe('工作表「财务」!A1:B1')
    expect(parts[0].text).toContain('B1: 120')
    expect(parts[1].text).toContain('公式无缓存结果，未计算')
  })

  it('无 BOM 的 UTF-8 CSV 保留中文内容和单元格位置', async () => {
    const dir = await temp(), path = join(dir, '城市交通.csv')
    await writeFile(path, '城市,交通\n上海,地铁\n', 'utf8')
    const parts = await extractSpreadsheet(path)
    expect(parts.map(part => part.text).join('\n')).toContain('上海')
    expect(parts[1].locator).toContain('A2:B2')
  })

  it('图片的 OCR 与模型描述分别建立引用', async () => {
    const dir = await temp(), path = join(dir, '原始图片.png')
    const { createCanvas } = await import('@napi-rs/canvas')
    const canvas = createCanvas(8, 8); canvas.getContext('2d').fillRect(0, 0, 8, 8)
    await writeFile(path, canvas.toBuffer('image/png'))
    const parts = await extractSource({ originalPath: path, scratchDir: dir, mediaDir: dir }, { signal: new AbortController().signal, progress: vi.fn(), vision: async () => ({ ocr: '原图文字', description: '黑色方块' }), transcribe: vi.fn() })
    expect(parts.map(part => part.kind)).toEqual(['ocr', 'vision'])
    expect(parts[1].text).toContain('[模型画面描述，非原文]')
  })

  it('混合 PDF 按页提取，只有扫描页触发视觉模型且保留页码', async () => {
    const dir = await temp(), path = join(dir, '混合扫描文档.pdf')
    const text = 'A textual page with enough readable content to extract independently.'
    const stream = `BT /F1 10 Tf 10 100 Td (${text}) Tj ET`
    const scanStream = '0 0 0 rg 20 20 80 80 re f'
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 7 0 R >>',
      `<< /Length ${scanStream.length} >>\nstream\n${scanStream}\nendstream`
    ]
    let pdf = '%PDF-1.4\n'; const offsets = [0]
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    await writeFile(path, pdf)
    const vision = vi.fn(async () => ({ ocr: '扫描文字', description: '方块示意图' }))
    const parts = await extractSource({ originalPath: path, scratchDir: dir, mediaDir: dir }, { signal: new AbortController().signal, progress: vi.fn(), vision, transcribe: vi.fn() })
    expect(parts[0].text).toContain('A textual page')
    expect(parts[0].locator).toBe('第 1 页')
    expect(vision).toHaveBeenCalledTimes(1)
    expect(parts.find(part => part.kind === 'ocr')?.locator).toContain('第 2 页')
  })

  it('网页正文不会执行页面脚本', async () => {
    const dir = await temp(), path = join(dir, '安全网页.html')
    await writeFile(path, '<html><head><title>公交分析</title></head><body><article><h1>公交分析</h1><p>' + '公共交通提升通勤效率。'.repeat(60) + '</p></article><script>globalThis.roundtableInjected = true</script></body></html>')
    const parts = await extractSource({ originalPath: path, mediaDir: dir, scratchDir: dir }, { signal: new AbortController().signal, progress: vi.fn(), vision: vi.fn(), transcribe: vi.fn() })
    expect(parts[0].kind).toBe('web')
    expect(parts[0].text).toContain('公共交通')
    expect((globalThis as Record<string, unknown>).roundtableInjected).toBeUndefined()
  })

  it('Word 中文段落通过 Mammoth 提取并保留段落引用', async () => {
    const dir = await temp(), path = join(dir, '中文报告.docx')
    await writeFile(path, fixtureZip({
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段：交通政策。</w:t></w:r></w:p><w:p><w:r><w:t>第二段：环保效果。</w:t></w:r></w:p></w:body></w:document>'
    }))
    const parts = await extractSource({ originalPath: path, mediaDir: dir, scratchDir: dir }, { signal: new AbortController().signal, progress: vi.fn(), vision: vi.fn(), transcribe: vi.fn() })
    expect(parts.map(part => [part.locator, part.text])).toEqual([['段落 1', '第一段：交通政策。'], ['段落 2', '第二段：环保效果。']])
  })
})

describe('知识库完整导入与检索', () => {
  it('缺少可选索引组件时在保存原件和付费 Embedding 之前失败', async () => {
    const { store, gateway, directory, model } = await setup()
    const service = new KnowledgeService(store, gateway, directory, directory, () => {})
    const file = join(directory, '暂不导入.md'); await writeFile(file, '原件不应该提前复制。')
    const kb = service.create({ name: '缺组件知识库', embedding: model })
    const embedding = vi.spyOn(gateway, 'embed')
    await expect(service.importSources({ knowledgeBaseId: kb.id, filePaths: [file] })).rejects.toThrow('[component:lancedb]')
    expect(store.listSources(kb.id)).toEqual([]); expect(embedding).not.toHaveBeenCalled()
    await service.shutdown()
  })
  it('首次组件缺失不会永久缓存失败，准备完成后可再次打开索引', async () => {
    const directory = await temp(); let available = false
    const component = async () => { if (!available) throw new Error('组件未准备'); return { id: 'lancedb' as const, version: '0.39.0', directory: resolve('.'), executable: resolve('node_modules/@lancedb/lancedb/dist/index.js') } }
    const vectors = new VectorStore(join(directory, 'vectors'), { resolve: component, ensure: component })
    await expect(vectors.ready()).rejects.toThrow('组件未准备')
    available = true; await vectors.ready(); await vectors.add('retry', [{ id: 'ready', sourceId: 'source', vector: [1, 0] }])
    expect(await vectors.nearest('retry', [1, 0], ['source'])).toEqual(['ready'])
    await vectors.close()
  })
  it('原件本地持久化，LanceDB 语义匹配并返回 SQLite 引用快照', async () => {
    const { service, store, directory, model } = await setup()
    const path = join(directory, '交通资料.md'); await writeFile(path, '公共交通有助于缓解城市拥堵。\n\n森林保护有助于生物多样性。')
    const kb = service.create({ name: '长期知识', embedding: model })
    const [source] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(store.getSource(source.id)?.status).toBe('ready'))
    expect(await readFile(source.originalPath!, 'utf8')).toContain('公共交通')
    expect(store.getKnowledgeBase(kb.id)?.dimensions).toBe(3)
    const evidence = await service.retrieve([kb.id], '地铁的城市作用', new AbortController().signal)
    expect(evidence[0].text).toContain('公共交通')
    expect(evidence[0].locator).toBe('段落 1')
    const retained = structuredClone(evidence)
    await service.deleteSource(source.id)
    expect(await service.retrieve([kb.id], '地铁', new AbortController().signal)).toEqual([])
    expect(retained[0].text).toContain('公共交通')
  })

  it('Embedding 维度变化让资料失败，不混入已绑定的索引', async () => {
    let wrong = false
    const { service, store, directory, model } = await setup(async (_model, texts) => texts.map(() => wrong ? [1, 2] : [1, 2, 3]))
    const path = join(directory, '资料.txt'); await writeFile(path, '内容')
    const kb = service.create({ name: '维度约束', embedding: model })
    const [first] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(store.getSource(first.id)?.status).toBe('ready'))
    wrong = true
    const [second] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(store.getSource(second.id)?.status).toBe('failed'))
    expect(store.getSource(second.id)?.error).toContain('维度不一致')
    expect(store.getKnowledgeBase(kb.id)?.dimensions).toBe(3)
    await expect(service.retrieve([kb.id], '内容', new AbortController().signal)).rejects.toThrow('维度不一致')
  })

  it('取消后迟到的 Embedding 结果不能让资料恢复为 ready', async () => {
    let release!: (vectors: number[][]) => void
    const started = vi.fn()
    const { service, store, directory, model } = await setup(async () => { started(); return new Promise(resolve => { release = resolve }) })
    const path = join(directory, '取消.txt'); await writeFile(path, '取消测试')
    const kb = service.create({ name: '取消', embedding: model })
    const [source] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    const cancellation = service.cancel(source.id)
    expect(store.getSource(source.id)?.status).toBe('cancelled')
    release([[1, 2, 3]]); await cancellation
    expect(store.getSource(source.id)?.status).toBe('cancelled')
    expect(await service.retrieve([kb.id], '测试', new AbortController().signal)).toEqual([])
  })

  it('显式重建复用已提取片段并重新绑定维度', async () => {
    const extract = vi.fn(async () => [{ text: '持久化资料', kind: 'text' as const, locator: '段落 1' }])
    const { service, store, directory, model } = await setup(async (ref, texts) => texts.map(() => ref.modelId === 'new' ? [1, 2] : [1, 2, 3]), extract)
    const path = join(directory, '重建.txt'); await writeFile(path, '持久化资料')
    const kb = service.create({ name: '重建', embedding: model })
    const [source] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(store.getSource(source.id)?.status).toBe('ready'))
    await service.rebuild(kb.id, { ...model, modelId: 'new' })
    expect(extract).toHaveBeenCalledTimes(1)
    expect(store.getKnowledgeBase(kb.id)?.dimensions).toBe(2)
    expect(store.getSource(source.id)?.status).toBe('ready')
  })

  it('取消排队资料立即返回，不等待其他资料的模型请求', async () => {
    let release!: (vectors: number[][]) => void
    const started = vi.fn()
    const { service, store, directory, model } = await setup(async () => { started(); return new Promise(resolve => { release = resolve }) })
    const path = join(directory, '队列.txt'); await writeFile(path, '队列测试')
    const kb = service.create({ name: '队列', embedding: model })
    const [first, second] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path, path] })
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    await service.cancel(second.id)
    expect(store.getSource(second.id)?.status).toBe('cancelled')
    release([[1, 2, 3]])
    await vi.waitFor(() => expect(store.getSource(first.id)?.status).toBe('ready'))
    expect(started).toHaveBeenCalledTimes(1)
  })

  it('检索在每次付费 Embedding 前扣减预算，拒绝后不发请求', async () => {
    const embed = vi.fn(async (_model: ModelRef, texts: string[]) => texts.map(() => [1, 2]))
    const { service, store, directory, model } = await setup(embed)
    const path = join(directory, '预算.txt'); await writeFile(path, '内容')
    const kb = service.create({ name: '预算', embedding: model })
    const [source] = await service.importSources({ knowledgeBaseId: kb.id, filePaths: [path] })
    await vi.waitFor(() => expect(store.getSource(source.id)?.status).toBe('ready'))
    embed.mockClear()
    await expect(service.retrieve([kb.id], '内容', new AbortController().signal, () => { throw new Error('调用预算已用完') })).rejects.toThrow('调用预算已用完')
    expect(embed).not.toHaveBeenCalled()
  })

  it('ready 过滤阻止遗留向量泄漏未完成来源', async () => {
    const component = async () => ({ id: 'lancedb' as const, version: '0.39.0', directory: resolve('.'), executable: resolve('node_modules/@lancedb/lancedb/dist/index.js') })
    const dir = await temp(), vectors = new VectorStore(join(dir, 'vectors'), { resolve: component, ensure: component })
    cleanups.push(() => vectors.close())
    await vectors.add('test', [{ id: 'unfinished', sourceId: 'failed', vector: [1, 0] }, { id: 'complete', sourceId: 'ready', vector: [0.8, 0.2] }])
    expect(await vectors.nearest('test', [1, 0], ['ready'])).toEqual(['complete'])
  })

  it('空向量、非有限值和批次条数不一致都拒绝', () => {
    expect(() => validateVectors([], 1)).toThrow()
    expect(() => validateVectors([[1, NaN]], 1)).toThrow()
    expect(() => validateVectors([[1, 2]], 2)).toThrow()
    expect(() => validateVectors([[1, 2], [1]], 2)).toThrow()
  })
})
