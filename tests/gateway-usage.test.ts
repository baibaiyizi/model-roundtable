import { describe, expect, it } from 'vitest'
import { Gateway } from '../src/main/gateway'
import { exportMarkdown } from '../src/main/export'
import { DEFAULT_LIMITS, type Provider, type Session, type Usage } from '../src/shared/types'

const provider: Provider = { id: 'usage-test', name: '用量测试', baseUrl: 'https://gateway.invalid/v1', modelIds: ['chat'], hasKey: false, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 3000 }
const cases: { name: string; json: string; expected?: Usage }[] = [
  { name: 'empty object', json: '{}' },
  { name: 'null value', json: 'null' },
  { name: 'unexpected array', json: '[]' },
  { name: 'input only has no aggregate', json: '{"prompt_tokens":12}' },
  { name: 'output only has no aggregate', json: '{"completion_tokens":8}' },
  { name: 'actual total without invented components', json: '{"total_tokens":20}', expected: { totalTokens: 20 } },
  { name: 'total with one actual component', json: '{"prompt_tokens":12,"total_tokens":20}', expected: { inputTokens: 12, totalTokens: 20 } },
  { name: 'two actual components can be summed', json: '{"prompt_tokens":12,"completion_tokens":8}', expected: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
  { name: 'actual total takes precedence', json: '{"prompt_tokens":12,"completion_tokens":8,"total_tokens":23}', expected: { inputTokens: 12, outputTokens: 8, totalTokens: 23 } },
  { name: 'reported zero total remains real zero', json: '{"total_tokens":0}', expected: { totalTokens: 0 } },
  { name: 'two reported zero components remain real zero', json: '{"prompt_tokens":0,"completion_tokens":0}', expected: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  { name: 'negative total is unknown', json: '{"total_tokens":-1}' },
  { name: 'negative component cannot create an aggregate', json: '{"prompt_tokens":-2,"completion_tokens":8}' },
  { name: 'valid total does not legitimize invalid components', json: '{"prompt_tokens":-2,"completion_tokens":1e309,"total_tokens":20}', expected: { totalTokens: 20 } },
  { name: 'nonfinite total is unknown', json: '{"total_tokens":1e309}' },
  { name: 'negative nonfinite input is unknown', json: '{"prompt_tokens":-1e309,"completion_tokens":8}' },
  { name: 'valid components can replace an invalid aggregate', json: '{"prompt_tokens":12,"completion_tokens":8,"total_tokens":-1}', expected: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
  { name: 'numeric strings are not reported counts', json: '{"prompt_tokens":"12","completion_tokens":"8","total_tokens":"20"}' },
  { name: 'fractional counts are invalid', json: '{"prompt_tokens":1.5,"completion_tokens":2.5}' },
  { name: 'unsafe sum is not displayed as an exact count', json: '{"prompt_tokens":9007199254740991,"completion_tokens":1}' },
]

describe.each([false, true])('usage through actual SDK parsing (stream=%s)', stream => {
  it.each(cases)('$name', async ({ json, expected }) => {
    // Exercise Gateway and the SDK with raw HTTP response bodies; 1e309 must
    // survive JSON parsing as Infinity instead of JSON.stringify coercing null.
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      expect(request.stream).toBe(stream)
      if (stream) return new Response(
        'data: {"id":"u","object":"chat.completion.chunk","created":1,"model":"chat","choices":[{"index":0,"delta":{"content":"有文字回答"},"finish_reason":null}]}\n\n'
        + `data: {"id":"u","object":"chat.completion.chunk","created":1,"model":"chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":${json}}\n\n`
        + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      return new Response(`{"id":"u","object":"chat.completion","created":1,"model":"chat","choices":[{"index":0,"message":{"role":"assistant","content":"有文字回答"},"finish_reason":"stop"}],"usage":${json}}`, { headers: { 'Content-Type': 'application/json' } })
    }
    const gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'usage-test-key' }, fetcher)
    const result = await gateway.chat({ model: { providerId: provider.id, modelId: 'chat' }, system: '', prompt: '测试用量', maxOutputTokens: 100, signal: new AbortController().signal, ...(stream ? { onDelta: () => {} } : {}) })
    expect(result.text).toBe('有文字回答')
    expect(result.usage).toEqual(expected)
  })
})

describe('usage in exported transcripts', () => {
  const sessionWithUsage = (usage: Usage): Session => ({
    id: 's', title: '用量导出', topic: '问题', mode: 'roundtable', participants: [], moderator: { providerId: 'p', modelId: 'chat' }, knowledgeBaseIds: [], searchEnabled: false, limits: DEFAULT_LIMITS,
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', status: 'complete', evidence: [],
    messages: [{ id: 'm', sessionId: 's', runId: 'r', turnId: 't', contextVersion: 1, speakerId: 'p', speakerName: '模型', kind: 'assistant', phase: 'opening', content: '回答', status: 'complete', createdAt: '2026-09-23T00:00:00.000Z', usage }]
  })
  it('shows an actual total and explicitly labels missing components', () => {
    const output = exportMarkdown(sessionWithUsage({ totalTokens: 20 }))
    expect(output).toContain('总计 20 / 输入 未报告 / 输出 未报告')
    expect(output).not.toMatch(/undefined|NaN|Infinity|输入 0|输出 0/)
  })
  it('keeps an actual zero component without inventing the other component', () => {
    expect(exportMarkdown(sessionWithUsage({ inputTokens: 0, totalTokens: 8 }))).toContain('总计 8 / 输入 0 / 输出 未报告')
  })
  it('does not render invalid stored numbers as usage', () => {
    for (const invalid of [NaN, Infinity, -1, 0.5]) {
      expect(exportMarkdown(sessionWithUsage({ totalTokens: invalid }))).not.toContain('*用量：')
      const output = exportMarkdown(sessionWithUsage({ totalTokens: 20, inputTokens: invalid, outputTokens: invalid }))
      expect(output).toContain('总计 20 / 输入 未报告 / 输出 未报告')
      expect(output).not.toMatch(/NaN|Infinity|输入 -1|输出 -1/)
    }
  })
})
