import { useEffect, useId, useRef, useState } from 'react'
import { MoreHorizontal, X } from 'lucide-react'
import type { ModelRef, Provider } from '../../shared/types'
import { Modal, modelKey } from './common'

export function FilterChoices({ label, options, selected, onChange }: { label: string; options: { id: string; name: string }[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState('')
  const visible = options.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const ids = new Set(visible.map(item => item.id))
  return <div className="filter-choices"><div className="filter-input"><input onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} aria-label={`筛选${label}`} placeholder={`筛选${label}…`} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" className="icon-button" aria-label={`清除${label}筛选`} onClick={() => setQuery('')}><X size={13}/></button>}</div><div className="selection-toolbar"><span>已选 {selected.length} · 当前 {visible.length}</span><button type="button" disabled={!visible.length} onClick={() => onChange([...new Set([...selected, ...ids])])}>全选当前筛选</button><button type="button" disabled={!selected.some(id => ids.has(id))} onClick={() => onChange(selected.filter(id => !ids.has(id)))}>取消当前筛选</button></div><div className="kb-options">{visible.map(item => <label className="check-label" key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={event => onChange(event.target.checked ? [...new Set([...selected, item.id])] : selected.filter(id => id !== item.id))}/>{item.name}</label>)}{!visible.length && <p className="muted small">没有符合筛选的选项</p>}</div></div>
}

export function BatchModelPicker({ providers, existing, capacity, debate = false, onAdd, onClose }: { providers: Provider[]; existing: (ModelRef | undefined)[]; capacity: number; debate?: boolean; onAdd: (models: ModelRef[], team?: 'pro' | 'con') => void; onClose: () => void }) {
  const [providerId, setProviderId] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [team, setTeam] = useState<'' | 'pro' | 'con'>('')
  const existingKeys = new Set(existing.filter(Boolean).map(modelKey))
  const models = providers.flatMap(provider => provider.modelIds.map(modelId => ({ providerId: provider.id, modelId }))).filter(model => !existingKeys.has(modelKey(model)))
  const options = models.filter(model => !providerId || model.providerId === providerId).map(model => ({ id: modelKey(model), name: `${providers.find(provider => provider.id === model.providerId)!.name} / ${model.modelId}` }))
  const chosen = selected.map(key => models.find(model => modelKey(model) === key)).filter((model): model is ModelRef => !!model)
  const over = chosen.length > capacity
  return <Modal title="批量添加模型" onClose={onClose}><p className="modal-description">已加入的模型不会重复添加。先填入空席位，最多还可加入 {capacity} 个模型。</p>{debate && <label className="field"><span>添加到哪一方</span><select aria-label="批量添加阵营" value={team} onChange={event => setTeam(event.target.value as typeof team)}><option value="">先选择阵营</option><option value="pro">正方</option><option value="con">反方</option></select></label>}<label className="field"><span>按服务筛选</span><select aria-label="批量模型服务" value={providerId} onChange={event => setProviderId(event.target.value)}><option value="">全部服务</option>{providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label><FilterChoices label="可添加模型" options={options} selected={selected} onChange={setSelected}/>{over && <p className="form-hint" role="alert">已选 {chosen.length} 个，超过剩余 {capacity} 个席位，请取消部分选择。</p>}<div className="modal-footer"><span className="muted small">已选 {chosen.length} 个模型</span><button type="button" onClick={onClose}>取消</button><button type="button" className="primary" disabled={!chosen.length || over || (debate && !team)} onClick={() => { onAdd(chosen, team || undefined); onClose() }}>添加所选模型</button></div></Modal>
}

export interface MenuAction { label: string; action: () => void; disabled?: boolean; reason?: string; danger?: boolean }
export function SidebarMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    container.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const close = () => { setOpen(false); trigger.current?.focus() }
  const rect = trigger.current?.getBoundingClientRect()
  return <div ref={container} className="sidebar-menu" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = [...container.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }
  }} onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}><button ref={trigger} type="button" className="icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) } }}><MoreHorizontal size={16}/></button>{open && <div id={id} role="menu" aria-label={label} className="dropdown-menu" style={{ left: Math.max(8, (rect?.right ?? 200) - 192), top: Math.min(rect?.bottom ?? 0, window.innerHeight - actions.length * 54 - 20) }}>{actions.map(item => <button type="button" role="menuitem" key={item.label} disabled={item.disabled} title={item.reason} className={item.danger ? 'danger-text' : ''} onClick={() => { close(); item.action() }}>{item.label}{item.disabled && item.reason && <small>{item.reason}</small>}</button>)}</div>}</div>
}
