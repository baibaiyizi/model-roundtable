import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ModelResponseError, parseStructured } from '../src/main/structured'

const query = z.object({ query: z.string().nullable() }).strict()
describe('structured model output', () => {
  it.each([
    '<think>先考虑示例 {"query":"不能选这个示例"}，最终不需要搜索。</think>\n```json\n{"query":null}\n```',
    '<think>参考对象 {"query":"示例"} 不是最终结果。</think>\n{"query":null}',
    '```JSON\n{"query":null}\n```',
    '{"query":null}',
  ])('accepts complete leading wrappers without choosing reasoning examples', text => {
    expect(parseStructured({ text, finishReason: 'stop' }, query).value).toEqual({ query: null })
  })
  it('preserves tags and code fences inside valid JSON strings', () => {
    const value = { query: '解释 <think>文字</think> 和 ```json 的含义' }
    const parsed = parseStructured({ text: JSON.stringify(value) }, query)
    expect(parsed.value).toEqual(value); expect(parsed.diagnostic.normalizations).toBeUndefined()
  })
  it.each([
    ['这是答案：{"query":null}', 'invalid_json'],
    ['{"query":null}\n{"query":"第二个"}', 'invalid_json'],
    ['<think>没有闭合 {"query":null}', 'incomplete_reasoning'],
    ['<think>只有思考。</think>', 'empty'],
    ['{"query":', 'invalid_json'],
    ['{"query":42}', 'invalid_schema'],
    ['{"query":null,"command":"不应执行"}', 'invalid_schema'],
  ])('rejects malformed or ambiguous output: %s', (text, code) => {
    let failure: unknown
    try { parseStructured({ text, responseId: 'response-test' }, query) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(ModelResponseError)
    expect(failure).toMatchObject({ response: { text }, diagnostic: { code, rawChars: text.length, responseId: 'response-test' } })
    expect((failure as Error).message).not.toContain(text)
  })
  it('rejects a length-limited response even if its partial JSON happens to be valid', () => {
    expect(() => parseStructured({ text: '{"query":null}', finishReason: 'length' }, query)).toThrow('截断')
  })
})
