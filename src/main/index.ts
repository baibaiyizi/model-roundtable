import { app, BrowserWindow, dialog, ipcMain, safeStorage, session as electronSession, shell } from 'electron'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, extname, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Store } from './store'
import { LegacyRecovery } from './recovery'
import { LegacyKeyDecryptor, LEGACY_KEY_HELPER_FLAG, runLegacyKeyHelper } from './legacy-key-helper'
import { RuntimeManager } from './components/manager'
import { ExtensionService } from './extensions/service'
import { Gateway, readableError } from './gateway'
import { SearchService } from './search'
import { BrowserSearch } from './search-browser'
import { desktopFetch } from './network'
import { NetworkManager } from './networking/manager'
import { ElectronNetworkTransport } from './networking/electron'
import { Projects } from './projects'
import { EditorBridge } from './editor'
import { DocumentService, DOCUMENT_TOOLS } from './documents'
import { ExecutionManager, executionSchema, testToolCalling } from './execution'
import { NativeAgents } from './agents'
import { DiscussionEngine } from './discussion/engine'
import { KnowledgeService } from './knowledge/service'
import { SUPPORTED_EXTENSIONS } from './knowledge/protocol'
import { exportMarkdown } from './export'
import * as validate from './validation'
import type { AppEvent, Bootstrap, ModelRef } from '../shared/types'
import type { WebEvidenceScope, EvidenceToolScope } from '../shared/ports'
import { DEFAULT_SEARCH } from '../shared/workspace'

