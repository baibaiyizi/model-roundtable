import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { executionWebTools } from '../src/main/execution/web-tools'
import { ExecutionManager } from '../src/main/execution/manager'
import { SearchService } from '../src/main/search'
import type { Execution, ExecutionEvent, ExecutionInput } from '../src/shared/execution'
import type { Evidence } from '../src/shared/types'
import type { GatewayPort, WebEvidenceScope } from '../src/shared/ports'
import type { ExecutionStore } from '../src/main/execution/ports'

const item = (query = '资料'): Evidence => ({ id: query, title: query, text: `真实证据:${query}`, locator: 'https://example.org/page', url: 'https://example.org/page', kind: 'web', retrievedAt: new Date().toISOString() })
function fixture(maxSearches: number | null = null) {
  const execution = { web: { enabled: true, maxSearches }, searches: 0 } as Execution
  const signal = new AbortController(), events: Array<Omit<ExecutionEvent, 'id' | 'at'>> = [], evidence: Evidence[] = []
  const scope: WebEvidenceScope = { source: '冻结搜索', snapshots: { search: { selection: { mode: 'direct' }, label: '搜索线路' }, web: { selection: { mode: 'direct' }, label: '网页线路' } }, search: vi.fn(async query => [item(query)]), read: vi.fn(async () => [item('网页')]), close: vi.fn(async () => {}) }
  const hooks = { event: (event: Omit<ExecutionEvent, 'id' | 'at'>) => events.push(event), evidence: (items: Evidence[]) => evidence.push(...items), save: vi.fn() }
  return { execution, signal, events, evidence, scope, hooks, tools: executionWebTools(execution, scope, signal.signal, hooks) }
}
describe('统一执行联网工具', () => {
  it('不限搜索支持第六次调用，记录真实次数及证据和独立网页线路', async () => {
    const f = fixture()
    for (let i = 0; i < 6; i++) await f.tools.call('', 'web_search', { query: `查询${i}` }, f.signal.signal)
    await f.tools.call('', 'web_read', { url: 'https://example.org/page' }, f.signal.signal)
    expect(f.execution.searches).toBe(6); expect(f.evidence).toHaveLength(7)
    expect(f.evidence[0]).toMatchObject({ query: '查询0', searchSource: '冻结搜索', network: { label: '搜索线路' } })
    expect(f.evidence[6].network?.label).toBe('网页线路'); expect(f.events.filter(event => event.state === 'complete')).toHaveLength(7)
  })
  it('并发搜索严格遵守显式上限，未放行的调用不计费或计数', async () => {
    const f = fixture(2)
    const result = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => f.tools.call('', 'web_search', { query: `并发${i}` }, f.signal.signal)))
    expect(result.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    expect(f.scope.search).toHaveBeenCalledTimes(2); expect(f.execution.searches).toBe(2)
  })
  it('禁用联网不调用来源，也不能用非法URL访问本地文件', async () => {
    const f = fixture(); f.execution.web!.enabled = false
    await expect(f.tools.call('', 'web_search', { query: '不应搜索' }, f.signal.signal)).rejects.toThrow('未允许联网')
    expect(f.scope.search).not.toHaveBeenCalled()
    f.execution.web!.enabled = true
    await expect(f.tools.call('', 'web_read', { url: 'file:///C:/private.txt' }, f.signal.signal)).rejects.toThrow()
    expect(f.scope.read).not.toHaveBeenCalled()
  })
  it('已绑定的MCP搜索替代内置来源，保留无URL的工具证据', async () => {
    const f = fixture(), search = vi.fn(async () => [{ ...item(), url: undefined, kind: 'tool' as const }])
    const tools = executionWebTools(f.execution, f.scope, f.signal.signal, { ...f.hooks, search })
    await tools.call('', 'web_search', { query: 'MCP查询' }, f.signal.signal)
    expect(search).toHaveBeenCalledOnce(); expect(f.scope.search).not.toHaveBeenCalled()
    expect(f.evidence[0]).toMatchObject({ kind: 'tool', query: 'MCP查询' }); expect(f.evidence[0].url).toBeUndefined()
  })
  it('失败后记录错误并拒绝模型自动重试，不替换来源', async () => {
    const f = fixture(); f.scope.search = vi.fn(async () => { throw new Error('验证码需要人工验证') })
    await expect(f.tools.call('', 'web_search', { query: '第一次' }, f.signal.signal)).rejects.toThrow('验证码')
    await expect(f.tools.call('', 'web_search', { query: '换个查询' }, f.signal.signal)).rejects.toThrow('用户明确重试')
    await expect(f.tools.call('', 'web_read', { url: 'https://example.org' }, f.signal.signal)).rejects.toThrow('暂停')
    expect(f.scope.search).toHaveBeenCalledOnce(); expect(f.scope.read).not.toHaveBeenCalled(); expect(f.evidence).toEqual([])
    expect(f.events.at(-1)).toMatchObject({ state: 'failed' }); expect(f.execution.searches).toBe(1)
  })
  it('取消后的迟到结果不会写证据或完成事件', async () => {
    const f = fixture(); let resolve!: (items: Evidence[]) => void
    f.scope.search = () => new Promise(done => { resolve = done })
    const call = f.tools.call('', 'web_search', { query: '迟到' }, f.signal.signal)
    f.signal.abort(new Error('取消')); resolve([item('迟到证据')])
    await expect(call).rejects.toThrow('取消'); expect(f.evidence).toEqual([]); expect(f.events.some(event => event.state === 'complete')).toBe(false)
  })
})

