import { describe, expect, it } from 'vitest'
import { Gateway } from '../src/main/gateway'
import type { Provider } from '../src/shared/types'
import type { ChatRequest } from '../src/shared/ports'
import { ModelResponseError } from '../src/main/structured'

const provider: Provider = { id: 'p', name: 'gateway', baseUrl: 'https://example.invalid/v1', modelIds: ['model'], hasKey: true, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 3000 }
const request: ChatRequest = { model: { providerId: 'p', modelId: 'model' }, system: 'Return JSON', prompt: 'JSON', maxOutputTokens: 1500, signal: new AbortController().signal, structured: { name: 'test', jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }
const completion = (text = '{"ok":true}', finish = 'stop', refusal?: string) => Response.json({ id: 'response-123', choices: [{ index: 0, message: { role: 'assistant', content: text, refusal }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })

describe('gateway structured capabilities and diagnostics', () => {
  it('supports an unauthenticated local endpoint without sending placeholder credentials', async () => {
    const gateway = new Gateway({ getProvider: () => ({ ...provider, hasKey: false }), getSecret: async () => '' }, async (_url, init) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      expect(new Headers(init?.headers).has('api-key')).toBe(false)
      return completion()
    })
    expect((await gateway.chat(request)).text).toBe('{"ok":true}')
  })
  it('sends native mode only for the tested model and URL, never for ordinary prose', async () => {
    const saved: Provider = { ...provider, structuredOutputs: { model: { mode: 'json_schema', baseUrl: provider.baseUrl, testedAt: 'now' } } }
    const bodies: Record<string, any>[] = []
    const gateway = new Gateway({ getProvider: () => saved, getSecret: async () => 'secret' }, async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completion() })
    expect((await gateway.chat(request)).structuredMode).toBe('json_schema')
    await gateway.chat({ ...request, structured: undefined })
    await gateway.chat({ ...request, model: { ...request.model, modelId: 'other' } })
    saved.baseUrl = 'https://changed.invalid/v1'; await gateway.chat(request)
    expect(bodies[0].response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'test', strict: true } })
    expect(bodies.slice(1).every(body => body.response_format === undefined)).toBe(true)
  })
  it.each(['json_object', 'json_schema'] as const)('probes %s exactly once without saving a capability itself', async mode => {
    let calls = 0
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async (_url, init) => { calls++; expect(JSON.parse(String(init?.body)).response_format.type).toBe(mode); return completion() })
    expect(await gateway.testStructured(request.model, mode, request.signal)).toMatchObject({ mode, baseUrl: provider.baseUrl })
    expect(calls).toBe(1); expect(provider.structuredOutputs).toBeUndefined()
  })
  it('does not downgrade or retry when the upstream rejects native JSON mode', async () => {
    let calls = 0
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => { calls++; return Response.json({ error: { message: 'unsupported response_format' } }, { status: 400 }) })
    await expect(gateway.testStructured(request.model, 'json_schema', request.signal)).rejects.toThrow('HTTP 400')
    expect(calls).toBe(1)
  })
  it('does not confirm native capability when only wrapper cleanup makes output valid', async () => {
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => completion('<think>思考</think>{"ok":true}'))
    await expect(gateway.testStructured(request.model, 'json_object', request.signal)).rejects.toThrow('未返回纯 JSON')
  })
  it.each([false, true])('keeps raw content, usage, response ID and truncation reason (stream=%s)', async stream => {
    const raw = '{"ok":true}'
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => stream
      ? new Response(`data: ${JSON.stringify({ id: 'response-123', choices: [{ index: 0, delta: { content: raw }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : completion(raw, 'length'))
    await expect(gateway.chat({ ...request, onDelta: stream ? () => {} : undefined })).rejects.toMatchObject({ response: { text: raw, finishReason: 'length', responseId: 'response-123', usage: { totalTokens: 22 } }, diagnostic: { code: 'truncated' } })
  })
  it('distinguishes refusal from empty content, and never treats separate reasoning as the answer', async () => {
    const refusal = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => completion('', 'stop', 'declined'))
    await expect(refusal.chat(request)).rejects.toMatchObject({ diagnostic: { code: 'refusal', refusal: 'declined' } })
    const reasoning = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => Response.json({ id: 'empty', choices: [{ message: { content: null, reasoning_content: 'internal reasoning' }, finish_reason: 'stop' }] }))
    await expect(reasoning.chat(request)).rejects.toMatchObject({ diagnostic: { code: 'empty' }, response: { text: '' } })
  })
  it('preserves ordinary prose and does not clean thinking tags in the gateway', async () => {
    const raw = '<think>可见模型内容</think>正文和 {"举例":true}'
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'secret' }, async () => completion(raw))
    expect((await gateway.chat({ ...request, structured: undefined })).text).toBe(raw)
    expect(new ModelResponseError('error', { text: raw }, 'invalid_json').message).not.toContain(raw)
  })
})
