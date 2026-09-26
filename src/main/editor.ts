import { createServer, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { access, readFile, realpath, stat, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { Store } from './store'
import { resolveProjectPath } from './projects'
import type { EditorClient, EditorState, EditorTransfer, EditorOutbound, EditorWindow, EditorTarget } from '../shared/editor'
import { editorTransferBlock } from '../shared/editor'

const id = z.string().min(1).max(200)
const targetSchema = z.object({ kind: z.enum(['discussion-new', 'execution-new', 'discussion']), sessionId: id.optional(), projectId: id.optional() }).strict()
const transferSchema = z.object({ id: z.uuid(), kind: z.enum(['text','files']),
  text: z.object({ path: z.string().min(1).max(32000), filePath: z.string().min(1).max(32000).optional(), untitled: z.boolean().optional(), content: z.string().min(1).max(20000), startLine: z.number().int().positive(), endLine: z.number().int().positive(), language: z.string().max(100), dirty: z.boolean(), capturedAt: z.iso.datetime() }).strict().optional(),
  files: z.array(z.string().min(1).max(32000)).min(1).max(100).optional()
}).strict()
const office = /\.(pdf|docx|xlsx|xls|xlsm|csv|pptx)$/i
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y) }
const now = () => new Date().toISOString()
const claimSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const claimHash = (claim: string) => createHash('sha256').update(claim).digest('hex')
const connectionLifetime = 5 * 60 * 1000
type ConnectionStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'cancelled' | 'expired'
interface ConnectionRequest { id: string; name: string; claimHash: string; createdAt: string; expires: number; status: ConnectionStatus; clientId?: string; token?: string }
interface Options { store: Store; stateDir: string; vsixPath: string; emit(): void; importFiles(paths: string[], kbId: string): Promise<string[]> }

/** Only native absolute file paths are accepted, never network shares, devices or ADS. */
function localPath(path: string): string {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f]/.test(path) || (process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(path) || path.slice(2).includes(':')))) throw new Error('请选择本机磁盘中的绝对文件路径，不支持网络共享、设备路径或数据流。')
  return normalize(path)
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

