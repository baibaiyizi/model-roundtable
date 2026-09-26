import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StorePort } from '../shared/ports'
import type { StructuredCapability } from '../shared/structured'
import type { KnowledgeBase, Provider, ProviderInput, Session, Settings, SettingsInput, Source, SourceChunk, Project, DiscussionTemplate, Execution } from '../shared/types'

export interface SecretCodec { encrypt(value: string): Promise<Uint8Array>; decrypt(value: Uint8Array): Promise<string> }
const SCHEMA_VERSION = '2'

export class Store implements StorePort {
  private db: DatabaseSync
  constructor(filename: string, private codec: SecretCodec) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    const metaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()
    if (metaExists) {
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value
      if (version !== SCHEMA_VERSION) {
        this.db.close()
        throw new Error(`数据版本 ${String(version)} 不受此应用支持。原始数据未修改，请使用匹配版本。`)
      }
    } else {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      if (tables.length) { this.db.close(); throw new Error('发现未知数据库格式，已停止打开；原始数据未修改。') }
      this.db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE secrets (id TEXT PRIMARY KEY, value BLOB NOT NULL);`)
      this.db.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', SCHEMA_VERSION)
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;')
    this.recoverInterrupted()
  }
  private get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM entities WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(row.payload as string) as T : undefined
  }
  private list<T>(kind: string): T[] {
    return this.db.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.payload as string) as T)
  }
  private put(kind: string, id: string, data: unknown): void {
    this.db.prepare('INSERT INTO entities VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, id, JSON.stringify(data))
  }
  private remove(kind: string, id: string): void { this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id) }
  // Internal services share the existing entity store; these methods are never exposed over IPC.
  getEntity<T>(kind: string, id: string): T | undefined { return this.get<T>(kind, id) }
  listEntities<T>(kind: string): T[] { return this.list<T>(kind) }
  saveEntity<T>(kind: string, id: string, data: T): void { this.put(kind, id, data) }
  deleteEntity(kind: string, id: string): void { this.remove(kind, id) }
  backup(filename: string): void { mkdirSync(dirname(filename), { recursive: true }); this.db.prepare('VACUUM INTO ?').run(filename) }
  importRecoveredProviders(rows: { marker: string; provider: Provider; encryptedKey?: Uint8Array }[]): number {
    let imported = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        if (this.get('recovery', row.marker) || this.getProvider(row.provider.id)) continue
        this.put('provider', row.provider.id, row.provider)
        if (row.encryptedKey) this.db.prepare('INSERT INTO secrets(id,value) VALUES (?,?)').run(`provider:${row.provider.id}`, row.encryptedKey)
        this.put('recovery', row.marker, { providerId: row.provider.id, recoveredAt: new Date().toISOString() })
        imported++
      }
      this.db.exec('COMMIT')
      return imported
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  setStructuredCapability(providerId: string, modelId: string, capability: StructuredCapability): void {
    const provider = this.getProvider(providerId)
    if (!provider || provider.baseUrl !== capability.baseUrl || !provider.modelIds.includes(modelId)) throw new Error('模型服务已变更，请重新测试。')
    provider.structuredOutputs = { ...provider.structuredOutputs, [modelId]: capability }
    this.put('provider', provider.id, provider)
  }
  async setSecret(id: string, value: string): Promise<void> {
    if (!value) { this.db.prepare('DELETE FROM secrets WHERE id=?').run(id); return }
    const encrypted = await this.codec.encrypt(value)
    this.db.prepare('INSERT INTO secrets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, encrypted)
  }
  async getSecret(id: string): Promise<string> {
    const row = this.db.prepare('SELECT value FROM secrets WHERE id=?').get(id)
    return row ? this.codec.decrypt(row.value as Uint8Array) : ''
  }
  private hasSecret(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM secrets WHERE id=?').get(id)) }
  getProvider(id: string): Provider | undefined {
    const value = this.get<Provider>('provider', id)
    return value ? { ...value, hasKey: this.hasSecret(`provider:${id}`) } : undefined
  }
  listProviders(): Provider[] { return this.list<Provider>('provider').map(p => ({ ...p, hasKey: this.hasSecret(`provider:${p.id}`) })) }
  async saveProvider(input: ProviderInput): Promise<Provider> {
    const id = input.id ?? randomUUID()
    if (input.id && !this.getProvider(id)) throw new Error('服务不存在，请重新添加。')
    const old = this.getProvider(id)
    if (old && (old.baseUrl !== input.baseUrl || old.kind !== input.kind) && this.listKnowledgeBases().some(kb => kb.embedding.providerId === id)) {
      throw new Error('该服务被知识库索引使用。请新建服务，并在知识库中显式重建索引。')
    }
    // Switching to or from Claude must not silently send a previous service's
    // credential to Anthropic (or reuse an Anthropic key with another backend).
    if (old && old.kind !== input.kind && (old.kind === 'claude' || input.kind === 'claude') && input.apiKey === undefined) await this.setSecret(`provider:${id}`, '')
    if (input.apiKey !== undefined) await this.setSecret(`provider:${id}`, input.apiKey)
    const { apiKey: _secret, structuredOutputs: _untrustedCapabilities, ...publicInput } = input
    const capabilities = old && old.baseUrl === input.baseUrl && old.kind === input.kind && input.apiKey === undefined
      ? Object.fromEntries(Object.entries(old.structuredOutputs ?? {}).filter(([model]) => input.modelIds.includes(model))) : undefined
    const provider: Provider = { ...publicInput, id, hasKey: this.hasSecret(`provider:${id}`), ...(capabilities ? { structuredOutputs: capabilities } : {}) }
    this.put('provider', id, provider)
    return provider
  }
  removeProvider(id: string): void {
    if (this.listKnowledgeBases().some(kb => kb.embedding.providerId === id)) throw new Error('此服务仍被知识库使用，请先删除知识库或重建到其他服务。')
    this.remove('provider', id)
    this.db.prepare('DELETE FROM secrets WHERE id=?').run(`provider:${id}`)
    const settings = this.getSettings()
    for (const key of ['moderator', 'vision', 'transcription'] as const) if (settings[key]?.providerId === id) delete settings[key]
    this.put('settings', 'default', settings)
  }
  getSettings(): Settings { return { ...this.get<Settings>('settings', 'default'), hasTavilyKey: this.hasSecret('tavily') } }
  async saveSettings(input: SettingsInput): Promise<Settings> {
    if (input.tavilyKey !== undefined) await this.setSecret('tavily', input.tavilyKey)
    const { tavilyKey: _secret, ...rest } = input
    const settings = { ...rest, hasTavilyKey: this.hasSecret('tavily') }
    this.put('settings', 'default', settings)
    return settings
  }
  getSession(id: string): Session | undefined { return this.get('session', id) }
  saveSession(session: Session): void { this.put('session', session.id, session) }
  listSessions(): Session[] { return this.list<Session>('session').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) }
  deleteSession(id: string): void {
    this.remove('session', id)
    this.remove('draft', `message.${id}`)
    const prefix = 'execution-new.', suffix = `.${id}`
    this.db.prepare("DELETE FROM entities WHERE kind='draft' AND substr(id,1,?)=? AND substr(id,-?)=?").run(prefix.length,prefix,suffix.length,suffix)
  }
  getProject(id: string): Project | undefined { return this.get('project', id) }
  saveProject(project: Project): void { this.put('project', project.id, project) }
  listProjects(): Project[] { return this.list<Project>('project').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) }
  deleteProject(id: string): void {
    this.remove('project', id)
    this.remove('draft', `discussion-new.${id}`)
    const prefix = `execution-new.${id}.`
    this.db.prepare("DELETE FROM entities WHERE kind='draft' AND substr(id,1,?)=?").run(prefix.length,prefix)
  }
  getExecution(id: string): Execution | undefined { return this.get('execution', id) }
  saveExecution(execution: Execution): void { this.put('execution', execution.id, execution) }
  listExecutions(): Execution[] { return this.list<Execution>('execution').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) }
  deleteExecution(id: string): void { this.remove('execution', id) }
  saveTemplate(template: DiscussionTemplate): void { this.put('template', template.id, template) }
  listTemplates(): DiscussionTemplate[] { return this.list('template') }
  deleteTemplate(id: string): void { this.remove('template', id) }
  saveDraft(id: string, text: string): void { this.put('draft', id, text) }
  saveEditorDraft(id: string, text: string, transfer: import('../shared/editor').EditorTransfer): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { this.put('draft', id, text); this.put('editor-transfer', transfer.id, transfer); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  getDraft(id: string): string { return this.get('draft', id) ?? '' }
  getKnowledgeBase(id: string): KnowledgeBase | undefined { return this.get('knowledge', id) }
  saveKnowledgeBase(kb: KnowledgeBase): void { this.put('knowledge', kb.id, kb) }
  listKnowledgeBases(): KnowledgeBase[] { return this.list('knowledge') }
  deleteKnowledgeBase(id: string): void {
    for (const source of this.listSources(id)) this.deleteSource(source.id)
    this.remove('knowledge', id)
  }
  getSource(id: string): Source | undefined { return this.get('source', id) }
  saveSource(source: Source): void { this.put('source', source.id, source) }
  listSources(knowledgeBaseId?: string): Source[] { return this.list<Source>('source').filter(s => !knowledgeBaseId || s.knowledgeBaseId === knowledgeBaseId) }
  deleteSource(id: string): void { this.remove('source', id); this.remove('chunks', id) }
  saveChunks(sourceId: string, chunks: SourceChunk[]): void { this.put('chunks', sourceId, chunks) }
  getChunks(sourceId: string): SourceChunk[] { return this.get('chunks', sourceId) ?? [] }
  private recoverInterrupted(): void {
    for (const execution of this.listExecutions()) {
      if (!['running','reviewing','stopping'].includes(execution.status)) continue
      execution.status = 'needs_attention'
      execution.error = '上次退出时任务未完成，文件可能已修改。请核对改动后手动重试；不会自动重放命令。'
      execution.updatedAt = new Date().toISOString()
      for (const event of execution.events) if (event.state === 'running') { event.state = 'failed'; event.text += '\n[退出时状态未知，未重放]' }
      this.saveExecution(execution)
    }
    for (const session of this.listSessions()) {
      let dirty = false
      for (const message of session.messages) {
        if (message.status === 'streaming') { message.status = 'interrupted'; dirty = true }
      }
      if (session.status === 'running') {
        session.status = 'paused'
        if (session.run) { session.run.contextVersion += 1; session.run.pauseRequested = false; session.run.error = '应用上次退出时讨论尚未完成，请手动继续。' }
        dirty = true
      }
      if (dirty) this.saveSession(session)
    }
    for (const source of this.listSources()) {
      if (source.status === 'processing' || source.status === 'queued') {
        this.saveSource({ ...source, status: 'failed', progress: '导入已中断', error: '上次退出时导入未完成。请重新导入或重建索引。' })
      }
    }
  }
  close(): void { this.db.close() }
}
