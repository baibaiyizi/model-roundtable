import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ImportSubscriptionInput, NetworkLease, NetworkNode, NetworkNodeRef, NetworkTestJob, NetworkScopeLease, NetworkScopeName, NetworkSelection, NetworkSnapshot, NetworkState, NetworkSubscription, ProviderNetworkPort } from '../../shared/network'
import type { NetworkBindings, NetworkManagerOptions, PreparedNetworkRoute } from './ports'
import { MihomoProcess, MIHOMO_VERSION, selectionKey, type CoreNode, type CoreResource, type CoreRoute } from './core'
import { downloadSubscription, prepareSubscription, subscriptionUrl, type SubscriptionContent } from './subscriptions'
import { cleanupOrphanedCores } from './ownership'
import { runNodeTests } from './node-tests'

interface StoredSubscription extends Omit<NetworkSubscription, 'nodes'> { nodes: CoreNode[]; revision: string }
interface SecretSubscription extends SubscriptionContent { url?: string; originalContent?: string }
interface ActiveSubscription { metadata: StoredSubscription; secret: SecretSubscription }
const clone = <T>(value: T): T => structuredClone(value)
const requestSignal = (input: Parameters<typeof fetch>[0], init?: RequestInit): AbortSignal | undefined => init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal ?? undefined
const scopes = new Set(['search','catalog','downloads','subscriptions','web','accounts'])
const publicNode = ({ id, name, type, delayMs, testedAt, error }: CoreNode): NetworkNode => ({ id,name,type,...(delayMs !== undefined ? { delayMs } : {}),...(testedAt ? { testedAt } : {}),...(error ? { error } : {}) })

export function validateNetworkSelection(value: unknown): NetworkSelection {
  if (!value || typeof value !== 'object') throw new Error('网络线路设置无效')
  const selection = value as NetworkSelection
  if (selection.mode === 'system' || selection.mode === 'direct') return { mode: selection.mode }
  if (selection.mode === 'subscription' && typeof selection.subscriptionId === 'string' && typeof selection.nodeId === 'string' && selection.subscriptionId.length <= 100 && selection.nodeId.length <= 100) return { mode: selection.mode, subscriptionId: selection.subscriptionId, nodeId: selection.nodeId }
  throw new Error('网络线路设置无效')
}
/** Case-insensitive removal prevents inherited lowercase proxy settings from overriding a route. */
export function applyNetworkEnvironment(base: NodeJS.ProcessEnv, overrides: Record<string,string>): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(base).filter(([key]) => !/^(http_proxy|https_proxy|all_proxy|no_proxy)$/i.test(key))), ...overrides }
}
export function proxyEnvironment(proxyUrl?: string): Record<string,string> {
  const result: Record<string,string> = {}
  for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']) { result[name] = proxyUrl ?? ''; result[name.toLowerCase()] = proxyUrl ?? '' }
  result.NO_PROXY = result.no_proxy = proxyUrl ? 'localhost,127.0.0.1,::1' : '*'
  return result
}
export function systemProxyUrl(value: string): string | undefined {
  const parts = value.split(';').map(part => part.trim()).filter(Boolean)
  if (parts.length !== 1) throw new Error('此系统代理包含多候选或自动回退，命令行任务无法准确继承，请选择直连或固定订阅节点')
  if (parts[0] === 'DIRECT') return undefined
  const match = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^\s]+)$/.exec(parts[0])
  if (!match) throw new Error('此系统代理格式无法传递给命令行任务，请选择直连或固定订阅节点')
  const scheme = match[1] === 'HTTPS' ? 'https' : ['SOCKS','SOCKS5'].includes(match[1]) ? 'socks5h' : 'http'
  return `${scheme}://${match[2]}`
}

