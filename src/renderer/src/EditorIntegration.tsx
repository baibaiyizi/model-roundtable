import { useEffect, useRef, useState } from 'react'
import { Code2, RefreshCw, Send, Unlink, X } from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import { editorSourceTransfers, isEditorInboxTransfer, type EditorConnectionRequest, type EditorState, type EditorTarget, type EditorTransfer } from '../../shared/editor'
import { api, errorText } from './api'
import { Modal, Spinner, useTask, type Notify } from './common'
import { Collapsible } from './Collapsible'
import './editor.css'

export function EditorSettings({notify}:{notify:Notify}) {
  const [state,setState]=useState<EditorState>()
  const [error,setError]=useState('')
  const {busy,run}=useTask(notify)
  const load=()=>api.editorState().then(s=>{setState(s);setError('')}).catch(e=>setError(errorText(e)))
  useEffect(()=>{void load();return api.onEvent(e=>{if(e.type==='editor')void load()})},[])
  const hasClients=!!state?.clients.length
  return <Collapsible id="settings.editor" className="settings-section editor-settings" title={<><Code2 size={19}/>编辑器协同</>} summary={error ? '编辑器状态读取失败' : !state ? '正在检测 VS Code…' : state.running ? `资料连接已开启 · ${state.clients.length} 个已授权编辑器` : 'VS Code 伴随扩展 · 资料连接未开启'}>
    <p className="muted small section-description">在 VS Code 中编辑文件，将选区和资料送到圆桌；收到的内容由你确认后使用，无需绑定项目。</p>
    {error && <div className="editor-load-error"><p role="alert" className="panel-error">{error}</p><button type="button" disabled={busy} onClick={()=>void run(load)}><RefreshCw size={14}/>重试检测</button></div>}
    {!state && !error && <Spinner text="正在检测本机编辑器…"/>}
    {state && <>
      <section className="editor-setting-block" aria-labelledby="editor-install-title">
        <div className="editor-setting-row"><div><h3 id="editor-install-title">安装扩展</h3><p>{state.executable ? '已找到 VS Code。首次使用请安装伴随扩展。' : '未找到 VS Code，请选择安装目录中的 Code.exe。'}</p></div>
          {state.executable ? <button type="button" disabled={busy} onClick={()=>void run(async()=>{await api.editorInstall();notify('伴随扩展已安装。必要时重新加载 VS Code 窗口，右键发送文字后回圆桌允许首次连接即可。')})}>安装／更新伴随扩展</button> : <button type="button" disabled={busy} onClick={()=>void run(async()=>setState(await api.editorSelectExecutable()))}>选择 VS Code</button>}
        </div>
        <details className="advanced editor-install-details"><summary>安装路径与手动安装</summary>
          {state.executable && <><p>VS Code 安装路径</p><code>{state.executable}</code><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>setState(await api.editorSelectExecutable()))}>更换 VS Code 路径</button></>}
          <p>也可在 VS Code 的“扩展”视图点击“⋯ → 从 VSIX 安装”，选择以下文件：</p><code>{state.vsixPath}</code><p>安装后如右键菜单尚未出现，请重新加载 VS Code 窗口。</p>
        </details>
      </section>
      <section className="editor-setting-block" aria-labelledby="editor-connection-title">
        <div className="editor-setting-row"><div><h3 id="editor-connection-title">连接状态</h3><p>{state.running ? hasClients ? `资料连接已开启 · ${state.clients.length} 个已授权编辑器 · ${state.windows.length} 个在线窗口` : '已允许本机连接请求。在 VS Code 右键发送资料，回圆桌确认一次即可。' : '资料连接已关闭，开启后即可接受本机 VS Code 的连接请求。'}</p></div><div className="button-group">
          <button type="button" disabled={busy} onClick={()=>void run(async()=>setState(await api.editorEnable(!state.enabled)))}>{state.enabled ? '关闭资料连接' : '开启资料连接'}</button>
          {state.enabled && !state.running && <button type="button" disabled={busy} onClick={()=>void run(async()=>setState(await api.editorEnable(true)))}>重新连接</button>}
        </div></div>
        {hasClients && <div className="editor-clients">{state.clients.map(client=><div className="editor-client" key={client.id}><div><strong>{client.name}</strong><span>{state.windows.filter(window=>window.clientId===client.id).length} 个在线窗口 · 可跨项目接收资料</span></div><button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>setState(await api.editorRevoke(client.id)))}><Unlink size={14}/>撤销连接</button></div>)}</div>}
      </section>
    </>}
    <section className="editor-setting-block editor-guide" aria-labelledby="editor-guide-title"><h3 id="editor-guide-title">使用说明</h3>
      <ol><li>安装伴随扩展，必要时重新加载 VS Code 窗口。</li><li>在 VS Code 编辑区选中文字，右键<strong>“模型圆桌：发送选中文本”</strong>；也可发送当前文本文件。</li><li>首次发送时，回圆桌点击<strong>“允许连接”</strong>。以后自动复用连接，无需配对码或项目绑定。</li><li>打开圆桌左侧<strong>“VS Code 资料”</strong>，选择讨论或执行草稿，确认接收。默认追加到独立的新讨论草稿。</li></ol>
      <p>PDF、Office 文件：在左侧资源管理器右键，选择“模型圆桌：导入资料到知识库”，回圆桌选择集合并确认导入。</p>
      <p className="muted">需 VS Code 1.138 或更新版本及可信的 Windows 本机环境。无需打开文件夹，可发送未命名文本及未保存修改；接收资料不会自动启动模型任务。连接被拒绝或撤销后，可从 VS Code 命令面板运行“模型圆桌：重新连接应用”。</p>
      <p className="editor-guide-links">文档预览：{[{title:'Markdown 原生预览',url:'https://code.visualstudio.com/docs/languages/markdown'},{title:'Draw.io Integration',url:'https://github.com/hediet/vscode-drawio'},{title:'PDF 预览插件',url:'https://github.com/tomoki1207/vscode-pdfviewer'}].map((item,index)=><span key={item.url}>{index>0 && ' · '}<a href={item.url} onClick={event=>{event.preventDefault();void run(()=>api.openExternal(item.url))}}>{item.title}</a></span>)}</p>
      <p className="muted">第三方插件使用其自己的账号、权限和网络设置。</p>
    </section>
  </Collapsible>
}

