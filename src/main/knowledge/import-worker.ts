import { randomUUID } from 'node:crypto'
import { isMainThread, parentPort as threadPort, Worker } from 'node:worker_threads'
import { extractSource } from './parsers'
import type { WorkerRequest, WorkerEvent, ExtractedPart } from './protocol'

// Keep parsing isolated in an Electron utility process, and give Node libraries
// a real Node worker environment. PDF.js intentionally treats Electron's
// `process.type = utility` as a browser; Node workers have no Electron type.
if (isMainThread) {
  const upstream = process.parentPort
  if (!upstream) throw new Error('资料处理程序只能在 Electron utilityProcess 中启动')
  const worker = new Worker(__filename)
  upstream.on('message', event => worker.postMessage(event.data))
  worker.on('message', (message: WorkerEvent) => upstream.postMessage(message))
  worker.on('error', error => upstream.postMessage({ type: 'error', error: error.message } satisfies WorkerEvent))
  worker.on('exit', code => { if (code !== 0) upstream.postMessage({ type: 'error', error: `资料解析线程意外退出 (${code})` } satisfies WorkerEvent) })
} else {
  startParser()
}

function startParser(): void {
const port = threadPort
if (!port) throw new Error('资料解析线程没有父消息端口')
const controller = new AbortController()
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
let started = false
function send(event: WorkerEvent): void { port!.postMessage(event) }
function rpc(method: 'vision' | 'transcribe' | 'extract-pptx', argument: string): Promise<unknown> {
  controller.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = randomUUID(); pending.set(id, { resolve, reject }); send({ type: 'rpc', id, method, argument })
  })
}
port.on('message', async (message: WorkerRequest) => {
  if (message.type === 'cancel') {
    controller.abort()
    for (const item of pending.values()) item.reject(new Error('资料处理已取消'))
    pending.clear(); return
  }
  if (message.type === 'rpc-result') {
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.value)
    return
  }
  if (message.type !== 'job' || started) return
  started = true
  try {
    const parts = await extractSource(message.job, {
      signal: controller.signal,
      progress: text => send({ type: 'progress', text }),
      vision: async dataUrl => await rpc('vision', dataUrl) as { ocr: string; description: string },
      transcribe: async path => await rpc('transcribe', path) as string,
      extractPptx: async path => await rpc('extract-pptx', path) as ExtractedPart[]
    })
    controller.signal.throwIfAborted()
    if (!parts.some(part => part.text.trim())) throw new Error('资料未提取到内容，未加入知识库')
    send({ type: 'done', parts })
  } catch (error) { send({ type: 'error', error: error instanceof Error ? error.message : String(error) }) }
})
}