export class NetworkManager implements ProviderNetworkPort {
  private active = new Map<string, ActiveSubscription>()
  private unavailable = new Map<string, string>()
  private bindings: NetworkBindings = {}
  private providers = new Map<string, NetworkSelection>()
  private initialized?: Promise<void>
  private leases = 0
  private preparing = 0
  private applying?: Promise<void>
  private coreRelease?: () => void
  private core?: MihomoProcess
  private coreRoutes = new Map<string, CoreRoute>()
  private coreState: NetworkState['core'] = { phase: 'stopped', version: MIHOMO_VERSION }
  private starting?: Promise<void>
  private mutation: Promise<unknown> = Promise.resolve()
  private disposed = false
  private poll: ReturnType<typeof setInterval>
  private controllers = new Set<AbortController>()
  private nodeTests?: { job: NetworkTestJob; controller: AbortController; done: Promise<void> }
  constructor(private options: NetworkManagerOptions) {
    this.poll = setInterval(() => { if (this.getState().pending && !this.busy()) void this.applyPending().catch(() => {}) }, 1000)
    this.poll.unref()
  }
  private busy(): boolean { return this.leases > 0 || this.preparing > 0 || !!this.options.isBusy?.() }
  private emit(): void { this.options.emit?.(this.getState()) }
  private ready(): Promise<void> {
    this.initialized ??= (async () => {
      await cleanupOrphanedCores(join(this.options.stateDir, 'network', 'runtime'))
      this.bindings = clone(this.options.store.getEntity<NetworkBindings>('network', 'bindings') ?? {})
      for (const provider of this.options.store.listProviders()) this.providers.set(provider.id, clone(provider.network ?? { mode: 'system' }))
      for (const record of this.options.store.listEntities<StoredSubscription>('network-subscription')) {
        try { this.active.set(record.id, { metadata: clone(record), secret: await this.readSecret(record) }) }
        catch { this.markUnavailable(record) }
      }
    })()
    return this.initialized
  }
  getState(): NetworkState {
    const bindings = clone(this.options.store.getEntity<NetworkBindings>('network','bindings') ?? {})
    const records = this.options.store.listEntities<StoredSubscription>('network-subscription')
    const pending = !!this.initialized && (JSON.stringify(bindings) !== JSON.stringify(this.bindings) || records.some(record => this.subscriptionPending(record)) || [...this.active.keys()].some(id => !records.some(record => record.id === id)) || this.options.store.listProviders().some(provider => JSON.stringify(provider.network ?? { mode: 'system' }) !== JSON.stringify(this.providers.get(provider.id) ?? { mode: 'system' })))
    return { subscriptions: records.map(record => ({ id: record.id, name: record.name, source: record.source, host: record.host, updatedAt: record.updatedAt, nodes: record.nodes.map(publicNode), error: record.error, pending: !!this.initialized && this.subscriptionPending(record) })), bindings, core: clone(this.coreState), pending, ...(this.nodeTests ? { nodeTests: clone(this.nodeTests.job) } : {}) }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutation.catch(() => {}).then(operation); this.mutation = pending.catch(() => {}); return pending
  }
  private async readSecret(record: StoredSubscription): Promise<SecretSubscription> {
    try {
      const secret = JSON.parse(await this.options.store.getSecret(`network:subscription:${record.id}:${record.revision}`)) as SecretSubscription
      if (!secret || !Array.isArray(secret.resources) || secret.resources.some(resource => !resource || typeof resource.key !== 'string' || typeof resource.content !== 'string')) throw new Error('Invalid subscription snapshot')
      return secret
    } catch { throw new Error('订阅凭据无法解密，请重新导入') }
  }
  private subscriptionPending(record: StoredSubscription): boolean { return this.active.get(record.id)?.metadata.revision !== record.revision && this.unavailable.get(record.id) !== record.revision }
  private markUnavailable(record: StoredSubscription): void {
    this.unavailable.set(record.id,record.revision)
    if (this.options.store.getEntity<StoredSubscription>('network-subscription',record.id)?.revision === record.revision) this.options.store.saveEntity('network-subscription',record.id,{...record,error:'订阅凭据无法解密，请重新导入'})
  }
  private resources(): CoreResource[] { return [...this.active.values()].flatMap(item => item.secret.resources.map(resource => ({ ...resource, subscriptionId: item.metadata.id }))) }
  private async inspect(id: string, content: SubscriptionContent, signal?: AbortSignal): Promise<CoreNode[]> {
    let release: (() => void) | undefined
    let core: MihomoProcess | undefined
    try {
      const component = await this.options.runtime.ensure('mihomo', signal)
      release = this.options.runtime.acquire?.('mihomo')
      core = new MihomoProcess(component.executable, join(this.options.stateDir, 'network', 'runtime'))
      const resources = content.resources.map(resource => ({ ...resource, subscriptionId: id }))
      await core.start(resources, [], signal); return (await core.nodes(resources))[id] ?? []
    } finally { await core?.stop(); release?.() }
  }
  async importSubscription(input: ImportSubscriptionInput): Promise<NetworkState> {
    return this.serial(async () => {
      await this.ready()
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || !!input.url === !!input.content) throw new Error('请填写订阅名称，并提供订阅地址或文件内容')
      const controller = new AbortController(); this.controllers.add(controller)
      try {
        const id = randomUUID(), fetcher = this.fetchForScope('subscriptions')
        const originalContent = input.url ? await downloadSubscription(fetcher, input.url, controller.signal) : input.content!
        const content = await prepareSubscription(originalContent, fetcher, controller.signal)
        const nodes = await this.inspect(id, content, controller.signal)
        if (!nodes.length) throw new Error('订阅没有可用节点')
        const revision = randomUUID()
        const record: StoredSubscription = { id, name: input.name.trim(), source: input.url ? 'url' : 'file', ...(input.url ? { host: subscriptionUrl(input.url).hostname } : {}), updatedAt: new Date().toISOString(), nodes, revision }
        await this.options.store.setSecret(`network:subscription:${id}:${revision}`, JSON.stringify({ ...content, ...(input.url ? { url: input.url } : { originalContent }) } satisfies SecretSubscription))
        this.options.store.saveEntity('network-subscription', id, record)
        await this.applyPending(); this.emit(); return this.getState()
      } catch (error) { throw new Error(this.safeError(error)) }
      finally { this.controllers.delete(controller) }
    })
  }
  async refresh(id: string): Promise<NetworkState> {
    return this.serial(async () => {
      await this.ready()
      const record = this.options.store.getEntity<StoredSubscription>('network-subscription', id)
      if (!record) throw new Error('订阅不存在')
      const controller = new AbortController(); this.controllers.add(controller)
      try {
        const old = await this.readSecret(record), fetcher = this.fetchForScope('subscriptions')
        const originalContent = old.url ? await downloadSubscription(fetcher, old.url, controller.signal) : old.originalContent!
        const content = await prepareSubscription(originalContent, fetcher, controller.signal)
        const nodes = await this.inspect(id, content, controller.signal), revision = randomUUID()
        await this.options.store.setSecret(`network:subscription:${id}:${revision}`, JSON.stringify({ ...content, ...(old.url ? { url: old.url } : { originalContent }) } satisfies SecretSubscription))
        this.options.store.saveEntity('network-subscription', id, { ...record, revision, nodes, updatedAt: new Date().toISOString(), error: undefined })
        if (this.active.get(id)?.metadata.revision !== record.revision) await this.options.store.setSecret(`network:subscription:${id}:${record.revision}`, '')
        await this.applyPending(); this.emit(); return this.getState()
      } catch (error) { this.options.store.saveEntity('network-subscription', id, { ...record, error: this.safeError(error) }); this.emit(); throw new Error(this.safeError(error)) }
      finally { this.controllers.delete(controller) }
    })
  }
  async remove(id: string): Promise<NetworkState> {
    return this.serial(async () => {
    await this.ready()
    const record = this.options.store.getEntity<StoredSubscription>('network-subscription', id)
    const inUse = (selection?: NetworkSelection) => selection?.mode === 'subscription' && selection.subscriptionId === id
    if (this.options.store.listProviders().some(provider => inUse(provider.network)) || Object.values(this.options.store.getEntity<NetworkBindings>('network','bindings') ?? {}).some(inUse)) throw new Error('此订阅仍被模型服务或应用网络设置使用，请先更改对应线路')
    this.options.store.deleteEntity('network-subscription', id)
    if (record && this.active.get(id)?.metadata.revision !== record.revision) await this.options.store.setSecret(`network:subscription:${id}:${record.revision}`, '')
    await this.applyPending(); this.emit(); return this.getState()
    })
  }
  async saveBindings(input: NetworkBindings): Promise<NetworkState> {
    await this.ready()
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('网络设置格式错误')
    const bindings: NetworkBindings = {}
    for (const [scope,value] of Object.entries(input)) {
      if (!scopes.has(scope) && !/^mcp:[\w-]{1,100}$/.test(scope)) throw new Error('未知的网络用途')
      const selection = validateNetworkSelection(value)
      this.validateSelection(selection)
      bindings[scope as NetworkScopeName] = selection
    }
    this.options.store.saveEntity('network','bindings',bindings)
    await this.applyPending(); this.emit(); return this.getState()
  }
  validateSelection(selection: NetworkSelection): void {
    if (selection.mode !== 'subscription') return
    const record = this.options.store.getEntity<StoredSubscription>('network-subscription', selection.subscriptionId)
    if (!record?.nodes.some(node => node.id === selection.nodeId)) throw new Error('所选订阅节点不存在，请重新选择固定节点')
  }
  async applyPending(): Promise<void> {
    if (this.applying) return this.applying
    const applying = this.applyChanges()
    this.applying = applying
    try { await applying } finally { if (this.applying === applying) this.applying = undefined }
  }
  private async stopCore(): Promise<void> { await this.core?.stop(); this.core = undefined; this.coreRelease?.(); this.coreRelease = undefined }
  private async applyChanges(): Promise<void> {
    await this.ready()
    if (this.busy() || this.disposed) { this.emit(); return }
    const records = this.options.store.listEntities<StoredSubscription>('network-subscription')
    const changed = records.some(record => this.subscriptionPending(record)) || [...this.active.keys(),...this.unavailable.keys()].some(id => !records.some(record => record.id === id))
    if (changed) {
      const next = new Map<string, ActiveSubscription>()
      for (const record of records) {
        const previous = this.active.get(record.id)
        if (!this.subscriptionPending(record)) { if (previous) next.set(record.id,previous); continue }
        try { next.set(record.id,{metadata:clone(record),secret:await this.readSecret(record)}); this.unavailable.delete(record.id) }
        catch { this.markUnavailable(record); if (previous) next.set(record.id,previous) }
      }
      if (this.busy() || this.disposed) { this.emit(); return }
      // A broken subscription must not interrupt unrelated routes. Keep an already
      // active good snapshot when an update cannot be decrypted.
      if (next.size !== this.active.size || [...next].some(([id,item]) => this.active.get(id)?.metadata.revision !== item.metadata.revision)) {
        await this.stopCore(); this.coreRoutes.clear()
        if (this.coreState.phase !== 'failed') this.coreState.phase = 'stopped'
      }
      const previous = this.active; this.active = next
      for (const id of this.unavailable.keys()) if (!records.some(record => record.id === id)) this.unavailable.delete(id)
      for (const item of previous.values()) if (next.get(item.metadata.id)?.metadata.revision !== item.metadata.revision) await this.options.store.setSecret(`network:subscription:${item.metadata.id}:${item.metadata.revision}`, '')
    }
    this.bindings = clone(this.options.store.getEntity<NetworkBindings>('network','bindings') ?? {})
    this.providers = new Map(this.options.store.listProviders().map(provider => [provider.id, clone(provider.network ?? { mode: 'system' })]))
    this.emit()
  }
  private snapshot(selection: NetworkSelection): NetworkSnapshot {
    if (selection.mode !== 'subscription') return { selection: clone(selection), label: selection.mode === 'direct' ? '直连' : '跟随系统' }
    const record = this.active.get(selection.subscriptionId)?.metadata, node = record?.nodes.find(node => node.id === selection.nodeId)
    if (!record && this.unavailable.has(selection.subscriptionId)) throw new Error('所选订阅凭据无法解密，请重新导入；没有自动改为直连')
    if (!node || !record) throw new Error('所选订阅节点已失效；请手动选择新的固定节点')
    return { selection: clone(selection), label: `${record.name} / ${node.name}`, subscriptionName: record.name, nodeName: node.name, coreVersion: MIHOMO_VERSION, subscriptionRevision: record.revision }
  }
  private async route(selection: NetworkSelection, signal?: AbortSignal): Promise<PreparedNetworkRoute> {
    signal?.throwIfAborted(); if (this.disposed) throw new Error('网络管理器已关闭')
    const key = selectionKey(selection), snapshot = this.snapshot(selection)
    if (selection.mode !== 'subscription') return { key, mode: selection.mode, snapshot }
    await this.ensureCore([selection], signal)
    const proxyUrl = this.core?.routes.get(key)
    if (!proxyUrl) throw new Error('所选节点线路尚未就绪')
    return { key: `${key}:${proxyUrl}`, mode: selection.mode, proxyUrl, snapshot }
  }
  private async ensureCore(selections: NetworkSelection[], signal?: AbortSignal): Promise<void> {
    const requested = selections.filter((value): value is Extract<NetworkSelection,{mode:'subscription'}> => value.mode === 'subscription')
    if (!requested.length) return
    if (this.starting) { await this.starting; return this.ensureCore(selections, signal) }
    if (this.coreState.phase === 'failed') throw new Error('网络内核已停止，请点击“重新启动”；不会自动直连或重放请求')
    for (const selection of requested) this.snapshot(selection)
    // Prepare all currently configured routes together: a later search/MCP call must not
    // need to restart the core while a model is already streaming on another route.
    const configured = [...this.providers.values(), ...Object.values(this.bindings)].filter((value): value is Extract<NetworkSelection,{mode:'subscription'}> => value?.mode === 'subscription' && !!this.active.get(value.subscriptionId)?.metadata.nodes.some(node => node.id === value.nodeId))
    const all = [...new Map([...requested,...configured].map(selection => [selectionKey(selection),selection])).values()]
    const missing = all.filter(selection => !this.core?.routes.has(selectionKey(selection)))
    if (this.core && !missing.length) return
    if (this.core && this.leases) throw new Error('新线路将在当前任务结束后启用；请等待任务结束后重试')
    for (const selection of missing) {
      const node = this.active.get(selection.subscriptionId)?.metadata.nodes.find(node => node.id === selection.nodeId)
      if (!node) throw new Error('所选节点不存在，请重新选择')
      const key = selectionKey(selection); this.coreRoutes.set(key, { key, subscriptionId: selection.subscriptionId, node })
    }
    this.starting = (async () => {
      this.coreState = { phase: 'starting', version: MIHOMO_VERSION }; this.emit()
      await this.stopCore()
      let core: MihomoProcess | undefined
      try {
      const component = await this.options.runtime.ensure('mihomo', signal)
      this.coreRelease = this.options.runtime.acquire?.('mihomo')
      core = new MihomoProcess(component.executable, join(this.options.stateDir,'network','runtime'), () => {
        if (this.core === core && !this.disposed) { this.coreState = { phase: 'failed', version: MIHOMO_VERSION, error: '网络内核意外退出；受影响的请求已失败，请手动重新启动' }; this.emit() }
      })
      this.core = core
      await core.start(this.resources(), [...this.coreRoutes.values()], signal); this.coreState = { phase: 'running', version: MIHOMO_VERSION }; this.emit()
      } catch (error) { await this.stopCore(); this.coreState = signal?.aborted ? { phase: 'stopped', version: MIHOMO_VERSION } : { phase: 'failed', version: MIHOMO_VERSION, error: this.safeError(error) }; this.emit(); throw error }
    })()
    try { await this.starting } finally { this.starting = undefined }
  }
  private async environment(route: PreparedNetworkRoute, targetUrl?: string): Promise<Record<string,string>> {
    if (route.mode !== 'system') return proxyEnvironment(route.proxyUrl)
    const targets = targetUrl ? [targetUrl] : ['https://registry.npmjs.org','https://pypi.org','https://github.com']
    const settings = await Promise.all(targets.map(target => this.options.transport.resolveSystemProxy(target)))
    if (new Set(settings).size > 1) throw new Error('系统按地址分流，无法为整个命令行进程准确继承；请为此用途选择直连或固定节点')
    return proxyEnvironment(systemProxyUrl(settings[0]))
  }
  async acquireForProviders(ids: string[], signal?: AbortSignal): Promise<NetworkLease> {
    await this.ready(); await this.applying; if (!this.busy()) await this.applyPending(); signal?.throwIfAborted()
    this.preparing++
    try {
    const selected = new Map<string,NetworkSelection>(ids.map(id => {
      if (!this.options.store.getProvider(id)) throw new Error('模型服务不存在')
      return [id, clone(this.providers.get(id) ?? this.options.store.getProvider(id)?.network ?? { mode:'system' } as NetworkSelection)] as const
    }))
    await this.ensureCore([...selected.values()], signal)
    const routes = new Map<string, PreparedNetworkRoute>()
    for (const [id,selection] of selected) routes.set(id, await this.route(selection, signal))
    this.leases++; let released = false
    const get = (id: string) => { if (released) throw new Error('网络线路快照已释放'); const route = routes.get(id); if (!route) throw new Error('此服务不在任务网络快照中'); return route }
    return {
      snapshots: Object.fromEntries([...routes].map(([id,route]) => [id,clone(route.snapshot)])),
      fetchForProvider: id => this.options.transport.fetch(get(id)),
      environmentForProvider: (id,target) => this.environment(get(id),target),
      release: () => { if (!released) { released = true; this.leases--; void this.applyPending().catch(() => {}) } },
    }
    } finally { this.preparing-- }
  }
  async acquireForScope(scope: NetworkScopeName, signal?: AbortSignal): Promise<NetworkScopeLease> {
    await this.ready(); await this.applying; if (!this.busy()) await this.applyPending()
    this.preparing++
    try {
    const route = await this.route(clone(this.bindings[scope] ?? { mode:'system' }), signal)
    this.leases++; let released = false
    return { fetch: this.options.transport.fetch(route), snapshot: clone(route.snapshot), environment: target => { if (released) throw new Error('网络线路快照已释放'); return this.environment(route,target) }, release: () => { if (!released) { released = true; this.leases--; void this.applyPending().catch(() => {}) } } }
    } finally { this.preparing-- }
  }
  fetchForProvider(id: string): typeof fetch { return async (input,init) => { const lease = await this.acquireForProviders([id], requestSignal(input,init)); return this.leasedFetch(lease.fetchForProvider(id),lease.release,input,init) } }
  fetchForScope(scope: NetworkScopeName): typeof fetch { return async (input,init) => { const lease = await this.acquireForScope(scope,requestSignal(input,init)); return this.leasedFetch(lease.fetch,lease.release,input,init) } }
  private async leasedFetch(fetcher: typeof fetch, release: () => void, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    try {
      const response = await fetcher(input,init)
      if (!response.body) { release(); return response }
      const reader = response.body.getReader(), signal = requestSignal(input,init)
      let settled = false, output: ReadableStreamDefaultController<Uint8Array>
      const finish = () => { if (!settled) { settled = true; signal?.removeEventListener('abort',abort); release() } }
      // A consumer may stop reading after the first chunk. Cancellation must still
      // end the lease, rather than waiting indefinitely for another pull.
      const abort = () => {
        if (settled) return
        output.error(signal?.reason ?? new Error('网络请求已取消'))
        void reader.cancel(signal?.reason).catch(() => {})
        finish()
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) { output = controller },
        async pull(controller) {
          try {
            const item = await reader.read()
            if (settled) return
            if (item.done) { finish(); controller.close() } else controller.enqueue(item.value)
          } catch (error) { if (!settled) { finish(); controller.error(error) } }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { finish() } },
      })
      signal?.addEventListener('abort',abort,{once:true})
      if (signal?.aborted) abort()
      const wrapped = new Response(body,{ status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperties(wrapped, { url: { value: response.url }, redirected: { value: response.redirected } })
      return wrapped
    } catch (error) { release(); throw error }
  }
  async prepareScope(scope: NetworkScopeName): Promise<PreparedNetworkRoute> { await this.ready(); await this.applying; if (!this.busy()) await this.applyPending(); this.preparing++; try { return await this.route(this.bindings[scope] ?? { mode:'system' }) } finally { this.preparing-- } }
  async environmentForProvider(id: string, targetUrl?: string): Promise<Record<string,string>> { const lease = await this.acquireForProviders([id]); try { return await lease.environmentForProvider(id,targetUrl) } finally { lease.release() } }
  async environmentForScope(scope: NetworkScopeName, targetUrl?: string): Promise<Record<string,string>> { const lease = await this.acquireForScope(scope); try { return await lease.environment(targetUrl) } finally { lease.release() } }
  async testNodes(nodes: NetworkNodeRef[]): Promise<NetworkTestJob> {
    await this.ready(); await this.applying
    if (!this.busy()) await this.applyPending()
    if (this.disposed) throw new Error('网络管理器已关闭')
    if (this.nodeTests?.job.status === 'running') throw new Error('已有节点检测正在进行，请等待或取消')
    const selected = [...new Map(nodes.map(node => [`${node.subscriptionId}:${node.nodeId}`, node])).values()]
    if (!selected.length || selected.length > 5000) throw new Error('请选择 1 至 5000 个节点')
    for (const node of selected) this.snapshot({ mode: 'subscription', ...node })
    const controller = new AbortController()
    const job: NetworkTestJob = { id: randomUUID(), status: 'running', items: selected.map(node => ({ ...node, status: 'waiting' })) }
    this.preparing++; this.controllers.add(controller)
    const done = Promise.resolve().then(() => runNodeTests(job, controller.signal, (node, signal) => this.testNode(node, signal), () => this.emit())).finally(() => {
      this.preparing--; this.controllers.delete(controller); void this.applyPending().catch(() => {})
    })
    this.nodeTests = { job, controller, done }; this.emit()
    return clone(job)
  }
  cancelTests(id: string): void {
    if (this.nodeTests?.job.id !== id) throw new Error('节点检测任务不存在')
    this.nodeTests.controller.abort(new Error('节点检测已取消'))
  }
  async testNode(input: NetworkNodeRef, signal?: AbortSignal): Promise<NetworkNode> {
    await this.ready(); await this.applying; if (!this.busy()) await this.applyPending()
    signal?.throwIfAborted()
    this.preparing++
    try {
      const record = this.active.get(input.subscriptionId)?.metadata, node = record?.nodes.find(node => node.id === input.nodeId)
      if (!node) throw new Error('节点尚未启用或已移除，请等待当前任务结束')
      if (this.coreState.phase === 'failed') throw new Error('网络内核已退出，请手动重新启动')
      if (this.starting) await this.starting
      else if (!this.core) await this.ensureCore([{ mode:'subscription',subscriptionId: input.subscriptionId, nodeId: input.nodeId }], signal)
      signal?.throwIfAborted()
      // Health checks use the provider API; no listener or model route is switched.
      try {
        const delayMs = await this.core!.testNode(input.subscriptionId,node,signal)
        signal?.throwIfAborted()
        node.delayMs = delayMs; node.testedAt = new Date().toISOString(); delete node.error
      } catch { signal?.throwIfAborted(); node.error = '节点延迟测试失败；没有自动换节点或直连'; delete node.delayMs; node.testedAt = new Date().toISOString() }
      const stored = this.options.store.getEntity<StoredSubscription>('network-subscription', input.subscriptionId)
      if (stored && stored.revision === record!.revision) this.options.store.saveEntity('network-subscription', stored.id, { ...stored, nodes: stored.nodes.map(item => item.id === node.id ? node : item) })
      this.emit(); return publicNode(node)
    } finally { this.preparing-- }
  }
  async restart(): Promise<NetworkState> {
    await this.ready(); await this.applying
    const restart = this.restartCore()
    this.applying = restart
    try { await restart; return this.getState() } finally { if (this.applying === restart) this.applying = undefined }
  }
  private async restartCore(): Promise<void> {
    if (this.busy()) throw new Error('请先结束正在运行的任务，再重新启动网络内核')
    await this.stopCore(); this.coreState = { phase:'stopped', version:MIHOMO_VERSION }
    await this.applyChanges()
    const selections = [...this.providers.values(), ...Object.values(this.bindings)].filter((value): value is NetworkSelection => !!value)
    await this.ensureCore(selections); this.emit()
  }
  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : ''
    if (/^(订阅|网络|节点|所选|需要 |只支持 |同一|合并|此系统|此订阅|系统|请|无法|新线路)/.test(message) && !/https?:\/\/|:\/\/|AGE-SECRET/.test(message)) return message.slice(0,300)
    return '网络操作失败，请检查订阅内容、网络线路和内核状态；敏感原始响应未写入日志'
  }
  async shutdown(): Promise<void> {
    this.disposed = true; clearInterval(this.poll)
    for (const controller of this.controllers) controller.abort()
    await this.nodeTests?.done.catch(() => {})
    await this.mutation.catch(() => {}); await this.applying?.catch(() => {}); await this.starting?.catch(() => {}); await this.stopCore(); await this.options.transport.close?.()
  }
}