export function EditorConnectionPrompt({request,onResolved,notify}:{request:EditorConnectionRequest;onResolved(state:EditorState):void;notify:Notify}) {
  const {busy,run}=useTask(notify)
  const resolve=(allow:boolean)=>run(async()=>onResolved(await api.editorResolveConnection({requestId:request.id,allow})))
  return <Modal title="VS Code 请求连接" onClose={()=>{if(!busy)void resolve(false)}}><p className="confirm-body"><strong>{request.name}</strong> 希望连接本机模型圆桌，发送文字与资料，并接收你发往 VS Code 的内容。</p><p className="small muted">允许一次后，此用户配置下的本机窗口可自动连接，不限项目。你可随时在“编辑器协同”中撤销。</p><p className="small muted">请求有效至 {new Date(request.expiresAt).toLocaleTimeString()}。</p><div className="modal-footer"><span/ ><button disabled={busy} onClick={()=>void resolve(false)}>拒绝连接</button><button className="primary" disabled={busy} onClick={()=>void resolve(true)}>允许连接</button></div></Modal>
}

export function EditorReceiving() {
  const dialog=useRef<HTMLDialogElement>(null)
  useEffect(()=>{const element=dialog.current;if(element && !element.open)element.showModal();return()=>element?.close()},[])
  return <dialog ref={dialog} className="modal" aria-label="正在接收资料" onCancel={event=>event.preventDefault()}><Spinner text="正在保存草稿…"/></dialog>
}

type TargetChoice = { value: string; label: string; target: EditorTarget; group: string; groupId: string }
function targetChoices(data:Bootstrap):TargetChoice[] {
  const items:TargetChoice[]=[{value:'discussion-new:independent',label:'新讨论草稿 · 独立讨论',target:{kind:'discussion-new'},group:'独立讨论',groupId:'independent'}]
  for(const project of data.projects) {
    items.push({value:`discussion-new:${project.id}`,label:`新讨论草稿 · ${project.name}`,target:{kind:'discussion-new',projectId:project.id},group:project.name,groupId:project.id})
    items.push({value:`execution-new:${project.id}`,label:`新执行草稿 · ${project.name}`,target:{kind:'execution-new',projectId:project.id},group:project.name,groupId:project.id})
  }
  for(const session of data.sessions.filter(s=>!['complete','stopped'].includes(s.status) && (!s.run || s.run.calls<s.limits.maxCalls))) {
    const project=session.projectId ? data.projects.find(p=>p.id===session.projectId) : undefined
    if(session.projectId && !project)continue
    items.push({value:`discussion:${session.id}`,label:`${session.title} · ${project?.name ?? '独立讨论'} · 讨论输入框`,target:{kind:'discussion',sessionId:session.id,projectId:session.projectId},group:project?.name ?? '独立讨论',groupId:project?.id ?? 'independent'})
  }
  return items
}

