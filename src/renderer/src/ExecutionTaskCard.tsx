import { useEffect, useState } from 'react'
import { FolderOpen, Play, Plus, Trash2 } from 'lucide-react'
import type { Bootstrap, ModelRef, Session } from '../../shared/types'
import { DEFAULT_EXECUTION_LIMITS, type Execution } from '../../shared/execution'
import { api } from './api'
import { Modal, ModelSelect, Spinner, useTask, type Notify } from './common'
import { useDraft } from './useDraft'
import { BatchModelPicker } from './SelectionControls'

export function ExecutionTaskCard({ data, projectId, session, initialTask, onClose, onCreated, notify }: {
  data: Bootstrap; projectId?: string; session?: Session; initialTask?: string
  onClose: () => void; onCreated: (execution: Execution) => void; notify: Notify
}) {
  const finalMessage = session?.messages.findLast(m => m.kind === 'assistant' && ['summary', 'verdict'].includes(m.phase) && m.status === 'complete')
  const [draft, setDraft, clearDraft] = useDraft(`execution-new.${projectId ?? 'none'}.${session?.id ?? 'new'}`, {
    projectId: projectId ?? session?.projectId ?? '', task: initialTask ?? finalMessage?.content ?? session?.topic ?? '',
    acceptance: '', executor: undefined as ModelRef | undefined, reviewers: (session ? [...new Map(session.participants.map(p => [JSON.stringify(p.model), p.model])).values()].slice(0, 2) : [undefined, undefined]) as (ModelRef | undefined)[],
    web: { enabled: true, maxSearches: null as number | null },
    ...DEFAULT_EXECUTION_LIMITS, maxRepairRounds: DEFAULT_EXECUTION_LIMITS.maxRepairRounds as 0 | 1 | 2,
  })
  useEffect(() => { if (initialTask) setDraft(d => ({ ...d, task: initialTask })) }, [initialTask])
  const [batchOpen, setBatchOpen] = useState(false)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const { busy, run } = useTask(notify)
  const project = data.projects.find(p => p.id === draft.projectId)
  const usesNative = [draft.executor, ...draft.reviewers].some(model => { const kind = data.providers.find(p => p.id === model?.providerId)?.kind; return kind === 'codex' || kind === 'claude' })
  const valid = project && draft.task.trim() && draft.acceptance.trim() && draft.executor && draft.reviewers.every(Boolean)
  const set = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => setDraft(d => ({ ...d, [key]: value }))
  return <Modal title={session ? '把讨论交给执行者' : '新建执行任务'} wide onClose={onClose}>
    <form onSubmit={e => { e.preventDefault(); void run(async () => {
      if (!valid || !draft.executor) return
      const execution = await api.createExecution({ ...draft, web: draft.web ?? { enabled: false, maxSearches: null }, sessionId: session?.id, executor: draft.executor, reviewers: draft.reviewers.filter((m): m is ModelRef => !!m) })
      clearDraft(); onCreated(execution); onClose()
      await api.executionAction({ id: execution.id, action: 'start' })
    }) }}>
      <div className="task-intro"><span className="task-icon"><Play size={20}/></span><div><strong>一位执行者动手，多位审阅者检查</strong><p>在选定目录中读写文件、运行命令。任务记录会保留修改、验证结果和来源。</p></div></div>
      <label className="field"><span>执行项目</span><select aria-label="执行项目" required value={draft.projectId} onChange={e => set('projectId', e.target.value)}><option value="">选择项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {project && <div className="path-note"><FolderOpen size={15}/><span>{project.directory}</span></div>}
      {!data.projects.length && <p className="form-hint">请先在左侧新建项目，绑定实际工作目录。</p>}
      {session && <div className="handoff-source"><span className="eyebrow">来源讨论</span><strong>{session.title}</strong><span>{session.messages.length} 条记录 · {session.evidence.length} 份证据，将保存为任务快照</span></div>}
      <label className="field"><span>要执行的任务</span><textarea aria-label="要执行的任务" required rows={5} value={draft.task} onChange={e => set('task', e.target.value)} placeholder="明确要创建或修改什么，可以调整讨论得出的方案…"/></label>
      <label className="field"><span>完成判定</span><textarea aria-label="完成判定" required rows={3} value={draft.acceptance} onChange={e => set('acceptance', e.target.value)} placeholder="例如：生成可编辑的报告文件，包含引用；或修改登录页面并通过现有测试。"/></label>
      <ModelSelect required label="执行模型" providers={data.providers} value={draft.executor} onChange={v => set('executor', v)}/>
      <div className="section-heading"><h3>审阅模型 <span className="muted small">只读检查，可选</span></h3><div className="button-group"><button type="button" onClick={() => setBatchOpen(true)}>批量添加模型</button><button type="button" onClick={() => set('reviewers', [...draft.reviewers, undefined])} disabled={draft.reviewers.length >= 8}><Plus size={14}/>添加审阅者</button></div></div>
      {draft.reviewers.map((reviewer, index) => <div className="reviewer-row" key={index}><ModelSelect required label={`审阅模型 ${index + 1}`} providers={data.providers} value={reviewer} onChange={value => set('reviewers', draft.reviewers.map((m, i) => i === index ? value : m))}/><button type="button" className="icon-button" aria-label={`移除审阅者 ${index + 1}`} onClick={() => set('reviewers', draft.reviewers.filter((_, i) => i !== index))}><Trash2 size={15}/></button></div>)}
      <label className="field"><span>审阅后的最大修复轮数</span><select aria-label="最大修复轮数" value={draft.maxRepairRounds} onChange={e => set('maxRepairRounds', Number(e.target.value) as 0 | 1 | 2)}><option value={0}>只审阅，不自动修复</option><option value={1}>最多修复 1 轮</option><option value={2}>最多修复 2 轮</option></select></label>
      <label className="check-label"><input type="checkbox" checked={draft.web?.enabled ?? false} onChange={event => set('web', { enabled: event.target.checked, maxSearches: draft.web?.maxSearches ?? null })}/>允许自动联网<span className="muted small">执行者按需要搜索与读取网页，保存来源供审阅</span></label>
      <p className="form-hint">调用预算累计执行与审阅：API 按请求计数；官方账号按后台调用计数，不包含其内部 HTTP 请求。</p>{usesNative && <p className="form-hint">官方账号的单次输出 Token 上限由官方运行时决定。执行时限与停止操作仍然有效。</p>}<details className="advanced" open={limitsOpen} onToggle={e => setLimitsOpen(e.currentTarget.open)}><summary>执行限制</summary><div className="form-grid"><label className="field"><span>最多模型调用</span><input aria-label="执行最多模型调用" type="number" min={1} max={1000} value={draft.maxCalls} onChange={e => set('maxCalls', Number(e.target.value))}/></label><label className="field"><span>单次输出 Token 上限</span><input type="number" min={128} max={32768} value={draft.maxOutputTokens} onChange={e => set('maxOutputTokens', Number(e.target.value))}/></label><label className="field"><span>执行时限（分钟）</span><input type="number" min={1} max={240} value={draft.timeoutMs / 60000} onChange={e => set('timeoutMs', Number(e.target.value) * 60000)}/></label><label className="field"><span>最多搜索次数（留空不限）</span><input aria-label="执行最多搜索次数" type="number" min={0} max={1000} placeholder="不限" disabled={!draft.web?.enabled} value={draft.web?.maxSearches ?? ''} onChange={event => set('web', { enabled: draft.web?.enabled ?? false, maxSearches: event.target.value === '' ? null : Number(event.target.value) })}/></label></div></details>
      <div className="modal-footer"><span className="muted small">草稿自动保存在本机</span><button type="button" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !valid}>{busy ? <Spinner/> : <><Play size={15}/>创建并执行</>}</button></div>
    </form>{batchOpen && <BatchModelPicker providers={data.providers} existing={draft.reviewers} capacity={8 - draft.reviewers.filter(Boolean).length} onClose={() => setBatchOpen(false)} onAdd={models => {
      const next = [...draft.reviewers]
      for (const model of models) { const empty = next.findIndex(item => !item); if (empty >= 0) next[empty] = model; else next.push(model) }
      set('reviewers', next)
    }}/>}
  </Modal>
}
