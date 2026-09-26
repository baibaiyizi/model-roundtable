import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionManager } from '../src/main/execution/manager'
import type { ExecutionStore } from '../src/main/execution/ports'
import type { Execution, ExecutionInput } from '../src/shared/execution'
import type { GatewayPort } from '../src/shared/ports'
import type { NetworkLease, ProviderNetworkPort } from '../src/shared/network'
import { testComponents } from './helpers/components'

const input: ExecutionInput = { projectId: 'p', task: '使用授权项目工具读取材料', acceptance: '报告工具结果', executor: { providerId: 'api', modelId: 'qa-model' }, reviewers: [], maxCalls: 10, maxOutputTokens: 1024, timeoutMs: 60000, maxRepairRounds: 0 }
const gateway: GatewayPort = { chat: async () => { throw new Error('Unexpected review') }, embed: async () => [], transcribe: async () => '' }

async function fixture(blocked = false) {
  const directory = await mkdtemp(join(tmpdir(), 'OpenCode 扩展-'))
  const stateDir = await mkdtemp(join(tmpdir(), 'OpenCode MCP state-'))
  const data = new Map<string, Execution>()
  const requests: unknown[] = []
  let toolRequested = false, entered = 0, completed = 0, cancelled = 0, closed = 0, networkLeases = 0, routedRequests = 0
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk.toString()
    const body = JSON.parse(raw); requests.push(body)
    expect(req.headers.authorization).toBe('Bearer qa-private-provider-key')
    expect(req.headers['x-qa-route']).toBe('frozen-executor-route')
    expect(body.model).toBe('qa-model')
    // The executor receives schemas/results; the bearer credential belongs only
    // to its MCP transport and must never be a model input.
    expect(raw).not.toContain('Authorization'); expect(raw).not.toContain('qa-private-provider-key')
    const tool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name.endsWith('ext_qa_read'))
    const invoke = Boolean(tool && !toolRequested)
    if (invoke) toolRequested = true
    const delta = invoke ? { tool_calls: [{ index: 0, id: 'qa-extension-call', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ query: '中文材料' }) } }] } : { content: '已读取项目材料，来源 qa://project/material。' }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ id: 'qa', object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, delta: {}, finish_reason: invoke ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`)
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'qa', choices: [{ message: { role: 'assistant', content: 'QA 摘要' }, finish_reason: 'stop' }] })) }
  })
  api.listen(0, '127.0.0.1'); await once(api, 'listening')
  const baseUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`
  const store: ExecutionStore = {
    getProject: () => ({ id: 'p', name: '本机QA', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }),
    getProvider: () => ({ id: 'api', kind: 'api', name: 'QA', baseUrl, modelIds: ['qa-model'], hasKey: true, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 15000 }),
    getSecret: async () => 'qa-private-provider-key', getSession: () => undefined,
    getExecution: id => structuredClone(data.get(id)), saveExecution: value => data.set(value.id, structuredClone(value)), listExecutions: () => [...data.values()].map(value => structuredClone(value)),
  }
  const network = { acquireForProviders: async (ids: string[]): Promise<NetworkLease> => {
    expect(ids).toEqual(['api']); networkLeases++; let released = false
    return { snapshots: { api: { selection: { mode: 'direct' }, label: 'frozen-executor-route' } },
      fetchForProvider: id => { expect(id).toBe('api'); return (input, init) => { routedRequests++; const headers = new Headers(init?.headers); headers.set('x-qa-route', 'frozen-executor-route'); return fetch(input, { ...init, headers }) } },
      environmentForProvider: async () => ({}), release: () => { if (!released) { released = true; networkLeases-- } },
    }
  } } as unknown as ProviderNetworkPort
  const manager = new ExecutionManager(store, gateway, { stateDir, runtimeDir: '', components: testComponents, network, fetch: async () => { throw new Error('unselected default network') },
    extensionTools: async (_execution, signal, onEvidence) => ({
      tools: [{ name: 'ext_qa_read', description: '读取本项目材料', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      call: async (name, args) => {
        entered++; expect(name).toBe('ext_qa_read'); expect(args).toEqual({ query: '中文材料' })
        if (blocked) await new Promise<void>((_resolve, reject) => { const abort = () => { cancelled++; reject(signal.reason) }; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
        signal.throwIfAborted(); completed++
        onEvidence([{ id: 'qa-evidence', kind: 'tool', title: 'QA 材料', text: '可追溯的中文材料', retrievedAt: new Date().toISOString(), locator: 'qa://project/material', toolCallId: 'qa-extension-call' }])
        return { text: '可追溯的中文材料', source: 'qa://project/material' }
      }, close: async () => { closed++ },
    }),
  }, () => {})
  return { manager, store, requests, networkMetrics: () => ({ networkLeases, routedRequests }), metrics: () => ({ entered, completed, cancelled, closed }), close: async () => { await manager.shutdown(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())) } }
}

describe.skipIf(process.platform !== 'win32')('真实 OpenCode 的统一扩展 MCP 代理（本机可控模型）', () => {
  it('ExecutionManager 把扩展工具交给真实后台调用并保存证据；上游调用计数准确', async () => {
    const f = await fixture()
    try {
      const task = f.manager.create(input); await f.manager.start(task.id)
      await expect.poll(() => f.manager.isActive(task.id), { timeout: 60000 }).toBe(false)
      const result = f.store.getExecution(task.id)!
      expect(result.error ?? result.status).toBe('complete')
      expect(f.metrics()).toEqual({ entered: 1, completed: 1, cancelled: 0, closed: 1 })
      expect(result.calls).toBe(f.requests.length)
      expect(f.networkMetrics()).toEqual({ networkLeases: 0, routedRequests: f.requests.length })
      expect(result.networkSnapshots?.[0].providers.api.label).toBe('frozen-executor-route')
      expect(result.toolEvidence?.[0].toolCallId).toBe('qa-extension-call')
      expect(result.events.some(event => event.kind === 'tool' && event.tool?.endsWith('ext_qa_read') && event.state === 'complete')).toBe(true)
      expect(JSON.stringify(result)).not.toContain('qa-private-provider-key')
      expect(JSON.stringify(f.requests)).toContain('qa://project/material')
    } finally { await f.close() }
  }, 75000)
  it('真实后台正在等待扩展时停止，取消工具且不保留迟到证据或再次请求', async () => {
    const f = await fixture(true)
    try {
      const task = f.manager.create(input); await f.manager.start(task.id)
      await expect.poll(() => f.metrics().entered, { timeout: 45000 }).toBe(1)
      const count = f.requests.length
      const stopped = await f.manager.stop(task.id)
      expect(stopped.status).toBe('stopped'); expect(f.manager.isActive(task.id)).toBe(false)
      expect(f.metrics()).toEqual({ entered: 1, completed: 0, cancelled: 1, closed: 1 })
      expect(stopped.toolEvidence ?? []).toEqual([]); expect(stopped.calls).toBe(count)
      expect(f.requests.length).toBe(count)
      expect(f.networkMetrics()).toEqual({ networkLeases: 0, routedRequests: count })
      expect(stopped.events.some(event => event.kind === 'tool' && event.state === 'complete')).toBe(false)
    } finally { await f.close() }
  }, 75000)
})
