import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve, sep } from 'node:path'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import type { GatewayPort, StorePort } from '../../shared/ports'
import type { AppEvent, Evidence, ImportInput, KnowledgeBase, KnowledgeBaseInput, ModelRef, Source, SourceChunk } from '../../shared/types'
import { chunkParts, validateVectors, SUPPORTED_EXTENSIONS, type ExtractedPart, type ImportJob, type PptxExtractor } from './protocol'
import { VectorStore } from './vector-store'
import { extractInWorker } from './worker-client'
import type { ComponentRuntimePort } from '../../shared/components'

interface VectorPort {
  ready?(): Promise<void>
  add(kbId: string, rows: { id: string; sourceId: string; vector: number[] }[]): Promise<void>
  removeSource(kbId: string, sourceId: string): Promise<void>
  drop(kbId: string): Promise<void>
  nearest(kbId: string, vector: number[], readyIds: string[], limit?: number): Promise<string[]>
  close?(): Promise<void>
}
interface Dependencies {
  fetch?: typeof fetch
  components?: ComponentRuntimePort
  vectors?: VectorPort
  extract?: (job: ImportJob, signal: AbortSignal, progress: (text: string) => void) => Promise<ExtractedPart[]>
  extractPptx?: PptxExtractor
}
interface PendingJob { controller: AbortController; promise: Promise<void>; started: boolean }

