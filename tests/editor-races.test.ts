import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { EditorBridge } from '../src/main/editor'
import { editorTransferBlock } from '../src/shared/editor'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture(importFiles: () => Promise<string[]> = async () => ['source']) {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-editor-races-')), project = join(root, '项目 A')
  await mkdir(project); await writeFile(join(project, '资料.md'), 'original'); await writeFile(join(project, '资料.pdf'), 'document')
  const store = new Store(join(root, 'data.sqlite'), { encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString() })
  store.saveProject({ id: 'a', name: 'A', directory: project, instructions: '', knowledgeBaseIds: [], createdAt: 'now', updatedAt: 'now' })
  store.saveProject({ id: 'b', name: 'B', directory: root, instructions: '', knowledgeBaseIds: [], createdAt: 'now', updatedAt: 'now' })
  store.saveKnowledgeBase({ id: 'kb', name: '资料', embedding: { providerId: 'p', modelId: 'e' }, embeddingBaseUrl: 'http://localhost', chunkVersion: 1, createdAt: 'now' })
  const bridge = new EditorBridge({ store, stateDir: root, vsixPath: 'unused.vsix', emit() {}, importFiles })
  cleanups.push(async () => { await bridge.close(); store.close(); await rm(root, { recursive: true, force: true }) })
  await bridge.start()
  const { port } = JSON.parse(await readFile(join(root, 'editor-bridge.json'), 'utf8')), base = `http://127.0.0.1:${port}`
  const connection={id:randomUUID(),claim:randomBytes(32).toString('base64url'),name:'race test'}
  await fetch(`${base}/connections`, { method: 'POST', body: JSON.stringify(connection) })
  await bridge.resolveConnection({requestId:connection.id,allow:true})
  const credential = await fetch(`${base}/connections/${connection.id}`, { method: 'POST', body: JSON.stringify({claim:connection.claim}) }).then(r => r.json()) as { token: string; clientId: string }
  const headers = { authorization: `Bearer ${credential.token}` }
  const request = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = () => ({ id: randomUUID(), kind: 'text', text: { path: '资料.md', filePath:join(project,'资料.md'), content: 'snapshot', startLine: 1, endLine: 1, language: 'markdown', dirty: true, capturedAt: new Date().toISOString() } })
  return { bridge, store, root, project, base, headers, credential, request, text }
}