const helperArgument = process.argv.indexOf(LEGACY_KEY_HELPER_FLAG)
if (helperArgument >= 0) runLegacyKeyHelper(process.argv[helperArgument + 1] ?? '')
else {
app.setPath('userData', process.env.MODEL_ROUNDTABLE_DATA_DIR ?? join(app.getPath('userData'), 'v2'))
app.setAppUserModelId('org.modelroundtable.desktop')
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
let window: BrowserWindow | undefined
let store: Store | undefined
let engine: DiscussionEngine | undefined
let knowledge: KnowledgeService | undefined
let browserSearch: BrowserSearch | undefined
let documents: DocumentService | undefined
let executions: ExecutionManager | undefined
let nativeAgents: NativeAgents | undefined
let components: RuntimeManager | undefined
let networking: NetworkManager | undefined
let extensions: ExtensionService | undefined
let editorBridge: EditorBridge | undefined
let legacyKeys: LegacyKeyDecryptor | undefined
let legacyRecovery: LegacyRecovery | undefined
const recoveryOperations = new Set<Promise<unknown>>()
let shuttingDown = false
let windowCloseGuard = false
let windowCloseApproved = false
const selectedPaths = new Set<string>()

async function start(): Promise<void> {
  const codec = {
    async encrypt(value: string) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥保护不可用，未保存密钥。')
      return safeStorage.encryptString(value)
    },
    async decrypt(value: Uint8Array) { return safeStorage.decryptString(Buffer.from(value)) }
  }
  const db = new Store(join(app.getPath('userData'), 'roundtable.sqlite'), codec)
  store = db
  const legacy = new LegacyKeyDecryptor({ sourceProfile: dirname(app.getPath('userData')), tempRoot: join(app.getPath('temp'), 'model-roundtable-recovery'), executablePath: process.execPath, appPath: app.getAppPath(), packaged: app.isPackaged })
  legacyKeys = legacy
  const recovery = new LegacyRecovery(db, join(dirname(app.getPath('userData')), 'roundtable.sqlite'), join(app.getPath('userData'), 'backups'), { encrypt: codec.encrypt, decrypt: value => legacy.decrypt(value) })
  legacyRecovery = recovery
  const trackRecovery = <T>(operation: Promise<T>): Promise<T> => { recoveryOperations.add(operation); void operation.finally(() => recoveryOperations.delete(operation)).catch(() => {}); return operation }
  const capabilityTests = new Set<string>()
  const providerChanges = new Set<string>()
  let foregroundNetworkOperations = 0
  const emit = (event: AppEvent): void => { if (window && !window.isDestroyed()) window.webContents.send('app:event', event) }
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  const runtime: RuntimeManager = new RuntimeManager({ manifestPath: join(resourceRoot, 'components', 'manifest.json'), cacheDir: process.env.MODEL_ROUNDTABLE_TEST === '1' && process.env.MODEL_ROUNDTABLE_COMPONENTS_DIR ? process.env.MODEL_ROUNDTABLE_COMPONENTS_DIR : join(app.getPath('userData'), 'components'), fetch: (input, init) => network.fetchForScope('downloads')(input, init), emit: component => emit({ type: 'component', component }) })
  components = runtime
  const networkTransport = new ElectronNetworkTransport()
  const network: NetworkManager = new NetworkManager({ store: db, runtime, stateDir: app.getPath('userData'), transport: networkTransport, emit: state => emit({ type: 'network', network: state }), isBusy: () => foregroundNetworkOperations > 0 || db.listSessions().some(value => engine?.isActive(value.id)) || db.listExecutions().some(value => executions?.isActive(value.id)) || db.listSources().some(value => ['queued', 'processing'].includes(value.status)) || Boolean(extensions?.state().jobs.some(value => value.status === 'running')) })
  networking = network
  const extensionService = new ExtensionService({ store: db, stateDir: app.getPath('userData'), runtime, fetch: network.fetchForScope('catalog'), network, emit, openExternal: url => shell.openExternal(validate.httpUrlSchema.parse(url)) })
  extensions = extensionService
  const projects = new Projects(db)
  const agentsDir = app.isPackaged ? join(process.resourcesPath,'agents') : join(app.getAppPath(),'resources','agents')
  const native = new NativeAgents({ runtimeDir: agentsDir, stateDir: app.getPath('userData'), getProvider: id => db.getProvider(id), getApiKey: id => db.getSecret(`provider:${id}`), fetch: network.fetchForScope('downloads'), components: runtime, network })
  nativeAgents = native
  const gateway = new Gateway(db, desktopFetch, native, network)
  const mediaDir = app.isPackaged ? join(process.resourcesPath, 'media') : join(app.getAppPath(), 'resources', 'media')
  const documentRuntime = app.isPackaged ? join(process.resourcesPath, 'documents') : join(app.getAppPath(), 'resources', 'documents')
  const docs = new DocumentService({ runtimeDir: documentRuntime, stateDir: join(app.getPath('userData'),'document-jobs'), components: runtime })
  documents = docs
  const kb = new KnowledgeService(db, gateway, app.getPath('userData'), mediaDir, emit, { components: runtime, fetch: network.fetchForScope('web'), extractPptx: (path, signal, progress) => docs.extractPptx(path, signal, progress) })
  knowledge = kb
  const editor = new EditorBridge({ store: db, stateDir: app.getPath('userData'), vsixPath: join(resourceRoot, 'editor', `model-roundtable-companion-${app.getVersion()}.vsix`), emit: () => emit({ type: 'editor' }), importFiles: async (paths, knowledgeBaseId) => (await kb.importSources({ knowledgeBaseId, filePaths: paths })).map(source => source.id) })
  editorBridge = editor
  await editor.start()
  browserSearch = new BrowserSearch(async () => {
    const lease = await network.acquireForScope('search')
    try { return { session: await networkTransport.sessionForRoute(await network.prepareScope('search')), release: () => lease.release() } }
    catch (error) { lease.release(); throw error }
  })
  const search = new SearchService(() => db.getSettings().search, () => db.getSecret('tavily'), browserSearch, network.fetchForScope('search'), network.fetchForScope('web'))
  const webScope = async (signal: AbortSignal, toolScope?: EvidenceToolScope): Promise<WebEvidenceScope> => {
    signal.throwIfAborted()
    const config = structuredClone(db.getSettings().search ?? DEFAULT_SEARCH)
    const extensionId = toolScope?.searchExtensionId
    const source = extensionId ? toolScope!.searchSource ?? `MCP · ${extensionId}` : config.provider === 'browser' ? `浏览器搜索 · ${config.engine}` : config.provider === 'tavily' ? 'Tavily' : `SearXNG · ${config.searxngUrl ?? '未配置'}`
    const searchLease = await network.acquireForScope(extensionId ? `mcp:${extensionId}` : 'search', signal)
    let webLease: Awaited<ReturnType<typeof network.acquireForScope>> | undefined
    try {
      webLease = await network.acquireForScope('web', signal)
      const key = !extensionId && config.provider === 'tavily' ? await db.getSecret('tavily') : ''
      const fixedSession = !extensionId && config.provider === 'browser' ? await networkTransport.sessionForRoute(await network.prepareScope('search')) : undefined
      const taskBrowser = { search: (query: string, engine: typeof config.engine, signal: AbortSignal) => browserSearch!.search(query, engine, signal, async () => {
        if (!fixedSession) throw new Error('本次任务未选择浏览器搜索。')
        const windowLease = await network.acquireForScope('search', signal)
        return { session: fixedSession, release: () => windowLease.release() }
      }) }
      const service = new SearchService(() => config, async () => key, taskBrowser, searchLease.fetch, webLease.fetch)
      signal.throwIfAborted()
      let closed = false
      return { source, snapshots: { search: searchLease.snapshot, web: webLease.snapshot }, search: (query, signal) => service.search(query, signal), read: (url, signal) => service.read(url, signal), close: async () => { if (closed) return; closed = true; webLease?.release(); searchLease.release() } }
    } catch (error) { webLease?.release(); searchLease.release(); throw error }
  }
  const discussion = new DiscussionEngine(db, gateway, {
    retrieve: (ids, query, signal, beforeModelCall) => kb.retrieve(ids, query, signal, beforeModelCall),
    search: (query, signal) => search.search(query, signal),
    web: (_session, signal, scope) => webScope(signal, scope),
    tools: (session, signal, onEvidence) => extensionService.createScope({ projectId: session.projectId!, runId: session.run!.id, contextVersion: session.run!.contextVersion, mode: 'discussion', signal, onEvidence }),
  }, emit, network)
  engine = discussion
  const execution = new ExecutionManager(db,gateway,{
    stateDir: app.getPath('userData'), runtimeDir: agentsDir, fetch: desktopFetch, native, components: runtime, network,
    webTools: (_execution, signal, scope) => webScope(signal, scope),
    extensionTools: (execution, signal, onEvidence) => extensionService.createScope({ projectId: execution.projectId, runId: execution.id, attempt: execution.attempt, mode: 'execution', signal, onEvidence }),
    documentTools: { tools: DOCUMENT_TOOLS, call: (root,name,args,signal) => docs.callTool(root,name,args,signal) }
  }, event => {
    emit(event)
    const current = event.execution
    if (!current.sessionId || !['complete','needs_attention','failed','stopped'].includes(current.status)) return
    const source = db.getSession(current.sessionId)
    if (!source) return
    const marker = `[执行任务 ${current.id} · 尝试 ${current.attempt}]`
    if (!source.messages.some(m => m.kind === 'system' && m.content.includes(marker))) discussion.appendResult(source.id, `${marker}\n状态：${current.status}\n修改文件：${current.changes.map(c => c.path).join('、') || '未记录到文件差异'}\n${current.result ?? ''}\n${current.error ?? ''}\n请在项目的执行会话中核对差异、命令输出和审阅记录。`)
  })
  executions = execution

  const ensureModel = (model: ModelRef | undefined): void => {
    if (model && !db.getProvider(model.providerId)) throw new Error('所选模型的服务不存在，请重新选择。')
  }
  const ensureApiModel = (model: ModelRef | undefined): void => {
    ensureModel(model)
    const provider = model ? db.getProvider(model.providerId) : undefined
    if (provider?.kind && provider.kind !== 'api') throw new Error('此能力需要 API 服务，不能使用官方账号讨论连接。')
  }
  const handle = <I, O>(name: string, schema: z.ZodType<I>, fn: (input: I) => O | Promise<O>): void => {
    ipcMain.handle(name, async (event, raw: unknown) => {
      if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '请求来源无效。' }
      const track = !name.startsWith('network:')
      if (track) foregroundNetworkOperations++
      try { return { ok: true, value: await fn(schema.parse(raw)) } }
      catch (error) {
        return { ok: false, error: error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('；') : readableError(error) }
      }
      finally { if (track) { foregroundNetworkOperations--; void network.applyPending().catch(() => {}) } }
    })
  }
  handle('app:bootstrap', z.undefined(), (): Bootstrap => ({ projects: db.listProjects(), templates: db.listTemplates(), executions: db.listExecutions(), activeExecutionIds: db.listExecutions().filter(item => execution.isActive(item.id)).map(item => item.id), providers: db.listProviders(), settings: db.getSettings(), sessions: db.listSessions(), activeSessionIds: db.listSessions().filter(session => discussion.isActive(session.id)).map(session => session.id), knowledgeBases: db.listKnowledgeBases(), sources: db.listSources(), version: app.getVersion(), mediaReady: existsSync(join(mediaDir, 'bin', 'ffmpeg.exe')) && existsSync(join(mediaDir, 'bin', 'ffprobe.exe')) }))
  handle('network:state', z.undefined(), () => network.getState())
  handle('network:import', z.object({ name: z.string().trim().min(1).max(100), url: validate.httpUrlSchema.optional(), content: z.string().min(1).max(10 * 1024 * 1024).optional() }).strict().refine(value => Boolean(value.url) !== Boolean(value.content), '请提供订阅链接或本地订阅内容'), input => network.importSubscription(input))
  handle('network:refresh', validate.idSchema, id => network.refresh(id))
  handle('network:remove', validate.idSchema, id => network.remove(id))
  handle('network:test-node', z.object({ subscriptionId: validate.idSchema, nodeId: validate.idSchema }).strict(), input => network.testNode(input))
  handle('network:test-nodes', z.array(z.object({ subscriptionId: validate.idSchema, nodeId: validate.idSchema }).strict()).min(1).max(5000), input => network.testNodes(input))
  handle('network:cancel-tests', validate.idSchema, id => network.cancelTests(id))
  const networkScope = z.string().max(300).refine(value => ['search', 'catalog', 'downloads', 'subscriptions', 'web', 'accounts'].includes(value) || /^mcp:[\w.:-]+$/.test(value), '未知网络用途')
  handle('network:bindings', z.record(networkScope, validate.networkSelectionSchema), input => network.saveBindings(input))
  handle('network:restart', z.undefined(), () => network.restart())
  handle('recovery:preview', z.undefined(), () => trackRecovery(recovery.preview()))
  handle('recovery:import', z.object({ token: z.string().uuid(), entries: z.array(z.object({ legacyId: validate.idSchema, asSeparate: z.boolean() }).strict()).max(1000) }).strict(), input => trackRecovery(recovery.import(input)))
  const componentId = z.enum(['documents', 'libreoffice', 'lancedb', 'opencode', 'codex', 'claude', 'node', 'python', 'uv', 'git', 'skills', 'mihomo'])
  handle('component:list', z.undefined(), () => runtime.list())
  handle('component:prepare', componentId, id => runtime.prepare(id))
  handle('component:cancel', componentId, id => runtime.cancel(id))
  handle('component:remove', componentId, id => runtime.remove(id))
  handle('component:select', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择组件或扩展文件', properties: ['openFile', 'multiSelections'] })
    if (result.canceled) return []
    for (const path of result.filePaths) selectedPaths.add(path)
    return result.filePaths
  })
  handle('component:import', z.object({ id: componentId, paths: z.array(z.string().min(1).max(32000)).min(1).max(200) }).strict(), input => {
    if (input.paths.some(path => !selectedPaths.has(path))) throw new Error('请通过“离线导入”选择官方组件包。')
    return runtime.import(input.id, input.paths)
  })
  const extensionKind = z.enum(['mcp', 'skill'])
  const extensionId = z.string().min(1).max(500)
  const extensionFields = z.record(z.string().max(500), z.string().max(32000))
  const extensionDetails = z.object({ kind: extensionKind, id: extensionId, version: z.string().max(255).optional() }).strict()
  handle('extension:state', z.undefined(), () => extensionService.state())
  handle('extension:search', z.object({ kind: extensionKind, query: z.string().trim().max(300), cursor: z.string().max(4000).optional() }).strict(), input => extensionService.search(input))
  handle('extension:details', extensionDetails, input => extensionService.details(input))
  handle('extension:install', extensionDetails.extend({ packageIndex: z.number().int().min(0).max(100).optional(), remoteIndex: z.number().int().min(0).max(100).optional(), values: extensionFields.optional(), secrets: extensionFields.optional() }), input => extensionService.install(input))
  handle('extension:update', z.object({ id: extensionId, values: extensionFields.optional(), secrets: extensionFields.optional() }).strict(), input => extensionService.update(input))
  handle('extension:remove', extensionId, id => extensionService.remove(id))
  handle('extension:cancel', extensionId, id => extensionService.cancelJob(id))
  handle('extension:clear-job', extensionId, id => extensionService.clearJob(id))
  handle('extension:clear-finished', z.undefined(), () => extensionService.clearFinishedJobs())
  handle('extension:popularity', z.array(z.object({ kind: extensionKind, id: extensionId }).strict()).min(1).max(1000), input => extensionService.popularity(input))
  handle('extension:test', extensionId, id => extensionService.test(id))
  handle('extension:configure', z.object({ id: extensionId, values: extensionFields, secrets: extensionFields.optional() }).strict(), input => extensionService.configure(input))
  handle('extension:grant', z.object({ projectId: validate.idSchema, extensionId, enabled: z.boolean(), tools: z.array(z.object({ name: z.string().min(1).max(500), schemaHash: z.string().regex(/^[a-f0-9]{64}$/), access: z.enum(['read', 'project-write', 'external']) }).strict()).max(500), updatedAt: z.string().optional() }).strict(), input => extensionService.saveGrant(input))
  handle('extension:approve', z.object({ id: extensionId, allow: z.boolean() }).strict(), input => extensionService.resolveApproval(input))
  handle('extension:updates', z.undefined(), () => extensionService.checkUpdates())
  handle('extension:search-unbind', validate.idSchema, projectId => extensionService.removeSearchBinding(projectId))
  handle('extension:login', extensionId, id => extensionService.login(id))
  handle('extension:import-mcp', z.object({ name: z.string().trim().min(1).max(100), configuration: z.string().min(1).max(1000000) }).strict(), input => extensionService.importMcpConfiguration(input))
  handle('extension:import-skill', z.object({ kind: z.enum(['directory', 'zip', 'github']), source: z.string().min(1).max(32000), skillName: z.string().max(300).optional(), ref: z.string().max(500).optional() }).strict(), input => {
    if (input.kind !== 'github' && !selectedPaths.has(input.source)) throw new Error('请使用选择文件或目录导入本地 Skill。')
    return extensionService.importSkill(input)
  })
  handle('extension:search-binding', z.object({ projectId: validate.idSchema, extensionId, tool: z.string().min(1).max(500), schemaHash: z.string().regex(/^[a-f0-9]{64}$/), queryField: z.string().min(1).max(300), resultPath: z.string().max(1000), titleField: z.string().max(300), urlField: z.string().max(300), textField: z.string().min(1).max(300), contentType: z.enum(['snippet', 'body']), fixedArguments: z.record(z.string(), z.unknown()).optional() }).strict(), input => extensionService.saveSearchBinding(input))
  handle('project:save', validate.projectSchema, input => {
    if (input.id && db.listExecutions().some(e => e.projectId === input.id && execution.isActive(e.id))) throw new Error('项目正在执行，请停止后再修改项目设置。')
    return projects.save(input)
  })
  handle('project:select', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择项目工作目录', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled) return null
    for (const path of result.filePaths) selectedPaths.add(path)
    return result.filePaths[0] ?? null
  })
  handle('project:remove', validate.idSchema, async id => {
    if (db.listSessions().some(s => s.projectId === id && discussion.isActive(s.id)) || db.listExecutions().some(e => e.projectId === id && execution.isActive(e.id))) throw new Error('请先停止项目内正在运行的任务，并等待停止完成。')
    for (const s of db.listSessions().filter(s => s.projectId === id)) { discussion.remove(s.id); db.deleteSession(s.id) }
    for (const e of db.listExecutions().filter(e => e.projectId === id)) { await execution.remove(e.id); db.deleteExecution(e.id) }
    db.deleteProject(id)
  })
  handle('project:files', validate.projectPathSchema, input => projects.files(input.projectId,input.path))
  handle('editor:state', z.undefined(), () => editor.state())
  handle('editor:enable', z.boolean(), enabled => editor.enable(enabled))
  handle('editor:select', z.undefined(), async () => { const result = await dialog.showOpenDialog(window!, { title: '选择 VS Code 的 Code.exe', properties: ['openFile'], filters: [{ name: 'VS Code', extensions: ['exe'] }] }); return result.canceled ? editor.state() : editor.selectExecutable(result.filePaths[0]) })
  handle('editor:install', z.undefined(), () => editor.install())
  handle('editor:resolve-connection', z.object({ requestId: validate.idSchema, allow: z.boolean() }).strict(), input => editor.resolveConnection(input))
  handle('editor:revoke', validate.idSchema, id => editor.revoke(id))
  handle('editor:dismiss', validate.idSchema, id => editor.dismiss(id))
  handle('editor:apply', z.object({ transferId: validate.idSchema, target: z.object({ kind: z.enum(['discussion-new', 'execution-new', 'discussion']), projectId: validate.idSchema.optional(), sessionId: validate.idSchema.optional() }).strict(), draftId: validate.idSchema, draft: z.string().max(100000) }).strict(), input => editor.apply(input))
  handle('editor:import', z.object({ transferId: validate.idSchema, knowledgeBaseId: validate.idSchema }).strict(), input => editor.importTransfer(input.transferId, input.knowledgeBaseId))
  handle('editor:open', z.object({ projectId: validate.idSchema, path: z.string().max(32000).optional(), line: z.number().int().positive().optional() }).strict(), input => editor.open(input.projectId,input.path,input.line))
  handle('editor:open-source', validate.idSchema, id => editor.openSource(id))
  handle('editor:send', z.object({ title: z.string().max(500), text: z.string().max(1024*1024), windowId: validate.idSchema.optional() }).strict(), input => editor.send(input))
  handle('project:file', z.object({ projectId: validate.idSchema, path: z.string().min(1).max(32000) }).strict(), input => projects.file(input.projectId,input.path))
  handle('project:open', validate.projectPathSchema, async input => {
    const target = await projects.path(input.projectId,input.path)
    if (input.path && /\.(exe|com|bat|cmd|ps1|vbs|js|msi|lnk|url)$/i.test(target)) { shell.showItemInFolder(target); return }
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })
  const documentInput = z.object({ projectId: validate.idSchema, path: z.string().min(1).max(32000) }).strict()
  handle('document:inspect', documentInput, input => {
    const project = db.getProject(input.projectId)
    if (!project) throw new Error('项目不存在。')
    return docs.execute(project.directory, { action: 'inspect', path: input.path })
  })
  handle('document:preview', documentInput, async input => {
    const project = db.getProject(input.projectId)
    if (!project) throw new Error('项目不存在。')
    const result = await docs.execute(project.directory, { action: 'preview', path: input.path })
    if (result.previewPath && /\.pdf$/i.test(result.previewPath) && result.status === 'complete') {
      const viewer = new BrowserWindow({ width: 1100, height: 850, title: `文档预览 · ${input.path}`, show: process.env.MODEL_ROUNDTABLE_TEST !== '1', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true } })
      viewer.setMenuBarVisibility(false)
      viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      viewer.webContents.on('will-navigate', event => event.preventDefault())
      await viewer.loadURL(pathToFileURL(result.previewPath).toString())
    }
    return result
  })
  handle('draft:save', z.object({ id: validate.idSchema, text: z.string().max(100000) }).strict(), input => db.saveDraft(input.id,input.text))
  handle('draft:get', validate.idSchema, id => db.getDraft(id))
  handle('execution:create', executionSchema, input => execution.create(input))
  handle('execution:action', z.object({ id: validate.idSchema, action: z.enum(['start','stop','retry']) }).strict(), input => execution[input.action](input.id))
  handle('execution:delete', validate.idSchema, async id => { if (execution.isActive(id)) throw new Error('请先停止执行，并等待停止完成。'); await execution.remove(id); db.deleteExecution(id) })
  handle('agent:status', z.undefined(), () => native.status())
  handle('agent:prepare', z.enum(['api','codex','claude']), kind => native.prepare(kind))
  const ensureAccountIdle = (kind: 'codex' | 'claude'): void => {
    const usesAccount = (model: ModelRef): boolean => { const provider = db.getProvider(model.providerId); return provider?.kind === kind && !(kind === 'claude' && provider.claudeAuth === 'apiKey') }
    if (db.listExecutions().some(e => execution.isActive(e.id) && [e.executor,...e.reviewers].some(usesAccount)) || db.listSessions().some(s => discussion.isActive(s.id) && [...s.participants.map(p => p.model), ...(s.moderator ? [s.moderator] : [])].some(usesAccount))) throw new Error('此官方账号正在使用，请先停止相关任务并等待结束。')
  }
  handle('agent:login', validate.agentLoginSchema, input => { ensureAccountIdle(input.kind); return native.login(input) })
  handle('agent:open-claude', z.undefined(), () => { ensureAccountIdle('claude'); return native.openClaude() })
  handle('agent:logout', z.enum(['codex','claude']), kind => { ensureAccountIdle(kind); return native.logout(kind) })
  handle('template:save', z.object({ name: z.string().trim().min(1).max(100), sessionId: validate.idSchema }).strict(), input => {
    const s = db.getSession(input.sessionId)
    if (!s) throw new Error('来源讨论不存在。')
    const config = validate.sessionSchema.parse({ title: s.title, topic: s.topic, mode: s.mode, participants: s.participants, moderator: s.moderator, knowledgeBaseIds: s.knowledgeBaseIds, searchEnabled: s.searchEnabled, limits: s.limits })
    const template = { id: randomUUID(), name: input.name, config, createdAt: new Date().toISOString() }
    db.saveTemplate(template); return template
  })
  handle('template:delete', validate.idSchema, id => db.deleteTemplate(id))
  handle('session:branch', z.object({ sessionId: validate.idSchema, messageId: validate.idSchema, title: z.string().trim().max(150).optional() }).strict(), input => discussion.branch(input))
  handle('session:mute', z.object({ sessionId: validate.idSchema, participantId: validate.idSchema, muted: z.boolean() }).strict(), input => discussion.mute(input.sessionId,input.participantId,input.muted))
  handle('session:summarize', z.object({ sessionId: validate.idSchema, model: validate.modelSchema }).strict(), input => discussion.summarize(input.sessionId,input.model))
  handle('session:search', z.object({ sessionId: validate.idSchema, query: z.string().trim().min(1).max(500) }).strict(), input => discussion.manualSearch(input.sessionId,input.query))
  handle('search:web', z.string().trim().min(1).max(500), query => search.search(query,AbortSignal.timeout(120000)))
  const providerInUse = (id: string): boolean => db.listExecutions().some(e => execution.isActive(e.id) && [e.executor,...e.reviewers].some(m => m.providerId === id)) || db.listSessions().some(s => discussion.isActive(s.id) && (s.moderator?.providerId === id || s.participants.some(p => p.model.providerId === id) || s.knowledgeBaseIds.some(k => db.getKnowledgeBase(k)?.embedding.providerId === id))) || db.listSources().some(source => ['queued', 'processing'].includes(source.status) && (db.getKnowledgeBase(source.knowledgeBaseId)?.embedding.providerId === id || db.getSettings().vision?.providerId === id || db.getSettings().transcription?.providerId === id))
  handle('provider:save', validate.providerSchema, async input => {
    const old = input.id ? db.getProvider(input.id) : undefined
    const networkOnly = old && input.apiKey === undefined && (old.kind ?? 'api') === (input.kind ?? 'api') && (old.claudeAuth ?? 'official') === (input.claudeAuth ?? 'official') && ['name', 'baseUrl', 'modelIds', 'tokenParameter', 'streamUsage', 'timeoutMs'].every(key => JSON.stringify(old[key as keyof typeof old]) === JSON.stringify(input[key as keyof typeof input]))
    if (input.id && providerChanges.has(input.id)) throw new Error('此服务正在保存，请完成后再修改。')
    if (input.id && !networkOnly && (capabilityTests.has(input.id) || providerInUse(input.id))) throw new Error('此服务正在任务中使用；当前只能保存网络线路变更，其他设置请等待任务结束。')
    if (input.id) providerChanges.add(input.id)
    try { const provider = await db.saveProvider(input); await network.applyPending(); return provider }
    finally { if (input.id) providerChanges.delete(input.id) }
  })
  handle('provider:remove', validate.idSchema, id => {
    if (capabilityTests.has(id) || providerChanges.has(id)) throw new Error('此服务正在保存或测试结构化输出，请完成后再删除。')
    if (providerInUse(id)) throw new Error('此服务正在任务中使用，请先结束任务。')
    db.removeProvider(id)
  })
  handle('provider:discover', z.object({ providerId: validate.idSchema }).strict(), input => gateway.discover(input.providerId))
  handle('provider:test-structured', z.object({ model: validate.modelSchema, mode: z.enum(['json_object', 'json_schema']) }).strict(), async input => {
    ensureApiModel(input.model)
    if (capabilityTests.has(input.model.providerId) || providerChanges.has(input.model.providerId)) throw new Error('此服务正在保存或已有结构化能力测试正在运行。')
    capabilityTests.add(input.model.providerId)
    try {
      const capability = await gateway.testStructured(input.model, input.mode, AbortSignal.timeout(120000))
      db.setStructuredCapability(input.model.providerId, input.model.modelId, capability)
      return capability
    } finally { capabilityTests.delete(input.model.providerId) }
  })
  handle('provider:test', validate.modelSchema, model => gateway.chat({ model, system: '你正在执行连接测试。只回复：连接成功。', prompt: '连接测试', maxOutputTokens: 64, signal: AbortSignal.timeout(120000) }))
  handle('provider:test-tools', validate.modelSchema, async model => {
    const provider = db.getProvider(model.providerId)
    if (!provider) throw new Error('服务不存在。')
    if (provider.kind && provider.kind !== 'api') throw new Error('官方 Agent 自带执行工具，请使用账号状态和执行任务验证。')
    return testToolCalling(provider,await db.getSecret(`provider:${provider.id}`),model.modelId,desktopFetch,undefined,network)
  })
  handle('settings:save', validate.settingsSchema, input => {
    ensureModel(input.moderator); ensureApiModel(input.vision); ensureApiModel(input.transcription)
    return db.saveSettings(input)
  })
  handle('session:create', validate.sessionSchema, input => {
    ensureModel(input.moderator); input.participants.forEach(p => ensureModel(p.model))
    if (input.knowledgeBaseIds.some(id => !db.getKnowledgeBase(id))) throw new Error('所选知识库已删除，请重新选择。')
    if (input.searchEnabled && !(input.projectId && extensionService.getSearchBinding(input.projectId)) && db.getSettings().search?.provider === 'tavily' && !db.getSettings().hasTavilyKey) throw new Error('请先设置 Tavily 搜索密钥，或改用免 Key 搜索。')
    const project = input.projectId ? db.getProject(input.projectId) : undefined
    if (input.projectId && !project) throw new Error('所选项目不存在。')
    return discussion.create(input,project?.instructions)
  })
  handle('session:action', validate.actionSchema, input => discussion.action(input))
  handle('session:interject', validate.interjectSchema, input => discussion.interject(input))
  handle('session:delete', validate.idSchema, id => {
    if (discussion.isActive(id)) throw new Error('请先停止讨论，并等待停止完成。')
    discussion.remove(id)
    db.deleteSession(id)
  })
  handle('session:export', validate.idSchema, async id => {
    const current = db.getSession(id)
    if (!current) throw new Error('会话不存在。')
    const safeName = current.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 70)
    const result = await dialog.showSaveDialog(window!, { title: '导出讨论记录', defaultPath: `${safeName || '讨论记录'}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, exportMarkdown(current), 'utf8')
    return result.filePath
  })
  handle('knowledge:create', validate.kbSchema, input => { ensureApiModel(input.embedding); return kb.create(input) })
  handle('knowledge:delete', validate.idSchema, id => kb.deleteKnowledgeBase(id))
  handle('knowledge:rebuild', z.object({ id: validate.idSchema, embedding: validate.modelSchema }).strict(), input => { ensureApiModel(input.embedding); return kb.rebuild(input.id, input.embedding) })
  handle('source:select', z.undefined(), async () => {
    const result = await dialog.showOpenDialog(window!, { title: '选择要导入的资料', properties: ['openFile', 'multiSelections'], filters: [
      { name: '支持的资料', extensions: SUPPORTED_EXTENSIONS.map(extension => extension.slice(1)) },
      { name: '所有文件', extensions: ['*'] }
    ] })
    for (const path of result.filePaths) selectedPaths.add(path)
    return result.filePaths
  })
  handle('source:import', validate.importSchema, input => {
    if (input.url) validate.httpUrlSchema.parse(input.url)
    if (input.filePaths?.some(path => !selectedPaths.has(path))) throw new Error('请通过“选择文件”导入本机资料。')
    return kb.importSources(input)
  })
  handle('source:cancel', validate.idSchema, id => kb.cancel(id))
  handle('source:delete', validate.idSchema, id => kb.deleteSource(id))
  handle('source:chunks', validate.idSchema, id => kb.getSourceChunks(id))
  handle('knowledge:search', z.object({ knowledgeBaseIds: z.array(validate.idSchema).min(1).max(30), query: z.string().trim().min(1).max(10000) }).strict(), input => kb.retrieve(input.knowledgeBaseIds, input.query, AbortSignal.timeout(120000)))
  handle('source:open', z.object({ sourceId: validate.idSchema, locator: z.string().max(2000).optional() }).strict(), async input => {
    const source = db.getSource(input.sourceId)
    if (!source) throw new Error('原始资料已删除，仍可查看会话中保存的证据摘录。')
    if (source.url) { await shell.openExternal(validate.httpUrlSchema.parse(source.url)); return }
    if (!source.originalPath || !existsSync(source.originalPath)) throw new Error('原始文件不存在，仍可查看已保存的证据摘录。')
    if (['.pdf','.png','.jpg','.jpeg','.webp','.bmp','.mp4','.webm','.mp3','.wav','.ogg'].includes(extname(source.originalPath).toLowerCase())) {
      const viewer = new BrowserWindow({ width: 1050, height: 800, title: source.title, backgroundColor: '#f6f7f4', show: process.env.MODEL_ROUNDTABLE_TEST !== '1', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, plugins: true } })
      viewer.setMenuBarVisibility(false)
      viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const page = input.locator?.match(/(?:第\s*)?(\d+)\s*页|page\s*(\d+)/i)
      const time = input.locator?.match(/^(\d{2,}):(\d{2}):(\d{2}(?:\.\d+)?)/)
      const fragment = page ? `#page=${page[1] ?? page[2]}` : time ? `#t=${Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])}` : ''
      const originalUrl = `${pathToFileURL(source.originalPath).toString()}${fragment}`
      if (['.mp4', '.webm', '.mp3', '.wav', '.ogg'].includes(extname(source.originalPath).toLowerCase())) {
        const tag = ['.mp4', '.webm'].includes(extname(source.originalPath).toLowerCase()) ? 'video' : 'audio'
        const previewPath = `${source.originalPath}.preview.html`
        const mediaUrl = originalUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
        const playerScript = "const media=document.querySelector('audio,video');const showError=()=>{document.getElementById('error').hidden=false};media.addEventListener('error',showError);if(media.error)showError();"
        const scriptHash = createHash('sha256').update(playerScript).digest('base64')
        await writeFile(previewPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>资料播放</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'"><style>body{margin:0;display:grid;place-items:center;align-content:center;gap:20px;min-height:100vh;background:#f6f7f4;font-family:sans-serif}audio,video{width:min(90vw,960px);max-height:90vh}</style><${tag} controls preload="metadata" src="${mediaUrl}"></${tag}><p id="error" role="status" hidden>此编码无法在预览中播放。</p><script>${playerScript}</script></html>`, 'utf8')
        await viewer.loadURL(`${pathToFileURL(previewPath).toString()}${fragment}`)
      } else await viewer.loadURL(originalUrl)
    } else {
      const error = await shell.openPath(source.originalPath)
      if (error) throw new Error(`无法打开原件：${error}`)
    }
  })
  handle('app:external', validate.httpUrlSchema, async url => { await shell.openExternal(url) })
  handle('app:close-guard', z.boolean(), enabled => { windowCloseGuard = enabled })
  handle('app:close-window', z.undefined(), () => { windowCloseApproved = true; window?.close() })

  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  electronSession.defaultSession.setPermissionCheckHandler(() => false)
  createWindow()
}

