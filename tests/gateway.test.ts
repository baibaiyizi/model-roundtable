import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/main/gateway'
import { WebSearch } from '../src/main/search'
import { startMockAPI } from './helpers/mock-api'
import type { Provider } from '../src/shared/types'

describe('OpenAI compatible gateway integration', () => {
  let mock: Awaited<ReturnType<typeof startMockAPI>>
  let provider: Provider
  let key = 'test-key'
  let gateway: Gateway
  beforeEach(async () => {
    mock = await startMockAPI()
    key = 'test-key'
    provider = { id: 'p', name: 'test', baseUrl: `${mock.url}/v1`, modelIds: [], hasKey: true, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 3000 }
    gateway = new Gateway({ getProvider: () => provider, getSecret: async () => key })
  })
  afterEach(async () => { await mock.close() })
  it('discovers model IDs and streams content and actual usage', async () => {
    expect(await gateway.discover('p')).toContain('analyst')
    const deltas: string[] = []
    const result = await gateway.chat({ model: { providerId: 'p', modelId: 'analyst' }, system: 'test', prompt: '你好', signal: new AbortController().signal, maxOutputTokens: 100, onDelta: delta => deltas.push(delta) })
    expect(deltas.join('')).toBe(result.text)
    expect(result.usage?.totalTokens).toBe(140)
    expect(mock.calls[0].body.max_tokens).toBe(100)
    expect(mock.calls[0].authorization).toBe('Bearer test-key')
  })
  it('does not invent usage when a compatible service omits it', async () => {
    provider.streamUsage = false
    const result = await gateway.chat({ model: { providerId: 'p', modelId: 'analyst' }, system: 'test', prompt: '你好', signal: new AbortController().signal, maxOutputTokens: 100, onDelta: () => {} })
    expect(result.usage).toBeUndefined()
    expect(mock.calls[0].body.stream_options).toBeUndefined()
  })
  it('reports 401 and 429 without implicit retries or leaking upstream details', async () => {
    key = 'reject-me'
    await expect(gateway.chat({ model: { providerId: 'p', modelId: 'analyst' }, system: '', prompt: '', maxOutputTokens: 64, signal: new AbortController().signal })).rejects.toThrow('认证失败')
    expect(mock.calls.length).toBe(1)
    key = 'test-key'
    await expect(gateway.chat({ model: { providerId: 'p', modelId: 'rate-limited' }, system: '', prompt: '', maxOutputTokens: 64, signal: new AbortController().signal })).rejects.toThrow('限流')
    expect(mock.calls.length).toBe(2)
  })
  it('cancels streaming and accepts a separate embedding capability', async () => {
    const controller = new AbortController()
    await expect(gateway.chat({ model: { providerId: 'p', modelId: 'slow' }, system: '', prompt: '', maxOutputTokens: 100, signal: controller.signal, onDelta: () => controller.abort() })).rejects.toBeDefined()
    const vectors = await gateway.embed({ providerId: 'p', modelId: 'embedding' }, ['太阳能', '普通资料'], new AbortController().signal)
    expect(vectors).toEqual([[1,0,0,0],[0,1,0,0]])
  })
  it('shares deduplicated search evidence with provenance', async () => {
    const search = new WebSearch(async () => 'search-test-key', `${mock.url}/search`)
    const rows = await search.search('测试问题', new AbortController().signal)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ query: '测试问题', kind: 'web', url: 'https://example.org/source' })
    expect(rows[0].retrievedAt).toBeTruthy()
  })
  it('does not treat a prematurely closed SSE response as a completed answer', async () => {
    await expect(gateway.chat({ model: { providerId: 'p', modelId: 'cut-stream' }, system: '', prompt: 'test', maxOutputTokens: 100, signal: new AbortController().signal, onDelta: () => {} })).rejects.toThrow('流式连接提前结束')
  })
  it('enforces the provider deadline after SSE headers and the first chunk without retrying', async () => {
    provider.timeoutMs = 200
    const release = mock.holdSlowStreams()
    const controller = new AbortController()
    const watchdog = setTimeout(() => controller.abort(new Error('test watchdog: stream never timed out')), 1500)
    const chunks: string[] = []
    try {
      await expect(gateway.chat({ model: { providerId: 'p', modelId: 'slow' }, system: '', prompt: '超时测试', maxOutputTokens: 100, signal: controller.signal, onDelta: delta => chunks.push(delta) })).rejects.toThrow('模型服务超时')
      expect(chunks).toHaveLength(1)
      expect(controller.signal.aborted).toBe(false)
      expect(mock.calls).toHaveLength(1)
    } finally { clearTimeout(watchdog); release(); controller.abort() }
  })
  it('preserves the user cancellation reason instead of reporting a provider timeout', async () => {
    const release = mock.holdSlowStreams()
    const controller = new AbortController()
    const reason = new Error('用户停止讨论')
    try {
      await expect(gateway.chat({ model: { providerId: 'p', modelId: 'slow' }, system: '', prompt: '停止测试', maxOutputTokens: 100, signal: controller.signal, onDelta: () => controller.abort(reason) })).rejects.toBe(reason)
      expect(mock.calls).toHaveLength(1)
    } finally { release(); controller.abort() }
  })
})
