import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, BookOpen, CheckCircle2, CircleAlert, CircleDot, Compass, FolderOpen, Globe2, Inbox, MessagesSquare, Play, Plus, RefreshCw, Settings2, Sparkles, Users, X } from 'lucide-react'
import type { Bootstrap, Session } from '../../shared/types'
import type { Project } from '../../shared/workspace'
import type { Execution } from '../../shared/execution'
import type { NetworkState } from '../../shared/network'
import { api, errorText } from './api'
import { Modal, Spinner, modeLabel, type Confirm, type Notify } from './common'
import { Discussion } from './Discussion'
import { KnowledgeView } from './KnowledgeView'
import { NewSession } from './NewSession'
import { SettingsView, ProviderEditor } from './SettingsView'
import { ProjectEditor } from './ProjectEditor'
import { ProjectFiles } from './ProjectFiles'
import { ExecutionTaskCard } from './ExecutionTaskCard'
import { ExecutionView, executionStatusLabel } from './ExecutionView'
import { clearLocalDrafts, receiveEditorDraft } from './useDraft'
import { EditorConnectionPrompt, EditorInbox, EditorReceiving, OpenInEditor } from './EditorIntegration'
import { isEditorInboxTransfer, type EditorConnectionRequest, type EditorState, type EditorTarget, type EditorTransfer } from '../../shared/editor'
import { ExtensionsView, ProjectExtensionsPanel, ExtensionApprovalsPanel, ExtensionSearchBindingPanel } from './ExtensionsView'
import { ComponentsView } from './ComponentsView'
import { NetworkView } from './NetworkView'
import { NetworkContext } from './NetworkContext'
import { SidebarMenu } from './SelectionControls'
import './workspace.css'

