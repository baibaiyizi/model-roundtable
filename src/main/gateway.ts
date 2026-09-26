import OpenAI from 'openai'
import { createReadStream } from 'node:fs'
import type { GatewayPort, ChatRequest, ChatResult } from '../shared/ports'
import type { ModelRef, Provider, Usage } from '../shared/types'
import type { Store } from './store'
import { isTokenCount } from '../shared/usage'
import type { StructuredCapability, StructuredMode } from '../shared/structured'
import { z } from 'zod'
import { assertCompleteResponse, ModelResponseError, parseStructured, structuredSpec } from './structured'
import type { NetworkLease, ProviderNetworkPort } from '../shared/network'

export function readableError(error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError || (error instanceof Error && error.name === 'TimeoutError')) return '模型服务超时，请检查网络或增加超时时间。'
  if (error instanceof OpenAI.APIConnectionError) return '无法连接模型服务，请检查地址、网络和服务状态。'
  if (error instanceof OpenAI.APIError) {
    const reasons: Record<number,string> = { 400: '接口拒绝了请求参数，请核对模型能力和高级参数。', 401: '认证失败，请核对 API 密钥。', 403: '当前密钥没有访问权限。', 404: '接口或模型不存在，请核对 API 地址和模型 ID。', 413: '资料超过服务的上传大小限制。', 429: '服务限流或额度不足，请稍后手动重试。', 500: '模型服务内部错误。', 502: '模型服务暂时不可用。', 503: '模型服务暂时不可用。' }
    return `HTTP ${error.status ?? '错误'}：${reasons[error.status ?? 0] ?? '模型服务请求失败，请检查服务日志。'}`
  }
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/sk-[A-Za-z0-9_-]+/g, '[密钥已隐藏]')
  return '操作失败，请重试。'
}

