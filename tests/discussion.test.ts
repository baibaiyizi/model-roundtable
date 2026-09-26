import { describe, expect, it, vi } from 'vitest'
import { DiscussionEngine } from '../src/main/discussion/engine'
import type { ChatRequest, ChatResult, EvidencePort, GatewayPort, StorePort } from '../src/shared/ports'
import { DEFAULT_LIMITS, type AppEvent, type Evidence, type Session, type SessionInput } from '../src/shared/types'
import type { NetworkLease, ProviderNetworkPort } from '../src/shared/network'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<SessionInput> = {}, handler?: (request: ChatRequest, index: number) => Promise<ChatResult>, network?: ProviderNetworkPort) {
  const sessions = new Map<string, Session>()
  const events: AppEvent[] = []
  const requests: ChatRequest[] = []
  const store: StorePort = {
    getSession: id => { const item = sessions.get(id); return item && structuredClone(item) },
    listSessions: () => structuredClone([...sessions.values()]),
    saveSession: session => { sessions.set(session.id, structuredClone(session)) },
    getProvider: id => ({ id, name: 'Test', baseUrl: 'https://example.invalid/v1', hasKey: true, modelIds: ['a', 'b', 'host'], tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 30000 }),
    getSettings: () => ({ hasTavilyKey: true }),
    getKnowledgeBase: () => undefined, saveKnowledgeBase: () => {}, listKnowledgeBases: () => [], deleteKnowledgeBase: () => {},
    getSource: () => undefined, saveSource: () => {}, listSources: () => [], deleteSource: () => {}, saveChunks: () => {}, getChunks: () => [],
  }
  let choices = 0
  const normal = async (request: ChatRequest, index: number): Promise<ChatResult> => {
    let text = `回答-${request.model.modelId}-${index}`
    if (request.prompt.includes('只返回 JSON：{"speakerId"')) text = JSON.stringify({ speakerId: choices++ % 2 ? 'b' : 'a', replyTo: choices === 1 ? '$user' : 'a', instruction: '具体回应对方观点' })
    if (request.prompt.includes('只返回 JSON：{"query"')) text = '{"query":null}'
    if (request.prompt.includes('"wantsToSpeak"')) text = JSON.stringify({ wantsToSpeak: true, reason: '补充新证据', replyTo: '$user', searchQuery: null })
    if (request.prompt.includes('请压缩以下早期讨论')) text = '双方存在分歧；摘要保留原消息映射。'
    request.onDelta?.(text.slice(0, 3))
    request.onDelta?.(text.slice(3))
    return { text, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
  }
  const gateway: GatewayPort = {
    chat: vi.fn(async request => {
      requests.push(request)
      return (handler ?? normal)(request, requests.length)
    }),
    embed: vi.fn(async () => []), transcribe: vi.fn(async () => ''),
  }
  const evidence: EvidencePort = { retrieve: vi.fn(async () => []), search: vi.fn(async () => []) }
  const engine = new DiscussionEngine(store, gateway, evidence, event => events.push(event), network)
  const input: SessionInput = {
    topic: '如何改善城市公共交通？', mode: 'roundtable',
    participants: [
      { id: 'a', name: '甲', model: { providerId: 'p', modelId: 'a' }, role: '研究员', team: 'pro' },
      { id: 'b', name: '乙', model: { providerId: 'p', modelId: 'b' }, role: '批评者', team: 'con' },
    ], moderator: { providerId: 'p', modelId: 'host' }, knowledgeBaseIds: [], searchEnabled: false, limits: { ...DEFAULT_LIMITS },
    ...overrides,
  }
  const create = () => engine.create(input)
  const get = (id: string) => store.getSession(id)!
  const status = async (id: string, expected: Session['status']) => { await vi.waitFor(() => expect(get(id).status).toBe(expected), { timeout: 5000, interval: 5 }); return get(id) }
  return { engine, create, get, status, requests, events, gateway, evidence, store, normal, input }
}

describe('DiscussionEngine', () => {
  it('freezes one route for all active discussion calls and records later resumes separately', async () => {
    let held = 0, version = 0
    const leases: NetworkLease[] = []
    const network = { acquireForProviders: vi.fn(async (ids: string[]) => {
      expect(ids).toEqual(['p']); version++; held++
      const lease: NetworkLease = { snapshots: { p: { selection: { mode: 'direct' }, label: `路线${version}` } }, fetchForProvider: () => fetch, environmentForProvider: async () => ({}), release: vi.fn(() => { held-- }) }
      leases.push(lease); return lease
    }) } as unknown as ProviderNetworkPort
    const h = setup({ mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 2 } }, async (request, index) => { expect(held).toBe(1); return h.normal(request, index) }, network)
    const session = h.create(); await h.status(session.id, 'paused')
    expect(held).toBe(0); expect(h.requests.every(request => request.network === leases[0])).toBe(true)
    h.engine.action({ sessionId: session.id, action: 'resume' }); const result = await h.status(session.id, 'paused')
    expect(result.run?.networkSnapshots?.map(snapshot => snapshot.providers.p.label)).toEqual(['路线1', '路线2'])
    expect(result.messages.filter(message => message.kind === 'assistant').map(message => message.network?.label)).toEqual(['路线1', '路线1', '路线2', '路线2'])
    expect(h.requests.slice(4).every(request => request.network === leases[1])).toBe(true)
    expect(held).toBe(0)
  })
  it('does not use or persist a late network lease after stop', async () => {
    const pending = deferred<NetworkLease>(), release = vi.fn()
    const network = { acquireForProviders: vi.fn(() => pending.promise) } as unknown as ProviderNetworkPort
    const h = setup({}, undefined, network), session = h.create()
    await vi.waitFor(() => expect(network.acquireForProviders).toHaveBeenCalledOnce())
    h.engine.action({ sessionId: session.id, action: 'stop' })
    pending.resolve({ snapshots: { p: { selection: { mode: 'direct' }, label: '迟到路线' } }, fetchForProvider: () => fetch, environmentForProvider: async () => ({}), release })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    expect(h.get(session.id).status).toBe('stopped'); expect(h.requests).toEqual([])
    expect(h.get(session.id).run?.networkSnapshots).toBeUndefined()
  })
  it('holds the route until MCP cleanup finishes and a queued resume gets a new lease', async () => {
    const closing = deferred<void>(); let held = 0, sequence = 0
    const network = { acquireForProviders: vi.fn(async () => {
      expect(held).toBe(0); held++; sequence++
      return { snapshots: { p: { selection: { mode: 'direct' }, label: String(sequence) } }, fetchForProvider: () => fetch, environmentForProvider: async () => ({}), release: () => { held-- } } as NetworkLease
    }) } as unknown as ProviderNetworkPort
    const h = setup({ projectId: 'project', mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } }, undefined, network)
    const close = vi.fn().mockImplementationOnce(() => closing.promise).mockResolvedValue(undefined)
    h.evidence.tools = async () => ({ tools: [], call: async () => ({}), close })
    const session = h.create(); await h.status(session.id, 'paused'); expect(held).toBe(1)
    h.engine.action({ sessionId: session.id, action: 'resume' }); closing.resolve()
    await vi.waitFor(() => expect(h.get(session.id).messages.filter(message => message.kind === 'assistant')).toHaveLength(2))
    await h.status(session.id, 'paused'); expect(held).toBe(0); expect(sequence).toBe(2)
  })
  it.each(['resolve', 'reject'] as const)('resumes after pending project cleanup settles with %s', async outcome => {
    const closing = deferred<void>()
    const h = setup({ projectId: 'project', mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } })
    const close = vi.fn().mockImplementationOnce(() => closing.promise).mockResolvedValue(undefined)
    h.evidence.tools = vi.fn(async () => ({ tools: [], call: async () => ({}), close }))
    const session = h.create(); await h.status(session.id, 'paused')
    expect(close).toHaveBeenCalledOnce()
    h.engine.action({ sessionId: session.id, action: 'resume' })
    expect(h.requests).toHaveLength(2)
    if (outcome === 'resolve') closing.resolve()
    else closing.reject(new Error('fixture close failed'))
    await vi.waitFor(() => expect(h.get(session.id).messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(2), { timeout: 1000 })
    await h.status(session.id, 'paused')
    expect(h.requests).toHaveLength(4)
    expect(close).toHaveBeenCalledTimes(2)
    if (outcome === 'reject') expect(h.get(session.id).messages.some(m => m.content.includes('fixture close failed'))).toBe(true)
    h.engine.shutdown()
  })
  it.each(['retry', 'skip'] as const)('honors %s while failed project cleanup is still pending', async action => {
    const closing = deferred<void>()
    const h = setup({ projectId: 'project' }, async (request, index) => {
      if (index === 1) throw new Error('fixture generation failed')
      return h.normal(request, index)
    })
    const close = vi.fn().mockImplementationOnce(() => closing.promise).mockResolvedValue(undefined)
    h.evidence.tools = async () => ({ tools: [], call: async () => ({}), close })
    const session = h.create(); await h.status(session.id, 'error')
    h.engine.action({ sessionId: session.id, action })
    expect(h.requests).toHaveLength(1)
    closing.resolve()
    const completed = await h.status(session.id, 'complete')
    expect(completed.messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(action === 'retry' ? 5 : 4)
    expect(close).toHaveBeenCalledTimes(2)
  })
  it('resumes after manual search restores paused state before project cleanup finishes', async () => {
    const closing = deferred<void>()
    const h = setup({ projectId: 'project', mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } })
    const close = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => closing.promise).mockResolvedValue(undefined)
    h.evidence.tools = async () => ({ tools: [], call: async () => ({}), close })
    const session = h.create(); await h.status(session.id, 'paused')
    const search = h.engine.manualSearch(session.id, '补充资料')
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2))
    expect(h.get(session.id).status).toBe('paused')
    h.engine.action({ sessionId: session.id, action: 'resume' })
    closing.resolve(); await search
    await vi.waitFor(() => expect(h.get(session.id).messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(2))
    await h.status(session.id, 'paused')
    expect(h.evidence.search).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(3)
    h.engine.shutdown()
  })
  it.each(['stop', 'shutdown'] as const)('does not revive a queued resume after %s during project cleanup', async action => {
    const closing = deferred<void>()
    const h = setup({ projectId: 'project', mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } })
    const close = vi.fn(() => closing.promise)
    h.evidence.tools = vi.fn(async () => ({ tools: [], call: async () => ({}), close }))
    const session = h.create(); await h.status(session.id, 'paused')
    h.engine.action({ sessionId: session.id, action: 'resume' })
    if (action === 'stop') h.engine.action({ sessionId: session.id, action: 'stop' })
    else h.engine.shutdown()
    const saved = h.get(session.id)
    closing.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.requests).toHaveLength(2)
    expect(h.evidence.tools).toHaveBeenCalledOnce()
    expect(h.get(session.id)).toEqual(saved)
    h.engine.shutdown()
  })
  it('does not replace or duplicate an interjection job when old project cleanup completes', async () => {
    const closing = deferred<void>(), reply = deferred<ChatResult>()
    const h = setup({ projectId: 'project', mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } }, (request, index) => index === 3 ? reply.promise : h.normal(request, index))
    const close = vi.fn().mockImplementationOnce(() => closing.promise).mockResolvedValue(undefined)
    h.evidence.tools = vi.fn(async () => ({ tools: [], call: async () => ({}), close }))
    const session = h.create(); await h.status(session.id, 'paused')
    h.engine.interject({ sessionId: session.id, participantId: 'b', text: '回应新问题' })
    await vi.waitFor(() => expect(h.requests).toHaveLength(3))
    closing.resolve()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.requests).toHaveLength(3)
    expect(h.requests[2].signal.aborted).toBe(false)
    reply.resolve({ text: '新问题的回应' })
    const result = await h.status(session.id, 'paused')
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(2)
    expect(result.messages.at(-1)).toMatchObject({ phase: 'interjection', speakerId: 'b', status: 'complete', content: '新问题的回应' })
    expect(h.evidence.tools).toHaveBeenCalledTimes(2)
    h.engine.shutdown()
  })
  it('shares project read tools before both independent openings and accounts for planner calls', async () => {
    let planned = 0
    const h = setup({ projectId: 'project' }, async (request, index) => request.structured?.name === 'discussion_read_tool'
      ? { text: JSON.stringify({ tool: planned++ ? null : 'project_read', argumentsJson: '{}' }), finishReason: 'stop' }
      : h.normal(request, index))
    const close = vi.fn(async () => {})
    h.evidence.tools = vi.fn(async (_session, _signal, onEvidence) => ({ tools: [{ name: 'project_read', description: 'Read project', inputSchema: { type: 'object' } }], close,
      call: vi.fn(async () => { onEvidence([{ id: 'tool-evidence', kind: 'tool', title: '项目资料', locator: 'read_project', text: '真实工具结果', retrievedAt: new Date().toISOString(), toolCallId: 'call-1' }]); return { result: '真实工具结果' } }) }))
    const result = await h.status(h.create().id, 'complete')
    expect(result.evidence[0]).toMatchObject({ id: 'tool-evidence', kind: 'tool' })
    expect(result.run).toMatchObject({ calls: 7, toolCalls: 1, toolsLoaded: true })
    const openings = h.requests.filter(request => request.prompt.includes('【本次发言任务】') && request.prompt.includes('此阶段看不到'))
    expect(openings).toHaveLength(2)
    for (const opening of openings) expect(opening.prompt).toContain('真实工具结果')
    expect(close).toHaveBeenCalledOnce()
  })
  it('fails invalid tool arguments before marking planning complete or calling a tool', async () => {
    const h = setup({ projectId: 'project' }, async () => ({ text: '{"tool":"read","argumentsJson":"not json"}' }))
    const call = vi.fn(async () => ({})), close = vi.fn(async () => {})
    h.evidence.tools = async () => ({ tools: [{ name: 'read', description: '', inputSchema: { type: 'object' } }], call, close })
    const result = await h.status(h.create().id, 'error')
    expect(result.run?.errorTask).toBe('tools')
    expect(result.messages.at(-1)).toMatchObject({ status: 'failed', diagnostic: { code: 'invalid_schema' } })
    expect(call).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    h.engine.action({ sessionId: result.id, action: 'skip' })
    expect(h.get(result.id).run?.toolsLoaded).toBe(true)
    h.engine.shutdown()
  })
  it('rejects late tool evidence and never starts speakers after stop', async () => {
    const pending = deferred<unknown>()
    const h = setup({ projectId: 'project' }, async () => ({ text: '{"tool":"read","argumentsJson":"{}"}' }))
    let late!: (items: Evidence[]) => void
    const call = vi.fn(() => pending.promise), close = vi.fn(async () => {})
    h.evidence.tools = async (_session, _signal, onEvidence) => { late = onEvidence; return { tools: [{ name: 'read', description: '', inputSchema: {} }], call, close } }
    const session = h.create()
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    h.engine.action({ sessionId: session.id, action: 'stop' })
    late([{ id: 'late', kind: 'tool', title: '迟到', locator: '', text: '不应使用', retrievedAt: '' }]); pending.resolve({})
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(h.get(session.id).evidence).toEqual([])
    expect(h.requests).toHaveLength(1)
  })
  it('accepts wrapped search JSON while retaining raw provenance and independent openings', async () => {
    const raw = '<think>考虑示例 {"query":"不采用"}，最终无需搜索。</think>\n```json\n{"query":null}\n```'
    const h = setup({ searchEnabled: true }, async (request, index) => request.structured?.name === 'search_query'
      ? { text: raw, finishReason: 'stop', responseId: 'search-response' }
      : h.normal(request, index))
    const result = await h.status(h.create().id, 'complete')
    const planning = result.messages.find(message => message.phase === 'search')!
    expect(planning).toMatchObject({ status: 'complete', content: raw, diagnostic: { responseId: 'search-response', normalizations: ['think', 'fence'] } })
    expect(h.evidence.search).not.toHaveBeenCalled()
    expect(result.messages.filter(message => message.phase === 'opening')).toHaveLength(2)
  })
  it('persists failed structured output, retries the same model explicitly and keeps the call budget', async () => {
    const raw = '<think>只返回一半思考 {"query":null}'
    const h = setup({ searchEnabled: true, limits: { ...DEFAULT_LIMITS, maxCalls: 2 } }, async (_request, index) => ({ text: index === 1 ? raw : '{"query":null}', usage: { totalTokens: 30 }, responseId: `attempt-${index}` }))
    const session = h.create(); const failed = await h.status(session.id, 'error')
    expect(failed.run).toMatchObject({ errorTask: 'search', calls: 1 })
    expect(failed.messages.at(-1)).toMatchObject({ status: 'failed', content: raw, usage: { totalTokens: 30 }, diagnostic: { code: 'incomplete_reasoning', responseId: 'attempt-1', maxOutputTokens: 1500 } })
    expect(h.requests).toHaveLength(1)
    h.engine.action({ sessionId: session.id, action: 'retry' })
    const retried = await h.status(session.id, 'paused')
    expect(retried.run?.calls).toBe(2)
    expect(h.requests.map(request => request.model.modelId)).toEqual(['host', 'host'])
    expect(retried.messages.filter(message => message.phase === 'opening')).toHaveLength(0)
    expect(retried.messages.find(message => message.status === 'failed')?.content).toBe(raw)
  })
  it('records truncation separately and never schedules a speaker from truncated JSON', async () => {
    const h = setup({ mode: 'free' }, async () => ({ text: '{"speakerId":"a","replyTo":null,"instruction":"讨论"}', finishReason: 'length' }))
    const result = await h.status(h.create().id, 'error')
    expect(result.messages.at(-1)).toMatchObject({ status: 'failed', diagnostic: { code: 'truncated', finishReason: 'length' } })
    expect(result.messages.filter(message => message.kind === 'assistant')).toHaveLength(0)
    expect(h.requests).toHaveLength(1)
  })
  it('leaves ordinary discussion messages untouched by structured normalization', async () => {
    const raw = '<think>模型自带内容</think>自然语言正文 {"例子":true}'
    const h = setup({}, async () => ({ text: raw }))
    const result = await h.status(h.create().id, 'complete')
    expect(result.messages.filter(message => message.kind === 'assistant').every(message => message.content === raw)).toBe(true)
    expect(h.requests.every(request => request.structured === undefined)).toBe(true)
  })
  it('branches from historical completed rounds and from the end of the whole debate inquiry', async () => {
    const h = setup({moderator:undefined})
    const s=h.create(); const first=await h.status(s.id,'complete')
    const firstReview=first.messages.filter(m=>m.phase==='review').at(-1)!
    h.engine.action({sessionId:s.id,action:'review'}); await h.status(s.id,'complete')
    const branch=h.engine.branch({sessionId:s.id,messageId:firstReview.id})
    expect(branch.messages.at(-1)?.id).toBe(firstReview.id)
    expect(branch.run?.calls).toBe(0)
    expect(h.engine.branch({sessionId:branch.id,messageId:firstReview.id}).branchOf?.messageId).toBe(firstReview.id)
    const debate=setup({mode:'debate'}), d=debate.create(); const full=await debate.status(d.id,'complete')
    const questions=full.messages.filter(m=>m.phase==='question'), answers=full.messages.filter(m=>m.phase==='answer')
    expect(()=>debate.engine.branch({sessionId:d.id,messageId:questions[0].id})).toThrow('阶段末尾')
    expect(()=>debate.engine.branch({sessionId:d.id,messageId:answers[0].id})).toThrow('阶段末尾')
    const afterInquiry=debate.engine.branch({sessionId:d.id,messageId:answers.at(-1)!.id})
    expect(afterInquiry.run!.steps[afterInquiry.run!.cursor].phase).toBe('rebuttal')
  })

  it('runs a hostless roundtable without inserting a hidden moderator and allows explicit summary', async () => {
    const h = setup({ moderator: undefined })
    const s = h.create(); let result = await h.status(s.id, 'complete')
    expect(result.run?.calls).toBe(4)
    expect(result.messages.filter(m => m.kind === 'assistant').map(m => m.speakerId)).toEqual(['a','b','a','b'])
    await h.engine.summarize(s.id, { providerId: 'p', modelId: 'b' })
    result = h.get(s.id)
    expect(result.status).toBe('complete')
    expect(result.messages.at(-1)?.phase).toBe('optional-summary')
    expect(result.messages.at(-1)?.model?.modelId).toBe('b')
    expect(() => setup({ mode: 'debate', moderator: undefined }).create()).toThrow('裁判')
  })

  it('collects hostless bids on one context and chooses by last speech, not response speed', async () => {
    const h = setup({ mode: 'free', moderator: undefined, limits: { ...DEFAULT_LIMITS, autoTurns: 2 } }, async (request,index) => {
      if (request.prompt.includes('"wantsToSpeak"')) {
        await new Promise(resolve => setTimeout(resolve, request.model.modelId === 'a' ? 20 : 1))
        return { text: JSON.stringify({ wantsToSpeak: true, reason: '补充', replyTo: '$user', searchQuery: null }) }
      }
      return { text: `正式发言${index}` }
    })
    const s = h.create(), result = await h.status(s.id, 'paused')
    expect(result.messages.filter(m => m.kind === 'assistant').map(m => m.speakerId)).toEqual(['a','b'])
    expect(result.run?.calls).toBe(6)
    const bids = h.requests.filter(r => r.prompt.includes('"wantsToSpeak"'))
    expect(bids[0].prompt.split('\n你是 ')[0]).toBe(bids[1].prompt.split('\n你是 ')[0])
    expect(new Set(result.messages.map(m => m.turnId)).size).toBe(result.messages.length)
  })

  it('rotates hostless shared summaries while keeping source IDs and full history', async () => {
    const h = setup({ mode: 'free', moderator: undefined, limits: { ...DEFAULT_LIMITS, autoTurns: 12, maxCalls: 100, contextChars: 6000 } }, async request => {
      if (request.prompt.includes('"wantsToSpeak"')) return { text: JSON.stringify({ wantsToSpeak: true, reason: '补充', replyTo: null, searchQuery: null }) }
      if (request.prompt.includes('请压缩以下早期讨论')) return { text: '有待验证的少数意见。' }
      return { text: '保留完整讨论和少数意见。'.repeat(150) }
    })
    const s = h.create(), result = await h.status(s.id, 'paused')
    const summaries = result.messages.filter(m => m.phase === 'compression')
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    expect(summaries.slice(0,2).map(m => m.model?.modelId)).toEqual(['a','b'])
    const answers = result.messages.filter(m => m.kind === 'assistant')
    expect(answers).toHaveLength(12)
    expect(answers.every(m => m.content.length > 1000)).toBe(true)
    expect(result.run?.summary).toContain(answers[0].id)
    expect(h.requests.at(-1)?.prompt).toContain('不是原始证据')
  })

  it('retries only failed bids and permits skipping the failed portion', async () => {
    let failure = true
    const h = setup({ mode: 'free', moderator: undefined, limits: { ...DEFAULT_LIMITS, autoTurns: 1 } }, async request => {
      if (request.prompt.includes('"wantsToSpeak"')) {
        if (request.model.modelId === 'b' && failure) { failure = false; throw new Error('429 限流') }
        return { text: JSON.stringify({ wantsToSpeak: true, reason: '补充', replyTo: null, searchQuery: null }) }
      }
      return { text: '正式回答' }
    })
    const s = h.create(); await h.status(s.id,'error')
    expect(h.get(s.id).run?.bidBatch?.bids).toHaveLength(1)
    h.engine.action({sessionId:s.id,action:'retry'})
    const result = await h.status(s.id,'paused')
    expect(h.requests.filter(r => r.prompt.includes('"wantsToSpeak"')).map(r => r.model.modelId)).toEqual(['a','b','b'])
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(1)
  })

  it('reserves the complete bid batch plus speech and supports single-turn and muted explicit mentions', async () => {
    const limited = setup({mode:'free',moderator:undefined,limits:{...DEFAULT_LIMITS,maxCalls:2}})
    const l=limited.create(); await limited.status(l.id,'paused'); expect(limited.requests).toHaveLength(0)
    const h=setup({mode:'free',moderator:undefined,limits:{...DEFAULT_LIMITS,autoTurns:1}})
    const s=h.create(); await h.status(s.id,'paused')
    h.engine.mute(s.id,'a',true); h.engine.mute(s.id,'b',true)
    h.engine.action({sessionId:s.id,action:'one-turn'}); await h.status(s.id,'paused')
    expect(h.get(s.id).run?.error).toContain('没有成员')
    h.engine.interject({sessionId:s.id,participantId:'b',text:'请回应这一个问题'})
    const result=await h.status(s.id,'paused')
    expect(result.messages.filter(m => m.kind==='assistant').at(-1)?.speakerId).toBe('b')
  })

  it('stops an entire concurrent bid batch and rejects every late result', async () => {
    const wait = deferred<ChatResult>()
    const h=setup({mode:'free',moderator:undefined},()=>wait.promise)
    const s=h.create(); await vi.waitFor(()=>expect(h.requests).toHaveLength(2))
    h.engine.action({sessionId:s.id,action:'stop'})
    wait.resolve({text:JSON.stringify({wantsToSpeak:true,reason:'迟到',replyTo:null,searchQuery:null})})
    await new Promise(resolve=>setTimeout(resolve,20))
    expect(h.get(s.id).status).toBe('stopped'); expect(h.requests).toHaveLength(2)
    expect(h.get(s.id).messages.filter(m=>m.status==='interrupted')).toHaveLength(2)
    expect(h.requests.every(r=>r.signal.aborted)).toBe(true)
  })

  it('freezes shared blind evidence only after all hostless search proposals have finished', async () => {
    const h=setup({moderator:undefined,searchEnabled:true,limits:{...DEFAULT_LIMITS,maxSearches:2}},async request=>({text:request.prompt.includes('"query"') ? JSON.stringify({query:`查询-${request.model.modelId}`}) : '独立回答'}))
    vi.mocked(h.evidence.search).mockImplementation(async query=>[{id:query,title:query,text:query,locator:query,kind:'web',retrievedAt:new Date().toISOString()}])
    const s=h.create(); const result=await h.status(s.id,'complete')
    expect(result.evidence).toHaveLength(2)
    expect(h.requests[2].prompt).toContain('查询-b'); expect(h.requests[3].prompt).toContain('查询-a')
    expect(h.requests[2].prompt.split('【本次发言任务】')[0]).toEqual(h.requests[3].prompt.split('【本次发言任务】')[0])
    expect(h.requests[3].prompt).not.toContain('独立回答')
  })

  it('does not speak for a member muted while the selected turn waits for web evidence', async () => {
    const waiting = deferred<Evidence[]>()
    const h = setup({mode:'free',moderator:undefined,searchEnabled:true,limits:{...DEFAULT_LIMITS,autoTurns:1}},async request=>({text:request.prompt.includes('"wantsToSpeak"') ? JSON.stringify({wantsToSpeak:true,reason:'核对证据',replyTo:null,searchQuery:'查证'}) : '正式发言'}))
    vi.mocked(h.evidence.search).mockImplementation(()=>waiting.promise)
    const s=h.create()
    await vi.waitFor(()=>expect(h.evidence.search).toHaveBeenCalledTimes(1))
    h.engine.mute(s.id,'a',true); waiting.resolve([])
    const result=await h.status(s.id,'paused')
    expect(result.messages.filter(m=>m.kind==='assistant').map(m=>m.speakerId)).toEqual(['b'])
  })

  it('branches at completed stage boundaries with copied evidence and a fresh paused budget', async () => {
    const h=setup({moderator:undefined});const s=h.create();const result=await h.status(s.id,'complete')
    const opening=result.messages.filter(m=>m.phase==='opening')
    expect(()=>h.engine.branch({sessionId:s.id,messageId:opening[0].id})).toThrow('阶段')
    const branch=h.engine.branch({sessionId:s.id,messageId:opening[1].id})
    expect(branch.status).toBe('paused');expect(branch.run?.calls).toBe(0);expect(branch.run?.cursor).toBe(2)
    expect(branch.messages.at(-1)?.id).toBe(opening[1].id)
    h.engine.action({sessionId:branch.id,action:'resume'});const finished=await h.status(branch.id,'complete')
    expect(finished.run?.calls).toBe(2);expect(h.get(s.id).messages.length).toBe(result.messages.length)
  })
  it('runs blind independent openings, shared reviews, a minority-preserving summary and an additional review', async () => {
    const h = setup()
    const session = h.create()
    let result = await h.status(session.id, 'complete')
    expect(result.messages.filter(m => m.kind === 'assistant').map(m => m.phase)).toEqual(['opening', 'opening', 'review', 'review', 'summary'])
    expect(h.requests[0].prompt).not.toContain('回答-')
    expect(h.requests[1].prompt).not.toContain('回答-')
    expect(h.requests[2].prompt).toContain('回答-a-1')
    expect(h.requests[2].prompt).toContain('回答-b-2')
    expect(h.requests[4].prompt).toContain('少数意见')
    expect(result.messages.at(-1)?.usage?.totalTokens).toBe(30)
    expect(result.run?.calls).toBe(5)
    expect(result.messages.filter(m => m.kind === 'assistant').every(m => m.contextVersion === 1 && m.runId === result.run!.id)).toBe(true)
    h.engine.action({ sessionId: session.id, action: 'review' })
    result = await h.status(session.id, 'complete')
    expect(result.run?.calls).toBe(8)
    expect(result.messages.filter(m => m.phase === 'summary')).toHaveLength(2)
  })

  it('runs both debate sides through questions, responses, rebuttals, closings and judgment', async () => {
    const h = setup({ mode: 'debate' })
    const session = h.create()
    const result = await h.status(session.id, 'complete')
    expect(result.messages.filter(m => m.kind === 'assistant').map(m => m.phase)).toEqual(['opening', 'opening', 'question', 'answer', 'question', 'answer', 'rebuttal', 'rebuttal', 'closing', 'closing', 'verdict'])
    expect(h.requests[1].prompt).not.toContain('回答-a-1')
    expect(h.requests[1].system).toContain('反方')
    expect(h.requests[3].prompt).toContain('回答-a-3')
    expect(h.requests[10].system).toContain('中立主持')
    expect(result.messages.at(-1)?.speakerName).toBe('裁判')
    const invalid = { ...h.input, participants: h.input.participants.map(p => ({ ...p, team: 'pro' as const })) }
    expect(() => h.engine.create(invalid)).toThrow('正反双方')
  })

  it('lets the moderator choose free-chat speakers and response targets, then pauses at the turn limit', async () => {
    const h = setup({ mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 2 } })
    const session = h.create()
    const result = await h.status(session.id, 'paused')
    expect(result.messages.filter(m => m.kind === 'assistant').map(m => m.speakerId)).toEqual(['a', 'b'])
    expect(result.run?.calls).toBe(4)
    expect(h.requests[2].prompt).toContain('回答-a-2')
    expect(h.requests[3].prompt).toContain('回应对象：a')
    expect(h.requests[3].prompt).not.toContain('"speakerId":"a"')
    h.engine.action({ sessionId: session.id, action: 'resume' })
    await h.status(session.id, 'paused')
    expect(h.get(session.id).messages.filter(m => m.kind === 'assistant')).toHaveLength(4)
  })

  it('pauses after the active utterance completes without starting another request', async () => {
    const first = deferred<ChatResult>()
    const h = setup({}, (_request, index) => index === 1 ? first.promise : Promise.resolve({ text: `后续-${index}` }))
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    h.engine.action({ sessionId: session.id, action: 'pause' })
    expect(h.get(session.id).status).toBe('running')
    first.resolve({ text: '第一位完整发言' })
    const result = await h.status(session.id, 'paused')
    expect(h.requests).toHaveLength(1)
    expect(result.messages.at(-1)?.status).toBe('complete')
    expect(result.run?.cursor).toBe(1)
    h.engine.action({ sessionId: session.id, action: 'resume' })
    await h.status(session.id, 'complete')
  })

  it('stops immediately and discards late deltas and results even when a gateway ignores abort', async () => {
    const first = deferred<ChatResult>()
    const h = setup({}, () => first.promise)
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    const snapshotEvents = h.events.filter(e => e.type === 'session').length
    h.requests[0].onDelta?.('已收到的半句话')
    expect(h.get(session.id).messages.at(-1)?.content).toBe('已收到的半句话')
    expect(h.events.filter(e => e.type === 'session')).toHaveLength(snapshotEvents)
    h.engine.action({ sessionId: session.id, action: 'stop' })
    const deltaCount = h.events.filter(e => e.type === 'delta').length
    h.requests[0].onDelta?.('过期数据')
    first.resolve({ text: '迟到的完整回答' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const result = h.get(session.id)
    expect(h.requests[0].signal.aborted).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(result.status).toBe('stopped')
    expect(result.messages.at(-1)).toMatchObject({ content: '已收到的半句话', status: 'interrupted' })
    expect(h.events.filter(e => e.type === 'delta')).toHaveLength(deltaCount)
  })

  it('keeps repeated interjections authoritative and never puts interrupted output into subsequent context', async () => {
    const waiting = [deferred<ChatResult>(), deferred<ChatResult>(), deferred<ChatResult>(), deferred<ChatResult>()]
    const h = setup({}, (_request, index) => waiting[index - 1].promise)
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    h.requests[0].onDelta?.('过期首轮内容')
    h.engine.interject({ sessionId: session.id, participantId: 'b', text: '请先解释成本' })
    await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    h.requests[1].onDelta?.('过期首次插话回应')
    h.engine.interject({ sessionId: session.id, participantId: 'a', text: '先讨论无障碍设计' })
    await vi.waitFor(() => expect(h.requests).toHaveLength(3))
    expect(h.requests[2].model.modelId).toBe('a')
    expect(h.requests[2].prompt).toContain('先讨论无障碍设计')
    expect(h.requests[2].prompt).not.toContain('过期首轮内容')
    expect(h.requests[2].prompt).not.toContain('过期首次插话回应')
    waiting[0].resolve({ text: '忽略取消的旧结果一' })
    waiting[1].resolve({ text: '忽略取消的旧结果二' })
    waiting[2].resolve({ text: '有效的新回应' })
    await vi.waitFor(() => expect(h.requests).toHaveLength(4))
    expect(h.get(session.id).messages.some(m => m.status === 'complete' && m.content === '有效的新回应')).toBe(true)
    expect(h.requests[3].prompt).toContain('先讨论无障碍设计')
    expect(h.requests[3].prompt).not.toContain('有效的新回应')
    expect(h.requests[3].prompt).not.toContain('忽略取消')
    expect(h.get(session.id).messages.filter(m => m.status === 'interrupted')).toHaveLength(2)
    h.engine.action({ sessionId: session.id, action: 'stop' })
    waiting[3].resolve({ text: '最终取消' })
  })

  it('exposes 429 failures and retries the same seat without substituting models', async () => {
    const h = setup({}, async (_request, index) => { if (index === 1) throw new Error('429 速率限制'); return { text: `成功-${index}` } })
    const session = h.create()
    let result = await h.status(session.id, 'error')
    expect(result.run?.error).toContain('429')
    expect(result.messages.at(-1)?.status).toBe('failed')
    expect(() => h.engine.action({ sessionId: session.id, action: 'resume' })).toThrow('重试')
    h.engine.action({ sessionId: session.id, action: 'retry' })
    result = await h.status(session.id, 'complete')
    expect(h.requests[1].model).toEqual(h.requests[0].model)
    expect(result.run?.calls).toBe(6)
    expect(result.messages.filter(m => m.status === 'failed')).toHaveLength(1)
  })

  it('restarts all blind seats after a user supplement and reviews only the updated openings', async () => {
    const oldSecond = deferred<ChatResult>()
    const h = setup({}, async (_request, index) => {
      if (index === 1) return { text: '旧条件下甲的首轮答案' }
      if (index === 2) return oldSecond.promise
      return { text: `新条件回答-${index}` }
    })
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    h.engine.interject({ sessionId: session.id, text: '补充约束：预算必须少于一亿元' })
    const result = await h.status(session.id, 'complete')
    expect(h.requests[2].model.modelId).toBe('a')
    expect(h.requests[3].model.modelId).toBe('b')
    expect(h.requests[2].prompt.split('【本次发言任务】')[0]).toEqual(h.requests[3].prompt.split('【本次发言任务】')[0])
    expect(h.requests[3].prompt).toContain('预算必须少于一亿元')
    expect(h.requests[3].prompt).not.toContain('新条件回答-3')
    expect(h.requests[4].prompt).toContain('新条件回答-3')
    expect(h.requests[4].prompt).not.toContain('旧条件下甲的首轮答案')
    expect(result.messages.some(m => m.content === '旧条件下甲的首轮答案')).toBe(true)
    oldSecond.resolve({ text: '旧条件迟到答案' })
  })

  it('permits explicit skipped roundtable failures but does not allow debate seats to be skipped', async () => {
    const h = setup({}, async (_request, index) => { if (index === 1) throw new Error('401'); return { text: '剩余发言' } })
    const session = h.create()
    await h.status(session.id, 'error')
    h.engine.action({ sessionId: session.id, action: 'skip' })
    const result = await h.status(session.id, 'complete')
    expect(result.messages.some(m => m.kind === 'system' && m.content.includes('跳过'))).toBe(true)
    expect(h.requests[1].model.modelId).toBe('b')
    const debate = setup({ mode: 'debate' }, async () => { throw new Error('超时') })
    const d = debate.create()
    await debate.status(d.id, 'error')
    expect(() => debate.engine.action({ sessionId: d.id, action: 'skip' })).toThrow('必要席位')
    expect(debate.get(d.id).status).toBe('error')
  })

  it('counts moderator requests in the hard call limit and rejects invalid speaker JSON', async () => {
    const h = setup({ mode: 'free', limits: { ...DEFAULT_LIMITS, maxCalls: 2 } })
    const session = h.create()
    const result = await h.status(session.id, 'paused')
    expect(result.run?.calls).toBe(2)
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(1)
    expect(() => h.engine.action({ sessionId: session.id, action: 'resume' })).toThrow('调用上限')
    const invalid = setup({ mode: 'free' }, async () => ({ text: '{"speakerId":"nonexistent","replyTo":null,"instruction":"讨论"}' }))
    const bad = invalid.create()
    expect((await invalid.status(bad.id, 'error')).run?.error).toContain('不存在')
    expect(invalid.get(bad.id).messages.at(-1)).toMatchObject({ status: 'failed', diagnostic: { code: 'invalid_schema' } })
    expect(invalid.requests).toHaveLength(1)
  })

  it('shares retrieved and searched evidence in both blind openings, with a bounded search budget', async () => {
    const h = setup({ searchEnabled: true, knowledgeBaseIds: ['kb'], limits: { ...DEFAULT_LIMITS, maxSearches: 1 } }, async (request, index) => {
      if (request.prompt.includes('只返回 JSON：{"query"')) return { text: '{"query":"公交改善 研究"}' }
      return { text: `独立答案-${index}` }
    })
    const local: Evidence = { id: 'local', sourceId: 'source', knowledgeBaseId: 'kb', title: '交通报告', text: '中文语义检索材料', locator: '第 2 页', kind: 'text', retrievedAt: new Date().toISOString() }
    const web: Evidence = { id: 'web', title: '网络交通研究', text: '联网得到的研究', locator: '网页', kind: 'web', url: 'https://example.org/report', retrievedAt: new Date().toISOString() }
    vi.mocked(h.evidence.retrieve).mockResolvedValue([local])
    vi.mocked(h.evidence.search).mockResolvedValue([web, web])
    const session = h.create()
    const result = await h.status(session.id, 'complete')
    expect(result.evidence).toHaveLength(2)
    expect(result.evidence[1].query).toBe('公交改善 研究')
    expect(result.run?.searches).toBe(1)
    expect(h.evidence.search).toHaveBeenCalledOnce()
    expect(h.requests[1].prompt).toContain('[local]')
    expect(h.requests[2].prompt).toContain('[web]')
    expect(h.requests[2].prompt).not.toContain('独立答案-2')
    expect(result.run?.calls).toBe(6)
  })

  it('requires the user to choose continuing after failed search and does not invent evidence', async () => {
    const h = setup({ searchEnabled: true, limits: { ...DEFAULT_LIMITS, maxSearches: 1 } }, async (request) => ({ text: request.prompt.includes('只返回 JSON：{"query"') ? '{"query":"测试"}' : '没有外部证据的回答' }))
    vi.mocked(h.evidence.search).mockRejectedValue(new Error('搜索服务超时'))
    const session = h.create()
    let result = await h.status(session.id, 'error')
    expect(result.run?.errorTask).toBe('search')
    expect(result.evidence).toEqual([])
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(0)
    h.engine.action({ sessionId: session.id, action: 'skip' })
    result = await h.status(session.id, 'complete')
    expect(result.evidence).toEqual([])
    expect(result.messages.some(m => m.content.includes('用户选择跳过'))).toBe(true)
    expect(h.evidence.search).toHaveBeenCalledOnce()
  })

  it('retrieves knowledge again for a user supplement and retains both old and new evidence snapshots', async () => {
    const oldResponse = deferred<ChatResult>()
    const h = setup({ knowledgeBaseIds: ['kb'] }, async (_request, index) => index === 1 ? oldResponse.promise : { text: `新的回答-${index}` })
    const original: Evidence = { id: 'original', title: '旧资料', text: '原议题资料', locator: '第 1 页', kind: 'text', retrievedAt: '2026-01-01' }
    const added: Evidence = { id: 'added', title: '无障碍资料', text: '最新补充检索资料', locator: '第 2 页', kind: 'text', retrievedAt: '2026-01-02' }
    vi.mocked(h.evidence.retrieve).mockResolvedValueOnce([original]).mockResolvedValueOnce([added])
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    h.engine.interject({ sessionId: session.id, text: '无障碍出行还有哪些证据？' })
    const result = await h.status(session.id, 'complete')
    expect(h.evidence.retrieve).toHaveBeenCalledTimes(2)
    const renewedQuery = vi.mocked(h.evidence.retrieve).mock.calls[1][1]
    expect(renewedQuery).toContain(h.input.topic)
    expect(renewedQuery).toContain('无障碍出行')
    expect(h.requests[1].prompt).toContain('最新补充检索资料')
    expect(result.evidence.map(e => e.id)).toEqual(['original', 'added'])
    oldResponse.resolve({ text: '无效旧结果' })
  })

  it('pauses when the final available call is used by moderator selection', async () => {
    const h = setup({ mode: 'free', limits: { ...DEFAULT_LIMITS, maxCalls: 1 } })
    const session = h.create()
    const result = await h.status(session.id, 'paused')
    expect(result.run?.calls).toBe(1)
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(0)
    expect(result.run?.error).toContain('调用上限')
  })

  it('counts each knowledge query embedding and blocks extra embedding requests at the hard limit', async () => {
    const h = setup({ knowledgeBaseIds: ['one', 'two'], limits: { ...DEFAULT_LIMITS, maxCalls: 1 } })
    let embedded = 0
    vi.mocked(h.evidence.retrieve).mockImplementation(async (_ids, _query, _signal, beforeModelCall) => {
      beforeModelCall?.()
      embedded++
      beforeModelCall?.()
      embedded++
      return []
    })
    const session = h.create()
    const result = await h.status(session.id, 'paused')
    expect(embedded).toBe(1)
    expect(result.run?.calls).toBe(1)
    expect(h.requests).toHaveLength(0)
    expect(result.run?.error).toContain('Embedding')
  })

  it('keeps original messages while making a shared, source-mapped context summary', async () => {
    let hostChoice = 0
    const h = setup({ mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 8, contextChars: 4000 } }, async request => {
      if (request.prompt.includes('只返回 JSON：{"speakerId"')) return { text: JSON.stringify({ speakerId: hostChoice++ % 2 ? 'b' : 'a', replyTo: null, instruction: '论证' }) }
      if (request.prompt.includes('请压缩以下早期讨论')) return { text: '摘要保留双方观点和未决分歧。' }
      return { text: '保留原始内容'.repeat(250) }
    })
    const session = h.create()
    const result = await h.status(session.id, 'paused')
    expect(result.run?.summary).toContain('本次摘要来源消息：')
    expect(result.run?.summaryThrough).toBeTruthy()
    expect(result.messages.filter(m => m.kind === 'assistant')).toHaveLength(8)
    expect(result.messages.filter(m => m.phase === 'compression')).toHaveLength(1)
    expect(result.run?.calls).toBe(17)
    expect(h.requests.at(-1)?.prompt).toContain('不是原始证据')
    expect(result.messages.find(m => m.kind === 'assistant')?.content).toHaveLength(1500)
  })

  it('does not invent usage and does not automatically replay interrupted requests on restart', async () => {
    const pending = deferred<ChatResult>()
    const h = setup({}, () => pending.promise)
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    const secondGateway = { ...h.gateway, chat: vi.fn(async () => ({ text: '应由用户继续' })) }
    const restarted = new DiscussionEngine(h.store, secondGateway, h.evidence, () => {})
    const stored = h.get(session.id)
    expect(stored.status).toBe('paused')
    expect(stored.messages.at(-1)?.status).toBe('interrupted')
    expect(secondGateway.chat).not.toHaveBeenCalled()
    expect(stored.messages.at(-1)?.usage).toBeUndefined()
    h.engine.shutdown()
    pending.resolve({ text: '迟到' })
    restarted.shutdown()
  })

  it('requires stop and completed cleanup before deletion, and rejects stale results', async () => {
    const pending = deferred<ChatResult>()
    const h = setup({}, () => pending.promise)
    const session = h.create()
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(() => h.engine.remove(session.id)).toThrow('请先停止')
    h.engine.action({ sessionId: session.id, action: 'stop' })
    expect(h.engine.isActive(session.id)).toBe(true)
    expect(() => h.engine.remove(session.id)).toThrow('收尾')
    const save = vi.spyOn(h.store, 'saveSession')
    expect(h.requests[0].signal.aborted).toBe(true)
    pending.resolve({ text: '已删除会话的旧回答' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(h.engine.isActive(session.id)).toBe(false)
    h.engine.remove(session.id)
    vi.spyOn(h.store, 'getSession').mockReturnValue(undefined)
    expect(save).not.toHaveBeenCalled()
    expect(() => h.engine.action({ sessionId: session.id, action: 'resume' })).toThrow('不存在')
  })
  it('allows more than five searches with null limit and freezes web tools before independent openings', async () => {
    const h = setup({ searchEnabled: true, moderator: undefined, participants: Array.from({ length: 6 }, (_, i) => ({ id: `seat-${i}`, name: `成员${i}`, model: { providerId: 'p', modelId: `m${i}` }, role: '' })) }, async request => ({ text: request.prompt.includes('只返回 JSON：{"query"') ? JSON.stringify({ query: `资料-${request.model.modelId}` }) : '根据共同证据回答' }))
    const close = vi.fn(), search = vi.fn(async (query: string): Promise<Evidence[]> => [{ id: query, title: query, text: `共同材料${query}`, locator: 'https://example.org', url: 'https://example.org', kind: 'web', retrievedAt: '' }])
    h.evidence.web = vi.fn(async () => ({ source: '冻结来源', snapshots: { search: { selection: { mode: 'direct' as const }, label: '固定线路' } }, search, read: async () => [], close }))
    const session = h.create(), result = await h.status(session.id, 'complete')
    expect(result.run?.searches).toBe(6); expect(search).toHaveBeenCalledTimes(6)
    expect(h.evidence.web).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce(); expect(h.evidence.search).not.toHaveBeenCalled()
    expect(result.run?.webSnapshots?.[0]).toMatchObject({ source: '冻结来源', search: { label: '固定线路' } })
    for (const request of h.requests.filter(item => item.prompt.includes('本次发言任务') && item.prompt.includes('独立作答'))) {
      for (let i = 0; i < 6; i++) expect(request.prompt).toContain(`共同材料资料-m${i}`)
    }
  })
  it('keeps discussion active until frozen web scope cleanup completes after stop', async () => {
    const closing = deferred<void>(), replying = deferred<ChatResult>()
    const h = setup({ searchEnabled: true }, request => request.prompt.includes('只返回 JSON：{"query"') ? Promise.resolve({ text: '{"query":null}' }) : replying.promise)
    h.evidence.web = async () => ({ source: '免Key搜索', search: async () => [], read: async () => [], close: () => closing.promise })
    const session = h.create(); await vi.waitFor(() => expect(h.requests).toHaveLength(2))
    h.engine.action({ sessionId: session.id, action: 'stop' }); replying.resolve({ text: '迟到回答' })
    expect(h.engine.isActive(session.id)).toBe(true); expect(() => h.engine.remove(session.id)).toThrow('收尾')
    closing.resolve(); await vi.waitFor(() => expect(h.engine.isActive(session.id)).toBe(false))
    expect(h.events.findLast(event => event.type === 'activity')?.activeSessionIds).toEqual([])
    expect(h.get(session.id).messages.some(message => message.content === '迟到回答')).toBe(false)
  })
  it('explicit manual search freezes a scope even when automatic web permission is off', async () => {
    const h = setup({ searchEnabled: false, mode: 'free', limits: { ...DEFAULT_LIMITS, autoTurns: 1 } }), close = vi.fn(), search = vi.fn(async () => [])
    h.evidence.web = vi.fn(async () => ({ source: '手动搜索快照', search, read: async () => [], close }))
    const session = h.create(); await h.status(session.id, 'paused'); expect(h.evidence.web).not.toHaveBeenCalled()
    const result = await h.engine.manualSearch(session.id, '手动请求')
    expect(h.evidence.web).toHaveBeenCalledOnce(); expect(search).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    expect(result.searchEnabled).toBe(false); expect(result.run?.webSnapshots?.[0].source).toBe('手动搜索快照'); expect(h.evidence.search).not.toHaveBeenCalled()
  })
  it('uses the selected MCP scope for source and route when project binding changes during setup', async () => {
    const h = setup({ projectId: 'project', searchEnabled: true }, async request => ({ text: request.prompt.includes('只返回 JSON：{"query"') ? '{"query":"固定查询"}' : '回答' }))
    let binding = 'selected'
    h.evidence.tools = async () => {
      const captured = binding; binding = 'changed'
      return { tools: [], call: async () => ({}), close: async () => {}, searchSource: `MCP-${captured}`, searchExtensionId: captured, search: async () => [{ id: captured, title: captured, text: '工具证据', kind: 'tool', locator: captured, retrievedAt: '' }] }
    }
    h.evidence.web = async (_session, _signal, tools) => {
      expect(binding).toBe('changed'); expect(tools?.searchExtensionId).toBe('selected')
      return { source: tools!.searchSource!, snapshots: { search: { selection: { mode: 'direct' }, label: tools!.searchExtensionId! } }, search: async () => { throw new Error('不应退回默认来源') }, read: async () => [], close: async () => {} }
    }
    const session = h.create(), result = await h.status(session.id, 'complete')
    expect(result.evidence[0]).toMatchObject({ id: 'selected', searchSource: 'MCP-selected', network: { label: 'selected' } })
    expect(result.run?.webSnapshots?.[0]).toMatchObject({ source: 'MCP-selected', search: { label: 'selected' } })
  })
})
