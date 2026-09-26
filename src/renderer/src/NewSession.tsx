import { useState } from 'react'
import { Users, MessagesSquare, Scale, Plus, Trash2, ArrowRight, Globe2, BookOpen } from 'lucide-react'
import type { Bootstrap, Mode, Participant, Session, ModelRef, Limits } from '../../shared/types'
import { DEFAULT_LIMITS } from '../../shared/types'
import { api } from './api'
import { Modal, ModelSelect, Spinner, useTask, type Notify } from './common'
import { useDraft } from './useDraft'
import { BatchModelPicker, FilterChoices } from './SelectionControls'

type DraftParticipant = Omit<Participant, 'model'> & { model?: Participant['model'] }

export function NewSession({ data, projectId, onClose, onCreated, notify, refresh }: { data: Bootstrap; projectId?: string; onClose: () => void; onCreated: (s: Session) => void; notify: Notify; refresh: () => Promise<void> }) {
  const available = data.providers.flatMap(p => p.modelIds.map(modelId => ({ providerId: p.id, modelId })))
  const project = data.projects.find(p => p.id === projectId)
  const [batchOpen, setBatchOpen] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [draft, setDraft, clearDraft] = useDraft(`discussion-new.${projectId ?? 'independent'}`, {
    mode: 'roundtable' as Mode, topic: '', participants: [0, 1].map(i => ({ id: crypto.randomUUID(), name: `成员 ${i + 1}`, role: i === 0 ? '从实际可行性出发提出建议' : '检验假设，提供不同视角', team: i === 0 ? 'pro' : 'con' })) as DraftParticipant[],
    moderator: undefined as ModelRef | undefined, knowledgeBaseIds: project?.knowledgeBaseIds ?? [], searchEnabled: true, limits: { ...DEFAULT_LIMITS },
  })
  const { mode, topic, participants, moderator, knowledgeBaseIds, searchEnabled, limits } = draft
  const setMode = (mode: Mode) => setDraft(d => ({ ...d, mode, moderator: mode === 'debate' ? d.moderator ?? data.settings.moderator : d.mode === 'debate' ? undefined : d.moderator }))
  const setTopic = (topic: string) => setDraft(d => ({ ...d, topic }))
  const setParticipants = (update: DraftParticipant[] | ((previous: DraftParticipant[]) => DraftParticipant[])) => setDraft(d => ({ ...d, participants: typeof update === 'function' ? update(d.participants) : update }))
  const setModerator = (moderator: ModelRef | undefined) => setDraft(d => ({ ...d, moderator }))
  const setKBs = (update: (ids: string[]) => string[]) => setDraft(d => ({ ...d, knowledgeBaseIds: update(d.knowledgeBaseIds) }))
  const setSearch = (searchEnabled: boolean) => setDraft(d => ({ ...d, searchEnabled }))
  const setLimits = (update: (limits: Limits) => Limits) => setDraft(d => ({ ...d, limits: update(d.limits) }))
  const searchConfigured = data.settings.search?.provider !== 'tavily' || data.settings.hasTavilyKey
  const applyTemplate = (id: string) => {
    setTemplateId(id)
    const config = data.templates.find(t => t.id === id)?.config
    if (config) setDraft(d => ({ ...d, mode: config.mode, participants: config.participants.map(p => ({ ...p, id: crypto.randomUUID() })), moderator: config.moderator, knowledgeBaseIds: config.knowledgeBaseIds, searchEnabled: config.searchEnabled, limits: { ...config.limits } }))
  }
  const { busy, run } = useTask(notify)
  const setParticipant = (id: string, patch: Partial<DraftParticipant>) => setParticipants(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p))
  const valid = topic.trim() && (mode !== 'debate' || moderator) && participants.length >= 2 && participants.every(p => p.name.trim() && p.model) && (mode !== 'debate' || (participants.some(p => p.team === 'pro') && participants.some(p => p.team === 'con')))
  return <Modal title="开启一次新讨论" onClose={onClose} wide><form onSubmit={e => { e.preventDefault(); void run(async () => { if (!valid) return; const s = await api.createSession({ projectId, topic: topic.trim(), mode, participants: participants as Participant[], moderator, knowledgeBaseIds, searchEnabled, limits }); clearDraft(); onCreated(s); onClose() }) }}>
    {project && <div className="path-note">项目：{project.name}<span>{project.directory}</span></div>}
    {data.templates.length > 0 && <div className="template-picker"><label className="field"><span>使用讨论模板</span><select aria-label="使用讨论模板" value={templateId} onChange={e => applyTemplate(e.target.value)}><option value="">选择已保存的班底与设置</option>{data.templates.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label>{templateId && <button type="button" aria-label="删除所选模板" onClick={() => void run(async () => { await api.deleteTemplate(templateId); setTemplateId(''); await refresh(); notify('模板已删除') })}><Trash2 size={14}/></button>}</div>}
    <div className="mode-grid">{([{ id: 'roundtable', icon: Users, title: '圆桌讨论', description: '独立思考 · 交叉评议 · 凝练共识' }, { id: 'free', icon: MessagesSquare, title: '自由群聊', description: '自主发言 · 自由回应 · 随时加入' }, { id: 'debate', icon: Scale, title: '正式辩论', description: '正反交锋 · 质询反驳 · 裁判评议' }] as const).map(m => <button type="button" className={`mode-card ${mode === m.id ? 'selected' : ''}`} key={m.id} onClick={() => setMode(m.id)}><m.icon size={23}/><strong>{m.title}</strong><span>{m.description}</span></button>)}</div>
    <label className="field topic-field"><span>{mode === 'debate' ? '辩题' : '今天，想一起讨论什么？'}</span><textarea autoFocus required value={topic} onChange={e => setTopic(e.target.value)} placeholder={mode === 'debate' ? '写下一个有明确正反立场的命题…' : '描述你的问题、背景，以及你希望得到的结果…'} rows={3}/></label>
    <div className="section-heading"><h3>邀请模型入席</h3><div className="button-group"><button type="button" disabled={!available.length} onClick={() => setBatchOpen(true)}>批量添加模型</button><button type="button" disabled={!available.length || participants.length >= 30} onClick={() => setParticipants(ps => [...ps, { id: crypto.randomUUID(), name: `成员 ${ps.length + 1}`, role: '', team: ps.length % 2 === 0 ? 'pro' : 'con' }])}><Plus size={15}/>添加成员</button></div></div>
    <div className="participants-editor">{participants.map((p, i) => <div className="participant-editor" key={p.id}><span className={`seat-number color-${i % 5}`}>{String(i + 1).padStart(2, '0')}</span><div className="participant-fields"><div className="form-grid"><label className="field"><span>席位名称</span><input aria-label={`成员 ${i + 1} 名称`} required value={p.name} onChange={e => setParticipant(p.id, { name: e.target.value })}/></label><ModelSelect required label={`成员 ${i + 1} 模型`} providers={data.providers} value={p.model} onChange={model => setParticipant(p.id, { model })}/></div><div className="inline-input"><input aria-label={`成员 ${i + 1} 角色`} value={p.role} onChange={e => setParticipant(p.id, { role: e.target.value })} placeholder="角色提示（可选），例如：注重证据的研究员"/>{mode === 'debate' && <select aria-label={`成员 ${i + 1} 阵营`} value={p.team} onChange={e => setParticipant(p.id, { team: e.target.value as 'pro' | 'con' })}><option value="pro">正方</option><option value="con">反方</option></select>}</div></div><button type="button" className="icon-button danger-hover" aria-label={`移除成员 ${i + 1}`} onClick={() => setParticipants(ps => ps.filter(x => x.id !== p.id))}><Trash2 size={16}/></button></div>)}</div>
    {participants.length < 2 && <p className="form-hint">至少需要两个参会席位。同一个模型可以承担不同角色。</p>}
    {mode === 'debate' && (!participants.some(p => p.team === 'pro') || !participants.some(p => p.team === 'con')) && <p className="form-hint">正式辩论需要正反双方各至少一位成员。</p>}
    <ModelSelect required={mode === 'debate'} label={mode === 'debate' ? '裁判模型' : '主持模型（可选）'} providers={data.providers} value={moderator} onChange={setModerator}/>
    {!moderator && mode !== 'debate' && <p className="form-hint">{mode === 'free' ? '无主持：成员先提出发言意愿，再选一位正式回答。每次通常先调用 N 位成员申请，再调用 1 次正式回答，申请也计入调用上限。可点名、静音或单次发言。' : '无主持：各成员独立回答、交叉评议并分别总结，保留不同结论。'}</p>}
    <div className="session-resources"><label className="check-label"><input type="checkbox" checked={searchEnabled} onChange={e => setSearch(e.target.checked)}/><Globe2 size={17}/><span>允许自动联网</span><span className="muted small">{searchConfigured ? '收集查询并向全体共享证据' : 'Tavily 尚未配置密钥；请配置服务、绑定搜索 MCP 或关闭联网'}</span></label><div className="section-heading compact"><h3><BookOpen size={16}/>引用知识库</h3></div>{data.knowledgeBases.length ? <FilterChoices label="知识库" options={data.knowledgeBases.map(k => ({ id: k.id, name: k.name }))} selected={knowledgeBaseIds} onChange={ids => setKBs(() => ids)}/> : <p className="muted small">尚无知识库。创建后可以在不同讨论中重复使用资料。</p>}</div>
    <details className="advanced"><summary>讨论与费用限制</summary><div className="form-grid">{([{ key: 'autoTurns', label: '连续发言后暂停', min: 1, max: 100 }, { key: 'maxCalls', label: '最多模型调用次数', min: 1, max: 1000 }, { key: 'maxOutputTokens', label: '单次最大输出 Token', min: 64, max: 32000 }, { key: 'contextChars', label: '上下文字符预算', min: 4000, max: 500000 }] as const).map(f => <label className="field" key={f.key}><span>{f.label}</span><input required type="number" min={f.min} max={f.max} value={limits[f.key]} onChange={e => setLimits(l => ({ ...l, [f.key]: Number(e.target.value) }))}/></label>)}<label className="field"><span>最多搜索次数（留空不限）</span><input aria-label="最多搜索次数" type="number" min={0} max={1000} placeholder="不限" value={limits.maxSearches ?? ''} onChange={e => setLimits(l => ({ ...l, maxSearches: e.target.value === '' ? null : Number(e.target.value) }))}/></label></div><p className="muted small">实际费用由所选服务决定。未返回用量的调用不会被记为零消耗。</p></details>
    <div className="modal-footer"><span className="muted small">{participants.length} 位成员 · {knowledgeBaseIds.length} 个知识库</span><button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={busy || !valid}>{busy ? <Spinner text="创建讨论…"/> : <>开始讨论<ArrowRight size={17}/></>}</button></div>
  </form>{batchOpen && <BatchModelPicker providers={data.providers} existing={participants.map(p => p.model)} capacity={30 - participants.filter(p => p.model).length} debate={mode === 'debate'} onClose={() => setBatchOpen(false)} onAdd={(models, team) => setParticipants(previous => {
    const next = [...previous]
    for (const model of models) {
      const empty = next.findIndex(p => !p.model)
      if (empty >= 0) next[empty] = { ...next[empty], model, ...(team ? { team } : {}) }
      else next.push({ id: crypto.randomUUID(), name: `成员 ${next.length + 1}`, role: '', model, team: team ?? 'pro' })
    }
    return next
  })}/>}</Modal>
}
