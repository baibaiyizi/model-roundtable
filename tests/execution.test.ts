import { describe, it, expect, vi } from 'vitest'
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, unlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { RequestGate } from '../src/main/execution/gate'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DocumentsMcp } from '../src/main/execution/documents-mcp'
import { DirectoryLocks } from '../src/main/execution/locks'
import { captureDirectory, compareSnapshots } from '../src/main/execution/snapshot'
import { ExecutionManager } from '../src/main/execution/manager'
import type { ExecutionStore } from '../src/main/execution/ports'
import type { Execution, ExecutionInput } from '../src/shared/execution'
import type { Provider } from '../src/shared/types'
import type { GatewayPort } from '../src/shared/ports'
import type { NetworkLease, ProviderNetworkPort } from '../src/shared/network'
import { testComponents } from './helpers/components'

const provider: Provider = { id: 'p', name: '测试', kind: 'api', baseUrl: 'http://127.0.0.1', modelIds: ['test-model'], hasKey: true, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 15000 }
const baseInput: ExecutionInput = { projectId: 'project', task: '创建 proof.txt 并确认完成', acceptance: 'proof.txt 包含真实工具已执行', executor: { providerId: 'p', modelId: 'test-model' }, reviewers: [], maxCalls: 10, maxOutputTokens: 1024, timeoutMs: 60000, maxRepairRounds: 2 }
async function upstream(handler: RequestListener) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/v1`, close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) } }
}
function memory(directory: string, baseUrl = provider.baseUrl): ExecutionStore & { deleteExecution(id: string): void } {
  const executions = new Map<string, Execution>()
  return { getProject: () => ({ id: 'project', name: '项目', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }), getProvider: () => ({ ...provider, baseUrl }), getSecret: async () => 'private-secret', getSession: () => undefined, getExecution: id => structuredClone(executions.get(id)), saveExecution: value => executions.set(value.id, structuredClone(value)), listExecutions: () => structuredClone([...executions.values()]), deleteExecution: id => { executions.delete(id) } }
}
const gateway: GatewayPort = { chat: async () => ({ text: '{"verdict":"pass","findings":"验收通过"}' }), embed: async () => [], transcribe: async () => '' }
async function waitDone(store: ExecutionStore, id: string) {
  for (let i = 0; i < 1000; i++) { const value = store.getExecution(id)!; if (!['running', 'reviewing', 'stopping'].includes(value.status)) return value; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error('执行未结束')
}
describe('执行边界', () => {
  it('项目搜索绑定变化不改变已捕获执行scope的来源与线路快照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-binding-')), state = await mkdtemp(join(tmpdir(), 'web-binding-state-')), store = memory(root)
    let binding = 'selected'
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', extensionTools: async () => {
      const captured = binding; binding = 'changed'
      return { tools: [], call: async () => ({}), close: async () => {}, searchSource: `MCP-${captured}`, searchExtensionId: captured, search: async () => [{ id: captured, title: captured, text: '工具证据', kind: 'tool', locator: captured, retrievedAt: '' }] }
    }, webTools: async (_execution, _signal, tools) => {
      expect(binding).toBe('changed'); expect(tools?.searchExtensionId).toBe('selected')
      return { source: tools!.searchSource!, snapshots: { search: { selection: { mode: 'direct' }, label: tools!.searchExtensionId! } }, search: async () => { throw new Error('不应退回默认来源') }, read: async () => [], close: async () => {} }
    }, backendFactory: (_execution, mcp) => ({ run: async () => {
      const client = new Client({ name: 'binding-probe', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${mcp!.token}` } } }))
      try { await client.callTool({ name: 'web_search', arguments: { query: '固定查询' } }) } finally { await client.close() }
      return '完成'
    } }) }, () => {})
    const task = manager.create({ ...baseInput, web: { enabled: true, maxSearches: null } }); await manager.start(task.id); await vi.waitFor(() => expect(manager.isActive(task.id)).toBe(false))
    const result = store.getExecution(task.id)!
    expect(result.status).toBe('complete'); expect(result.toolEvidence?.[0]).toMatchObject({ id: 'selected', searchSource: 'MCP-selected', network: { label: 'selected' } })
    expect(result.webSnapshots?.[0]).toMatchObject({ source: 'MCP-selected', search: { label: 'selected' } })
  })
  it('旧任务和明确关闭联网的任务不创建应用搜索工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-disabled-')), state = await mkdtemp(join(tmpdir(), 'web-disabled-state-')), store = memory(root)
    const webTools = vi.fn(async () => { throw new Error('不应创建联网scope') })
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', webTools, backendFactory: (_execution, mcp) => ({ run: async () => { expect(mcp).toBeUndefined(); return '离线完成' } }) }, () => {})
    for (const input of [baseInput, { ...baseInput, web: { enabled: false, maxSearches: null } }]) {
      const task = manager.create(input); await manager.start(task.id); await vi.waitFor(() => expect(manager.isActive(task.id)).toBe(false)); expect(store.getExecution(task.id)?.status).toBe('complete')
    }
    expect(webTools).not.toHaveBeenCalled()
  })
  it('搜索失败保留明确重试入口，只有用户重试才再次调用来源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-failure-')), state = await mkdtemp(join(tmpdir(), 'web-failure-state-')), store = memory(root)
    let fail = true
    const search = vi.fn(async () => { if (fail) throw new Error('网络暂不可用'); return [] }), close = vi.fn(async () => {})
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', webTools: async () => ({ source: '受控来源', search, read: async () => [], close }), backendFactory: (_execution, mcp) => ({ run: async () => {
      const client = new Client({ name: 'failure-probe', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${mcp!.token}` } } }))
      try { await client.callTool({ name: 'web_search', arguments: { query: '搜索请求' } }) } finally { await client.close() }
      return '执行者如实报告了搜索情况。'
    } }) }, () => {})
    const task = manager.create({ ...baseInput, web: { enabled: true, maxSearches: null } }); await manager.start(task.id)
    await vi.waitFor(() => expect(manager.isActive(task.id)).toBe(false))
    expect(store.getExecution(task.id)?.status).toBe('needs_attention'); expect(store.getExecution(task.id)?.error).toContain('明确重试'); expect(search).toHaveBeenCalledOnce()
    fail = false; await manager.retry(task.id); await vi.waitFor(() => expect(manager.isActive(task.id)).toBe(false))
    expect(store.getExecution(task.id)?.status).toBe('complete'); expect(store.getExecution(task.id)?.searches).toBe(2); expect(search).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledTimes(2)
  })
  it('阻止父子目录并发，并在释放后允许重新获取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'locks-')); await mkdir(join(root, 'child'))
    const locks = new DirectoryLocks(); const release = await locks.acquire(root, 'a')
    await expect(locks.acquire(join(root, 'child'), 'b')).rejects.toThrow('父子目录')
    release(); (await locks.acquire(join(root, 'child'), 'b'))()
  })
  it('非 Git 项目保留新增、删除、文本及二进制变更', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapshot-')); await writeFile(join(root, '原文.txt'), '旧文'); await writeFile(join(root, '删除.txt'), '删除'); await writeFile(join(root, '.env'), 'TOKEN=private-project-secret')
    const before = await captureDirectory(root); await writeFile(join(root, '原文.txt'), '新文'); await writeFile(join(root, '图片.bin'), Buffer.from([0, 1, 2]))
    await unlink(join(root, '删除.txt'))
    const changes = compareSnapshots(before, await captureDirectory(root))
    expect(changes.find(item => item.path === '原文.txt')?.diff).toContain('+新文')
    expect(changes.find(item => item.path === '图片.bin')?.binary).toBe(true)
    expect(changes.find(item => item.path === '删除.txt')?.kind).toBe('deleted')
    expect(before.files['.env'].text).toBeUndefined(); expect(JSON.stringify(before)).not.toContain('private-project-secret')
  })
  it('首个上游错误之后 OpenCode 的重试只能被本机拒绝', async () => {
    let requests = 0, calls = 0, failures = 0
    const api = await upstream((_req, res) => { requests++; res.writeHead(429); res.end('rate limited') })
    const gate = new RequestGate({ provider: { ...provider, baseUrl: api.url }, apiKey: 'secret', modelId: 'test-model', maxOutputTokens: 100, signal: new AbortController().signal, reserve: () => { calls++ }, fail: () => { failures++ } })
    try {
      await gate.start()
      const invoke = () => fetch(`${gate.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gate.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', messages: [], stream: false }) })
      expect((await invoke()).status).toBe(502); expect((await invoke()).status).toBe(403)
      expect(requests).toBe(1); expect(calls).toBe(1); expect(failures).toBe(1)
    } finally { await gate.close(); await api.close() }
  })
  it('初审后最多两轮修复；审阅依据包含真实改动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-')); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    let runs = 0, reviews = 0
    const release = vi.fn(), lease: NetworkLease = { snapshots: { p: { selection: { mode: 'direct' }, label: '执行与审阅固定线路' } }, fetchForProvider: () => fetch, environmentForProvider: async () => ({}), release }
    const network = { acquireForProviders: vi.fn(async () => lease) } as unknown as ProviderNetworkPort
    const manager = new ExecutionManager(store, { ...gateway, chat: async request => { reviews++; expect(request.network).toBe(lease); expect(release).not.toHaveBeenCalled(); expect(request.prompt).toContain('proof.txt'); return { text: '{"verdict":"changes_requested","findings":"仍需修复验收问题"}' } } }, { stateDir: state, runtimeDir: '', network, backendFactory: () => ({ run: async context => { expect(context.network).toBe(lease); expect(release).not.toHaveBeenCalled(); context.reserveCall(); runs++; await writeFile(join(root, 'proof.txt'), String(runs)); return '已写文件' } }) }, () => {})
    const task = manager.create({ ...baseInput, reviewers: [{ providerId: 'p', modelId: 'review' }] }); await manager.start(task.id)
    const result = await waitDone(store, task.id)
    expect(result.status).toBe('needs_attention'); expect(runs).toBe(3); expect(reviews).toBe(3); expect(result.calls).toBe(6)
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(network.acquireForProviders).toHaveBeenCalledOnce()
    expect(result.networkSnapshots).toMatchObject([{ attempt: 1, providers: { p: { label: '执行与审阅固定线路' } } }])
  })
  it('线路准备期间停止会释放迟到lease，不启动执行或留下付费调用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-network-')), state = await mkdtemp(join(tmpdir(), 'network-state-')), store = memory(root)
    let finish!: (lease: NetworkLease) => void, runs = 0
    const release = vi.fn(), lease: NetworkLease = { snapshots: {}, fetchForProvider: () => fetch, environmentForProvider: async () => ({}), release }
    const network = { acquireForProviders: vi.fn(() => new Promise<NetworkLease>(resolve => { finish = resolve })) } as unknown as ProviderNetworkPort
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', network, backendFactory: () => ({ run: async () => { runs++; return '不应执行' } }) }, () => {})
    const task = manager.create(baseInput), starting = manager.start(task.id).catch(error => error)
    await vi.waitFor(() => expect(network.acquireForProviders).toHaveBeenCalledOnce())
    const stopped = manager.stop(task.id); finish(lease)
    expect(await starting).toBeInstanceOf(Error)
    expect((await stopped).status).toBe('stopped'); expect(release).toHaveBeenCalledOnce()
    expect(runs).toBe(0); expect(store.getExecution(task.id)?.calls).toBe(0)
    expect(store.getExecution(task.id)?.networkSnapshots).toBeUndefined()
    expect(manager.isActive(task.id)).toBe(false)
  })
  it('并发请求不会突破预算，也不会把本机拒绝计为上游请求', async () => {
    let calls = 0, requests = 0
    const api = await upstream((_req, res) => { requests++; res.setHeader('content-type', 'application/json'); res.end('{"choices":[{"message":{"content":"ok"}}]}') })
    const gate = new RequestGate({ provider: { ...provider, baseUrl: api.url }, apiKey: 'secret', modelId: 'test-model', maxOutputTokens: 100, signal: new AbortController().signal, reserve: () => { if (calls >= 2) throw new Error('预算已用尽'); calls++ }, fail: () => {} })
    try {
      await gate.start()
      await Promise.all(Array.from({ length: 8 }, () => fetch(`${gate.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gate.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', messages: [], stream: false }) }).catch(() => null)))
      expect(calls).toBe(2); expect(requests).toBeLessThanOrEqual(2)
    } finally { await gate.close(); await api.close() }
  })
  it('不完整SSE关闭该运行，迟到重试不发往上游', async () => {
    let requests = 0, reason = ''
    const api = await upstream((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n') })
    const gate = new RequestGate({ provider: { ...provider, baseUrl: api.url }, apiKey: 'secret', modelId: 'test-model', maxOutputTokens: 100, signal: new AbortController().signal, reserve: () => {}, fail: error => { reason = error.message } })
    try {
      await gate.start()
      const request = () => fetch(`${gate.url}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gate.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test-model', messages: [], stream: true }) })
      await request().then(response => response.text()).catch(() => {})
      expect(reason).toContain('提前结束'); expect((await request()).status).toBe(403); expect(requests).toBe(1)
    } finally { await gate.close(); await api.close() }
  })
  it('审阅格式错误留下失败记录，保留已有改动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-failure-')); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    const manager = new ExecutionManager(store, { ...gateway, chat: async () => ({ text: '不是有效 JSON' }) }, { stateDir: state, runtimeDir: '', backendFactory: () => ({ run: async () => { await writeFile(join(root, 'proof.txt'), 'changed'); return '已写入' } }) }, () => {})
    const task = manager.create({ ...baseInput, reviewers: [baseInput.executor] }); await manager.start(task.id)
    const result = await waitDone(store, task.id)
    expect(result.status).toBe('failed'); expect(result.reviews[0].verdict).toBe('failed'); expect(result.changes[0].path).toBe('proof.txt')
  })
  it('停止后迟到的后台结果不会恢复执行，目录锁在核对后释放', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stop-late-')); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    let entered = false, release: (() => void) | undefined
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', backendFactory: () => ({ run: async context => {
      entered = true; context.event({ kind: 'tool', toolId: 'ongoing', tool: 'write', state: 'running', text: 'writing' })
      await new Promise<void>(done => { release = done }); context.event({ kind: 'text', text: 'stale result' }); return 'stale'
    } }) }, () => {})
    const task = manager.create(baseInput); await manager.start(task.id)
    while (!entered) await new Promise(resolve => setTimeout(resolve, 10))
    const stopped = manager.stop(task.id); release!(); const result = await stopped
    expect(result.status).toBe('stopped'); expect(result.events.some(event => event.text === 'stale result')).toBe(false)
    expect(result.result).toBeUndefined()
    expect(result.events.find(event => event.toolId === 'ongoing')?.state).toBe('failed')
  })
  it.each(['stop', 'remove', 'shutdown'] as const)('启动后立即 %s 不启动后台，删除不会复活任务', async action => {
    const root = await mkdtemp(join(tmpdir(), 'pending-stop-')); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    let runs = 0
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', backendFactory: () => ({ run: async () => { runs++; return '完成' } }) }, () => {})
    const task = manager.create(baseInput)
    const starting = manager.start(task.id).then(() => null, error => error as Error)
    expect(manager.isActive(task.id)).toBe(true)
    if (action === 'stop') expect((await manager.stop(task.id)).status).toBe('stopped')
    if (action === 'remove') { await expect(manager.remove(task.id)).rejects.toThrow('请先停止'); await manager.stop(task.id); await manager.remove(task.id); store.deleteExecution(task.id) }
    if (action === 'shutdown') await manager.shutdown()
    expect(await starting).toBeInstanceOf(Error)
    expect(manager.isActive(task.id)).toBe(false)
    expect(runs).toBe(0)
    if (action === 'remove') expect(store.getExecution(task.id)).toBeUndefined()
    else expect(store.getExecution(task.id)?.attempt).toBe(0)
    if (action === 'shutdown') await expect(manager.start(manager.create(baseInput).id)).rejects.toThrow('正在退出')
    else {
      const next = manager.create(baseInput); await manager.start(next.id)
      expect((await waitDone(store, next.id)).status).toBe('complete'); expect(runs).toBe(1)
      await manager.shutdown()
    }
  })
  it('获取写锁期间停止会等待启动退出并释放刚取得的锁', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pending-lock-')); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    let allowLock!: () => void, lockAcquired!: () => void, runs = 0
    const acquired = new Promise<void>(resolve => { lockAcquired = resolve })
    const delayed = new Promise<void>(resolve => { allowLock = resolve })
    const acquire = DirectoryLocks.prototype.acquire
    const spy = vi.spyOn(DirectoryLocks.prototype, 'acquire').mockImplementationOnce(async function (this: DirectoryLocks, directory, owner) {
      const release = await acquire.call(this, directory, owner); lockAcquired(); await delayed; return release
    })
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', backendFactory: () => ({ run: async () => { runs++; return '完成' } }) }, () => {})
    try {
      const task = manager.create(baseInput); const starting = manager.start(task.id).then(() => null, error => error as Error)
      await acquired
      let stopReturned = false
      const stopping = manager.stop(task.id).then(result => { stopReturned = true; return result })
      await Promise.resolve(); expect(stopReturned).toBe(false)
      allowLock(); expect((await stopping).status).toBe('stopped'); expect(await starting).toBeInstanceOf(Error); expect(runs).toBe(0)
      await manager.retry(task.id); expect((await waitDone(store, task.id)).status).toBe('complete'); expect(runs).toBe(1)
    } finally { allowLock(); spy.mockRestore(); await manager.shutdown() }
  })
  it('启动目录检查失败不留下待启动任务，同一任务修正目录后可启动', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'pending-failure-')), 'missing'); const state = await mkdtemp(join(tmpdir(), 'execution-state-')); const store = memory(root)
    const manager = new ExecutionManager(store, gateway, { stateDir: state, runtimeDir: '', backendFactory: () => ({ run: async () => '完成' }) }, () => {})
    const task = manager.create(baseInput)
    await expect(manager.start(task.id)).rejects.toThrow(); expect(store.getExecution(task.id)?.status).toBe('ready')
    await mkdir(root); await manager.start(task.id); expect((await waitDone(store, task.id)).status).toBe('complete')
    await manager.shutdown()
  })
  it('标准MCP只执行注册文档工具并绑定当前项目目录', async () => {
    const controller = new AbortController(); let actualDirectory = ''
    const bridge = new DocumentsMcp({ tools: [{ name: 'document_inspect', description: '查看', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], call: async (directory, name, args) => { actualDirectory = directory; return { name, args } } }, 'C:\\project', controller.signal)
    const client = new Client({ name: 'test', version: '1' })
    try {
      await bridge.start(); await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }))
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['document_inspect'])
      const result = await client.callTool({ name: 'document_inspect', arguments: { path: '文档.docx' } })
      expect(result.isError).not.toBe(true); expect(actualDirectory).toBe('C:\\project')
    } finally { await client.close(); await bridge.close() }
  })
})
describe.skipIf(process.platform !== 'win32')('真实 OpenCode 与本机可控模型', () => {
  it('模型工具调用真正写入中文路径的文件，记录差异和最终报告', async () => {
    // The manager passes the canonical directory to the model. Match it in this
    // scripted reply too: Windows CI's temp directory can contain an 8.3 alias.
    const root = await realpath(await mkdtemp(join(tmpdir(), '圆桌 执行-'))); const state = await mkdtemp(join(tmpdir(), 'opencode-state-'))
    const ambient = await mkdtemp(join(tmpdir(), 'ambient-opencode-'))
    await mkdir(join(ambient, '.opencode'))
    await writeFile(join(ambient, '.opencode', 'opencode.json'), JSON.stringify({ mcp: { forbidden_ambient: { type: 'local', command: ['nonexistent-executable'], enabled: true } } }))
    const originalProfile = process.env.USERPROFILE; process.env.USERPROFILE = ambient
    let calls = 0, toolRequested = false, documentRequested = false, searchRequested = false, readRequested = false
    const api = await upstream(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk.toString()
      const body = JSON.parse(raw); calls++
      expect(body.model).toBe('test-model'); expect(req.headers.authorization).toBe('Bearer private-secret'); expect(req.url).toBe('/v1/chat/completions')
      const tool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name === 'write')
      const documentTool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name.endsWith('document_create'))
      const searchTool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name.endsWith('web_search'))
      const readTool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name.endsWith('web_read'))
      expect(body.tools?.some((item: { function?: { name: string } }) => ['websearch', 'webfetch'].includes(item.function?.name ?? ''))).not.toBe(true)
      const writeNow = !!tool && !toolRequested
      const documentNow = !writeNow && !!documentTool && !documentRequested
      const searchNow = !writeNow && !documentNow && !!searchTool && !searchRequested
      const readNow = !writeNow && !documentNow && !searchNow && !!readTool && !readRequested
      const wantsTool = writeNow || documentNow || searchNow || readNow
      if (writeNow) toolRequested = true
      if (documentNow) documentRequested = true
      if (searchNow) searchRequested = true
      if (readNow) readRequested = true
      const selectedTool = writeNow ? 'write' : documentNow ? documentTool?.function.name : searchNow ? searchTool?.function.name : readTool?.function.name
      const argumentsValue = writeNow ? { filePath: join(root, 'proof.txt'), content: '真实工具已执行' } : documentNow ? { path: '文档工具.md', text: '文档工具已执行' } : searchNow ? { query: '联网验证' } : { url: 'https://example.org' }
      const delta = wantsTool ? { tool_calls: [{ index: 0, id: `call_${calls}`, type: 'function', function: { name: selectedTool, arguments: JSON.stringify(argumentsValue) } }] } : { content: '已完成，proof.txt 包含真实工具已执行。' }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'answer', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ id: 'answer', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: wantsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'answer', choices: [{ message: { role: 'assistant', content: '任务已完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })) }
    })
    const store = memory(root, api.url)
    const manager = new ExecutionManager(store, gateway, { runtimeDir: resolve('resources/agents'), stateDir: state, components: testComponents, webTools: async () => ({ source: '受控免Key搜索', search: async () => [{ id: 'search-proof', title: '搜索证据', text: '搜索成功', kind: 'web', url: 'https://example.org', locator: 'https://example.org', retrievedAt: '' }], read: async () => [{ id: 'read-proof', title: '网页证据', text: '读取成功', kind: 'web', url: 'https://example.org', locator: 'https://example.org', retrievedAt: '' }], close: async () => {} }), documentTools: { tools: [{ name: 'document_create', description: '创建文档', inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } }], call: async (directory, _name, args) => { const input = args as { path: string; text: string }; expect(directory).toBe(root); await writeFile(join(directory, input.path), input.text); return { status: 'complete' } } } }, () => {})
    try {
      const task = manager.create({ ...baseInput, web: { enabled: true, maxSearches: null } }); await manager.start(task.id)
      const result = await waitDone(store, task.id)
      expect(result.error ?? result.status).toBe('complete')
      expect(result.events.filter(event => event.kind === 'tool' && event.state === 'failed')).toEqual([])
      expect(await readFile(join(root, 'proof.txt'), 'utf8')).toBe('真实工具已执行')
      expect(await readFile(join(root, '文档工具.md'), 'utf8')).toBe('文档工具已执行')
      expect(documentRequested).toBe(true)
      expect(searchRequested).toBe(true); expect(readRequested).toBe(true); expect(result.searches).toBe(1); expect(result.toolEvidence).toHaveLength(2)
      expect(result.changes.some(change => change.path === 'proof.txt')).toBe(true)
      expect(result.events.some(event => event.kind === 'tool' && event.state === 'complete')).toBe(true)
      expect(result.calls).toBe(calls); expect(calls).toBeGreaterThanOrEqual(2)
    } finally { if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile; await manager.shutdown(); await api.close() }
  }, 90000)
  it('真实后台收到429后停止且不会自动付费重试', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencode-fail-')); const state = await mkdtemp(join(tmpdir(), 'opencode-state-')); let calls = 0
    const api = await upstream((_req, res) => { calls++; res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limit"}}') })
    const store = memory(root, api.url); const manager = new ExecutionManager(store, gateway, { runtimeDir: resolve('resources/agents'), stateDir: state, components: testComponents }, () => {})
    try {
      const task = manager.create(baseInput); await manager.start(task.id); const result = await waitDone(store, task.id)
      expect(result.status).toBe('failed'); expect(result.error).toContain('429'); expect(calls).toBe(1); expect(result.calls).toBe(1)
    } finally { await manager.shutdown(); await api.close() }
  }, 60000)
})
