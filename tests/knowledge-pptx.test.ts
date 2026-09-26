import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../src/main/documents/service'
import { extractSource } from '../src/main/knowledge/parsers'
import { extractInWorker } from '../src/main/knowledge/worker-client'
import type { ExtractedPart } from '../src/main/knowledge/protocol'
import type { GatewayPort, StorePort } from '../src/shared/ports'
import type { ComponentRuntimePort } from '../src/shared/components'
import { testComponents } from './helpers/components'

const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork }, net: {} }))
const runtime = await testComponents.resolve('documents')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
async function setup(components: ComponentRuntimePort = testComponents) {
  const directory = await mkdtemp(join(tmpdir(), '圆桌 PPTX-'))
  const service = new DocumentService({ runtimeDir: runtime.directory, stateDir: join(directory, 'journal'), components })
  cleanups.push(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }) })
  return { directory, service }
}
function fixture(path: string, body: string) {
  const code = `from pptx import Presentation\nfrom pptx.util import Inches\nfrom pathlib import Path\nimport sys,io\np=Presentation()\ns=p.slides.add_slide(p.slide_layouts[6])\n${body}\np.save(sys.argv[1])`
  const result = spawnSync(runtime.executable, ['-I', '-B', '-X', 'utf8', '-c', code, path], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}
const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')

describe('PPTX full knowledge extraction', () => {
  it('retains >2000 shapes, >20000 characters, nested groups and table locations without touching the original', async () => {
    const { directory, service } = await setup(), path = join(directory, '中文 演示.pptx')
    fixture(path, `s.shapes.turbo_add_enabled=True\nfor i in range(2101):\n s.shapes.add_textbox(0,0,Inches(2),Inches(1)).text=f'正文 {i}'\ns.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='长'*25001+'完整末尾'\ng=s.shapes.add_group_shape().shapes.add_group_shape()\ng.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='深层组合文字'\ntb=s.shapes.add_table(2,2,0,0,Inches(2),Inches(1))\ng.shapes.add_group_shape([tb])\nt=tb.table\nt.cell(0,0).text='太阳能'\nt.cell(1,1).text='储能预算'\ns2=p.slides.add_slide(p.slide_layouts[6])\ns2.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='第二页引用'`)
    const before = await digest(path), progress = vi.fn()
    const parts = await service.extractPptx(path, undefined, progress)
    expect(parts.length).toBeGreaterThan(2101)
    expect(parts.find(part => part.text.startsWith('长'))!.text).toBe('长'.repeat(25001) + '完整末尾')
    expect(parts.find(part => part.text === '正文 2100')).toBeTruthy()
    expect(parts.find(part => part.text === '深层组合文字')!.locator).toContain('第 1 张幻灯片')
    expect(parts.find(part => part.text.includes('储能预算'))).toMatchObject({ locator: expect.stringContaining('表格第 2 行') })
    expect(parts.find(part => part.text === '第二页引用')!.locator).toContain('第 2 张幻灯片')
    expect(progress).toHaveBeenLastCalledWith(expect.stringContaining('已完整提取 2 张幻灯片'))
    expect(await digest(path)).toBe(before)
  }, 30000)

  it('reports a picture-only presentation as unindexable and never invokes vision', async () => {
    const { directory, service } = await setup(), path = join(directory, '纯图片.pptx')
    fixture(path, `from PIL import Image\nb=io.BytesIO()\nImage.new('RGB',(8,8),'red').save(b,format='PNG')\nb.seek(0)\ns.shapes.add_picture(b,0,0,Inches(1),Inches(1))`)
    const vision = vi.fn()
    await expect(extractSource({ originalPath: path, mediaDir: '', scratchDir: directory }, { signal: new AbortController().signal, progress: vi.fn(), transcribe: vi.fn(), vision, extractPptx: p => service.extractPptx(p) })).rejects.toThrow('纯图片幻灯片暂不执行 OCR')
    expect(vision).not.toHaveBeenCalled()
  })

  it('fails the entire import beyond the full extraction character budget rather than returning the beginning', async () => {
    const { directory, service } = await setup(), path = join(directory, '超限.pptx')
    fixture(path, `s.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='保留也不可提前提交'\ns.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='甲'*(2*1024*1024+1)`)
    await expect(service.extractPptx(path)).rejects.toThrow('文字超过 2097152 字符')
  }, 30000)

  it('prepares the component before acquiring its lease, and missing components do not leave a lease', async () => {
    const order: string[] = []
    const components: ComponentRuntimePort = { resolve: vi.fn(), ensure: async () => { order.push('ensure'); return runtime }, acquire: () => { order.push('acquire'); return () => { order.push('release') } } }
    const { directory, service } = await setup(components), path = join(directory, '准备.pptx')
    fixture(path, `s.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='有效文字'`)
    await service.extractPptx(path)
    expect(order).toEqual(['ensure', 'acquire', 'release'])
    components.ensure = async () => { order.push('missing'); throw new Error('文档组件下载失败') }
    await expect(service.extractPptx(path)).rejects.toThrow('文档组件下载失败')
    expect(order).toEqual(['ensure', 'acquire', 'release', 'missing'])
  })

  it('rejects a truncated/partial worker response even if it contains valid text', async () => {
    const { directory, service } = await setup(), path = join(directory, '不完整.pptx')
    fixture(path, `s.shapes.add_textbox(0,0,Inches(2),Inches(1)).text='有效文字'`)
    const stub = vi.spyOn(service as unknown as { run: () => Promise<{ stdout: string; stderr: string }> }, 'run')
    stub.mockResolvedValue({ stdout: JSON.stringify({ ok: true, slides: 1, parts: [{ text: '部分', locator: '第 1 张幻灯片', kind: 'text' }], truncated: true }), stderr: '' })
    await expect(service.extractPptx(path)).rejects.toThrow('未完整通过验证')
    stub.mockResolvedValue({ stdout: '{"ok":true,"parts":[', stderr: '' })
    await expect(service.extractPptx(path)).rejects.toThrow('不完整或无法解析')
  })

  it('cancels component preparation without acquiring a lease or starting Python', async () => {
    const acquire = vi.fn(), started = vi.fn()
    const components: ComponentRuntimePort = { resolve: vi.fn(), ensure: (_id, signal) => new Promise((_, reject) => { started(); signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }) }), acquire }
    const { directory, service } = await setup(components), path = join(directory, '准备取消.pptx')
    await writeFile(path, 'test fixture')
    const controller = new AbortController(), pending = service.extractPptx(path, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(started).toHaveBeenCalled())
    controller.abort(); await rejected
    expect(acquire).not.toHaveBeenCalled()
  })

  it('cancels Python and its child process before releasing the component lease', async () => {
    let released = false
    const { directory } = await setup(), fake = join(directory, '运行时')
    await mkdir(fake)
    await symlink(join(runtime.directory, 'python'), join(fake, 'python'), 'junction')
    const pids = join(directory, 'pids.json')
    await writeFile(join(fake, 'worker.py'), `import os,sys,time,json,subprocess\nfrom pathlib import Path\nchild=subprocess.Popen([sys.executable,'-I','-B','-c','import time; time.sleep(60)'])\nPath(${JSON.stringify(pids)}).write_text(json.dumps([os.getpid(),child.pid]))\ntime.sleep(60)\n`, 'utf8')
    const components: ComponentRuntimePort = { resolve: async () => runtime, ensure: async () => ({ ...runtime, directory: fake }), acquire: () => () => { released = true } }
    const service = new DocumentService({ runtimeDir: fake, stateDir: join(directory, 'history'), components })
    cleanups.push(() => service.shutdown())
    const path = join(directory, '取消.pptx'); await writeFile(path, 'test fixture')
    const controller = new AbortController(), pending = service.extractPptx(path, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(async () => expect(JSON.parse(await readFile(pids, 'utf8'))).toHaveLength(2), { timeout: 10000, interval: 30 })
    const processes = JSON.parse(await readFile(pids, 'utf8')) as number[]
    expect(released).toBe(false)
    controller.abort(); await rejected
    expect(released).toBe(true)
    for (const pid of processes) expect(() => process.kill(pid, 0)).toThrow()
  }, 20000)
})

