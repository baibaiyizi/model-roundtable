import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { EditorBridge } from '../src/main/editor'
import { editorTransferBlock, type EditorTransfer } from '../src/shared/editor'
import { DEFAULT_LIMITS, type Session } from '../src/shared/types'

const cleanups: Array<()=>Promise<void>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const cleanup of cleanups.splice(0).reverse())await cleanup()})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'roundtable-editor-')), project=join(root,'中文 项目')
  await mkdir(project);await writeFile(join(project,'资料.md'),'磁盘原文');await writeFile(join(project,'资料.pdf'),'test')
  const store=new Store(join(root,'data.sqlite'),{encrypt:async text=>Buffer.from(text),decrypt:async bytes=>Buffer.from(bytes).toString()})
  store.saveProject({id:'project',name:'测试项目',directory:project,instructions:'',knowledgeBaseIds:[],createdAt:'now',updatedAt:'now'})
  let imports=0; const imported:string[][]=[]
  const bridge=new EditorBridge({store,stateDir:root,vsixPath:'not-used.vsix',emit(){},importFiles:async(paths)=>{imports++;imported.push(paths);return ['source']}})
  cleanups.push(async()=>{await bridge.close();store.close();await rm(root,{recursive:true,force:true})})
  await bridge.start();const discovery=JSON.parse(await readFile(join(root,'editor-bridge.json'),'utf8'));const base=`http://127.0.0.1:${discovery.port}`
  const connect=async()=> {
    const input={id:randomUUID(),claim:randomBytes(32).toString('base64url'),name:'测试 VS Code'}
    const send=(path:string,body:unknown,method='POST')=>fetch(base+path,{method,body:JSON.stringify(body)})
    expect((await send('/connections',input)).status).toBe(200)
    return {input,send,read:()=>send(`/connections/${input.id}`,{claim:input.claim})}
  }
  const pending=await connect();await bridge.resolveConnection({requestId:pending.input.id,allow:true})
  const credential=await (await pending.read()).json() as {token:string;clientId:string}
  const request=async(path:string,body?:unknown,windowId?:string)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${credential.token}`,...(windowId?{'X-Editor-Window-Id':windowId}:{})},body:body===undefined?undefined:JSON.stringify(body)})
  const text=()=>({id:randomUUID(),kind:'text',text:{path:'资料.md',filePath:join(project,'资料.md'),content:'尚未保存的新文字 ``` 内容',startLine:1,endLine:2,language:'markdown',dirty:true,capturedAt:new Date().toISOString()}})
  return {root,project,store,bridge,credential,pending,connect,discovery,base,request,text,imports:()=>imports,imported}
}
describe('local VS Code bridge',()=>{
  it('requires approval and secret claim, retains one grant on retries, rejects origins and removes old protocol endpoints',async()=>{
    const f=await fixture(), pending=await f.connect()
    expect(f.discovery.protocol).toBe(2)
    expect((await fetch(f.base+'/connection')).status).toBe(401)
    expect((await fetch(f.base+'/connection',{headers:{origin:'https://example.com',authorization:`Bearer ${f.credential.token}`}})).status).toBe(403)
    expect((await pending.send(`/connections/${pending.input.id}`,{claim:randomBytes(32).toString('base64url')})).status).toBe(403)
    expect((await pending.send(`/connections/${pending.input.id}`,{})).status).toBe(400)
    expect(await (await pending.read()).json()).toMatchObject({status:'pending'})
    const state=JSON.stringify(await f.bridge.state());expect(state).not.toContain(pending.input.claim);expect(state).not.toContain(f.credential.token)
    await f.bridge.resolveConnection({requestId:pending.input.id,allow:true})
    const first=await (await pending.read()).json();expect(await (await pending.read()).json()).toEqual(first)
    expect((await pending.send('/connections',pending.input)).status).toBe(200)
    expect((await f.bridge.state()).clients).toHaveLength(2)
    for(const path of ['/projects','/targets','/pair','/bind'])expect((await f.request(path,{})).status).toBe(404)
    await f.bridge.revoke(f.credential.clientId)
    expect((await f.request('/connection')).status).toBe(401)
    expect(await (await f.pending.read()).json()).toMatchObject({status:'cancelled'})
  })
  it('reports rejection, cancellation and expiry without creating credentials',async()=>{
    const f=await fixture(), rejected=await f.connect(), cancelled=await f.connect(), expired=await f.connect()
    await f.bridge.resolveConnection({requestId:rejected.input.id,allow:false})
    expect(await (await rejected.read()).json()).toMatchObject({status:'rejected'})
    expect(await (await cancelled.send(`/connections/${cancelled.input.id}`,{claim:cancelled.input.claim},'DELETE')).json()).toMatchObject({status:'cancelled'})
    await expect(f.bridge.resolveConnection({requestId:cancelled.input.id,allow:true})).rejects.toThrow('已处理或过期')
    const future=Date.now()+300001;vi.spyOn(Date,'now').mockReturnValue(future)
    expect(await (await expired.read()).json()).toMatchObject({status:'expired'})
    await expect(f.bridge.resolveConnection({requestId:expired.input.id,allow:true})).rejects.toThrow('已处理或过期')
    expect((await f.bridge.state()).clients).toHaveLength(1);expect((await f.bridge.state()).connectionRequests).toHaveLength(0)
  })
  it('defaults to enabled but preserves an explicitly disabled preference and legacy credentials on restart',async()=>{
    const f=await fixture();expect((await f.bridge.state()).running).toBe(true)
    f.store.saveEntity('editor-client','legacy',{id:'legacy',name:'旧连接',createdAt:'now',bindings:{removed:'not-used'}});await f.store.setSecret('editor:legacy','legacy-token')
    await f.bridge.close();await f.bridge.start()
    const {port}=JSON.parse(await readFile(join(f.root,'editor-bridge.json'),'utf8'))
    expect((await fetch(`http://127.0.0.1:${port}/connection`,{headers:{authorization:'Bearer legacy-token'}})).status).toBe(200)
    expect(JSON.stringify((await f.bridge.state()).clients)).not.toContain('bindings')
    await f.bridge.enable(false);await f.bridge.start();expect((await f.bridge.state()).running).toBe(false);expect((await f.bridge.state()).enabled).toBe(false)
  })
  it('keeps named dirty and untitled buffers, deduplicates receipts and never starts work',async()=>{
    const f=await fixture(),input=f.text()
    expect((await f.request('/transfers',input)).status).toBe(200);expect((await f.request('/transfers',input)).status).toBe(200)
    const untitled={...f.text(),text:{...input.text,path:'Untitled-1',filePath:undefined,untitled:true}}
    expect((await f.request('/transfers',untitled)).status).toBe(200)
    const state=await f.bridge.state();expect(state.transfers).toHaveLength(2)
    expect(state.transfers.find(t=>t.id===input.id)?.text).toMatchObject({content:input.text.content,resolvedFilePath:await realpath(input.text.filePath)})
    expect(state.transfers.find(t=>t.id===untitled.id)?.text?.filePath).toBeUndefined()
    await expect(f.bridge.openSource(untitled.id)).rejects.toThrow('未命名')
    for(const filePath of ['../data.sqlite','\\\\server\\share\\资料.md','\\\\?\\C:\\资料.md','C:\\资料.md:secret']) expect((await f.request('/transfers',{...f.text(),text:{...input.text,filePath}})).status).toBe(400)
    expect((await f.request('/transfers',{...f.text(),projectId:'project',target:{kind:'discussion-new'}})).status).toBe(400)
    expect(f.imports()).toBe(0);expect(f.store.listSessions()).toHaveLength(0);expect(f.store.listExecutions()).toHaveLength(0)
    expect(await readFile(join(f.project,'资料.md'),'utf8')).toBe('磁盘原文')
  })
  it('appends to independent or different-project drafts and retains choices; invalid targets and limits preserve pending data',async()=>{
    const f=await fixture();const input=f.text();await f.request('/transfers',input)
    const t=(await f.bridge.state()).transfers[0],key='discussion-new.independent',target={kind:'discussion-new'} as const
    f.store.saveDraft(key,JSON.stringify({topic:'原草稿',participants:['keep']}))
    expect(()=>f.bridge.apply({transferId:t.id,target,draftId:key,draft:JSON.stringify({topic:'x'.repeat(20000)+editorTransferBlock(t),_editorTransfers:[t.id]})})).toThrow('20,000')
    expect(()=>f.bridge.apply({transferId:t.id,target:{kind:'discussion-new',projectId:'deleted'},draftId:'discussion-new.deleted',draft:'{}'})).toThrow('已删除')
    expect(JSON.parse(f.store.getDraft(key)).topic).toBe('原草稿')
    const draft=JSON.stringify({topic:'原草稿'+editorTransferBlock(t),participants:['keep'],_editorTransfers:[t.id]})
    f.bridge.apply({transferId:t.id,target,draftId:key,draft});f.bridge.apply({transferId:t.id,target,draftId:key,draft})
    expect(f.store.getDraft(key)).toBe(draft);expect((await f.bridge.state()).transfers[0].status).toBe('applied')
    const other=f.text();await f.request('/transfers',other);f.store.deleteProject('project')
    const receipt=(await f.bridge.state()).transfers.find(t=>t.id===other.id)!
    f.store.saveProject({id:'other',name:'其它项目',directory:f.root,instructions:'',knowledgeBaseIds:[],createdAt:'now',updatedAt:'now'})
    const exec=JSON.stringify({projectId:'other',task:editorTransferBlock(receipt),executor:{modelId:'keep'},_editorTransfers:[receipt.id]})
    f.bridge.apply({transferId:receipt.id,target:{kind:'execution-new',projectId:'other'},draftId:'execution-new.other.new',draft:exec})
    expect(JSON.parse(f.store.getDraft('execution-new.other.new')).executor).toEqual({modelId:'keep'})
  })
  it('imports absolute document snapshots without projects only after collection confirmation',async()=>{
    const f=await fixture(),id=randomUUID();f.store.deleteProject('project')
    expect((await f.request('/transfers',{id,kind:'files',files:[join(f.project,'资料.pdf')]})).status).toBe(200)
    expect(f.imports()).toBe(0)
    f.store.saveKnowledgeBase({id:'kb',name:'资料',embedding:{providerId:'p',modelId:'e'},embeddingBaseUrl:'http://localhost',chunkVersion:1,createdAt:'now'})
    await f.bridge.importTransfer(id,'kb');await f.bridge.importTransfer(id,'kb');expect(f.imports()).toBe(1)
    expect(f.imported[0]).toEqual([await realpath(join(f.project,'资料.pdf'))]);expect((await f.bridge.state()).transfers[0].sourceIds).toEqual(['source'])
    f.bridge.dismiss(id);expect((await f.bridge.state()).transfers[0].status).toBe('dismissed')
  })
  it('accepts another project’s active discussion but rejects changed ownership or a completed session',async()=>{
    const f=await fixture(),input=f.text();await f.request('/transfers',input)
    f.store.saveProject({id:'destination',name:'接收项目',directory:f.root,instructions:'',knowledgeBaseIds:[],createdAt:'now',updatedAt:'now'})
    const session:Session={id:'conversation',projectId:'destination',title:'运行中的讨论',topic:'讨论',mode:'roundtable',participants:[],knowledgeBaseIds:[],searchEnabled:false,limits:DEFAULT_LIMITS,createdAt:'now',updatedAt:'now',status:'running',messages:[],evidence:[]}
    f.store.saveSession(session)
    const transfer=(await f.bridge.state()).transfers[0],draft=JSON.stringify({text:'原有输入'+editorTransferBlock(transfer),participantId:'keep-seat',_editorTransfers:[transfer.id]}),draftId='message.conversation'
    f.store.saveDraft(draftId,JSON.stringify({text:'原有输入',participantId:'keep-seat'}))
    expect(()=>f.bridge.apply({transferId:transfer.id,target:{kind:'discussion',projectId:'project',sessionId:session.id},draftId,draft})).toThrow('讨论已结束、删除或达到调用上限')
    expect(JSON.parse(f.store.getDraft(draftId)).text).toBe('原有输入')
    f.bridge.apply({transferId:transfer.id,target:{kind:'discussion',projectId:'destination',sessionId:session.id},draftId,draft})
    expect(JSON.parse(f.store.getDraft(draftId)).participantId).toBe('keep-seat')
    expect(f.store.getSession(session.id)).toEqual(session)
    const second=f.text();await f.request('/transfers',second);f.store.saveSession({...session,status:'complete'})
    expect(()=>f.bridge.apply({transferId:second.id,target:{kind:'discussion',projectId:'destination',sessionId:session.id},draftId,draft})).toThrow('讨论已结束')
    expect((await f.bridge.state()).transfers.find(t=>t.id===second.id)?.status).toBe('pending')
  })
  it('opens the recorded source through CLI even after cross-project reception into a same-named file',async()=>{
    const f=await fixture(),destination=join(f.root,'接收项目');await mkdir(destination);await writeFile(join(destination,'资料.md'),'其它项目同名文件')
    f.store.saveProject({id:'destination',name:'接收项目',directory:destination,instructions:'',knowledgeBaseIds:[],createdAt:'now',updatedAt:'now'})
    const input=f.text();input.text.startLine=2;await f.request('/transfers',input)
    const t=(await f.bridge.state()).transfers[0],target={kind:'discussion-new',projectId:'destination'} as const
    f.bridge.apply({transferId:t.id,target,draftId:'discussion-new.destination',draft:JSON.stringify({topic:editorTransferBlock(t),_editorTransfers:[t.id]})})
    const cli=vi.spyOn(f.bridge as unknown as {cli(args:string[]):Promise<void>},'cli').mockResolvedValue()
    await f.bridge.openSource(t.id)
    expect(cli).toHaveBeenCalledWith(['--goto',`${await realpath(input.text.filePath)}:2`])
    const legacy:EditorTransfer={...t,id:randomUUID(),projectId:'project',text:{...t.text!,filePath:undefined,resolvedFilePath:undefined}}
    f.store.saveEntity('editor-transfer',legacy.id,legacy)
    await f.bridge.openSource(legacy.id);expect(cli).toHaveBeenLastCalledWith(['--goto',`${await realpath(input.text.filePath)}:2`])
    f.store.deleteProject('project')
    await expect(f.bridge.openSource(legacy.id)).rejects.toThrow('原始项目已不存在')
    expect(cli).toHaveBeenCalledTimes(2)
  })
  it('rejects changed symlink destinations for import and source location',async()=>{
    const f=await fixture(),other=join(f.root,'另一个目录'),link=join(f.root,'资料链接')
    await mkdir(other);await writeFile(join(other,'资料.md'),'different');await writeFile(join(other,'资料.pdf'),'different')
    await symlink(f.project,link,'junction')
    const text=f.text();text.text.filePath=join(link,'资料.md');expect((await f.request('/transfers',text)).status).toBe(200)
    const files={id:randomUUID(),kind:'files',files:[join(link,'资料.pdf')]};expect((await f.request('/transfers',files)).status).toBe(200)
    await unlink(link);await symlink(other,link,'junction')
    f.store.saveKnowledgeBase({id:'kb',name:'资料',embedding:{providerId:'p',modelId:'e'},embeddingBaseUrl:'http://localhost',chunkVersion:1,createdAt:'now'})
    await expect(f.bridge.openSource(text.id)).rejects.toThrow('实际位置已改变')
    await expect(f.bridge.importTransfer(files.id,'kb')).rejects.toThrow('实际位置已改变')
    expect(f.imports()).toBe(0);expect((await f.bridge.state()).transfers.every(t=>t.status==='pending')).toBe(true)
  })
  it('uses legacy source project only for locating files and preserves unavailable legacy records',async()=>{
    const f=await fixture(),legacy:EditorTransfer={id:randomUUID(),clientId:f.credential.clientId,projectId:'project',kind:'files',files:['资料.pdf'],status:'pending',createdAt:new Date().toISOString()}
    f.store.saveEntity('editor-transfer',legacy.id,legacy);f.store.saveKnowledgeBase({id:'kb',name:'资料',embedding:{providerId:'p',modelId:'e'},embeddingBaseUrl:'http://localhost',chunkVersion:1,createdAt:'now'})
    await f.bridge.importTransfer(legacy.id,'kb');expect(f.imported[0]).toEqual([await realpath(join(f.project,'资料.pdf'))])
    const missing={...legacy,id:randomUUID(),projectId:'missing'};f.store.saveEntity('editor-transfer',missing.id,missing)
    await expect(f.bridge.importTransfer(missing.id,'kb')).rejects.toThrow('原始项目已不存在')
    expect((await f.bridge.state()).transfers.find(t=>t.id===missing.id)?.status).toBe('pending')
  })
  it('routes markdown across projects to an exact window and rejects another window acknowledgment',async()=>{
    const f=await fixture();await f.request('/windows',{name:'窗口 A',workspace:f.project},'window-a');await f.request('/windows',{name:'窗口 B'},'window-b')
    await expect(f.bridge.send({title:'总结',text:'内容'})).rejects.toThrow('明确选择')
    await f.bridge.send({title:'总结',text:'内容',windowId:`${f.credential.clientId}:window-a`})
    const result=await (await f.request('/outbox',undefined,'window-a')).json() as {items:Array<{id:string;text:string}>};expect(result.items.map(i=>i.text)).toEqual(['内容'])
    expect((await f.request(`/outbox/${result.items[0].id}/ack`,{},'window-b')).status).toBe(400)
    expect((await (await f.request('/outbox',undefined,'window-a')).json() as {items:unknown[]}).items).toHaveLength(1)
    expect((await f.request(`/outbox/${result.items[0].id}/ack`,{},'window-a')).status).toBe(200)
    const waiting=f.request('/outbox',undefined,'window-b')
    await new Promise(resolve=>setTimeout(resolve,20));await f.bridge.enable(false);expect(await (await waiting).json()).toEqual({items:[]})
  })
})