export class KnowledgeService {
  private readonly vectors: VectorPort
  private readonly extract: NonNullable<Dependencies['extract']>
  private readonly originals: string
  private readonly scratch: string
  private readonly jobs = new Map<string, PendingJob>()
  private readonly rebuilding = new Set<string>()
  private readonly generations = new Map<string, number>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly store: StorePort, private readonly gateway: GatewayPort, userDataDir: string, private readonly mediaDir: string, private readonly emit: (event: AppEvent) => void, dependencies: Dependencies = {}) {
    this.originals = resolve(userDataDir, 'originals'); this.scratch = resolve(userDataDir, 'import-scratch')
    this.vectors = dependencies.vectors ?? new VectorStore(join(userDataDir, 'vectors'), dependencies.components)
    this.extract = dependencies.extract ?? ((job, signal, progress) => extractInWorker(job, store, gateway, signal, progress, dependencies.fetch, dependencies.extractPptx))
    // Never replay a paid operation after a crash or application restart.
    for (const source of store.listSources()) if (source.status === 'queued' || source.status === 'processing') {
      store.saveSource({ ...source, status: 'failed', progress: '应用关闭时导入未完成', error: '导入未完成；请明确重建知识库或重新导入，应用不会自动重试' })
    }
  }

  create(input: KnowledgeBaseInput): KnowledgeBase {
    this.assertOpen()
    if (!input.name.trim()) throw new Error('请填写知识库名称')
    const provider = this.store.getProvider(input.embedding.providerId)
    if (!provider || !input.embedding.modelId.trim()) throw new Error('请选择可用的 Embedding 服务和模型')
    const kb: KnowledgeBase = { id: randomUUID(), name: input.name.trim(), embedding: { ...input.embedding }, embeddingBaseUrl: provider.baseUrl, createdAt: new Date().toISOString(), chunkVersion: 1 }
    this.store.saveKnowledgeBase(kb); this.emit({ type: 'knowledge' }); return kb
  }

  async importSources(input: ImportInput): Promise<Source[]> {
    this.assertOpen()
    const kb = this.requireKnowledgeBase(input.knowledgeBaseId); this.assertBinding(kb)
    if (this.rebuilding.has(kb.id)) throw new Error('知识库正在重建，请稍后导入')
    if (!input.filePaths?.length && !input.url?.trim()) throw new Error('请选择文件或填写网页地址')
    await this.vectors.ready?.()
    const entries: { title: string; path?: string; url?: string }[] = []
    for (const path of input.filePaths ?? []) {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`不是文件：${basename(path)}`)
      if (info.size > 2 * 1024 ** 3) throw new Error(`文件超过 2 GB：${basename(path)}`)
      if (!SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase())) throw new Error(`不支持的格式：${basename(path)}`)
      entries.push({ title: basename(path), path })
    }
    if (input.url?.trim()) {
      const url = new URL(input.url.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网页仅支持不含账号密码的 HTTP/HTTPS 地址')
      entries.push({ title: url.hostname + url.pathname, url: url.toString() })
    }
    const sources: Source[] = []
    const createdDirectories: string[] = []
    try {
      for (const entry of entries) {
        const id = randomUUID(), directory = this.sourceDirectory(id), originalPath = join(directory, entry.path ? basename(entry.path) : 'webpage.html')
        await mkdir(directory, { recursive: true })
        createdDirectories.push(directory)
        if (entry.path) await copyFile(entry.path, originalPath)
        this.assertOpen(); this.requireKnowledgeBase(kb.id)
        if (this.rebuilding.has(kb.id)) throw new Error('知识库正在重建，请稍后导入')
        const source: Source = { id, knowledgeBaseId: kb.id, title: entry.title, originalPath, url: entry.url, status: 'queued', progress: '等待解析', createdAt: new Date().toISOString(), chunkCount: 0 }
        this.store.saveSource(source); sources.push(source); this.emit({ type: 'source', source })
      }
    } catch (error) {
      for (const source of sources) this.store.deleteSource(source.id)
      for (const directory of createdDirectories) await this.removeInside(this.originals, directory)
      throw error
    }
    for (const source of sources) this.enqueue(source.id, false)
    return sources
  }

  async cancel(id: string): Promise<void> {
    const source = this.store.getSource(id)
    if (!source || !['processing', 'queued'].includes(source.status)) return
    this.updateSource(id, { status: 'cancelled', progress: '已取消', error: undefined })
    const job = this.jobs.get(id); job?.controller.abort()
    if (job?.started) await job.promise
  }

  async deleteSource(id: string): Promise<void> {
    const source = this.store.getSource(id)
    if (!source) return
    if (this.rebuilding.has(source.knowledgeBaseId)) throw new Error('知识库正在重建，请等待完成后删除资料')
    await this.cancel(id)
    await this.vectors.removeSource(source.knowledgeBaseId, id)
    await this.removeInside(this.originals, this.sourceDirectory(id))
    this.store.deleteSource(id); this.emit({ type: 'knowledge' })
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    if (this.rebuilding.has(id)) throw new Error('知识库正在重建，请等待完成')
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.rebuilding.add(id)
    try {
      const sources = this.store.listSources(id)
      await Promise.all(sources.map(source => this.cancel(source.id)))
      await this.vectors.drop(id)
      for (const source of sources) await this.removeInside(this.originals, this.sourceDirectory(source.id))
      this.store.deleteKnowledgeBase(id); this.emit({ type: 'knowledge' })
    } finally { this.rebuilding.delete(id) }
  }

  async rebuild(id: string, embedding: ModelRef): Promise<void> {
    this.assertOpen()
    const kb = this.requireKnowledgeBase(id), provider = this.store.getProvider(embedding.providerId)
    if (!provider || !embedding.modelId.trim()) throw new Error('请选择可用的 Embedding 模型')
    if (this.rebuilding.has(id)) throw new Error('知识库已经在重建')
    await this.vectors.ready?.()
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.rebuilding.add(id)
    try {
      const sources = this.store.listSources(id)
      await Promise.all(sources.map(source => this.cancel(source.id)))
      // Mark every source unavailable before dropping the old index, including on an interrupted rebuild.
      for (const source of sources) this.updateSource(source.id, { status: 'queued', progress: '等待重建向量索引', error: undefined })
      await this.vectors.drop(id)
      this.store.saveKnowledgeBase({ ...kb, embedding: { ...embedding }, embeddingBaseUrl: provider.baseUrl, dimensions: undefined })
      this.emit({ type: 'knowledge' })
      for (const source of sources) this.enqueue(source.id, true)
      await Promise.all(sources.map(source => this.jobs.get(source.id)?.promise))
    } catch (error) {
      for (const source of this.store.listSources(id)) if (source.status === 'queued') this.updateSource(source.id, { status: 'failed', progress: '重建失败', error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally { this.rebuilding.delete(id) }
  }

  async retrieve(ids: string[], query: string, signal: AbortSignal, beforeModelCall?: () => void): Promise<Evidence[]> {
    this.assertOpen(); signal.throwIfAborted()
    if (!query.trim()) return []
    const result: Evidence[] = []
    for (const id of new Set(ids)) {
      signal.throwIfAborted()
      const kb = this.requireKnowledgeBase(id); this.assertBinding(kb)
      const generation = this.generations.get(id) ?? 0
      if (this.rebuilding.has(id)) throw new Error(`知识库「${kb.name}」正在重建，暂时不能检索`)
      const readySources = this.store.listSources(id).filter(source => source.status === 'ready')
      if (!readySources.length) continue
      if (!kb.dimensions) throw new Error('知识库缺少向量维度，请重建索引')
      await this.vectors.ready?.()
      beforeModelCall?.()
      const vectors = await this.gateway.embed(kb.embedding, [query], signal)
      signal.throwIfAborted(); this.assertBinding(kb); validateVectors(vectors, 1, kb.dimensions)
      if (this.rebuilding.has(id) || (this.generations.get(id) ?? 0) !== generation) throw new Error(`知识库「${kb.name}」正在或已经重建，请重新检索`)
      const readyIds = readySources.map(source => source.id)
      const foundIds = await this.vectors.nearest(id, vectors[0], readyIds)
      signal.throwIfAborted()
      if ((this.generations.get(id) ?? 0) !== generation) throw new Error(`知识库「${kb.name}」已改变，请重新检索`)
      // SQLite is authoritative; vectors left behind by a failed import can never become evidence.
      const chunks = new Map(readySources.flatMap(source => this.store.getSource(source.id)?.status === 'ready' ? this.store.getChunks(source.id) : []).map(chunk => [chunk.id, chunk]))
      for (const chunkId of foundIds) {
        const chunk = chunks.get(chunkId)
        if (chunk) result.push({ ...chunk, retrievedAt: new Date().toISOString() })
      }
    }
    return result
  }

  getSourceChunks(id: string): SourceChunk[] { return this.store.getChunks(id).map(chunk => ({ ...chunk })) }

  async shutdown(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    await this.tail
    await this.vectors.close?.()
  }

  private enqueue(id: string, reuseChunks: boolean): void {
    const controller = new AbortController()
    const promise = this.tail.then(async () => {
      const current = this.jobs.get(id)
      // A queued import can be replaced by an explicit rebuild before it starts.
      if (current?.controller !== controller) return
      current.started = true
      await this.processSource(id, reuseChunks, controller.signal)
    })
    this.jobs.set(id, { controller, promise, started: false })
    this.tail = promise.catch(() => {})
    void promise.finally(() => { if (this.jobs.get(id)?.controller === controller) this.jobs.delete(id) }).catch(() => {})
  }

  private async processSource(id: string, reuseChunks: boolean, signal: AbortSignal): Promise<void> {
    const source = this.store.getSource(id)
    if (!source || source.status !== 'queued') return
    const scratchDir = join(this.scratch, id)
    try {
      signal.throwIfAborted()
      let kb = this.requireKnowledgeBase(source.knowledgeBaseId); this.assertBinding(kb)
      this.updateSource(id, { status: 'processing', progress: '解析原件', error: undefined })
      let chunks = reuseChunks ? this.store.getChunks(id) : []
      if (!chunks.length) {
        if (!source.originalPath) throw new Error('原始文件不存在，请重新导入')
        const parts = await this.extract({ originalPath: source.originalPath, url: source.url, mediaDir: this.mediaDir, scratchDir }, signal, progress => { if (!signal.aborted) this.updateSource(id, { progress }) })
        signal.throwIfAborted()
        chunks = chunkParts(parts).map(part => ({ id: randomUUID(), sourceId: id, knowledgeBaseId: kb.id, title: source.title, url: source.url, ...part, retrievedAt: new Date().toISOString() }))
        if (!chunks.length) throw new Error('未提取到可索引的内容')
        this.store.saveChunks(id, chunks)
      }
      await this.vectors.removeSource(kb.id, id)
      const rows: { id: string; sourceId: string; vector: number[] }[] = []
      for (let start = 0; start < chunks.length; start += 24) {
        signal.throwIfAborted(); kb = this.requireKnowledgeBase(kb.id); this.assertBinding(kb)
        const batch = chunks.slice(start, start + 24)
        this.updateSource(id, { progress: `生成向量 ${start + 1}–${start + batch.length}/${chunks.length}` })
        const vectors = await this.gateway.embed(kb.embedding, batch.map(chunk => chunk.text), signal)
        signal.throwIfAborted(); this.assertBinding(kb)
        const dimensions = validateVectors(vectors, batch.length, kb.dimensions)
        if (kb.dimensions === undefined) { kb = { ...kb, dimensions }; this.store.saveKnowledgeBase(kb); this.emit({ type: 'knowledge' }) }
        rows.push(...batch.map((chunk, index) => ({ id: chunk.id, sourceId: id, vector: vectors[index] })))
      }
      signal.throwIfAborted(); await this.vectors.add(kb.id, rows); signal.throwIfAborted()
      this.updateSource(id, { status: 'ready', chunkCount: chunks.length, progress: `已索引 ${chunks.length} 个片段`, error: undefined })
    } catch (error) {
      const current = this.store.getSource(id)
      if (current) this.updateSource(id, { status: signal.aborted ? 'cancelled' : 'failed', progress: signal.aborted ? '已取消' : '导入失败', error: signal.aborted ? undefined : error instanceof Error ? error.message : String(error) })
      // Stale vectors are also excluded by the SQLite ready filter, even if cleanup fails.
      try { await this.vectors.removeSource(source.knowledgeBaseId, id) } catch (error) { this.emit({ type: 'error', error: `未完成索引的清理失败：${error instanceof Error ? error.message : String(error)}` }) }
    } finally {
      try { await this.removeInside(this.scratch, scratchDir) } catch (error) { this.emit({ type: 'error', error: `临时资料清理失败：${error instanceof Error ? error.message : String(error)}` }) }
    }
  }

  private assertOpen(): void { if (this.closed) throw new Error('应用正在关闭') }
  private requireKnowledgeBase(id: string): KnowledgeBase {
    const kb = this.store.getKnowledgeBase(id)
    if (!kb) throw new Error('知识库不存在')
    if (kb.chunkVersion !== 1) throw new Error('知识库格式版本不受支持，请重新导入；原数据未修改')
    return kb
  }
  private assertBinding(kb: KnowledgeBase): void {
    const provider = this.store.getProvider(kb.embedding.providerId)
    if (!provider) throw new Error(`知识库「${kb.name}」的 Embedding 服务不存在`)
    if (provider.baseUrl.replace(/\/+$/, '') !== kb.embeddingBaseUrl.replace(/\/+$/, '')) throw new Error(`知识库「${kb.name}」的 Embedding 服务地址已改变，请明确重建知识库`)
  }
  private updateSource(id: string, patch: Partial<Source>): void {
    const current = this.store.getSource(id)
    if (!current) return
    const source = { ...current, ...patch }; this.store.saveSource(source); this.emit({ type: 'source', source })
  }
  private sourceDirectory(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('资料 ID 无效')
    return join(this.originals, id)
  }
  private async removeInside(root: string, path: string): Promise<void> {
    const target = resolve(path), boundary = resolve(root)
    if (!target.startsWith(boundary + sep)) throw new Error('拒绝删除资料目录外的路径')
    await rm(target, { recursive: true, force: true })
  }
}