describe('PPTX parser RPC binding and cleanup', () => {
  const store = { getSettings: () => ({}) } as unknown as StorePort
  const gateway = { chat: vi.fn(), embed: vi.fn(), transcribe: vi.fn() } as unknown as GatewayPort
  function childFixture(argument: string) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() })
    mocks.fork.mockReturnValue(child)
    child.postMessage.mockImplementation((event: { type: string; value?: ExtractedPart[]; error?: string }) => {
      if (event.type === 'job') queueMicrotask(() => child.emit('message', { type: 'rpc', method: 'extract-pptx', id: 'rpc', argument }))
      if (event.type === 'rpc-result') queueMicrotask(() => child.emit('message', event.error ? { type: 'error', error: event.error } : { type: 'done', parts: event.value }))
      if (event.type === 'cancel') queueMicrotask(() => child.emit('message', { type: 'error', error: '资料处理已取消' }))
    })
    return child
  }
  it('accepts only this job original and never starts a model request', async () => {
    const path = 'C:/保存的原件/演示.pptx', extractor = vi.fn(async () => [{ text: '正文', locator: '第 1 张幻灯片', kind: 'text' as const }])
    childFixture(path)
    const job = { originalPath: path, mediaDir: '', scratchDir: '' }
    expect(await extractInWorker(job, store, gateway, new AbortController().signal, vi.fn(), fetch, extractor)).toHaveLength(1)
    expect(extractor).toHaveBeenCalledWith(path, expect.any(AbortSignal), expect.any(Function))
    expect(gateway.chat).not.toHaveBeenCalled()
    childFixture('C:/别的文件.pptx')
    await expect(extractInWorker(job, store, gateway, new AbortController().signal, vi.fn(), fetch, extractor)).rejects.toThrow('当前导入任务的原件')
    expect(extractor).toHaveBeenCalledTimes(1)
  })
  it('does not settle a cancelled utility process until its main-process extraction has closed', async () => {
    const path = 'C:/original/待取消.pptx', controller = new AbortController()
    childFixture(path)
    let close: (() => void) | undefined, rpcAborted = false, settled = false
    const extractor = vi.fn((_path: string, signal: AbortSignal) => new Promise<ExtractedPart[]>((resolve) => {
      signal.addEventListener('abort', () => { rpcAborted = true }, { once: true })
      close = () => resolve([])
    }))
    const pending = extractInWorker({ originalPath: path, mediaDir: '', scratchDir: '' }, store, gateway, controller.signal, vi.fn(), fetch, extractor)
    void pending.catch(() => { settled = true })
    await vi.waitFor(() => expect(close).toBeDefined())
    controller.abort()
    await Promise.resolve(); await Promise.resolve()
    expect(rpcAborted).toBe(true); expect(settled).toBe(false)
    close!()
    await expect(pending).rejects.toThrow('资料处理已取消')
  })
})