export class Gateway implements GatewayPort {
  constructor(private store: Pick<Store, 'getProvider' | 'getSecret'>, private fetcher: typeof fetch = fetch, private native?: { chat(request: ChatRequest): Promise<ChatResult>; discover(providerId: string): Promise<string[]> }, private network?: ProviderNetworkPort) {}
  private async client(providerId: string, network?: NetworkLease): Promise<{ client: OpenAI; provider: Provider }> {
    const provider = this.store.getProvider(providerId)
    if (!provider) throw new Error('模型所属服务已删除，请重新选择模型。')
    if (provider.kind && provider.kind !== 'api') throw new Error('该官方账号连接不支持此 API 能力，请另选 API 服务。')
    if (provider.network && provider.network.mode !== 'system' && !network) throw new Error('模型指定的网络线路尚未准备，未发送请求。')
    const key = await this.store.getSecret(`provider:${providerId}`)
    // The SDK requires a constructor credential even for unauthenticated local
    // endpoints. Its explicit null header omits authentication on the wire.
    const client = new OpenAI({ baseURL: provider.baseUrl, apiKey: key || 'unused', adminAPIKey: null, organization: null, project: null, defaultHeaders: key ? undefined : { Authorization: null }, maxRetries: 0, timeout: provider.timeoutMs, fetch: network ? network.fetchForProvider(providerId) : this.fetcher })
    return { client, provider }
  }
  async discover(providerId: string): Promise<string[]> {
    const provider = this.store.getProvider(providerId)
    if (provider?.kind && provider.kind !== 'api') {
      if (!this.native) throw new Error('官方账号后台尚未就绪。')
      return this.native.discover(providerId)
    }
    let deadline: AbortSignal | undefined
    let lease: NetworkLease | undefined
    try {
      deadline = AbortSignal.timeout(provider?.timeoutMs ?? 30000)
      lease = await this.network?.acquireForProviders([providerId], deadline)
      const { client } = await this.client(providerId, lease)
      const page = await client.models.list({ signal: deadline })
      deadline.throwIfAborted()
      return [...new Set(page.data.map(m => m.id).filter(Boolean))].sort()
    } catch (error) { throw new Error(readableError(deadline?.aborted ? deadline.reason : error)) }
    finally { lease?.release() }
  }
  async chat(request: ChatRequest): Promise<ChatResult> {
    return this.requestChat(request)
  }
  async testStructured(model: ModelRef, mode: Exclude<StructuredMode, 'text'>, signal: AbortSignal): Promise<StructuredCapability> {
    const provider = this.store.getProvider(model.providerId)
    if (!provider || (provider.kind && provider.kind !== 'api')) throw new Error('原生 JSON 能力测试仅用于 API 服务，官方账号当前使用文本协议。')
    if (!['json_object', 'json_schema'].includes(mode)) throw new Error('不支持的 JSON 测试模式。')
    const spec = structuredSpec('connection_probe', z.object({ ok: z.boolean() }).strict().refine(value => value.ok, { path: ['ok'], message: '模型未返回约定的确认结果。' }))
    const result = await this.requestChat({ model, signal, maxOutputTokens: 2048, system: '这是一次 JSON 输出能力测试。只返回 {"ok":true}，不要思考过程、解释或围栏。', prompt: '返回约定的 JSON 对象。', structured: spec.request }, mode)
    // A native-mode probe must return native JSON, not pass only after wrapper removal.
    const parsed = parseStructured(result, spec.schema)
    if (parsed.diagnostic.normalizations?.length) throw new ModelResponseError('接口未返回纯 JSON，尚不能确认此原生模式可用。请继续使用文本协议。', result, 'invalid_json')
    return { mode, baseUrl: provider.baseUrl, testedAt: new Date().toISOString() }
  }
  private async requestChat(request: ChatRequest, probeMode?: Exclude<StructuredMode, 'text'>): Promise<ChatResult> {
    request.signal.throwIfAborted()
    let owned: NetworkLease | undefined
    try {
      if (!request.network) owned = await this.network?.acquireForProviders([request.model.providerId], request.signal)
      const network = request.network ?? owned
      request.signal.throwIfAborted()
      const result = await this.requestChatOnRoute({ ...request, network }, probeMode)
      return { ...result, ...(network ? { network: network.snapshots[request.model.providerId] } : {}) }
    } finally { owned?.release() }
  }
  private async requestChatOnRoute(request: ChatRequest, probeMode?: Exclude<StructuredMode, 'text'>): Promise<ChatResult> {
    request.signal.throwIfAborted()
    const provider = this.store.getProvider(request.model.providerId)
    if (provider?.kind && provider.kind !== 'api') {
      if (!this.native) throw new Error('官方账号后台尚未就绪。')
      if (request.images?.length) throw new Error('官方账号讨论通道暂不支持图片输入，请指定 API 视觉模型。')
      const result = await this.native.chat(request)
      return { ...result, structuredMode: 'text' }
    }
    let deadline: AbortSignal | undefined
    const result: ChatResult = { text: '', structuredMode: 'text', ...(request.network ? { network: request.network.snapshots[request.model.providerId] } : {}) }
    try {
      const { client, provider } = await this.client(request.model.providerId, request.network)
      const capability = provider.structuredOutputs?.[request.model.modelId]
      const mode: StructuredMode = request.structured ? probeMode ?? (capability?.baseUrl === provider.baseUrl ? capability.mode : 'text') : 'text'
      result.structuredMode = mode
      const responseFormat = mode === 'json_schema' && request.structured
        ? { type: 'json_schema' as const, json_schema: { name: request.structured.name, strict: true, schema: request.structured.jsonSchema } }
        : mode === 'json_object' ? { type: 'json_object' as const } : undefined
      // The SDK timeout only bounds the fetch response, not a stalled SSE body.
      // Keep this signal active through the entire stream and preserve user stop.
      deadline = AbortSignal.any([request.signal, AbortSignal.timeout(provider.timeoutMs)])
      deadline.throwIfAborted()
      const content: OpenAI.ChatCompletionContentPart[] = [{ type: 'text', text: request.prompt }]
      for (const url of request.images ?? []) content.push({ type: 'image_url', image_url: { url } })
      const common = {
        model: request.model.modelId,
        messages: [
          { role: 'system' as const, content: request.system },
          { role: 'user' as const, content: request.images?.length ? content : request.prompt }
        ],
        ...(responseFormat ? { response_format: responseFormat } : {}),
        [provider.tokenParameter]: request.maxOutputTokens
      }
      if (request.onDelta) {
        const stream = await client.chat.completions.create({ ...common, stream: true, ...(provider.streamUsage ? { stream_options: { include_usage: true } } : {}) }, { signal: deadline })
        for await (const chunk of stream) {
          deadline.throwIfAborted()
          const delta = chunk.choices[0]?.delta?.content ?? ''
          if (chunk.id) result.responseId = chunk.id
          if (chunk.choices[0]?.finish_reason) result.finishReason = chunk.choices[0].finish_reason!
          const refusal = chunk.choices[0]?.delta?.refusal
          if (refusal) result.refusal = (result.refusal ?? '') + refusal
          result.text += delta
          if (delta) request.onDelta(delta)
          if (chunk.usage) result.usage = normalizeUsage(chunk.usage)
        }
        deadline.throwIfAborted()
        if (!result.finishReason) throw new ModelResponseError('流式连接提前结束，回答尚未完成。请重试或跳过。', result, 'interrupted')
        assertCompleteResponse(result)
        return result
      }
      const response = await client.chat.completions.create({ ...common, stream: false }, { signal: deadline })
      deadline.throwIfAborted()
      result.text = response.choices[0]?.message.content ?? ''
      result.finishReason = response.choices[0]?.finish_reason ?? undefined
      result.refusal = response.choices[0]?.message.refusal ?? undefined
      result.responseId = response.id
      result.usage = response.usage ? normalizeUsage(response.usage) : undefined
      assertCompleteResponse(result)
      return result
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason
      if (error instanceof ModelResponseError) throw error
      throw new ModelResponseError(readableError(deadline?.aborted ? deadline.reason : error), result, 'transport')
    }
  }
  async embed(model: ModelRef, texts: string[], signal: AbortSignal): Promise<number[][]> {
    signal.throwIfAborted()
    if (!texts.length) return []
    let deadline: AbortSignal | undefined
    let lease: NetworkLease | undefined
    try {
      lease = await this.network?.acquireForProviders([model.providerId], signal)
      signal.throwIfAborted()
      const { client, provider } = await this.client(model.providerId, lease)
      deadline = AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs)])
      deadline.throwIfAborted()
      const response = await client.embeddings.create({ model: model.modelId, input: texts, encoding_format: 'float' }, { signal: deadline })
      deadline.throwIfAborted()
      const rows = [...response.data].sort((a,b) => a.index - b.index)
      if (rows.length !== texts.length || rows.some((row,i) => row.index !== i || !row.embedding.length || row.embedding.some(n => !Number.isFinite(n)))) throw new Error('Embedding 接口返回了无效向量。')
      const dims = rows[0].embedding.length
      if (rows.some(row => row.embedding.length !== dims)) throw new Error('Embedding 返回的向量维度不一致。')
      return rows.map(row => row.embedding)
    } catch (error) { if (signal.aborted) throw signal.reason; throw new Error(readableError(deadline?.aborted ? deadline.reason : error)) }
    finally { lease?.release() }
  }
  async transcribe(model: ModelRef, filePath: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    let deadline: AbortSignal | undefined
    let lease: NetworkLease | undefined
    try {
      lease = await this.network?.acquireForProviders([model.providerId], signal)
      signal.throwIfAborted()
      const { client, provider } = await this.client(model.providerId, lease)
      deadline = AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs)])
      deadline.throwIfAborted()
      const response = await client.audio.transcriptions.create({ model: model.modelId, file: createReadStream(filePath) }, { signal: deadline })
      deadline.throwIfAborted()
      if (typeof response.text !== 'string') throw new Error('转录服务未返回有效文字。')
      return response.text
    } catch (error) { if (signal.aborted) throw signal.reason; throw new Error(readableError(deadline?.aborted ? deadline.reason : error)) }
    finally { lease?.release() }
  }
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const usage = raw as Record<string, unknown>
  const inputTokens = isTokenCount(usage.prompt_tokens) ? usage.prompt_tokens : undefined
  const outputTokens = isTokenCount(usage.completion_tokens) ? usage.completion_tokens : undefined
  const totalTokens = isTokenCount(usage.total_tokens) ? usage.total_tokens
    : inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
  if (!isTokenCount(totalTokens)) return undefined
  return { totalTokens, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) }
}