describe('搜索正文读取', () => {
  it('搜索和正文使用独立传输，正文保留来源、时间及内容', async () => {
    const searchFetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: '搜索标题', url: 'https://example.org/article', content: '摘要' }] }), { headers: { 'content-type': 'application/json' } }))
    const readFetch = vi.fn(async () => new Response(`<html><title>正文标题</title><article><h1>正文标题</h1><p>${'这是可以核对的原文资料。'.repeat(50)}</p></article></html>`, { headers: { 'content-type': 'text/html;charset=utf-8' } }))
    const service = new SearchService(() => ({ provider: 'searxng', engine: 'bing', searxngUrl: 'https://search.example.org' }), async () => '', { search: async () => [] }, searchFetch, readFetch)
    const result = await service.search('中文资料', new AbortController().signal)
    expect(searchFetch).toHaveBeenCalledOnce(); expect(readFetch).toHaveBeenCalledOnce()
    expect(result[0]).toMatchObject({ url: 'https://example.org/article', contentType: 'body', query: '中文资料' }); expect(result[0].text).toContain('可以核对')
    expect((await service.read('https://example.org/article', new AbortController().signal))[0].title).toBe('正文标题')
  })
})

describe('执行后台共用应用MCP联网通道', () => {
  const input: ExecutionInput = { projectId: 'p', task: '查资料', acceptance: '', executor: { providerId: 'provider', modelId: 'model' }, reviewers: [{ providerId: 'provider', modelId: 'review' }], maxCalls: 20, maxOutputTokens: 1000, timeoutMs: 60000, maxRepairRounds: 0, web: { enabled: true, maxSearches: null } }
  for (const backend of ['api', 'codex', 'claude'] as const) it(`${backend} 经实际MCP协议搜索及读取网页，审阅看到新证据并释放scope`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-mcp-')), values = new Map<string, Execution>(), scope = fixture().scope
    const store: ExecutionStore = { getProject: () => ({ id: 'p', name: '项目', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }), getProvider: () => ({ id: 'provider', name: '服务', kind: backend, baseUrl: '', modelIds: ['model'], hasKey: false, tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 5000 }), getSession: () => undefined, getSecret: async () => '', getExecution: id => structuredClone(values.get(id)), listExecutions: () => [...values.values()], saveExecution: execution => { values.set(execution.id, structuredClone(execution)) } }
    const chat = vi.fn(async (request: { prompt: string }) => { expect(request.prompt).toContain('真实证据:执行查询'); expect(request.prompt).toContain('真实证据:网页'); return { text: '{"verdict":"pass","findings":"证据已保存"}' } })
    const manager = new ExecutionManager(store, { chat, embed: async () => [], transcribe: async () => '' } as GatewayPort, { stateDir: directory, runtimeDir: '', webTools: async () => scope, backendFactory: (_execution, mcp) => ({ async run() {
      expect(mcp).toBeDefined()
      const client = new Client({ name: 'controlled-backend', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp!.url), { requestInit: { headers: { Authorization: `Bearer ${mcp!.token}` } } }))
      try {
        expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['web_search', 'web_read'])
        expect((await client.callTool({ name: 'web_search', arguments: { query: '执行查询' } })).isError).not.toBe(true)
        expect((await client.callTool({ name: 'web_read', arguments: { url: 'https://example.org/page' } })).isError).not.toBe(true)
      } finally { await client.close() }
      return '已查证'
    } }) }, () => {})
    const execution = manager.create(input); await manager.start(execution.id)
    await vi.waitFor(() => expect(manager.isActive(execution.id)).toBe(false), { timeout: 10000 })
    const result = store.getExecution(execution.id)!
    expect(result.status).toBe('complete'); expect(result.searches).toBe(1); expect(result.toolEvidence).toHaveLength(2); expect(result.webSnapshots?.[0].source).toBe('冻结搜索')
    expect(scope.close).toHaveBeenCalledOnce(); expect(chat).toHaveBeenCalledOnce()
  })
})
