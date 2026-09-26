import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { GatewayPort, StorePort } from '../src/shared/ports'
import type { Source } from '../src/shared/types'
import { extractInWorker } from '../src/main/knowledge/worker-client'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork }, net: {} }))
function harness(text: string) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() })
  mocks.fork.mockReturnValue(child)
  const source: Source = { id: 'source', title: '扫描页', knowledgeBaseId: 'kb', originalPath: 'C:/synthetic/page.png', status: 'processing', progress: '', createdAt: '', chunkCount: 0 }
  const model = { providerId: 'p', modelId: 'vision' }
  let currentModel = model
  const store = { getSettings: () => ({ vision: currentModel }), listSources: () => [structuredClone(source)], saveSource: (value: Source) => Object.assign(source, value) } as unknown as StorePort
  const gateway = { chat: vi.fn(async () => { currentModel = { ...model, modelId: 'changed-during-request' }; return { text, responseId: 'vision-response' } }) } as unknown as GatewayPort
  child.postMessage.mockImplementation((event: { type: string; error?: string; value?: { ocr: string; description: string } }) => {
    if (event.type === 'job') queueMicrotask(() => child.emit('message', { type: 'rpc', method: 'vision', id: 'rpc-1', argument: 'data:image/png;base64,synthetic' }))
    if (event.type === 'rpc-result') queueMicrotask(() => child.emit('message', event.error ? { type: 'error', error: event.error } : { type: 'done', parts: [{ text: event.value!.ocr, locator: '第1页', kind: 'ocr' }] }))
  })
  const run = () => extractInWorker({ originalPath: source.originalPath!, mediaDir: '', scratchDir: '' }, store, gateway, new AbortController().signal, () => {})
  return { run, source, gateway, child }
}
describe('vision structured results in the worker bridge', () => {
  it('normalizes model wrappers before replying to the parser worker', async () => {
    const h = harness('<think>这是扫描内容。</think>```json\n{"ocr":"识别文字","description":"一页纸"}\n```')
    expect(await h.run()).toEqual([{ text: '识别文字', locator: '第1页', kind: 'ocr' }])
    expect(h.gateway.chat).toHaveBeenCalledWith(expect.objectContaining({ structured: expect.objectContaining({ name: 'vision_extraction' }) }))
    expect(h.child.kill).toHaveBeenCalled()
  })
  it('keeps failed raw vision responses and the model actually called in the source record', async () => {
    const raw = '{"ocr":44,"description":"一页纸"}'
    const h = harness(raw)
    await expect(h.run()).rejects.toThrow('字段不符合约定')
    expect(h.source.modelDiagnostics).toEqual([expect.objectContaining({ model: { providerId: 'p', modelId: 'vision' }, rawResponse: raw, diagnostic: expect.objectContaining({ code: 'invalid_schema', responseId: 'vision-response', maxOutputTokens: 4096 }) })])
  })
})
