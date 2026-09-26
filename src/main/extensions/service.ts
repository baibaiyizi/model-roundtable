import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, rename, rm, readdir } from 'node:fs/promises'
import { join, dirname, relative, resolve, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { parse as yaml } from 'yaml'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import type { CatalogEntry, ExtensionApproval, ExtensionCall, ExtensionGrant, ExtensionInstallInput, ExtensionJob, ExtensionSearchBinding, ExtensionSearchInput, ExtensionState, ExtensionTool, ExtensionUpdateInput, InstalledExtension, SkillImportInput } from '../../shared/extensions'
import type { Evidence } from '../../shared/types'
import type { ExtensionOptions, ExtensionScope, ExtensionScopeInput } from './ports'
import { ExtensionCatalog } from './catalog'
import { ExtensionInstaller, unzip, type Revision } from './installer'
import { McpConnection, login } from './connection'
import { bounded, digest, httpUrl, inventory, isolatedEnvironment, jsonFetch } from './util'
import { redact, toolEvidence } from './evidence'

const installSchema = z.object({ kind: z.enum(['mcp', 'skill']), id: z.string().min(1).max(500), version: z.string().max(255).optional(), packageIndex: z.number().int().nonnegative().optional(), remoteIndex: z.number().int().nonnegative().optional(), values: z.record(z.string(), z.string()).optional(), secrets: z.record(z.string(), z.string()).optional() }).strict()
const grantSchema = z.object({ projectId: z.string().min(1), extensionId: z.string().min(1), enabled: z.boolean(), tools: z.array(z.object({ name: z.string().min(1), schemaHash: z.string().regex(/^[a-f0-9]{64}$/), access: z.enum(['read', 'project-write', 'external']) }).strict()).max(500), updatedAt: z.string().optional() }).strict()
const K = { installed: 'extension', job: 'extension-job', grant: 'extension-grant', call: 'extension-call', approval: 'extension-approval', binding: 'extension-search' }
const schemaValidator = new AjvJsonSchemaValidator()
export class ExtensionService {
  readonly catalog: ExtensionCatalog
  private installer: ExtensionInstaller
  private lifetime = new AbortController()
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private scopes = new Set<{ projectId: string; extensionIds: string[]; controller: AbortController; done: Promise<void> }>()
  private approvals = new Map<string, (allow: boolean) => void>()
  private operations = new Set<Promise<unknown>>()
  private busy = new Set<string>()
  constructor(private options: ExtensionOptions) {
    this.catalog = new ExtensionCatalog(options); this.installer = new ExtensionInstaller(options)
    for (const job of options.store.listEntities<ExtensionJob>(K.job)) if (job.status === 'running') { job.status = 'failed'; job.error = '应用已退出，未自动重放安装'; this.saveJob(job) }
    for (const approval of options.store.listEntities<ExtensionApproval>(K.approval)) if (approval.status === 'pending') { approval.status = 'cancelled'; options.store.saveEntity(K.approval, approval.id, approval) }
    for (const call of options.store.listEntities<ExtensionCall>(K.call)) if (call.status === 'running') { call.status = 'unknown'; call.error = '应用已退出，工具最终结果未确认，不自动重试'; options.store.saveEntity(K.call, call.id, call) }
  }
  state(): ExtensionState { const store = this.options.store; return { installed: store.listEntities(K.installed), jobs: store.listEntities(K.job), grants: store.listEntities(K.grant), approvals: store.listEntities(K.approval), calls: store.listEntities<ExtensionCall>(K.call).slice(-200), searchBindings: store.listEntities(K.binding) } }
  search(input: ExtensionSearchInput) { return this.catalog.search(input, this.lifetime.signal) }
  popularity(input: Parameters<ExtensionCatalog['popularity']>[0]) { return this.catalog.popularity(input, this.lifetime.signal) }
  async details(input: Parameters<ExtensionCatalog['details']>[0]) { const installed = this.state().installed.find(item => item.kind === input.kind && item.catalogId === input.id && (!input.version || item.version === input.version)); if (installed && (input.version || /^(manual|local):/.test(input.id))) return (await this.revision(installed.revisionId)).entry; return this.catalog.details(input, this.lifetime.signal) }
  private installed(id: string): InstalledExtension { const value = this.options.store.getEntity<InstalledExtension>(K.installed, id); if (!value) throw new Error('扩展不存在'); return value }
  private saveJob(job: ExtensionJob) { job.updatedAt = new Date().toISOString(); this.options.store.saveEntity(K.job, job.id, job); this.options.emit({ type: 'extensions', job: structuredClone(job) }) }
  private save(extension: InstalledExtension) { this.options.store.saveEntity(K.installed, extension.id, extension); this.options.emit({ type: 'extensions', extension: structuredClone(extension) }) }
  async revision(id: string): Promise<Revision> { const raw = await this.options.store.getSecret(`extension-revision:${id}`); if (!raw) throw new Error('扩展版本配置丢失，请重新安装'); return JSON.parse(raw) }
  private async saveRevision(revision: Revision) { await this.options.store.setSecret(`extension-revision:${revision.id}`, JSON.stringify(revision)); this.options.store.saveEntity('extension-revision', revision.id, { id: revision.id, extensionId: revision.extensionId, directory: revision.directory }) }
  private async secretValues(revision: Revision): Promise<string[]> { const values: string[] = []; for (const key of revision.secretKeys) values.push(await this.options.store.getSecret(`extension-value:${revision.id}:${key}`)); for (const key of ['tokens', 'client']) { const raw = await this.options.store.getSecret(`extension-oauth:${revision.id}:${key}`); if (raw) { const data = JSON.parse(raw); for (const field of ['access_token', 'refresh_token', 'client_secret']) if (typeof data[field] === 'string') values.push(data[field]) } } return values.filter(Boolean) }
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> { this.lifetime.signal.throwIfAborted(); if (this.busy.has(id) || [...this.jobs.keys()].some(jobId => this.options.store.getEntity<ExtensionJob>(K.job, jobId)?.extensionId === id)) return Promise.reject(new Error('此扩展已有操作正在进行')); this.busy.add(id); const pending = Promise.resolve().then(work).finally(() => { this.busy.delete(id); this.operations.delete(pending) }); this.operations.add(pending); return pending }
  private job(name: string, operation: ExtensionJob['operation'], extensionId: string, work: (job: ExtensionJob, signal: AbortSignal) => Promise<void>, reserved = false, source?: ExtensionJob['source']): ExtensionJob {
    this.lifetime.signal.throwIfAborted()
    if (this.busy.has(extensionId) && !reserved) throw new Error('此扩展已有操作正在进行')
    if ([...this.jobs.keys()].some(id => this.options.store.getEntity<ExtensionJob>(K.job, id)?.extensionId === extensionId)) throw new Error('此扩展已有安装任务')
    const now = new Date().toISOString(); const job: ExtensionJob = { id: randomUUID(), extensionId, name, operation, status: 'running', progress: '准备扩展', createdAt: now, updatedAt: now, source }; const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, this.lifetime.signal]); this.saveJob(job)
    const holder = { controller, done: Promise.resolve() }; this.jobs.set(job.id, holder)
    holder.done = Promise.resolve().then(() => work(job, signal)).then(() => { signal.throwIfAborted(); job.status = 'complete'; job.progress = '扩展已准备' }).catch(error => { job.status = signal.aborted ? 'cancelled' : 'failed'; job.error = String(redact(error instanceof Error ? error.message : String(error))) }).finally(() => { this.saveJob(job); this.jobs.delete(job.id) })
    return structuredClone(job)
  }
  install(input: ExtensionInstallInput): ExtensionJob {
    input = installSchema.parse(input); const extensionId = digest(`${input.kind}:${input.id}`).slice(0, 32)
    if (this.options.store.getEntity(K.installed, extensionId)) throw new Error('扩展已安装，请使用更新')
    return this.job(input.id, 'install', extensionId, async (job, signal) => this.performInstall(await this.catalog.details(input, signal), input, job, signal), false, { kind: input.kind, id: input.id })
  }
  update(input: ExtensionUpdateInput): ExtensionJob {
    const old = this.installed(input.id)
    if (old.catalogId.startsWith('manual:') || old.catalogId.startsWith('local:')) throw new Error('手动扩展请通过重新导入更新来源')
    return this.job(old.name, 'update', old.id, async (job, signal) => { const previous = await this.revision(old.revisionId); const secrets: Record<string, string> = {}; for (const name of previous.secretKeys) secrets[name] = await this.options.store.getSecret(`extension-value:${previous.id}:${name}`); const details = await this.catalog.details({ kind: old.kind, id: old.catalogId }, signal); await this.performInstall(details, { kind: old.kind, id: old.catalogId, values: { ...previous.values, ...input.values }, secrets: { ...secrets, ...input.secrets }, ...previous.selection }, job, signal) }, false, { kind: old.kind, id: old.catalogId })
  }
  private async performInstall(entry: CatalogEntry, input: ExtensionInstallInput, job: ExtensionJob, signal: AbortSignal, imported?: (revision: Revision) => Promise<void>): Promise<void> {
    if (entry.status === 'deleted') throw new Error('此扩展已从目录下架，不能安装')
    const secretNames = new Set(Object.keys(input.secrets ?? {})); const fields = (value: unknown): void => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) { value.forEach(fields); return } const item = value as Record<string, unknown>; if (item.isSecret && typeof item.name === 'string') secretNames.add(item.name); for (const [key, child] of Object.entries(item)) { if (key === 'variables' && child && typeof child === 'object') for (const [name, field] of Object.entries(child)) if ((field as { isSecret?: boolean })?.isSecret) secretNames.add(name); fields(child) } }; fields(entry)
    input = { ...input, values: { ...input.values }, secrets: { ...input.secrets } }; for (const key of Object.keys(input.values!)) if (secretNames.has(key) || /secret|password|token|api.?key|authorization/i.test(key)) { input.secrets![key] = input.values![key]; delete input.values![key] }
    const id = randomUUID(); const staging = join(this.options.stateDir, 'extensions', 'staging', id); const final = join(this.options.stateDir, 'extensions', 'versions', id); await mkdir(staging, { recursive: true })
    const revision: Revision = { id, extensionId: job.extensionId!, entry, directory: staging, values: {}, secretKeys: [], tools: [], selection: { packageIndex: input.packageIndex, remoteIndex: input.remoteIndex } }
    try {
      if (imported) await imported(revision); else await this.installer.install(entry, input, revision, signal, progress => { job.progress = progress; this.saveJob(job) })
      revision.values = { ...input.values }; revision.secretKeys = Object.keys(input.secrets ?? {}); if (entry.kind === 'mcp') await this.installer.configure(revision, input)
      signal.throwIfAborted(); await mkdir(dirname(final), { recursive: true }); await rename(staging, final)
      const relocated: Revision = JSON.parse(JSON.stringify(revision).split(JSON.stringify(staging).slice(1, -1)).join(JSON.stringify(final).slice(1, -1)))
      for (const [key, value] of Object.entries(input.secrets ?? {})) await this.options.store.setSecret(`extension-value:${id}:${key}`, value)
      await this.saveRevision(relocated); signal.throwIfAborted()
      const old = this.options.store.getEntity<InstalledExtension>(K.installed, job.extensionId!); const now = new Date().toISOString()
      const extension: InstalledExtension = { id: job.extensionId!, kind: entry.kind, catalogId: entry.id, name: entry.name, description: relocated.skillDescription ?? entry.description, version: relocated.entry.version, revisionId: id, source: entry.repositoryUrl ?? entry.source ?? entry.websiteUrl ?? entry.id, installedAt: old?.installedAt ?? now, updatedAt: now, tools: [], status: 'ready', configuredFields: [...Object.keys(relocated.values), ...relocated.secretKeys], configuration: relocated.values, skillFiles: relocated.files && Object.keys(relocated.files), ...relocated.selection }
      if (entry.kind === 'mcp') { const connection = new McpConnection(this.options, relocated); try { await connection.connect(signal); relocated.tools = await connection.tools(signal); extension.tools = relocated.tools } catch (error) { signal.throwIfAborted(); extension.status = 'needs-configuration'; extension.error = String(redact(error instanceof Error ? error.message : String(error), Object.values(input.secrets ?? {}))) } finally { await connection.close() } }
      await this.saveRevision(relocated); signal.throwIfAborted(); this.save(extension)
    } catch (error) { await rm(staging, { recursive: true, force: true }); await rm(final, { recursive: true, force: true }); await this.options.store.setSecret(`extension-revision:${id}`, ''); this.options.store.deleteEntity('extension-revision', id); for (const key of Object.keys(input.secrets ?? {})) await this.options.store.setSecret(`extension-value:${id}:${key}`, ''); throw new Error(String(redact(error instanceof Error ? error.message : String(error), Object.values(input.secrets ?? {})))) }
  }
  async cancelJob(id: string): Promise<void> { const job = this.jobs.get(id); if (job) { job.controller.abort(new Error('用户取消扩展安装')); await job.done } }
  clearJob(id: string): void {
    z.string().min(1).max(255).parse(id)
    const job = this.options.store.getEntity<ExtensionJob>(K.job, id)
    if (this.jobs.has(id) || job?.status === 'running') throw new Error('安装任务仍在运行，请先取消并等待结束')
    this.options.store.deleteEntity(K.job, id); this.options.emit({ type: 'extensions' })
  }
  clearFinishedJobs(): number {
    const finished = this.options.store.listEntities<ExtensionJob>(K.job).filter(job => job.status !== 'running' && !this.jobs.has(job.id))
    for (const job of finished) this.options.store.deleteEntity(K.job, job.id)
    this.options.emit({ type: 'extensions' }); return finished.length
  }
  async remove(id: string): Promise<void> {
    if (this.busy.has(id)) throw new Error('此扩展已有操作正在进行')
    this.installed(id)
    if ([...this.scopes].some(scope => scope.extensionIds.includes(id))) throw new Error('扩展正被运行中的任务使用，请先停止任务')
    for (const [jobId] of this.jobs) if (this.options.store.getEntity<ExtensionJob>(K.job, jobId)?.extensionId === id) await this.cancelJob(jobId)
    return this.exclusive(id, async () => { if ([...this.scopes].some(scope => scope.extensionIds.includes(id))) throw new Error('扩展正被运行中的任务使用，请先停止任务'); for (const metadata of this.options.store.listEntities<{ id: string; extensionId: string; directory: string }>('extension-revision').filter(item => item.extensionId === id)) {
      const revision = await this.revision(metadata.id); const expected = resolve(this.options.stateDir, 'extensions', 'versions'); if (!resolve(metadata.directory).startsWith(expected + sep)) throw new Error('扩展安装目录异常，未删除')
      await rm(metadata.directory, { recursive: true, force: true }); await this.options.store.setSecret(`extension-revision:${metadata.id}`, ''); for (const key of revision.secretKeys) await this.options.store.setSecret(`extension-value:${metadata.id}:${key}`, ''); for (const key of ['client', 'tokens', 'verifier']) await this.options.store.setSecret(`extension-oauth:${metadata.id}:${key}`, ''); this.options.store.deleteEntity('extension-revision', metadata.id)
    }
    this.options.store.deleteEntity(K.installed, id)
    for (const grant of this.options.store.listEntities<ExtensionGrant>(K.grant)) if (grant.extensionId === id) this.options.store.deleteEntity(K.grant, `${grant.projectId}:${id}`)
    for (const binding of this.options.store.listEntities<ExtensionSearchBinding>(K.binding)) if (binding.extensionId === id) this.options.store.deleteEntity(K.binding, binding.projectId)
    this.options.emit({ type: 'extensions' }) })
  }
  test(id: string): Promise<ExtensionTool[]> { return this.exclusive(id, () => this.testConnection(id)) }
  private async testConnection(id: string): Promise<ExtensionTool[]> {
    const extension = this.installed(id); if (extension.kind !== 'mcp') throw new Error('Skill 不建立 MCP 连接'); const revision = await this.revision(extension.revisionId); const connection = new McpConnection(this.options, revision)
    try { await connection.connect(this.lifetime.signal); const tools = await connection.tools(this.lifetime.signal); this.lifetime.signal.throwIfAborted(); revision.tools = tools; await this.saveRevision(revision); this.lifetime.signal.throwIfAborted(); if (this.installed(id).revisionId !== extension.revisionId) throw new Error('扩展版本已变化'); this.save({ ...extension, tools, status: 'ready', error: undefined }); return tools } catch (error) { const reason = String(redact(error instanceof Error ? error.message : String(error), await this.secretValues(revision))); if (!this.lifetime.signal.aborted) this.save({ ...extension, status: 'failed', error: reason }); throw new Error(reason) } finally { await connection.close() }
  }
  configure(input: { id: string; values: Record<string, string>; secrets?: Record<string, string> }): Promise<InstalledExtension> { return this.exclusive(input.id, () => this.configureConnection(input)) }
  private async configureConnection(input: { id: string; values: Record<string, string>; secrets?: Record<string, string> }): Promise<InstalledExtension> {
    input = z.object({ id: z.string().min(1), values: z.record(z.string(), z.string()), secrets: z.record(z.string(), z.string()).optional() }).strict().parse(input)
    if ([...this.scopes].some(scope => scope.extensionIds.includes(input.id))) throw new Error('扩展正在使用，请先停止相关任务后修改配置')
    const extension = this.installed(input.id); if (extension.kind !== 'mcp') throw new Error('Skill 没有连接配置'); const previous = await this.revision(extension.revisionId); const secrets: Record<string, string> = {}; for (const key of previous.secretKeys) secrets[key] = await this.options.store.getSecret(`extension-value:${previous.id}:${key}`)
    const installInput = { kind: extension.kind, id: extension.catalogId, values: { ...previous.values, ...input.values }, secrets: { ...secrets, ...input.secrets }, ...previous.selection }
    const job = this.job(extension.name, 'update', extension.id, async (job, signal) => this.performInstall(previous.entry, installInput, job, signal, async revision => {
      await cp(previous.directory, revision.directory, { recursive: true, force: false }); signal.throwIfAborted()
      const copied: Revision = JSON.parse(JSON.stringify(previous).split(JSON.stringify(previous.directory).slice(1, -1)).join(JSON.stringify(revision.directory).slice(1, -1)))
      Object.assign(revision, copied, { id: revision.id, directory: revision.directory, values: installInput.values, secretKeys: Object.keys(installInput.secrets), tools: [] })
      await this.installer.configure(revision, installInput)
    }), true)
    await this.jobs.get(job.id)!.done; const completed = this.options.store.getEntity<ExtensionJob>(K.job, job.id)!; if (completed.status !== 'complete') throw new Error(completed.error ?? '配置失败'); return this.installed(input.id)
  }
  login(id: string): Promise<{ authenticated: boolean; message: string }> { return this.exclusive(id, () => this.loginConnection(id)) }
  private async loginConnection(id: string): Promise<{ authenticated: boolean; message: string }> {
    const extension = this.installed(id); const revision = await this.revision(extension.revisionId); const task = login(this.options, revision, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(300000)])); this.operations.add(task)
    try { await task; this.lifetime.signal.throwIfAborted(); if (this.installed(id).revisionId !== extension.revisionId) throw new Error('扩展版本已变化'); extension.oauth = 'connected'; this.save(extension); await this.testConnection(id); return { authenticated: true, message: 'MCP 登录与连接测试已完成' } } finally { this.operations.delete(task) }
  }
  async checkUpdates(): Promise<InstalledExtension[]> { if (this.state().installed.some(extension => extension.kind === 'mcp' && !extension.catalogId.startsWith('manual:'))) await this.catalog.sync(this.lifetime.signal); for (const extension of this.state().installed) { if (extension.catalogId.startsWith('local:') || extension.catalogId.startsWith('manual:')) continue; const item = await this.catalog.details({ kind: extension.kind, id: extension.catalogId }, this.lifetime.signal); this.lifetime.signal.throwIfAborted(); if (this.options.store.getEntity<InstalledExtension>(K.installed, extension.id)?.revisionId !== extension.revisionId) continue; extension.availableUpdate = item.version !== extension.version ? item.version : undefined; extension.updateCheckedAt = new Date().toISOString(); if (item.status === 'deleted') extension.error = '扩展已从目录下架，请核对来源'; this.save(extension) } return this.state().installed }
  saveGrant(raw: ExtensionGrant): void { const input = grantSchema.parse(raw); if (!this.options.store.getProject(input.projectId)) throw new Error('项目不存在'); const extension = this.installed(input.extensionId); for (const grant of input.tools) if (!extension.tools.some(tool => tool.name === grant.name && tool.schemaHash === grant.schemaHash)) throw new Error('工具定义已变化，请重新连接并核对授权'); const old = this.options.store.getEntity<ExtensionGrant>(K.grant, `${input.projectId}:${input.extensionId}`); this.options.store.saveEntity(K.grant, `${input.projectId}:${input.extensionId}`, { ...input, updatedAt: new Date().toISOString() }); if (old?.enabled && (!input.enabled || old.tools.some(previous => !input.tools.some(tool => tool.name === previous.name && tool.schemaHash === previous.schemaHash && tool.access === previous.access)))) for (const scope of this.scopes) if (scope.projectId === input.projectId && scope.extensionIds.includes(input.extensionId)) scope.controller.abort(new Error('项目扩展授权已撤销或收紧')); this.options.emit({ type: 'extensions' }) }
  resolveApproval(input: { id: string; allow: boolean }): void { const callback = this.approvals.get(input.id); if (!callback) throw new Error('此工具确认已失效'); callback(input.allow) }
  private async approve(scope: ExtensionScopeInput, extensionId: string, tool: string, args: unknown, signal: AbortSignal, secrets: string[]): Promise<void> {
    const approval: ExtensionApproval = { id: randomUUID(), projectId: scope.projectId, runId: scope.runId, extensionId, tool, arguments: redact(args, secrets), status: 'pending', createdAt: new Date().toISOString() }
    await new Promise<void>((resolvePromise, reject) => {
      const finish = (allow: boolean, cancelled = false) => { signal.removeEventListener('abort', abort); this.approvals.delete(approval.id); approval.status = cancelled ? 'cancelled' : allow ? 'approved' : 'denied'; approval.resolvedAt = new Date().toISOString(); this.options.store.saveEntity(K.approval, approval.id, approval); this.options.emit({ type: 'extensions', approval }); if (allow) resolvePromise(); else reject(new Error(cancelled ? '工具调用已取消' : '用户拒绝外部操作')) }
      const abort = () => finish(false, true); this.approvals.set(approval.id, allow => finish(allow)); signal.addEventListener('abort', abort, { once: true }); this.options.store.saveEntity(K.approval, approval.id, approval); this.options.emit({ type: 'extensions', approval }); if (signal.aborted) abort()
    })
  }
  async createScope(input: ExtensionScopeInput): Promise<ExtensionScope> {
    this.lifetime.signal.throwIfAborted(); input.signal.throwIfAborted(); if (!this.options.store.getProject(input.projectId)) throw new Error('扩展授权项目不存在')
    const binding = this.getSearchBinding(input.projectId)
    const grants = this.state().grants.filter(grant => grant.projectId === input.projectId && grant.enabled && (input.mode !== 'discussion' || grant.tools.some(tool => tool.access === 'read') || this.installed(grant.extensionId).kind === 'skill')); const selected = grants.map(grant => ({ grant, extension: this.installed(grant.extensionId) })); if (selected.some(({ extension }) => this.busy.has(extension.id))) throw new Error('扩展正在配置、测试或移除，请稍后开始任务'); const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, input.signal, this.lifetime.signal]); let resolveDone!: () => void
    const holder = { projectId: input.projectId, extensionIds: grants.map(g => g.extensionId), controller, done: new Promise<void>(resolvePromise => { resolveDone = resolvePromise }) }; this.scopes.add(holder)
    const connections = new Map<string, McpConnection>(); const skills = new Map<string, Revision>(); const mapping = new Map<string, { revision: Revision; tool: ExtensionTool; access: ExtensionGrant['tools'][number]['access'] }>(); const pending = new Set<Promise<unknown>>(); let closing: Promise<void> | undefined
    const close = (): Promise<void> => { if (closing) return closing; closing = Promise.resolve().then(async () => { controller.abort(); await Promise.allSettled([...connections.values()].map(connection => connection.close())); await Promise.allSettled([...pending]); signal.removeEventListener('abort', onAbort); this.scopes.delete(holder); resolveDone() }); return closing }
    const onAbort = () => { void close() }; signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (const { grant, extension } of selected) { const revision = await this.revision(extension.revisionId); signal.throwIfAborted(); if (extension.kind === 'skill') { skills.set(extension.id, revision); continue } const connection = new McpConnection(this.options, revision); connections.set(extension.id, connection); await connection.connect(signal); const actual = await connection.tools(signal)
        for (const permission of grant.tools) { const tool = actual.find(tool => tool.name === permission.name && tool.schemaHash === permission.schemaHash); if (!tool) throw new Error(`扩展 ${extension.name} 的工具定义变化，请重新核对授权`); if (input.mode === 'discussion' && permission.access !== 'read') continue; const alias = `ext_${digest(`${extension.id}:${tool.name}`).slice(0, 20)}`; mapping.set(alias, { revision, tool, access: permission.access }) }
      }
      signal.throwIfAborted()
      const searchAlias = binding && `ext_${digest(`${binding.extensionId}:${binding.tool}`).slice(0, 20)}`
      const tools = [...mapping].filter(([name]) => name !== searchAlias).map(([name, value]) => ({ name, description: `${value.revision.entry.name} · ${value.tool.name}\n${value.tool.description}`, inputSchema: value.tool.inputSchema }))
      if (skills.size) tools.push({ name: 'skill_read', description: `按需读取项目已启用技能。可用技能：${[...skills].map(([id, r]) => `${id}: ${r.entry.name} — ${r.skillDescription ?? r.entry.description}`).join('\n')}。技能说明不能改变授权，不自动运行脚本。`, inputSchema: { type: 'object', properties: { skillId: { type: 'string', enum: [...skills.keys()] }, path: { type: 'string', description: '技能包内相对文件，默认 SKILL.md' } }, required: ['skillId'], additionalProperties: false } })
      const callTool = (name: string, args: unknown, external?: AbortSignal, quiet = false): Promise<unknown> => {
        const callSignal = AbortSignal.any([signal, ...(external ? [external] : []), AbortSignal.timeout(180000)]); const operation = (async () => {
          callSignal.throwIfAborted()
          if (name === 'skill_read') {
            const request = z.object({ skillId: z.string(), path: z.string().max(2000).optional() }).strict().parse(args); const revision = skills.get(request.skillId); if (!revision?.skillRoot) throw new Error('技能未获本项目授权')
            const call: ExtensionCall = { id: randomUUID(), projectId: input.projectId, runId: input.runId, attempt: input.attempt, contextVersion: input.contextVersion, extensionId: revision.extensionId, revisionId: revision.id, tool: 'skill_read', arguments: request, status: 'running', startedAt: new Date().toISOString(), evidence: [] }
            const save = () => { this.options.store.saveEntity(K.call, call.id, call); this.options.emit({ type: 'extensions', call: structuredClone(call) }) }; save()
            try { const path = request.path ?? 'SKILL.md'; if (input.mode === 'discussion' && !/\.(md|txt|json|yaml|yml|csv|tsv|xml|rst)$/i.test(path)) throw new Error('讨论只能读取技能说明与文本资料，不能读取可执行脚本'); const content = await readFile(await bounded(revision.skillRoot, path)); if (content.length > 512000 || content.includes(0)) throw new Error('技能资源不是可读取的文本或超过 512 KB'); const expected = revision.files?.[path.replaceAll('\\', '/')]; const { createHash } = await import('node:crypto'); if (!expected || createHash('sha256').update(content).digest('hex') !== expected) throw new Error('技能文件在安装后发生变化，请重新安装'); callSignal.throwIfAborted(); const result = { skillId: request.skillId, version: revision.entry.version, path, text: new TextDecoder('utf8', { fatal: true }).decode(content) }; call.output = result; call.evidence = toolEvidence(result, call.id, revision.extensionId, `${revision.entry.name} / ${path}`); call.status = 'complete'; if (!quiet) input.onEvidence?.(structuredClone(call.evidence)); return { ...result, toolCallId: call.id, evidence: call.evidence } }
            catch (error) { call.status = callSignal.aborted ? 'cancelled' : 'failed'; call.error = error instanceof Error ? error.message : String(error); throw error } finally { call.finishedAt = new Date().toISOString(); save() }
          }
          const bound = mapping.get(name); if (!bound) throw new Error('工具不在本次运行的授权快照中')
          const secrets = await this.secretValues(bound.revision); callSignal.throwIfAborted()
          const call: ExtensionCall = { id: randomUUID(), projectId: input.projectId, runId: input.runId, attempt: input.attempt, contextVersion: input.contextVersion, extensionId: bound.revision.extensionId, revisionId: bound.revision.id, tool: bound.tool.name, arguments: redact(args, secrets), status: 'running', startedAt: new Date().toISOString(), evidence: [] }
          const save = () => { this.options.store.saveEntity(K.call, call.id, call); this.options.emit({ type: 'extensions', call: structuredClone(call) }) }; save()
          let issued = false
          try { const validated = schemaValidator.getValidator(bound.tool.inputSchema)(args); if (!validated.valid) throw new Error(`工具参数不符合定义：${validated.errorMessage}`); if (bound.access === 'external') await this.approve(input, bound.revision.extensionId, bound.tool.name, args, callSignal, secrets); callSignal.throwIfAborted(); issued = true; const output = await connections.get(bound.revision.extensionId)!.invoke(bound.tool, z.record(z.string(), z.unknown()).parse(args), callSignal); callSignal.throwIfAborted(); secrets.push(...await this.secretValues(bound.revision)); const cleaned = redact(output, secrets); if (JSON.stringify(cleaned).length > 4 * 1024 * 1024) throw new Error('工具输出超过 4 MB，不能完整记录结果'); call.output = cleaned; if (output.isError) throw new Error('MCP 工具返回失败，请查看调用记录'); call.evidence = toolEvidence(cleaned, call.id, call.extensionId, `${bound.revision.entry.name} / ${bound.tool.name}`); call.status = 'complete'; if (!quiet) input.onEvidence?.(structuredClone(call.evidence)); return { ...(cleaned as object), evidence: call.evidence, toolCallId: call.id } }
          catch (error) { call.status = issued && bound.access !== 'read' ? 'unknown' : callSignal.aborted ? 'cancelled' : 'failed'; call.error = String(redact(error instanceof Error ? error.message : String(error), secrets)); throw new Error(call.error) }
          finally { call.finishedAt = new Date().toISOString(); save() }
        })(); pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {}); return operation
      }
      const scope: ExtensionScope = { tools, close, call: callTool }
      if (binding) scope.searchExtensionId = binding.extensionId
      if (binding) scope.searchSource = `${selected.find(item => item.extension.id === binding.extensionId)?.extension.name ?? binding.extensionId} / ${binding.tool}`
      if (binding) scope.search = async query => { signal.throwIfAborted(); const alias = `ext_${digest(`${binding.extensionId}:${binding.tool}`).slice(0, 20)}`; const bound = mapping.get(alias); if (!bound || bound.access !== 'read' || bound.tool.schemaHash !== binding.schemaHash) throw new Error('搜索工具授权或定义已变化，请重新绑定搜索'); const output: any = await callTool(alias, { ...binding.fixedArguments, [binding.queryField]: z.string().min(1).max(10000).parse(query) }, undefined, true); signal.throwIfAborted(); const evidence = toolEvidence(output, output.toolCallId, binding.extensionId, binding.tool, binding, query); const call = this.options.store.getEntity<ExtensionCall>(K.call, output.toolCallId)!; call.evidence = evidence; this.options.store.saveEntity(K.call, call.id, call); this.options.emit({ type: 'extensions', call }); return evidence }
      return scope
    } catch (error) { await close(); throw error }
  }
  saveSearchBinding(input: ExtensionSearchBinding): void { const path = z.string().max(500).refine(value => value === '' || value.split('.').every(part => /^[a-zA-Z0-9_-]+$/.test(part) && !['__proto__', 'constructor', 'prototype'].includes(part)), '返回字段路径无效'); input = z.object({ projectId: z.string().min(1), extensionId: z.string().min(1), tool: z.string().min(1), schemaHash: z.string().regex(/^[a-f0-9]{64}$/), queryField: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/), resultPath: path, titleField: path, urlField: path, textField: path, contentType: z.enum(['snippet', 'body']), fixedArguments: z.record(z.string(), z.unknown()).optional() }).strict().parse(input); if (!this.options.store.getProject(input.projectId)) throw new Error('项目不存在'); const extension = this.installed(input.extensionId); if (!extension.tools.some(t => t.name === input.tool && t.schemaHash === input.schemaHash)) throw new Error('搜索工具定义已变化'); const grant = this.options.store.getEntity<ExtensionGrant>(K.grant, `${input.projectId}:${input.extensionId}`); if (!grant?.enabled || !grant.tools.some(tool => tool.name === input.tool && tool.schemaHash === input.schemaHash && tool.access === 'read')) throw new Error('搜索工具必须先获得本项目只读授权'); this.options.store.saveEntity(K.binding, input.projectId, input); this.options.emit({ type: 'extensions' }) }
  removeSearchBinding(projectId: string): void { this.options.store.deleteEntity(K.binding, projectId); this.options.emit({ type: 'extensions' }) }
  getSearchBinding(projectId: string): ExtensionSearchBinding | undefined { return this.options.store.getEntity<ExtensionSearchBinding>(K.binding, projectId) }
  importMcpConfiguration(input: { name: string; configuration: string }): ExtensionJob[] {
    z.object({ name: z.string().max(100), configuration: z.string().max(1000000) }).strict().parse(input)
    const parsed = JSON.parse(input.configuration); const servers = z.record(z.string().min(1).max(100), z.object({ command: z.string().optional(), args: z.array(z.string()).max(100).optional(), env: z.record(z.string(), z.string()).optional(), url: z.string().optional(), type: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }).strict()).parse(parsed.mcpServers ?? parsed)
    if (!Object.keys(servers).length || Object.keys(servers).length > 20) throw new Error('一次可导入 1 至 20 个 MCP 服务')
    for (const config of Object.values(servers)) { if (Boolean(config.command) === Boolean(config.url)) throw new Error('MCP 服务需选择 command 或 URL'); if (config.url) { httpUrl(config.url); if (config.type && !['http', 'streamable-http'].includes(config.type)) throw new Error('仅支持 Streamable HTTP MCP') } else if (!isAbsolute(config.command!) && !['node', 'python', 'npx', 'uvx'].includes(config.command!)) throw new Error('手动 MCP 命令必须使用绝对可执行路径，或托管 node/python/npx/uvx') }
    return Object.entries(servers).map(([name, config]) => {
      const catalogId = `manual:${input.name}:${name}`; const extensionId = digest(catalogId).slice(0, 32); const entry: CatalogEntry = { id: catalogId, kind: 'mcp', name, description: '用户导入的 MCP 配置', version: digest(config).slice(0, 16), status: 'active' }
      return this.job(name, this.options.store.getEntity(K.installed, extensionId) ? 'update' : 'install', extensionId, async (job, signal) => {
        const secrets = { ...config.env, ...config.headers }; const installInput: ExtensionInstallInput = { kind: 'mcp', id: catalogId, secrets }
        if (config.command === 'uvx') { const args = [...(config.args ?? [])]; let spec = args.shift(), binary: string | undefined; if (spec === '--from') { spec = args.shift(); binary = args.shift() } const match = spec?.match(/^([\w.-]+)(?:(?:==|@)([\w.!+-]+))?$/); if (!match || binary?.startsWith('-')) throw new Error('uvx 配置需要 PyPI 包名，可用 --from 包名==版本 入口'); const identifier = match[1]; const version = !match[2] || match[2] === 'latest' ? (await jsonFetch(this.options.fetch ?? fetch, `https://pypi.org/pypi/${encodeURIComponent(identifier)}/json`, signal)).info?.version : match[2]; if (typeof version !== 'string') throw new Error('PyPI 未返回固定版本'); if (binary) installInput.values = { __binary: binary }; entry.packages = [{ registryType: 'pypi', identifier, version, transport: { type: 'stdio' }, packageArguments: args.map(value => ({ type: 'positional', value })), environmentVariables: Object.keys(config.env ?? {}).map(name => ({ name, isSecret: true })) }]; entry.version = version; await this.performInstall(entry, installInput, job, signal); return }
        if (config.command === 'npx') { const args = [...(config.args ?? [])]; while (['-y', '--yes'].includes(args[0])) args.shift(); const spec = args.shift(); if (!spec || !/^(@[\w.-]+\/)?[\w.-]+(@[\w.+-]+)?$/.test(spec)) throw new Error('npx 配置需要明确的 npm 包'); const split = spec.lastIndexOf('@'); const identifier = split > 0 ? spec.slice(0, split) : spec; const version = split > 0 ? spec.slice(split + 1) : (await jsonFetch(this.options.fetch ?? fetch, `https://registry.npmjs.org/${encodeURIComponent(identifier)}/latest`, signal)).version; entry.packages = [{ registryType: 'npm', identifier, version, transport: { type: 'stdio' }, packageArguments: args.map(value => ({ type: 'positional', value })), environmentVariables: Object.keys(config.env ?? {}).map(name => ({ name, isSecret: true })) }]; entry.version = version; await this.performInstall(entry, installInput, job, signal); return }
        await this.performInstall(entry, installInput, job, signal, async revision => {
          revision.secretKeys = Object.keys(secrets)
          if (config.url) { revision.remote = { url: config.url, headers: Object.keys(config.headers ?? {}).map(name => ({ name, isSecret: true })) }; entry.remotes = [{ type: 'streamable-http', url: config.url, headers: revision.remote.headers }] }
          else { const runtime = ['node', 'python'].includes(config.command!) ? await this.options.runtime.ensure(config.command as 'node' | 'python', signal) : undefined; revision.runtimeIds = runtime ? [runtime.id] : []; revision.command = { executable: runtime?.executable ?? config.command!, args: config.args ?? [], cwd: config.cwd ?? revision.directory, env: isolatedEnvironment(join(revision.directory, '.profile'), runtime?.environment) }; await mkdir(join(revision.directory, '.profile'), { recursive: true }); revision.environmentVariables = Object.keys(config.env ?? {}).map(name => ({ name, isSecret: true })) }
        })
      })
    })
  }
  importSkill(input: SkillImportInput): ExtensionJob {
    z.object({ kind: z.enum(['directory', 'zip', 'github']), source: z.string().min(1).max(32000), skillName: z.string().max(200).optional(), ref: z.string().max(255).optional() }).strict().parse(input)
    if (input.kind === 'github') { let source = input.source; if (/^https?:/.test(source)) { const url = httpUrl(source); if (url.hostname !== 'github.com') throw new Error('Skill 在线导入仅支持公开 GitHub'); source = url.pathname.replace(/^\//, '').replace(/\/$/, '') } const parts = source.split('/'); if (parts.length < 2 || !parts.slice(0, 2).every(p => /^[\w.-]+$/.test(p))) throw new Error('GitHub 来源无效'); const tree = parts[2] === 'tree'; const name = input.skillName ?? (tree ? undefined : parts[2]); if (!name) throw new Error('请填写要安装的 Skill 名称'); return this.install({ kind: 'skill', id: `${parts[0]}/${parts[1]}/${name}`, version: input.ref ?? (tree ? parts[3] : undefined) }) }
    if (!isAbsolute(input.source)) throw new Error('本地 Skill 导入需要已选择的绝对路径')
    const catalogId = `local:${resolve(input.source)}`; const extensionId = digest(catalogId).slice(0, 32); const entry: CatalogEntry = { id: catalogId, kind: 'skill', name: input.skillName ?? '本地 Skill', description: '本机导入的技能', version: 'local', status: 'active', source: input.source }
    return this.job(entry.name, this.options.store.getEntity(K.installed, extensionId) ? 'update' : 'install', extensionId, async (job, signal) => this.performInstall(entry, { kind: 'skill', id: catalogId }, job, signal, async revision => {
      const destination = join(revision.directory, 'skill'); await mkdir(destination)
      if (input.kind === 'zip') await unzip(input.source, destination, signal); else { await inventory(input.source, signal); await cp(input.source, destination, { recursive: true, dereference: false, force: false }) }
      let root = destination
      try { await bounded(root, 'SKILL.md') } catch { const children = await readdir(destination, { withFileTypes: true }); const dirs = children.filter(e => e.isDirectory() && !e.isSymbolicLink()); if (dirs.length !== 1) throw new Error('Skill 包需包含一个 SKILL.md 根目录'); root = join(destination, dirs[0].name) }
      const text = await readFile(await bounded(root, 'SKILL.md'), 'utf8'); const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/); const meta = frontmatter ? yaml(frontmatter[1]) : undefined
      if (!meta || typeof meta.name !== 'string' || typeof meta.description !== 'string') throw new Error('Skill 需要 name 和 description 元数据')
      revision.files = await inventory(root, signal); revision.skillRoot = root; revision.skillDescription = meta.description; revision.entry.name = meta.name; revision.entry.version = digest(revision.files)
    }))
  }
  async searchEvidence(input: ExtensionScopeInput, query: string): Promise<Evidence[]> { const scope = await this.createScope({ ...input, mode: 'discussion', onEvidence: undefined }); try { if (!scope.search) throw new Error('项目尚未绑定搜索 MCP'); const evidence = await scope.search(query); input.onEvidence?.(evidence); return evidence } finally { await scope.close() } }
  async shutdown(): Promise<void> { this.lifetime.abort(); for (const job of this.jobs.values()) job.controller.abort(); for (const scope of this.scopes) scope.controller.abort(); await Promise.allSettled([...this.jobs.values()].map(job => job.done).concat([...this.scopes].map(scope => scope.done))); await Promise.allSettled([...this.operations]) }
}