export function EditorInbox({data,open,onClose,onAccept,onKnowledge,notify}:{data:Bootstrap;open:boolean;onClose():void;onAccept(transfer:EditorTransfer,target:EditorTarget):Promise<void>;onKnowledge(projectId:string|undefined,kbId:string):Promise<void>;notify:Notify}) {
  const [state,setState]=useState<EditorState>()
  const [targets,setTargets]=useState<Record<string,string>>({})
  const [queries,setQueries]=useState<Record<string,string>>({})
  const [collections,setCollections]=useState<Record<string,string>>({})
  const {busy,run}=useTask(notify)
  const load=()=>api.editorState().then(setState)
  useEffect(()=>{if(open)void load().catch(e=>notify(errorText(e),true));return api.onEvent(e=>{if(open && (e.type==='editor'||e.type==='source'))void load().catch(()=>{})})},[open])
  if(!open)return null
  const transfers=state?.transfers.filter(isEditorInboxTransfer) ?? []
  const choices=targetChoices(data)
  return <Modal title="来自 VS Code 的资料" wide onClose={onClose}><p className="small muted">来自任意本机文件或未命名文本的资料都在这里。文本只追加到所选草稿；文件确认后才解析，视觉和 Embedding 可能使用付费服务。</p>{!state?<Spinner/>:!transfers.length?<p>暂无待处理资料。可在 VS Code 中选中文字，使用右键菜单发送。</p>:transfers.map(t=>{
    const target=targets[t.id] ?? 'discussion-new:independent'
    const query=(queries[t.id] ?? '').trim().toLocaleLowerCase()
    const selected=choices.find(c=>c.value===target)
    const visible=choices.filter(c=>c.value===target || `${c.group} ${c.label}`.toLocaleLowerCase().includes(query))
    const groups=[...new Set(visible.map(c=>c.groupId))]
    const sourceProject=t.projectId ? data.projects.find(project=>project.id===t.projectId) : undefined
    const collection=collections[t.id] ?? t.knowledgeBaseId ?? data.knowledgeBases[0]?.id ?? ''
    const sources=data.sources.filter(s=>t.sourceIds?.includes(s.id))
    const complete=t.status==='imported' && !!t.sourceIds?.length && sources.length===t.sourceIds.length && sources.every(s=>s.status==='ready')
    return <article className="editor-transfer" key={t.id}><div className="section-heading"><h3>{t.kind==='text' ? t.text?.path : `${t.files?.length} 份资料`}</h3><button className="icon-button" aria-label="移除资料接收记录" disabled={busy} onClick={()=>void run(async()=>{await api.editorDismiss(t.id);await load()})}><X size={16}/></button></div>
      {sourceProject && <p className="small muted editor-source-path">来源目录：{sourceProject.directory}</p>}
      {t.kind==='text'?<><p className="small muted">第 {t.text?.startLine}–{t.text?.endLine} 行 · {t.text?.untitled?'未命名文本 · ':''}{t.text?.dirty?'未保存的编辑器快照':'文本快照'} · {new Date(t.createdAt).toLocaleString()}</p>{t.text?.filePath && <p className="small muted editor-source-path">{t.text.filePath}</p>}{!t.text?.untitled && <OpenEditorSource transferId={t.id} notify={notify}/>}<pre className="editor-excerpt">{t.text?.content}</pre><label className="field"><span>接收到</span><input type="search" aria-label={`资料目标筛选 ${t.id}`} placeholder="搜索项目或讨论…" value={queries[t.id] ?? ''} onChange={e=>setQueries(v=>({...v,[t.id]:e.target.value}))}/><select aria-label={`资料目标 ${t.id}`} value={target} onChange={e=>setTargets(v=>({...v,[t.id]:e.target.value}))}>{!selected && <option value={target}>目标已不可用，请重新选择</option>}{groups.map(group=><optgroup key={group} label={visible.find(c=>c.groupId===group)!.group}>{visible.filter(c=>c.groupId===group).map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</optgroup>)}</select></label><button className="primary" disabled={busy || !selected} onClick={()=>void run(()=>onAccept(t,selected!.target))}>追加到草稿</button></>:<><ul>{(t.resolvedFiles ?? t.files)?.map(path=><li key={path}>{path}</li>)}</ul>{t.status==='pending'?<><label className="field"><span>目标知识库</span><select aria-label={`资料知识库 ${t.id}`} value={collection} onChange={e=>setCollections(v=>({...v,[t.id]:e.target.value}))}><option value="">先创建知识库并设置 Embedding 模型</option>{data.knowledgeBases.map(k=><option key={k.id} value={k.id}>{k.name}</option>)}</select></label><button className="primary" disabled={busy || !collection} onClick={()=>void run(async()=>{await api.editorImport({transferId:t.id,knowledgeBaseId:collection});await load();notify('已保存原件并加入导入队列，可在知识库查看进度或取消')})}>确认导入所选集合</button></>:<><p>{sources.map(s=>`${s.title}：${s.progress || s.status}`).join('；') || '原导入资料已删除'}</p><button disabled={!complete || busy} onClick={()=>void run(()=>onKnowledge(undefined,t.knowledgeBaseId!))}>使用此集合开启讨论草稿</button><p className="small muted">所有资料处理完成后才可从此入口开始讨论；失败或取消请到知识库处理。</p></>}</>}
    </article>
  })}</Modal>
}

export function OpenInEditor({projectId,path,line,notify,label='在 VS Code 打开'}:{projectId:string;path?:string;line?:number;notify:Notify;label?:string}) {
  const {busy,run}=useTask(notify)
  return <button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>{await api.editorOpen({projectId,path,line});notify('已交给 VS Code 打开')})}><Code2 size={14}/>{label}</button>
}
function OpenEditorSource({transferId,label='在 VS Code 定位来源',notify}:{transferId:string;label?:string;notify:Notify}) {
  const {busy,run}=useTask(notify)
  return <button type="button" className="text-button" disabled={busy} onClick={()=>void run(async()=>{await api.editorOpenSource(transferId);notify('已交给 VS Code 定位来源')})}><Code2 size={14}/>{label}</button>
}
export function EditorSourceLinks({text,notify}:{projectId?:string;text:string;notify:Notify}) {
  const [sources,setSources]=useState<EditorTransfer[]>([])
  const references=text.split(/\r?\n/).filter(line=>line.includes('[VS Code 资料：')).join('\n')
  useEffect(()=>{let active=true;if(!references){setSources([]);return}void api.editorState().then(state=>{if(active)setSources(editorSourceTransfers(references,state.transfers))}).catch(()=>{if(active)setSources([])});return()=>{active=false}},[references])
  return sources.length ? <div className="editor-source-links">{sources.map(source=><OpenEditorSource key={source.id} transferId={source.id} notify={notify} label={`定位来源：${source.text?.path}:${source.text?.startLine}`}/>)}</div> : null
}
export function SendToEditor({title,text,notify}:{projectId?:string;title:string;text:string;notify:Notify}) {
  const [choices,setChoices]=useState<Array<{id:string;label:string}>>([])
  const [selected,setSelected]=useState('')
  const {busy,run}=useTask(notify)
  const send=async(windowId:string)=>{await api.editorSend({title,text,windowId});setChoices([]);notify('资料已交给所选 VS Code 窗口；将打开为未保存文档')}
  return <><button type="button" className="text-button" disabled={busy || !text} onClick={()=>void run(async()=>{const state=await api.editorState();const items=state.windows.map(w=>({id:w.id,label:`${w.name || state.clients.find(c=>c.id===w.clientId)?.name || 'VS Code'} · ${w.workspace || '未打开文件夹'} · ${w.id.slice(-8)}`}));if(!items.length)throw new Error('尚无在线 VS Code 窗口。请安装伴随扩展，在 VS Code 右键发送一次资料并允许连接。');if(items.length===1)await send(items[0].id);else{setChoices(items);setSelected(items[0].id)}})}><Send size={14}/>发送到 VS Code</button>{choices.length>0&&<Modal title="选择 VS Code 窗口" onClose={()=>setChoices([])}><label className="field"><span>接收窗口</span><select value={selected} onChange={e=>setSelected(e.target.value)}>{choices.map(w=><option key={w.id} value={w.id}>{w.label}</option>)}</select></label><button disabled={busy} onClick={()=>void run(()=>send(selected))}>发送资料</button></Modal>}</>
}