/** Local editor transport: it deliberately has no model, command or filesystem-write endpoint. */
export class EditorBridge {
  private server?: Server
  private port = 0
  private connections = new Map<string, ConnectionRequest>()
  private connectionTimers = new Set<ReturnType<typeof setTimeout>>()
  private windows = new Map<string, EditorWindow>()
  private waiting = new Map<string, { response: ServerResponse; timer: ReturnType<typeof setTimeout> }>()
  private tokens = new Map<string, string>()
  private importing = new Set<string>()
  private outgoing = new Map<string, EditorOutbound>()
  private closing = false
  private operations = new Set<Promise<unknown>>()
  private imports = new Set<Promise<void>>()
  constructor(private options: Options) {}
  private get store() { return this.options.store }
  private get discovery() { return join(this.options.stateDir, 'editor-bridge.json') }
  async start() { if (this.store.getEntity<boolean>('editor-setting','enabled') !== false) await this.enable(true) }
  async state(): Promise<EditorState> {
    this.expireConnections()
    return { enabled: this.store.getEntity('editor-setting','enabled') !== false, running: !!this.server, executable: await this.executable(), vsixPath: this.options.vsixPath,
      clients: this.store.listEntities<EditorClient>('editor-client').map(({id,name,createdAt}) => ({id,name,createdAt})), windows: [...this.windows.values()].filter(w => Date.now()-w.lastSeen < 60000), transfers: this.store.listEntities<EditorTransfer>('editor-transfer').sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
      connectionRequests: [...this.connections.values()].filter(r => r.status === 'pending' || r.status === 'approving').map(({id,name,createdAt,expires}) => ({id,name,createdAt,expiresAt:new Date(expires).toISOString()})) }
  }
  async enable(enabled: boolean): Promise<EditorState> {
    if (!enabled) { await this.close(); this.closing = false }
    else if (!this.server) {
      this.closing = false
      const server = createServer((req,res) => { const operation = this.request(req,res).catch(error => { if (!res.headersSent) this.reply(res, { error: error instanceof z.ZodError ? '编辑器请求格式无效。' : error instanceof Error ? error.message : '编辑器请求失败。' }, 400); else res.end() }); this.operations.add(operation); void operation.finally(() => this.operations.delete(operation)) })
      server.headersTimeout = 10000; server.requestTimeout = 15000
      await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',() => { server.removeListener('error',reject); resolve() }) })
      this.server = server; this.port = (server.address() as {port:number}).port
      await writeFile(this.discovery, JSON.stringify({protocol:2,port:this.port}), {mode:0o600})
    }
    this.store.saveEntity('editor-setting','enabled',enabled); this.options.emit(); return this.state()
  }
  async close() {
    this.closing = true
    for (const wait of this.waiting.values()) { clearTimeout(wait.timer); this.reply(wait.response,{items:[]}) }
    this.waiting.clear(); this.windows.clear(); this.outgoing.clear(); this.connections.clear()
    for (const timer of this.connectionTimers) clearTimeout(timer)
    this.connectionTimers.clear()
    const server = this.server; this.server = undefined
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await Promise.allSettled([...this.operations, ...this.imports])
    await rm(this.discovery,{force:true})
  }
  private expireConnections() {
    let changed=false
    for (const [key, request] of this.connections) {
      if (request.expires <= Date.now() && request.status!=='expired') { request.status = 'expired'; request.token = undefined; changed=true }
      if (request.expires + connectionLifetime <= Date.now()) this.connections.delete(key)
    }
    if(changed) this.options.emit()
  }
  resolveConnection(input: {requestId:string;allow:boolean}): Promise<EditorState> {
    const operation = this.performResolution(input)
    this.operations.add(operation); void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }
  private async performResolution(input: {requestId:string;allow:boolean}): Promise<EditorState> {
    this.expireConnections()
    const request = this.connections.get(input.requestId)
    if (this.closing || !this.server || !request || request.status !== 'pending') throw new Error('此连接申请已处理或过期，请在 VS Code 重新连接。')
    if (!input.allow) { request.status = 'rejected'; this.options.emit(); return this.state() }
    request.status = 'approving'
    const client: EditorClient = {id:randomUUID(),name:request.name,createdAt:now()}, token=randomBytes(32).toString('base64url')
    try {
      await this.store.setSecret(`editor:${client.id}`,token)
      if (this.closing || this.connections.get(request.id) !== request || request.status !== 'approving' || request.expires <= Date.now()) {
        await this.store.setSecret(`editor:${client.id}`,''); this.expireConnections(); throw new Error('连接申请已取消或过期，请重新连接。')
      }
      this.store.saveEntity('editor-client',client.id,client); this.tokens.set(client.id,token)
      request.status='approved'; request.clientId=client.id; request.token=token
    } catch(error) { if(request.status === 'approving') request.status='rejected'; this.options.emit(); throw error }
    this.options.emit(); return this.state()
  }
  async revoke(clientId: string) {
    this.store.deleteEntity('editor-client',clientId); await this.store.setSecret(`editor:${clientId}`,''); this.tokens.delete(clientId)
    for (const request of this.connections.values()) if(request.clientId===clientId) { request.status='cancelled'; request.token=undefined }
    for (const [key,w] of this.windows) if (w.clientId === clientId) { const waiting = this.waiting.get(key); if (waiting) { clearTimeout(waiting.timer); this.reply(waiting.response,{error:'连接已撤销'},401); this.waiting.delete(key) } this.windows.delete(key) }
    for (const [key,item] of this.outgoing) if(item.windowId.startsWith(`${clientId}:`)) this.outgoing.delete(key)
    this.options.emit(); return this.state()
  }
  private reply(res: ServerResponse, body: unknown, code=200) { if (res.destroyed || res.writableEnded) return; res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(body)) }
  private async request(req: import('node:http').IncomingMessage, res: ServerResponse) {
    if (this.closing) throw new Error('编辑器连接正在关闭')
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}` || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { this.reply(res,{error:'请求来源无效'},403); return }
    const url = new URL(req.url ?? '/',`http://127.0.0.1:${this.port}`)
    const json = async (): Promise<unknown> => { let bytes=0; const chunks: Buffer[]=[]; for await (const chunk of req) { bytes+=chunk.length; if(bytes>1024*1024) throw new Error('请求超过 1 MiB'); chunks.push(Buffer.from(chunk)) } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('请求不是有效 JSON') } }
    if (req.method==='POST' && url.pathname==='/connections') {
      const input=z.object({id:z.uuid(),claim:claimSchema,name:z.string().trim().min(1).max(100)}).strict().parse(await json())
      if(this.closing) throw new Error('编辑器连接正在关闭')
      this.expireConnections()
      const previous=this.connections.get(input.id)
      if(previous) {
        if(!equal(previous.claimHash,claimHash(input.claim)) || previous.name!==input.name) { this.reply(res,{error:'连接申请凭证无效'},403); return }
        this.reply(res,this.connectionResult(previous)); return
      }
      if([...this.connections.values()].filter(r=>r.expires>Date.now()).length>=20) { this.reply(res,{error:'待处理连接申请过多，请稍后重试'},429); return }
      const request: ConnectionRequest={id:input.id,name:input.name,claimHash:claimHash(input.claim),createdAt:now(),expires:Date.now()+connectionLifetime,status:'pending'}
      this.connections.set(request.id,request)
      const timer=setTimeout(()=>{this.connectionTimers.delete(timer);this.expireConnections()},connectionLifetime)
      timer.unref(); this.connectionTimers.add(timer)
      this.reply(res,this.connectionResult(request)); this.options.emit(); return
    }
    const connection=url.pathname.match(/^\/connections\/([^/]+)$/)
    if(connection && (req.method==='POST' || req.method==='DELETE')) {
      const {claim}=z.object({claim:claimSchema}).strict().parse(await json())
      this.expireConnections(); const request=this.connections.get(connection[1])
      if(!request || !equal(request.claimHash,claimHash(claim))) { this.reply(res,{error:'连接申请不存在或领取凭证无效'},403); return }
      if(req.method==='DELETE' && request.status!=='expired') {
        request.status='cancelled'; request.token=undefined
        if(request.clientId) await this.revoke(request.clientId)
        this.options.emit()
      }
      this.reply(res,this.connectionResult(request)); return
    }
    const token=req.headers.authorization?.replace(/^Bearer /,'') ?? ''
    let client: EditorClient | undefined
    if (token) for (const value of this.store.listEntities<EditorClient>('editor-client')) {
      const secret=this.tokens.get(value.id) ?? await this.store.getSecret(`editor:${value.id}`)
      if(secret) this.tokens.set(value.id,secret)
      if(secret && equal(token,secret)) { client=value; break }
    }
    if(!client) { this.reply(res,{error:'请在 VS Code 重新连接模型圆桌，或在圆桌批准首次连接请求'},401); return }
    this.currentClient(client.id)
    if(req.method==='GET' && url.pathname==='/connection') { this.reply(res,{clientId:client.id,name:client.name}); return }
    if(req.method==='POST' && url.pathname==='/transfers') {
      const input=transferSchema.parse(await json())
      if(input.text?.filePath) input.text.filePath=localPath(input.text.filePath)
      if(input.files) input.files=input.files.map(localPath)
      const existing = () => {
        this.currentClient(client.id)
        const old=this.store.getEntity<EditorTransfer>('editor-transfer',input.id)
        if (!old) return false
        const previous = { id:old.id,kind:old.kind,text:old.text ? {path:old.text.path,filePath:old.text.filePath,untitled:old.text.untitled,content:old.text.content,startLine:old.text.startLine,endLine:old.text.endLine,language:old.text.language,dirty:old.text.dirty,capturedAt:old.text.capturedAt} : undefined,files:old.files }
        if(old.clientId!==client.id || JSON.stringify(transferSchema.parse(previous))!==JSON.stringify(input)) throw new Error('传输 ID 已用于不同的资料，请重新发送。')
        this.reply(res,{id:old.id,status:old.status}); return true
      }
      if(existing()) return
      let resolvedFiles:string[]|undefined
      let resolvedFilePath:string|undefined
      if(input.kind==='text') {
        if(!input.text || input.files || input.text.endLine<input.text.startLine || (!!input.text.filePath === !!input.text.untitled)) throw new Error('文本快照必须包含本机文件路径，或明确标记为未命名文本。')
        if(input.text.filePath) resolvedFilePath=await this.documentPath(input.text.filePath,false)
      } else {
        if(!input.files || input.text) throw new Error('请选择资料文件')
        resolvedFiles=await Promise.all(input.files.map(file=>this.documentPath(file,true)))
      }
      if(existing()) return
      const transfer: EditorTransfer={...input,clientId:client.id,status:'pending',createdAt:now(),resolvedFiles,text:input.text ? {...input.text,resolvedFilePath,sha256:createHash('sha256').update(input.text.content).digest('hex')} : undefined}
      this.store.saveEntity('editor-transfer',transfer.id,transfer); this.reply(res,{id:transfer.id,status:transfer.status}); this.options.emit(); return
    }
    if(req.method==='POST' && url.pathname==='/windows') {
      const input=z.object({name:z.string().trim().min(1).max(200),workspace:z.string().max(32000).optional()}).strict().parse(await json())
      this.currentClient(client.id); const key=this.windowKey(client.id,req.headers['x-editor-window-id'])
      this.windows.set(key,{id:key,clientId:client.id,name:input.name,workspace:input.workspace,lastSeen:Date.now()})
      this.reply(res,{id:key}); this.options.emit(); return
    }
    if(req.method==='GET' && url.pathname==='/outbox') {
      const key=this.registeredWindow(client.id,req.headers['x-editor-window-id'])
      const previous=this.waiting.get(key); if(previous) { clearTimeout(previous.timer); this.reply(previous.response,{items:[]}); this.waiting.delete(key) }
      const items=[...this.outgoing.values()].filter(i=>i.windowId===key)
      if(items.length) this.reply(res,{items})
      else { const timer=setTimeout(()=>{ this.waiting.delete(key); this.reply(res,{items:[]}) },25000); this.waiting.set(key,{response:res,timer}); res.on('close',()=>{ if(this.waiting.get(key)?.response===res) {clearTimeout(timer);this.waiting.delete(key)} }) }
      return
    }
    const ack=url.pathname.match(/^\/outbox\/([^/]+)\/ack$/)
    if(req.method==='POST' && ack) {
      z.object({}).strict().parse(await json()); this.currentClient(client.id)
      const key=this.registeredWindow(client.id,req.headers['x-editor-window-id']), item=this.outgoing.get(ack[1])
      if(item && item.windowId!==key) throw new Error('资料接收窗口不匹配。')
      this.outgoing.delete(ack[1]); this.reply(res,{ok:true}); return
    }
    if(req.method==='POST' && url.pathname==='/revoke') { await this.revoke(client.id); this.reply(res,{ok:true}); return }
    this.reply(res,{error:'未知编辑器操作，请确保应用和伴随扩展均已更新。'},404)
  }
  private connectionResult(request:ConnectionRequest) {
    return {id:request.id,status:request.status==='approving'?'pending':request.status,expiresAt:new Date(request.expires).toISOString(),...(request.status==='approved' ? {clientId:request.clientId,token:request.token} : {})}
  }
  private windowKey(clientId:string,header:string|string[]|undefined) { return `${clientId}:${z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).parse(header)}` }
  private registeredWindow(clientId:string,header:string|string[]|undefined) {
    const key=this.windowKey(clientId,header), window=this.windows.get(key)
    if(!window) throw new Error('VS Code 窗口尚未连接，请重新连接。')
    window.lastSeen=Date.now(); return key
  }
  private async documentPath(requested:string,officeOnly:boolean) {
    const path=localPath(await realpath(localPath(requested)))
    if(!(await stat(path)).isFile() || (officeOnly && !office.test(path))) throw new Error('请选择本机 PDF、DOCX、Excel、CSV 或 PPTX 资料文件。')
    return path
  }
  private currentClient(id: string) { const client=this.store.getEntity<EditorClient>('editor-client',id); if(this.closing || !client) throw new Error('连接已撤销或正在关闭，请重新连接。'); return client }
  private transfer(id: string) { const t=this.store.getEntity<EditorTransfer>('editor-transfer',id); if(!t) throw new Error('资料记录已移除'); return t }
  dismiss(id: string) { if(this.importing.has(id)) throw new Error('资料正在导入，请等待本次接收完成'); const t=this.transfer(id); this.store.saveEntity('editor-transfer',id,{...t,status:'dismissed'}); this.options.emit() }
  apply(input: {transferId:string;target:EditorTarget;draftId:string;draft:string}) {
    const t=this.transfer(input.transferId); if(t.status==='applied') return
    if(t.status!=='pending' || t.kind!=='text') throw new Error('此资料不能追加，请重新选择有效目标。')
    const target=targetSchema.parse(input.target)
    if(target.projectId && !this.store.getProject(target.projectId)) throw new Error('接收项目已删除，请重新选择目标。')
    let field:string
    if(target.kind==='discussion-new' && !target.sessionId && input.draftId===`discussion-new.${target.projectId ?? 'independent'}`) field='topic'
    else if(target.kind==='execution-new' && target.projectId && !target.sessionId && input.draftId===`execution-new.${target.projectId}.new`) field='task'
    else if(target.kind==='discussion' && target.sessionId && input.draftId===`message.${target.sessionId}`) {
      const session=this.store.getSession(target.sessionId)
      if(!session || session.projectId!==target.projectId || ['complete','stopped'].includes(session.status) || (session.run && session.run.calls>=session.limits.maxCalls)) throw new Error('讨论已结束、删除或达到调用上限，请改选新讨论。')
      field='text'
    } else throw new Error('接收目标与草稿不匹配，请重新选择。')
    const draft=JSON.parse(input.draft) as Record<string,unknown>
    if(!draft || typeof draft!=='object' || Array.isArray(draft)) throw new Error('草稿格式无效。')
    if ((field === 'task' || (field === 'topic' && draft.projectId !== undefined)) && draft.projectId !== target.projectId) throw new Error('草稿所属项目已改变。')
    const body = draft[field]
    if(typeof body!=='string' || body.length>20000 || !body.includes(editorTransferBlock(t)) || !Array.isArray(draft._editorTransfers) || !draft._editorTransfers.includes(t.id)) throw new Error('草稿内容不完整或超过 20,000 字符，请缩小选区。')
    this.store.saveEditorDraft(input.draftId,input.draft,{...t,target,status:'applied'}); this.options.emit()
  }
  importTransfer(id:string,kbId:string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭，请稍后重试'))
    const operation = this.performImport(id,kbId); this.imports.add(operation)
    void operation.finally(() => this.imports.delete(operation)).catch(() => {})
    return operation
  }
  private async performImport(id:string,kbId:string) {
    const t=this.transfer(id); if(t.status==='imported') return
    if(t.status!=='pending' || t.kind!=='files' || this.importing.has(id)) throw new Error('此资料已处理或正在导入')
    if(!this.store.getKnowledgeBase(kbId)) throw new Error('知识库已删除')
    this.importing.add(id)
    try {
      const paths=await Promise.all(t.files!.map(async(p,index)=> {
        if(t.resolvedFiles) {
          const path=await this.documentPath(p,true)
          if(!t.resolvedFiles[index] || !samePath(path,t.resolvedFiles[index])) throw new Error('资料文件的实际位置已改变，请在 VS Code 重新选择并发送。')
          return path
        }
        const project=t.projectId ? this.store.getProject(t.projectId) : undefined
        if(!project) throw new Error('资料的原始项目已不存在，请在 VS Code 重新发送。')
        return this.documentPath(await resolveProjectPath(project.directory,p),true)
      }))
      if(!this.store.getKnowledgeBase(kbId)) throw new Error('知识库已删除')
      const sourceIds=await this.options.importFiles(paths,kbId)
      this.store.saveEntity('editor-transfer',id,{...t,status:'imported',sourceIds,knowledgeBaseId:kbId}); this.options.emit()
    } finally { this.importing.delete(id) }
  }
  async executable():Promise<string|undefined> {
    const configured=this.store.getEntity<string>('editor-setting','executable')
    const candidates=[configured, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA,'Programs','Microsoft VS Code','Code.exe'), process.env.ProgramFiles && join(process.env.ProgramFiles,'Microsoft VS Code','Code.exe'), ...(process.env.PATH ?? '').split(';').filter(p=>/Microsoft VS Code[\\/]bin[\\/]?$/i.test(p)).map(p=>join(p,'..','Code.exe'))]
    for(const path of candidates) if(path) { try { if((await stat(path)).isFile()) return await realpath(path) } catch {} }
    return undefined
  }
  async selectExecutable(path:string) { if(basename(path).toLowerCase()!=='code.exe' || !(await stat(path)).isFile()) throw new Error('请选择 VS Code 安装目录中的 Code.exe'); this.store.saveEntity('editor-setting','executable',await realpath(path)); return this.state() }
  private async cli(args:string[]) {
    const executable=await this.executable(); if(!executable) throw new Error('没有找到 VS Code，请在编辑器协同设置中选择 Code.exe。')
    const root=dirname(executable), script=await readFile(join(root,'bin','code.cmd'),'utf8')
    const match=script.match(/"%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)"/i)
    if(!match) throw new Error('未找到此 VS Code 安装的官方 CLI，请修复安装或手动安装 VSIX。')
    const cli=await realpath(join(root,match[1])), rel=relative(await realpath(root),cli)
    if(rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('VS Code CLI 路径无效')
    await new Promise<void>((resolve,reject)=>{ const child=spawn(executable,[cli,...args],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',VSCODE_DEV:''}}); let output=''; const timer=setTimeout(()=>{child.kill();reject(new Error('VS Code 操作超时，请检查编辑器'))},120000); child.stdout.on('data',d=>{output=(output+d).slice(-4000)}); child.stderr.on('data',d=>{output=(output+d).slice(-4000)}); child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`VS Code 操作失败 (${code})：${output}`))}) })
  }
  async install() { await access(this.options.vsixPath); await this.cli(['--install-extension',this.options.vsixPath,'--force']) }
  async open(projectId:string,path?:string,line?:number) {
    const project=this.store.getProject(projectId); if(!project) throw new Error('项目已删除'); const target=await resolveProjectPath(project.directory,path)
    await this.cli(path ? [project.directory,'--goto',`${target}:${line ?? 1}`] : [target])
  }
  async openSource(transferId:string) {
    const transfer=this.transfer(transferId), text=transfer.text
    if(!text || text.untitled) throw new Error('未命名文本没有磁盘文件位置。')
    let path:string
    if(text.filePath) {
      path=await this.documentPath(text.filePath,false)
      if(text.resolvedFilePath && !samePath(path,text.resolvedFilePath)) throw new Error('资料文件的实际位置已改变，请在 VS Code 重新选择并发送。')
    }
    else {
      const project=transfer.projectId ? this.store.getProject(transfer.projectId) : undefined
      if(!project) throw new Error('资料的原始项目已不存在，请在 VS Code 重新发送。')
      path=await resolveProjectPath(project.directory,text.path)
    }
    await this.cli(['--goto',`${path}:${text.startLine}`])
  }
  async send(input:{title:string;text:string;windowId?:string}) {
    if(Buffer.byteLength(input.text,'utf8')>1024*1024) throw new Error('内容超过 1 MiB，请先导出 Markdown 文件')
    const windows=(await this.state()).windows
    const window=input.windowId ? windows.find(w=>w.id===input.windowId) : windows.length===1 ? windows[0] : undefined
    if(!window) throw new Error(windows.length>1?'请明确选择接收资料的 VS Code 窗口。':'请先在 VS Code 伴随扩展中连接模型圆桌。')
    this.currentClient(window.clientId)
    this.enqueue({id:randomUUID(),windowId:window.id,kind:'markdown',title:input.title,text:input.text})
  }
  private enqueue(item:EditorOutbound) { this.outgoing.set(item.id,item); const wait=this.waiting.get(item.windowId); if(wait) {clearTimeout(wait.timer);this.waiting.delete(item.windowId);this.reply(wait.response,{items:[item]})} }
}
