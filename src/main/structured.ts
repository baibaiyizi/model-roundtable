import { z } from 'zod'
import type { ChatResult } from '../shared/ports'
import type { ResponseDiagnostic, ResponseIssue, StructuredRequest } from '../shared/structured'

export interface StructuredSpec<T> { request: StructuredRequest; schema: z.ZodType<T> }
export function structuredSpec<T>(name: string, schema: z.ZodType<T>): StructuredSpec<T> {
  return { request: { name, jsonSchema: z.toJSONSchema(schema, { target: 'draft-7' }) }, schema }
}
export function responseDiagnostic(result: ChatResult, maxOutputTokens?: number): ResponseDiagnostic {
  return { rawChars: result.text.length, finishReason: result.finishReason, refusal: result.refusal, responseId: result.responseId, structuredMode: result.structuredMode, maxOutputTokens }
}
/** Keeps model content in local records without putting it in an error or log message. */
export class ModelResponseError extends Error {
  readonly diagnostic: ResponseDiagnostic
  constructor(message: string, readonly response: ChatResult, code: ResponseIssue, normalizations?: ResponseDiagnostic['normalizations']) {
    super(message); this.name = 'ModelResponseError'
    this.diagnostic = { ...responseDiagnostic(response), code, ...(normalizations?.length ? { normalizations } : {}) }
  }
}
export function assertCompleteResponse(result: ChatResult): void {
  if (result.refusal || result.finishReason === 'content_filter') throw new ModelResponseError('模型拒绝了本次请求，未得到可用结果。', result, 'refusal')
  if (result.finishReason === 'length' || result.finishReason === 'max_tokens') throw new ModelResponseError('模型回答达到输出上限而被截断，请提高上限后手动重试。', result, 'truncated')
  if (result.finishReason && !['stop', 'end_turn', 'completed'].includes(result.finishReason)) throw new ModelResponseError(`模型未以正常文本回答结束（${result.finishReason}）。`, result, 'unexpected_finish')
  if (!result.text.trim()) throw new ModelResponseError('模型没有返回文字内容。请检查输出上限或模型是否适合聊天。', result, 'empty')
}
export function parseStructured<T>(result: ChatResult, schema: z.ZodType<T>): { value: T; diagnostic: ResponseDiagnostic } {
  assertCompleteResponse(result)
  let text = result.text.trim()
  const normalizations: NonNullable<ResponseDiagnostic['normalizations']> = []
  let value: unknown
  try { value = JSON.parse(text) } catch {
    // Only remove complete leading wrappers, never tags inside JSON string values.
    while (/^<think>/i.test(text)) {
      const close = text.toLowerCase().indexOf('</think>')
      if (close < 0) throw new ModelResponseError('模型的思考块没有结束，未得到完整 JSON。请检查输出上限后重试。', result, 'incomplete_reasoning', normalizations)
      text = text.slice(close + '</think>'.length).trim(); normalizations.push('think')
    }
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    if (fence) { text = fence[1].trim(); normalizations.push('fence') }
    if (!text) throw new ModelResponseError('模型只返回思考或空代码块，没有返回 JSON 结果。', result, 'empty', normalizations)
    try { value = JSON.parse(text) }
    catch { throw new ModelResponseError('模型返回的 JSON 无法解析：结果含非 JSON 文字或格式不完整。原始响应已保留，请查看后手动重试。', result, 'invalid_json', normalizations) }
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map(issue => issue.path.map(String).join('.') || '根对象'))].join('、')
    const custom = parsed.error.issues.find(issue => issue.code === 'custom')?.message
    throw new ModelResponseError(custom ?? `模型返回的 JSON 字段不符合约定（${paths}）。请查看原始响应后手动重试。`, result, 'invalid_schema', normalizations)
  }
  return { value: parsed.data, diagnostic: { ...responseDiagnostic(result), ...(normalizations.length ? { normalizations } : {}) } }
}