type Selection = { kind: 'discussion' | 'execution'; id: string; projectId?: string }
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [loadError, setLoadError] = useState('')
  const [sidebarQuery, setSidebarQuery] = useState('')
  const [deletingIds, setDeletingIds] = useState<string[]>([])
  const leaveGuard = useRef<(() => Promise<boolean>) | undefined>(undefined)
  const windowClosePending = useRef(false)
  const [page, setPage] = useState<'home' | 'settings' | 'knowledge' | 'extensions' | 'components' | 'network'>('home')
  const [networkState, setNetworkState] = useState<NetworkState | null>(null)
  const [networkError, setNetworkError] = useState('')
  const [networkProvider, setNetworkProvider] = useState<string | null>(null)
  const [networkDialog, setNetworkDialog] = useState(false)
  const [projectId, setProjectId] = useState<string | undefined>()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [tabs, setTabs] = useState<Selection[]>([])
  const [creating, setCreating] = useState(false)
  const [editorInbox, setEditorInbox] = useState(false)
  const [editorReceiptCount, setEditorReceiptCount] = useState(0)
  const [editorRequests, setEditorRequests] = useState<EditorConnectionRequest[]>([])
  const [editorReceiving, setEditorReceiving] = useState(false)
  const [projectEditor, setProjectEditor] = useState<Project | 'new' | null>(null)
  const [executionDraft, setExecutionDraft] = useState<{ session?: Session; task?: string } | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string; error: boolean } | null>(null)
  const [confirmation, setConfirmation] = useState<{ title: string; body: string; resolve: (result: boolean) => void } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const notify: Notify = useCallback((text, error = false) => { clearTimeout(toastTimer.current); setToast({ id: Date.now(), text, error }); toastTimer.current = setTimeout(() => setToast(null), error ? 12000 : 5500) }, [])
  const registerLeaveGuard = useCallback((guard: () => Promise<boolean>) => {
    leaveGuard.current = guard
    void api.setWindowCloseGuard(true).catch(error => notify(errorText(error), true))
    return () => {
      if (leaveGuard.current === guard) leaveGuard.current = undefined
      // Replacing the guard in the same render must not briefly allow an unguarded close.
      queueMicrotask(() => { if (!leaveGuard.current) void api.setWindowCloseGuard(false).catch(() => {}) })
    }
  }, [notify])
  const requestWindowClose = useCallback(async () => {
    if (windowClosePending.current) return
    windowClosePending.current = true
    try { if (!leaveGuard.current || await leaveGuard.current()) await api.closeWindow() }
    catch (error) { notify(errorText(error), true) }
    finally { windowClosePending.current = false }
  }, [notify])
  const confirm: Confirm = (title, body) => new Promise(resolve => setConfirmation({ title, body, resolve }))
  const mergeSession = useCallback((session: Session) => setData(d => !d ? d : { ...d, sessions: [session, ...d.sessions.filter(s => s.id !== session.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }), [])
  const mergeExecution = useCallback((execution: Execution) => setData(d => !d ? d : { ...d, executions: [execution, ...d.executions.filter(e => e.id !== execution.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }), [])
  const updateNetwork = useCallback((state: NetworkState) => { setNetworkState(state); setNetworkError('') }, [])
  const refreshNetwork = useCallback(async () => { try { updateNetwork(await api.getNetworkState()) } catch (error) { setNetworkError(errorText(error)); throw error } }, [updateNetwork])
  const refresh = useCallback(async () => {
    const next = await api.bootstrap()
    setData(current => !current ? next : { ...next,
      sessions: next.sessions.map(s => {
        const local = current.sessions.find(x => x.id === s.id)
        if (!local || s.updatedAt > local.updatedAt) return { ...s, messages: s.messages.map(m => {
          const live = local?.messages.find(x => x.id === m.id && x.runId === m.runId && x.turnId === m.turnId && x.contextVersion === m.contextVersion)
          return live?.status === 'streaming' && m.status === 'streaming' && live.content.startsWith(m.content) ? { ...m, content: live.content } : m
        }) }
        return local
      }),
      executions: next.executions.map(e => { const local = current.executions.find(x => x.id === e.id); return local && local.updatedAt >= e.updatedAt ? local : e }),
    })
    setLoadError('')
  }, [])
  const updateEditorState = useCallback((state: EditorState) => {
    setEditorReceiptCount(state.transfers.filter(isEditorInboxTransfer).length)
    setEditorRequests(state.connectionRequests)
  }, [])
  useEffect(() => {
    if (!api) { setLoadError('桌面连接不可用。请从“模型圆桌”桌面程序启动应用。'); return }
    const updateEditor = () => void api.editorState().then(updateEditorState).catch(() => {})
    updateEditor()
    const off = api.onEvent(event => {
      if (event.type === 'editor') updateEditor()
      if (event.type === 'close-request') void requestWindowClose()
      if (event.type === 'session' && event.session) mergeSession(event.session)
      if (event.type === 'execution' && event.execution) {
        mergeExecution(event.execution)
        if (event.active !== undefined) setData(current => current ? { ...current, activeExecutionIds: event.active ? [...new Set([...(current.activeExecutionIds ?? []), event.execution!.id])] : current.activeExecutionIds?.filter(id => id !== event.execution!.id) } : current)
      }
      if (event.type === 'delta') setData(current => !current ? current : { ...current, sessions: current.sessions.map(s => {
        if (s.id !== event.sessionId || !s.run || s.run.id !== event.runId || s.run.contextVersion !== event.contextVersion) return s
        return { ...s, messages: s.messages.map(m => m.id === event.messageId && m.runId === event.runId && m.turnId === event.turnId && m.contextVersion === event.contextVersion && m.status === 'streaming' ? { ...m, content: m.content + (event.delta ?? '') } : m) }
      }) })
      if (event.type === 'source' && event.source) setData(d => !d ? d : { ...d, sources: [event.source!, ...d.sources.filter(s => s.id !== event.source!.id)] })
      if (event.type === 'knowledge') void refresh().catch(e => notify(errorText(e), true))
      if (event.type === 'activity') setData(current => current ? { ...current, activeSessionIds: event.activeSessionIds ?? [] } : current)
      if (event.type === 'network' && event.network) updateNetwork(event.network)
      if (event.type === 'error' && event.error) notify(event.error, true)
    })
    void refresh().catch(e => setLoadError(errorText(e)))
    void refreshNetwork().catch(() => {})
    return () => { off(); clearTimeout(toastTimer.current) }
  }, [mergeSession, mergeExecution, notify, refresh, refreshNetwork, updateNetwork, requestWindowClose, updateEditorState])
  if (!data) return <div className="app-loading"><div className="brand-mark"><CircleDot size={28}/></div><h1>模型圆桌</h1>{loadError ? <><p role="alert">{loadError}</p><button className="primary" onClick={() => { if (api) void refresh().catch(e => setLoadError(errorText(e))) }}><RefreshCw size={16}/>重新连接</button></> : <Spinner text="正在准备你的讨论空间…"/>}</div>
  const activeSession = selection?.kind === 'discussion' ? data.sessions.find(s => s.id === selection.id) : undefined
  const activeExecution = selection?.kind === 'execution' ? data.executions.find(e => e.id === selection.id) : undefined
  const project = data.projects.find(p => p.id === projectId)
  const hasModels = data.providers.some(p => p.modelIds.length)
  const navigate = async (action: () => void) => { if (page !== 'network' || !leaveGuard.current || await leaveGuard.current()) action() }
  const home = (id?: string) => void navigate(() => { setPage('home'); setSelection(null); setProjectId(id) })
  const showPage = (next: typeof page) => void navigate(() => setPage(next))
  const open = (item: Selection) => void navigate(() => { setSelection(item); setProjectId(item.projectId); setPage('home'); setTabs(t => t.some(x => x.id === item.id) ? t : [...t, item]) })
  const openSession = (s: Session) => open({ kind: 'discussion', id: s.id, projectId: s.projectId })
  const openExecution = (e: Execution) => open({ kind: 'execution', id: e.id, projectId: e.projectId })
  const start = () => { if (hasModels) setCreating(true); else { showPage('settings'); notify('先添加模型服务，就可以邀请它们一起讨论') } }
  const execute = (session?: Session, task?: string) => { if (!hasModels) { showPage('settings'); return } setExecutionDraft({ session, task }) }
  const removeTab = (id: string) => { setTabs(t => t.filter(x => x.id !== id)); if (selection?.id === id) setSelection(null) }
  const sessionBusy = (session: Session) => session.status === 'running' || session.messages.some(message => message.status === 'streaming') || !!data.activeSessionIds?.includes(session.id)
  const executionBusy = (execution: Execution) => ['running', 'reviewing', 'stopping'].includes(execution.status) || !!data.activeExecutionIds?.includes(execution.id)
  const projectBusy = (id: string) => data.sessions.some(session => session.projectId === id && sessionBusy(session)) || data.executions.some(execution => execution.projectId === id && executionBusy(execution))
  const remove = async (id: string, task: () => Promise<void>) => {
    if (deletingIds.includes(id)) return
    setDeletingIds(ids => [...ids, id])
    try { await task() } catch (error) { notify(errorText(error), true) } finally { setDeletingIds(ids => ids.filter(value => value !== id)) }
  }
  const exportSession = async (session: Session) => { try { const path = await api.exportSession(session.id); if (path) notify(`已导出：${path}`) } catch (error) { notify(errorText(error), true) } }
  const deleteSession = (session: Session) => void remove(session.id, async () => {
    if (sessionBusy(session)) { notify('请先停止，等待当前任务结束', true); return }
    if (!await confirm('删除这次讨论', `删除“${session.title}”及全部发言与证据记录，此操作无法撤销。`)) return
    await api.deleteSession(session.id)
    clearLocalDrafts({ sessionIds: [session.id] }); removeTab(session.id)
    setExecutionDraft(draft => draft?.session?.id === session.id ? null : draft)
    setData(current => current ? { ...current, sessions: current.sessions.filter(item => item.id !== session.id) } : current)
  })
  const deleteExecution = (execution: Execution) => void remove(execution.id, async () => {
    if (executionBusy(execution)) { notify('请先停止，等待当前任务结束', true); return }
    if (!await confirm('删除执行记录', '将删除本次任务记录，项目中的实际文件会保留，也不会回滚执行产生的改动。')) return
    await api.deleteExecution(execution.id); removeTab(execution.id)
    setData(current => current ? { ...current, executions: current.executions.filter(item => item.id !== execution.id) } : current)
  })
  const deleteProject = (target: Project) => void remove(target.id, async () => {
    if (projectBusy(target.id)) { notify('请先停止项目中的任务，等待处理结束', true); return }
    if (!await confirm('移除项目', `移除“${target.name}”及其全部讨论、执行记录和草稿。工作目录中的实际文件不会删除，也不会回滚执行产生的改动。`)) return
    await api.removeProject(target.id)
    const sessionIds = data.sessions.filter(session => session.projectId === target.id).map(session => session.id)
    clearLocalDrafts({ projectId: target.id, sessionIds }); setTabs(current => current.filter(tab => tab.projectId !== target.id))
    if (projectId === target.id) { setProjectId(undefined); setSelection(null); setCreating(false); setExecutionDraft(null) }
    else setExecutionDraft(draft => draft?.session?.projectId === target.id ? null : draft)
    setProjectEditor(current => typeof current === 'object' && current?.id === target.id ? null : current)
    setData(current => current ? { ...current, projects: current.projects.filter(item => item.id !== target.id), sessions: current.sessions.filter(item => item.projectId !== target.id), executions: current.executions.filter(item => item.projectId !== target.id) } : current)
  })
  const acceptEditor = async (transfer: EditorTransfer, target: EditorTarget) => {
    if (leaveGuard.current && !(await leaveGuard.current())) return
    const sameDraft = projectId === target.projectId && ((creating && target.kind === 'discussion-new') || (executionDraft && !executionDraft.session && target.kind === 'execution-new'))
    if (((creating || executionDraft) && !sameDraft) || projectEditor || networkProvider || networkDialog) throw new Error('请先关闭其他编辑窗口，再接收资料；资料会继续保留。')
    if (target.projectId && !data.projects.some(p => p.id === target.projectId)) throw new Error('目标项目已删除，请重新选择接收位置。')
    if (target.kind === 'execution-new' && !target.projectId) throw new Error('请为执行草稿选择实际执行项目。')
    const session = target.kind === 'discussion' ? data.sessions.find(s => s.id === target.sessionId && !['complete','stopped'].includes(s.status) && (!s.run || s.run.calls<s.limits.maxCalls)) : undefined
    if (target.kind === 'discussion' && !session) throw new Error('目标讨论不可用，请重新选择。')
    setEditorInbox(false); setEditorReceiving(true); setPage('home'); setProjectId(target.projectId); setSelection(null)
    const key = target.kind === 'discussion-new' ? `discussion-new.${target.projectId ?? 'independent'}` : target.kind === 'execution-new' ? `execution-new.${target.projectId}.new` : `message.${session!.id}`
    if (target.kind === 'discussion-new') setCreating(true)
    else if (target.kind === 'execution-new') setExecutionDraft({})
    else { const item: Selection = { kind: 'discussion', id: session!.id, projectId: session!.projectId }; setSelection(item); setProjectId(item.projectId); setTabs(t => t.some(tab => tab.id === item.id) ? t : [...t, item]) }
    try { await receiveEditorDraft(key, { transfer, target }); notify('资料已追加并保存到草稿，尚未发送模型请求') }
    finally { setEditorReceiving(false) }
  }
  const useEditorKnowledge = async (pid: string | undefined, knowledgeBaseId: string) => {
    if (leaveGuard.current && !(await leaveGuard.current())) return
    if (creating || executionDraft || projectEditor || networkProvider || networkDialog) throw new Error('请先关闭当前编辑窗口。')
    setEditorInbox(false); setEditorReceiving(true); setPage('home'); setProjectId(pid); setSelection(null); setCreating(true)
    try { await receiveEditorDraft(`discussion-new.${pid ?? 'independent'}`, { knowledgeBaseId }); notify('已选择导入资料所在集合，尚未开始讨论') }
    finally { setEditorReceiving(false) }
  }
  const matchesSidebar = (text: string) => text.toLocaleLowerCase().includes(sidebarQuery.trim().toLocaleLowerCase())
  const localSessions = data.sessions.filter(s => s.projectId === projectId)
  const localExecutions = data.executions.filter(e => e.projectId === projectId)
  const visibleTabs = tabs.filter(t => t.projectId === projectId && (t.kind === 'discussion' ? data.sessions.some(s => s.id === t.id) : data.executions.some(e => e.id === t.id)))
  const titleFor = (t: Selection) => t.kind === 'discussion' ? data.sessions.find(s => s.id === t.id)?.title : data.executions.find(e => e.id === t.id)?.task.split('\n')[0].replace(/^#+\s*/, '')
  return <NetworkContext.Provider value={{ state: networkState, error: networkError, refresh: refreshNetwork, update: updateNetwork, openProvider: setNetworkProvider, openSettings: () => setNetworkDialog(true), registerLeaveGuard }}><div className="app-shell"><aside className="navigation-sidebar"><button className="brand" onClick={() => home()}><span className="brand-mark"><CircleDot size={22}/></span><span>模型圆桌<small>THINK TOGETHER. BUILD TOGETHER.</small></span></button>
    <button className="new-discussion primary" onClick={start}><Plus size={18}/>新建讨论<span>＋</span></button>
    <nav className="primary-nav" aria-label="主导航"><button aria-current={page === 'home' && !selection && !projectId ? 'page' : undefined} className={page === 'home' && !selection && !projectId ? 'active' : ''} onClick={() => home()}><Compass size={18}/>讨论空间</button><button aria-current={page === 'knowledge' ? 'page' : undefined} className={page === 'knowledge' ? 'active' : ''} onClick={() => showPage('knowledge')}><BookOpen size={18}/>知识库<span className="nav-count">{data.knowledgeBases.length || ''}</span></button><button aria-current={page === 'extensions' ? 'page' : undefined} className={page === 'extensions' ? 'active' : ''} onClick={() => showPage('extensions')}><Sparkles size={18}/>扩展商店</button><button aria-current={page === 'components' ? 'page' : undefined} className={page === 'components' ? 'active' : ''} onClick={() => showPage('components')}><FolderOpen size={18}/>组件中心</button></nav>
    <div className="sidebar-filter filter-input"><input aria-label="筛选项目和会话" placeholder="筛选项目和会话…" value={sidebarQuery} onChange={event => setSidebarQuery(event.target.value)}/>{sidebarQuery && <button className="icon-button" aria-label="清除项目和会话筛选" onClick={() => setSidebarQuery('')}><X size={13}/></button>}</div>
    <div className="history-heading project-heading"><span>项目</span><button className="icon-button" aria-label="新建项目" title="新建项目" onClick={() => setProjectEditor('new')}><Plus size={15}/></button></div>
    <div className="project-list">{data.projects.filter(p => matchesSidebar(p.name)).map(p => <div className="sidebar-item-row" key={p.id}><button aria-label={`项目 ${p.name}`} aria-current={projectId === p.id && page === 'home' ? 'page' : undefined} className={`project-nav ${projectId === p.id ? 'active' : ''}`} onClick={() => home(p.id)}><FolderOpen size={16}/><span>{p.name}</span>{projectBusy(p.id) && <i className="tiny-live"/>}</button><SidebarMenu label={`项目 ${p.name} 更多操作`} actions={[{ label: '项目设置', action: () => setProjectEditor(p) }, { label: '移除项目', action: () => deleteProject(p), danger: true, disabled: projectBusy(p.id) || deletingIds.includes(p.id), reason: projectBusy(p.id) ? '请先停止，等待任务结束' : undefined }]}/></div>)}{!data.projects.length && <button className="project-first" onClick={() => setProjectEditor('new')}><FolderOpen size={15}/>绑定一个工作目录</button>}</div>
    <div className="history-heading"><span>{project ? `${project.name}的会话` : '独立讨论'}</span><span>{localSessions.length + localExecutions.length}</span></div>
    <div className="session-list">{[...localSessions.map(s => ({ kind: 'discussion' as const, id: s.id, title: s.title, date: s.updatedAt, status: s.status, subtitle: modeLabel[s.mode], item: s })), ...localExecutions.map(e => ({ kind: 'execution' as const, id: e.id, title: e.task.split('\n')[0].replace(/^#+\s*/, ''), date: e.updatedAt, status: e.status, subtitle: `执行 · ${executionStatusLabel[e.status]}`, item: e }))].filter(item => matchesSidebar(item.title)).sort((a, b) => b.date.localeCompare(a.date)).map(item => {
      const blocked = item.kind === 'discussion' ? sessionBusy(item.item as Session) : executionBusy(item.item as Execution)
      return <div className="sidebar-item-row" key={item.id}><button aria-current={page === 'home' && selection?.id === item.id ? 'page' : undefined} className={`session-item ${page === 'home' && selection?.id === item.id ? 'active' : ''}`} onClick={() => item.kind === 'discussion' ? openSession(item.item as Session) : openExecution(item.item as Execution)}><span className={`session-list-dot ${blocked ? 'running' : ''}`}/><div><strong>{item.title}</strong><span>{item.subtitle}<i>·</i>{new Date(item.date).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span></div></button><SidebarMenu label={`${item.kind === 'discussion' ? '讨论' : '执行'} ${item.title} 更多操作`} actions={[...(item.kind === 'discussion' ? [{ label: '导出 Markdown', action: () => void exportSession(item.item as Session) }] : []), { label: item.kind === 'discussion' ? '删除讨论' : '删除执行记录', action: () => item.kind === 'discussion' ? deleteSession(item.item as Session) : deleteExecution(item.item as Execution), danger: true, disabled: blocked || deletingIds.includes(item.id), reason: blocked ? '请先停止，等待任务结束' : undefined }]}/></div>
    })}{!localSessions.length && !localExecutions.length && <p className="history-empty">新的想法，<br/>从一次讨论开始。</p>}{sidebarQuery && ![...localSessions.map(s => s.title), ...localExecutions.map(e => e.task)].some(matchesSidebar) && <p className="history-empty">没有符合筛选的会话</p>}</div>
    <div className="nav-bottom">{editorReceiptCount > 0 && <button aria-haspopup="dialog" aria-expanded={editorInbox} onClick={() => setEditorInbox(true)}><Inbox size={18}/>VS Code 资料<span className="nav-count">{editorReceiptCount}</span></button>}<button aria-current={page === 'network' ? 'page' : undefined} className={page === 'network' ? 'active' : ''} onClick={() => showPage('network')}><Globe2 size={18}/>网络与订阅</button><button aria-current={page === 'settings' ? 'page' : undefined} className={page === 'settings' ? 'active' : ''} onClick={() => showPage('settings')}><Settings2 size={18}/>模型与设置{!hasModels && <span className="setup-dot"/>}</button><div className="local-label"><span/>本机工作空间 <span className="app-version">v{data.version}</span></div></div></aside>
    <main className="app-content workspace-content">{page === 'home' && visibleTabs.length > 0 && <div className="conversation-tabs" role="tablist" aria-label="已打开的会话">{visibleTabs.map(t => <div className={selection?.id === t.id ? 'active' : ''} key={t.id}><button role="tab" aria-selected={selection?.id === t.id} title={titleFor(t)} onClick={() => open(t)}>{t.kind === 'discussion' ? <MessagesSquare size={13}/> : <Play size={13}/>}<span>{titleFor(t)}</span></button><button className="tab-close" aria-label={`关闭标签 ${titleFor(t)}`} title="关闭标签，不会停止任务" onClick={() => removeTab(t.id)}><X size={12}/></button></div>)}</div>}
      <div className="workspace-view">{page === 'network' ? <NetworkView notify={notify} confirm={confirm}/> : page === 'extensions' ? <ExtensionsView notify={notify} confirm={confirm} projectId={projectId}/> : page === 'components' ? <ComponentsView notify={notify} confirm={confirm}/> : page === 'settings' ? <SettingsView data={data} refresh={refresh} notify={notify} confirm={confirm}/> : page === 'knowledge' ? <KnowledgeView data={data} refresh={refresh} notify={notify} confirm={confirm}/> : activeSession ? <Discussion key={activeSession.id} session={activeSession} data={data} onDelete={() => deleteSession(activeSession)} onExport={() => void exportSession(activeSession)} deletionBlocked={sessionBusy(activeSession) || deletingIds.includes(activeSession.id)} notify={notify} refresh={refresh} onOpen={openSession} onExecute={task => execute(activeSession, task)}/> : activeExecution ? <ExecutionView key={activeExecution.id} execution={activeExecution} data={data} notify={notify} deletionBlocked={executionBusy(activeExecution) || deletingIds.includes(activeExecution.id)} onDelete={() => deleteExecution(activeExecution)} onSource={id => { const s = data.sessions.find(s => s.id === id); if (s) openSession(s); else notify('来源讨论已被删除', true) }}/> : project ? <ProjectHome project={project} data={data} notify={notify} start={start} execute={() => execute()} edit={() => setProjectEditor(project)} remove={() => deleteProject(project)} removalBlocked={projectBusy(project.id) || deletingIds.includes(project.id)}/> : <Welcome data={data} hasModels={hasModels} start={start} newProject={() => setProjectEditor('new')}/>}</div>
      <ExtensionApprovalsPanel notify={notify} projects={data.projects}/>
    </main>
    {creating && <NewSession key={projectId ?? 'independent'} data={data} projectId={projectId} onClose={() => setCreating(false)} onCreated={openSession} notify={notify} refresh={refresh}/>}
    {projectEditor && <ProjectEditor key={typeof projectEditor === 'string' ? 'new' : projectEditor.id} project={projectEditor === 'new' ? undefined : projectEditor} data={data} onClose={() => setProjectEditor(null)} onSaved={p => { if (projectEditor === 'new') home(p.id); void refresh().catch(e => notify(errorText(e), true)) }} notify={notify}/>}
    {executionDraft && <ExecutionTaskCard key={`${projectId ?? 'none'}.${executionDraft.session?.id ?? 'new'}`} data={data} projectId={projectId} session={executionDraft.session} initialTask={executionDraft.task} onClose={() => setExecutionDraft(null)} onCreated={openExecution} notify={notify}/>}
    {networkProvider && data.providers.some(provider => provider.id === networkProvider) && <ProviderEditor key={networkProvider} provider={data.providers.find(provider => provider.id === networkProvider)} onClose={() => setNetworkProvider(null)} refresh={refresh} notify={notify}/>}
    {networkDialog && <Modal title="网络与订阅" wide onClose={() => void (async () => { if (!leaveGuard.current || await leaveGuard.current()) setNetworkDialog(false) })()}><NetworkView notify={notify} confirm={confirm}/></Modal>}
    <EditorInbox data={data} open={editorInbox} onClose={() => setEditorInbox(false)} onAccept={acceptEditor} onKnowledge={useEditorKnowledge} notify={notify}/>
    {editorReceiving && <EditorReceiving/>}
    {editorRequests[0] && <EditorConnectionPrompt key={editorRequests[0].id} request={editorRequests[0]} onResolved={updateEditorState} notify={notify}/>}
    {confirmation && <Modal title={confirmation.title} onClose={() => { confirmation.resolve(false); setConfirmation(null) }}><p className="confirm-body">{confirmation.body}</p><div className="modal-footer"><span/><button onClick={() => { confirmation.resolve(false); setConfirmation(null) }}>取消</button><button className="danger" onClick={() => { confirmation.resolve(true); setConfirmation(null) }}>确认删除</button></div></Modal>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'} key={toast.id}>{toast.error ? <CircleAlert size={19}/> : <CheckCircle2 size={19}/>}<span>{toast.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setToast(null)}><X size={15}/></button></div>}
  </div></NetworkContext.Provider>
}

function ProjectHome({ project, data, notify, start, execute, edit, remove, removalBlocked }: { project: Project; data: Bootstrap; notify: Notify; start: () => void; execute: () => void; edit: () => void; remove: () => void; removalBlocked: boolean }) {
  const [files, setFiles] = useState(false)
  return <div className="project-home"><div className="project-home-main"><header className="page-heading"><div><div className="eyebrow">PROJECT WORKSPACE</div><h1>{project.name}</h1><p className="project-path"><FolderOpen size={14}/>{project.directory}</p></div><button className="icon-button" aria-label="编辑当前项目" onClick={edit}><Settings2 size={18}/></button></header><div className="project-overview-card"><h2>一起想清楚，再一起完成。</h2><p>{project.instructions || '在这个项目中展开多场讨论，再把选定方案交给执行者。每个会话保留自己的上下文与草稿。'}</p><div className="button-group"><button className="primary" onClick={start}><MessagesSquare size={16}/>新建项目讨论</button><button onClick={execute}><Play size={15}/>新建执行任务</button></div></div><div className="project-stats"><div><strong>{data.sessions.filter(s => s.projectId === project.id).length}</strong><span>讨论会话</span></div><div><strong>{data.executions.filter(e => e.projectId === project.id).length}</strong><span>执行任务</span></div><div><strong>{project.knowledgeBaseIds.length}</strong><span>默认知识库</span></div></div><div className="project-home-actions"><OpenInEditor projectId={project.id} notify={notify}/><button onClick={() => setFiles(v => !v)}><FolderOpen size={16}/>{files ? '收起项目文件' : '浏览项目文件'}</button><button className="text-button danger-text" disabled={removalBlocked} title={removalBlocked ? '请先停止，等待项目中的任务结束' : undefined} onClick={remove}>移除项目</button></div><p className="muted small">切换项目、会话或关闭标签不会中断正在进行的工作。</p><ProjectExtensionsPanel projectId={project.id} notify={notify}/><ExtensionSearchBindingPanel projectId={project.id} notify={notify}/></div>{files && <aside className="project-home-files"><ProjectFiles key={project.id} projectId={project.id} notify={notify}/></aside>}</div>
}

function Welcome({ data, hasModels, start, newProject }: { data: Bootstrap; hasModels: boolean; start: () => void; newProject: () => void }) {
  return <div className="welcome-page"><div className="welcome-topline"><span>独立思考，共同完成</span><span><span className="online-dot"/>{data.providers.length} 个已配置服务</span></div><div className="welcome-content"><div className="welcome-illustration" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><Users size={36} strokeWidth={1.5}/></div><div className="orbit-node node-one"><Sparkles size={21}/></div><div className="orbit-node node-two"><MessagesSquare size={20}/></div><div className="orbit-node node-three"><BookOpen size={20}/></div><div className="orbit-node node-four"><CircleDot size={19}/></div></div><div className="eyebrow">MORE PERSPECTIVES. REAL PROGRESS.</div><h1>把不同的思考，<br/>变成共同的成果。</h1><p className="welcome-description">让模型围桌讨论，让执行者动手完成。<br/>每个项目，都有自己的讨论与工作空间。</p><div className="welcome-cta-group"><button className="primary welcome-cta" onClick={start}>{hasModels ? '开启一场讨论' : '连接我的模型'}<ArrowRight size={18}/></button><button className="welcome-cta" onClick={newProject}><FolderOpen size={16}/>创建项目</button></div><div className="welcome-modes"><div><span>01</span><strong>圆桌讨论</strong><p>先独立思考，再交换观点</p></div><div><span>02</span><strong>自由群聊</strong><p>自然对话，随时加入</p></div><div><span>03</span><strong>正式辩论</strong><p>在不同立场中检验论据</p></div></div></div><div className="welcome-footer"><span>你的模型 · 你的资料 · 你的项目</span><span>由好问题开始。</span></div></div>
}
