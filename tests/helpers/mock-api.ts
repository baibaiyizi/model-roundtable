import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedCall { path: string; body: Record<string, any>; authorization?: string }
export async function startMockAPI() {
  const calls: RecordedCall[] = []
  let slowGate: Promise<void> | undefined
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ object: 'list', data: ['analyst','critic','chair','embedding','vision','transcribe'].map(id => ({ id, object: 'model', created: 0, owned_by: 'local-test' })) }))
      return
    }
    if (path === '/article-redirect') { response.writeHead(302, { location: '/article' }); response.end(); return }
    if (path === '/article') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<html><head><title>城市能源资料</title></head><body><article><h1>城市能源资料</h1><p>这是一篇测试资料。太阳能发电依赖日照，储能可以平衡电力供需。可再生能源规划需要关注成本与可靠性。</p><p>这份示例只用于验证资料解析和引用流程。</p></article></body></html>')
      return
    }
    const raw = await readBody(request)
    let body: Record<string, any> = {}
    if (request.headers['content-type']?.includes('application/json')) body = JSON.parse(raw || '{}')
    calls.push({ path, body, authorization: request.headers.authorization })
    if (request.headers.authorization === 'Bearer reject-me') {
      response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Invalid API key secret-server-error', type: 'authentication_error' } })); return
    }
    if (body.model === 'rate-limited') {
      response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Rate limit', type: 'rate_limit_error' } })); return
    }
    if (path === '/v1/embeddings') {
      response.setHeader('Content-Type', 'application/json')
      const texts = Array.isArray(body.input) ? body.input : [body.input]
      response.end(JSON.stringify({ object: 'list', data: texts.map((text: string, index: number) => ({ object: 'embedding', index, embedding: /太阳|光伏|能源|solar/.test(text) ? [1,0,0,0] : [0,1,0,0] })), model: body.model, usage: { prompt_tokens: 10, total_tokens: 10 } }))
      return
    }
    if (path === '/v1/audio/transcriptions') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: '这是一段关于太阳能与储能的测试转录。' })); return }
    if (path === '/search') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ results: [{ title: '测试资料', url: 'https://example.org/source', content: '用于验证搜索证据快照的原文。' }, { title: '重复', url: 'https://example.org/source', content: '重复' }] })); return }
    if (path !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
    if (body.tool_choice?.function?.name === 'connection_probe') {
      response.setHeader('Content-Type','application/json')
      response.end(JSON.stringify({ id:'probe',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[{id:'probe-tool',type:'function',function:{name:'connection_probe',arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12} }))
      return
    }
    const messages = body.messages ?? []
    const last = messages.at(-1)?.content
    const prompt = typeof last === 'string' ? last : (last?.[0]?.text ?? '')
    let text = `我是 ${body.model}。我认为应当先明确问题、比较证据，再验证假设。`
    if (messages[0]?.content?.includes('连接测试')) text = '连接成功。'
    else if (prompt.includes('"wantsToSpeak"')) text = JSON.stringify({ wantsToSpeak: true, reason: '回应前述观点并给出新的验证建议。', replyTo: '$user', searchQuery: null })
    else if (body.model === 'vision') text = JSON.stringify({ ocr: '太阳能资料测试图片', description: '一张用于测试图片解析的示意图。' })
    else if (prompt.includes('只返回 JSON') && prompt.includes('speakerId')) {
      const id = prompt.split('【参会者】\n')[1]?.split('：')[0]?.trim() ?? 'analyst'
      text = JSON.stringify({ speakerId: id, replyTo: '$user', instruction: '回应用户问题，提出证据和反例。' })
    } else if (prompt.includes('即将进入') && prompt.includes('query')) text = JSON.stringify({ query: null })
    else if (prompt.includes('共享摘要')) text = '早期观点：需要比较成本和可靠性；仍有证据不足。原始消息与证据保留在记录中。'
    else if (prompt.includes('【本次发言任务】')) {
      const task = prompt.split('【本次发言任务】').at(-1) ?? ''
      text = task.includes('总结') || task.includes('裁判') ? '## 共识\n应先核查证据，再作决定。\n\n## 分歧\n成本与可靠性的权衡仍需验证。\n\n## 待验证\n补充真实数据，保留少数意见。' : `**${body.model} 的观点**\n\n我已阅读本阶段可见的记录。建议比较方案的成本、证据和不确定性，并回应其他成员提出的质疑。`
    }
    const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const fragments = text.match(/[\s\S]{1,18}/g) ?? []
      for (const content of fragments) {
        if (response.destroyed) break
        response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`)
        if (body.model === 'slow' && slowGate) await Promise.race([slowGate, new Promise<void>(resolve => response.once('close', resolve))])
        await new Promise(resolve => setTimeout(resolve, body.model === 'slow' ? 200 : 5))
        if (body.model === 'cut-stream') { response.end(); return }
      }
      response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(body.stream_options?.include_usage ? { usage } : {}) })}\n\n`)
      response.end('data: [DONE]\n\n')
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, calls, holdSlowStreams: () => { let release!: () => void; slowGate = new Promise<void>(resolve => { release = resolve }); return () => { slowGate = undefined; release() } }, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) }
}
async function readBody(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const part of request) parts.push(Buffer.from(part))
  return Buffer.concat(parts).toString('utf8')
}
