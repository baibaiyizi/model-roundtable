import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Gateway } from '../src/main/gateway'
import { testToolCalling } from '../src/main/execution/probe'
import type { NetworkLease, ProviderNetworkPort } from '../src/shared/network'
import type { Provider } from '../src/shared/types'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map(close => close())) })
async function endpoint(name: string) {
  const calls: Array<{ path: string; body: any }> = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString()
    const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : {}
    calls.push({ path: req.url!, body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: name }] }))
    if (req.url === '/v1/embeddings') return res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }))
    if (req.url === '/v1/audio/transcriptions') return res.end(JSON.stringify({ text: name }))
    const text = body.response_format ? '{"ok":true}' : name
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.write(`data: ${JSON.stringify({ id: name, choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`)
      if (body.model === 'held') return
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    }
    const message = body.tools ? { tool_calls: [{ function: { name: 'connection_probe', arguments: '{"ok":true}' } }] } : { content: text }
    res.end(JSON.stringify({ id: name, choices: [{ message, finish_reason: 'stop' }] }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  return { url, calls }
}
function routed(routes: Record<string, string>) {
  let held = 0, acquired = 0
  const acquireForProviders = vi.fn(async (ids: string[]): Promise<NetworkLease> => {
    held++; acquired++
    const frozen = structuredClone(routes); let released = false
    return {
      snapshots: Object.fromEntries(ids.map(id => [id, { selection: { mode: 'direct' }, label: id }])),
      fetchForProvider: id => {
        if (!ids.includes(id)) throw new Error('provider not leased')
        return (input, init) => {
          const request = new Request(input, init), source = new URL(request.url)
          return fetch(new Request(`${frozen[id]}${source.pathname}${source.search}`, request))
        }
      },
      environmentForProvider: async () => ({}),
      release: () => { if (!released) { held--; released = true } },
    }
  })
  return { network: { acquireForProviders } as unknown as ProviderNetworkPort, acquireForProviders, metrics: () => ({ held, acquired }) }
}
const provider = (id: string): Provider => ({ id, name: id, baseUrl: 'http://no-default-route.invalid/v1', hasKey: false, modelIds: ['model'], tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 3000 })
function gateway(network: ProviderNetworkPort) {
  const unselected = vi.fn<typeof fetch>(async () => { throw new Error('unselected transport must never be called') })
  return { gateway: new Gateway({ getProvider: provider, getSecret: async () => '' }, unselected, undefined, network), unselected }
}
const request = (id: string, signal = new AbortController().signal) => ({ model: { providerId: id, modelId: 'model' }, system: '', prompt: '网络验收', maxOutputTokens: 50, signal })

describe('模型服务网络接线（受控 HTTP 上游）', () => {
  it('显式线路缺少网络管理器时拒绝请求，不采用宿主默认网络', async () => {
    const configured = { ...provider('a'), network: { mode: 'direct' as const } }
    const fallback = vi.fn<typeof fetch>(async () => { throw new Error('must not be reached') })
    const gateway = new Gateway({ getProvider: () => configured, getSecret: async () => '' }, fallback)
    await expect(gateway.chat(request('a'))).rejects.toThrow('网络线路尚未准备')
    await expect(testToolCalling(configured, '', 'model', fallback)).rejects.toThrow('网络线路尚未准备')
    expect(fallback).not.toHaveBeenCalled()
  })
  it('所有 API 能力、原生 JSON 与工具测试使用各自服务的 transport', async () => {
    const a = await endpoint('线路 A'), b = await endpoint('线路 B'), h = routed({ a: a.url, b: b.url }), g = gateway(h.network)
    const directory = await mkdtemp(join(tmpdir(), 'route-audio-')), audio = join(directory, '样本.wav')
    cleanup.push(() => rm(directory, { recursive: true, force: true })); await writeFile(audio, 'synthetic audio')
    const [first, second] = await Promise.all([g.gateway.chat(request('a')), g.gateway.chat({ ...request('b'), onDelta: () => {}, images: ['data:image/png;base64,AA=='] })])
    expect([first.text, second.text]).toEqual(['线路 A', '线路 B'])
    expect(first.network?.label).toBe('a')
    expect(await g.gateway.discover('b')).toEqual(['线路 B'])
    expect(await g.gateway.embed(request('a').model, ['资料'], request('a').signal)).toEqual([[1, 2]])
    expect(await g.gateway.transcribe(request('b').model, audio, request('b').signal)).toBe('线路 B')
    expect((await g.gateway.testStructured(request('a').model, 'json_object', request('a').signal)).mode).toBe('json_object')
    expect((await testToolCalling(provider('b'), '', 'model', g.unselected, request('b').signal, h.network)).text).toContain('成功')
    expect(a.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/embeddings', '/v1/chat/completions'])
    expect(b.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/models', '/v1/audio/transcriptions', '/v1/chat/completions'])
    expect(g.unselected).not.toHaveBeenCalled(); expect(h.metrics()).toEqual({ held: 0, acquired: 7 })
  })
  it('共享任务 lease 保持原线路且只由任务持有者释放', async () => {
    const a = await endpoint('旧线路'), b = await endpoint('新线路'), routes = { a: a.url }, h = routed(routes), g = gateway(h.network)
    const lease = await h.network.acquireForProviders(['a'])
    routes.a = b.url
    expect((await g.gateway.chat({ ...request('a'), network: lease })).text).toBe('旧线路')
    expect((await g.gateway.chat({ ...request('a'), network: lease })).text).toBe('旧线路')
    expect(h.metrics()).toEqual({ held: 1, acquired: 1 }); lease.release()
    expect((await g.gateway.chat(request('a'))).text).toBe('新线路')
    expect(h.metrics().held).toBe(0)
  })
  it('线路失败不调用默认网络，流中止后释放请求 lease', async () => {
    const api = await endpoint('流式线路'), h = routed({ a: api.url }), g = gateway(h.network), controller = new AbortController()
    await expect(g.gateway.chat({ ...request('a', controller.signal), model: { providerId: 'a', modelId: 'held' }, onDelta: () => controller.abort(new Error('用户停止')) })).rejects.toThrow('用户停止')
    expect(h.metrics().held).toBe(0)
    const lease = await h.network.acquireForProviders(['a'])
    lease.fetchForProvider = () => async () => { throw new Error('selected proxy unavailable') }
    await expect(g.gateway.chat({ ...request('a'), network: lease })).rejects.toThrow('无法连接')
    expect(api.calls).toHaveLength(1); expect(g.unselected).not.toHaveBeenCalled(); lease.release()
  })
  it('取消发生在路由准备期间时不发送请求，并释放迟到 lease', async () => {
    const api = await endpoint('不得请求'), h = routed({ a: api.url }), lease = await h.network.acquireForProviders(['a'])
    let finish!: (lease: NetworkLease) => void
    h.acquireForProviders.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const g = gateway(h.network), controller = new AbortController()
    const pending = g.gateway.chat(request('a', controller.signal))
    controller.abort(new Error('提前取消')); finish(lease)
    await expect(pending).rejects.toThrow('提前取消')
    expect(api.calls).toEqual([]); expect(h.metrics().held).toBe(0)
  })
})