describe('editor bridge concurrent lifecycle boundaries', () => {
  it('cancellation during approval does not leave an active client or a reusable token', async () => {
    const f=await fixture(), connection={id:randomUUID(),claim:randomBytes(32).toString('base64url'),name:'cancel while encrypting'}
    const send=(method:string,path:string,body:unknown)=>fetch(f.base+path,{method,body:JSON.stringify(body)})
    await send('POST','/connections',connection)
    const entered=deferred(), finish=deferred(), original=f.store.setSecret.bind(f.store)
    const saved:string[]=[]
    vi.spyOn(f.store,'setSecret').mockImplementation(async(id,value)=>{if(value) {saved.push(id);entered.resolve();await finish.promise} await original(id,value)})
    const approval=f.bridge.resolveConnection({requestId:connection.id,allow:true});const rejected=expect(approval).rejects.toThrow('已取消或过期')
    await entered.promise
    expect((await send('DELETE',`/connections/${connection.id}`,{claim:connection.claim})).status).toBe(200)
    finish.resolve();await rejected
    expect((await f.bridge.state()).clients).toHaveLength(1)
    expect(await f.store.getSecret(saved[0])).toBe('')
    expect(await (await send('POST',`/connections/${connection.id}`,{claim:connection.claim})).json()).toMatchObject({status:'cancelled'})
  })

  it('parallel approvals grant one identity and closing drains an approval before storage teardown', async () => {
    const f=await fixture(), connection={id:randomUUID(),claim:randomBytes(32).toString('base64url'),name:'parallel approval'}
    await fetch(f.base+'/connections',{method:'POST',body:JSON.stringify(connection)})
    const results=await Promise.allSettled([f.bridge.resolveConnection({requestId:connection.id,allow:true}),f.bridge.resolveConnection({requestId:connection.id,allow:true})])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect((await f.bridge.state()).clients).toHaveLength(2)
    const pending={...connection,id:randomUUID()};await fetch(f.base+'/connections',{method:'POST',body:JSON.stringify(pending)})
    const entered=deferred(), finish=deferred(), original=f.store.setSecret.bind(f.store)
    vi.spyOn(f.store,'setSecret').mockImplementation(async(id,value)=>{if(value){entered.resolve();await finish.promise}await original(id,value)})
    const approving=f.bridge.resolveConnection({requestId:pending.id,allow:true}), rejected=expect(approving).rejects.toThrow('已取消或过期')
    await entered.promise
    let closed=false;const closing=f.bridge.close().then(()=>{closed=true})
    await new Promise(resolve=>setTimeout(resolve,20));expect(closed).toBe(false)
    finish.resolve();await rejected;await closing
    expect((await f.bridge.state()).clients).toHaveLength(2)
  })

  it('rejects execution drafts whose internal project changed while preserving the original draft', async () => {
    const f = await fixture(), input = f.text(); await f.request('/transfers', input)
    const transfer = (await f.bridge.state()).transfers[0], key = 'execution-new.a.new'
    const original = JSON.stringify({ projectId: 'b', task: '原来属于 B 的任务', executor: { modelId: 'keep', providerId: 'p' } })
    f.store.saveDraft(key, original)
    expect(() => f.bridge.apply({ transferId: input.id, target:{kind:'execution-new',projectId:'a'}, draftId: key, draft: JSON.stringify({ ...JSON.parse(original), task: '原来属于 B 的任务' + editorTransferBlock(transfer), _editorTransfers: [input.id] }) })).toThrow('项目')
    expect(f.store.getDraft(key)).toBe(original)
    expect((await f.bridge.state()).transfers[0].status).toBe('pending')
  })

  it('rejects sequential reuse of one transfer ID for different snapshots', async () => {
    const f = await fixture(), input = f.text()
    expect((await f.request('/transfers', input)).status).toBe(200)
    expect((await f.request('/transfers', { ...input, text: { ...input.text, content: 'changed' } })).status).toBe(400)
    expect((await f.bridge.state()).transfers[0].text?.content).toBe('snapshot')
  })

  it('does not let concurrent reuse of one ID overwrite the first accepted snapshot', async () => {
    const f = await fixture(), input = f.text()
    const responses = await Promise.all([f.request('/transfers', input), f.request('/transfers', { ...input, text: { ...input.text, content: 'racing change' } })])
    expect(responses.map(r => r.status).sort()).toEqual([200, 400])
    expect((await f.bridge.state()).transfers).toHaveLength(1)
  })

  it('revocation rejects a request authenticated before its delayed body arrives', async () => {
    const f = await fixture(), input = f.text(), incoming = deferred(), response = deferred<number>()
    const server = (f.bridge as unknown as { server: Server }).server
    server.once('request', () => incoming.resolve())
    const request = httpRequest(f.base + '/transfers', { method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' } }, res => { res.resume(); res.once('end', () => response.resolve(res.statusCode ?? 0)) })
    request.on('error', () => response.resolve(0)); request.flushHeaders()
    await incoming.promise; await f.bridge.revoke(f.credential.clientId)
    request.end(JSON.stringify(input))
    expect(await response.promise).not.toBe(200)
    expect((await f.bridge.state()).transfers).toHaveLength(0)
  })

  it('close drains an already-confirmed file import before callers can close storage', async () => {
    const entered = deferred(), finish = deferred<string[]>(), f = await fixture(async () => { entered.resolve(); return finish.promise })
    const id = randomUUID(); await f.request('/transfers', { id, kind: 'files', files: [join(f.project,'资料.pdf')] })
    const importing = f.bridge.importTransfer(id, 'kb'); await entered.promise
    let closed = false
    const closing = f.bridge.close().then(() => { closed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(closed).toBe(false)
    } finally { finish.resolve(['source']); await importing; await closing }
    expect((await f.bridge.state()).transfers[0].status).toBe('imported')
  })
})
