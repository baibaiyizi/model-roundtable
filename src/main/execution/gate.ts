import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createParser } from 'eventsource-parser'
import type { Provider, Usage } from '../../shared/types'

export interface GateOptions {
  provider: Provider; modelId: string; apiKey: string; maxOutputTokens: number; signal: AbortSignal
  reserve(): void; fail(error: Error): void; usage?(usage: Usage): void; fetch?: typeof fetch
}
export class RequestGate {
  readonly token = randomBytes(32).toString('hex')
  private server = createServer((req, res) => { void this.handle(req, res) })
  private controller = new AbortController()
  private blocked?: Error
  url = ''
  constructor(private options: GateOptions) {
    options.signal.addEventListener('abort', () => this.block(new Error('执行已取消。')), { once: true })
  }
  async start(): Promise<void> {
    this.options.signal.throwIfAborted()
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('请求闸门启动失败。')
    this.url = `http://127.0.0.1:${address.port}/v1`
  }
  block(error: Error): void {
    if (this.blocked) return
    this.blocked = error
    this.controller.abort(error)
    this.options.fail(error)
  }
  async close(): Promise<void> {
    this.controller.abort()
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number, message: string): void => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'execution_blocked' } })) }
    if (req.headers.authorization !== `Bearer ${this.token}`) { reject(401, '本机请求认证失败。'); return }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { reject(400, '不支持的执行接口。'); return }
    if (this.blocked || this.options.signal.aborted) { reject(403, '本次执行已关闭，请在应用中手动重试。'); return }
    let upstreamStarted = false
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const raw of req) {
        const data = Buffer.from(raw); size += data.length
        if (size > 16 * 1024 * 1024) throw new Error('模型请求超过 16 MB。')
        chunks.push(data)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (body.model !== this.options.modelId || !Array.isArray(body.messages)) throw new Error('执行请求使用了未授权的模型或无效消息。')
      const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? this.options.maxOutputTokens)
      delete body.max_tokens; delete body.max_completion_tokens
      body[this.options.provider.tokenParameter] = Number.isFinite(requested) && requested > 0 ? Math.min(requested, this.options.maxOutputTokens) : this.options.maxOutputTokens
      if (body.stream) { if (this.options.provider.streamUsage) body.stream_options = { include_usage: true }; else delete body.stream_options }
      if (this.blocked || this.options.signal.aborted) throw this.blocked ?? new Error('执行已取消。')
      this.options.reserve()
      upstreamStarted = true
      const deadline = AbortSignal.any([this.options.signal, this.controller.signal, AbortSignal.timeout(this.options.provider.timeoutMs)])
      const url = `${this.options.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
      const response = await (this.options.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` }, body: JSON.stringify(body), signal: deadline, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); throw new Error(`模型服务返回 HTTP ${response.status}，执行已停止；不会自动重试。`) }
      if (!response.body) throw new Error('模型服务未返回内容。')
      const usage = (raw: unknown): void => {
        if (!raw || typeof raw !== 'object') return
        const value = raw as Record<string, unknown>
        if (Number.isSafeInteger(value.total_tokens) && Number(value.total_tokens) >= 0) this.options.usage?.({ totalTokens: Number(value.total_tokens), ...(Number.isSafeInteger(value.prompt_tokens) && Number(value.prompt_tokens) >= 0 ? { inputTokens: Number(value.prompt_tokens) } : {}), ...(Number.isSafeInteger(value.completion_tokens) && Number(value.completion_tokens) >= 0 ? { outputTokens: Number(value.completion_tokens) } : {}) })
      }
      if (!body.stream) {
        const data = await response.json() as { error?: unknown; usage?: unknown; choices?: unknown[] }
        deadline.throwIfAborted()
        if (data.error || !data.choices?.length) throw new Error('模型服务返回了无效结果。')
        usage(data.usage)
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); return
      }
      let finished = false
      const parser = createParser({ onEvent: event => {
        if (event.data === '[DONE]') return
        const data = JSON.parse(event.data) as { error?: unknown; usage?: unknown; choices?: Array<{ finish_reason?: unknown }> }
        if (data.error) throw new Error('模型服务在流中返回错误。')
        if (data.choices?.some(choice => typeof choice.finish_reason === 'string' && choice.finish_reason)) finished = true
        usage(data.usage)
      }, onError: error => { throw error } })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const chunk = next.value
        deadline.throwIfAborted()
        parser.feed(decoder.decode(chunk, { stream: true }))
        if (res.destroyed) throw new Error('执行后台断开了模型流。')
        if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close').then(() => { throw new Error('模型流接收端已关闭。') })])
      }
      parser.feed(decoder.decode())
      deadline.throwIfAborted()
      if (!finished) throw new Error('模型流提前结束，未获得完整结果。')
      res.end()
    } catch (error) {
      const message = error instanceof Error ? error : new Error('执行模型请求失败。')
      // Never allow internal retries to make a second paid request after a failure.
      this.block(message)
      if (res.headersSent) res.destroy(message)
      else reject(upstreamStarted ? 502 : 403, message.message)
    }
  }
}