function createWindow(): void {
  window = new BrowserWindow({ width: 1500, height: 960, minWidth: 1060, minHeight: 700, title: '模型圆桌', icon: join(app.getAppPath(), 'resources', 'icon.png'), backgroundColor: '#f5f5f0', show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
  })
  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (shuttingDown || windowCloseApproved || !windowCloseGuard) return
    event.preventDefault()
    window?.webContents.send('app:event', { type: 'close-request' } satisfies AppEvent)
  })
  window.once('ready-to-show', () => { if (process.env.MODEL_ROUNDTABLE_TEST !== '1') window?.show() })
  window.on('closed', () => { window = undefined; app.quit() })
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

if (primaryInstance) app.whenReady().then(start).catch(error => { dialog.showErrorBox('模型圆桌无法启动', readableError(error)); app.quit() })
app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus() })
app.on('before-quit', event => {
  if (shuttingDown) return
  event.preventDefault()
  // The window guard must resolve before storage and background services shut down.
  if (window && !window.isDestroyed()) { window.close(); return }
  shuttingDown = true
  legacyRecovery?.shutdown()
  engine?.shutdown()
  browserSearch?.shutdown()
  void Promise.allSettled([editorBridge?.close(), knowledge?.shutdown(), documents?.shutdown(), executions?.shutdown(), nativeAgents?.shutdown(), extensions?.shutdown(), legacyKeys?.close(), ...recoveryOperations]).then(async () => {
    try { await networking?.shutdown() } finally { await components?.shutdown() }
  }).finally(() => {
    try { store?.close() } finally { app.quit() }
  }).catch(() => {})
})
}
