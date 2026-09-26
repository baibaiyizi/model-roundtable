import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { X, LoaderCircle, ChevronDown } from 'lucide-react'
import type { ModelRef, Provider } from '../../shared/types'
import { errorText } from './api'
import { networkLabel, useNetwork } from './NetworkContext'

export type Notify = (text: string, error?: boolean) => void
export type Confirm = (title: string, body: string) => Promise<boolean>
export const modelKey = (ref?: ModelRef) => ref ? JSON.stringify([ref.providerId, ref.modelId]) : ''
export const parseModel = (key: string): ModelRef | undefined => { if (!key) return; const [providerId, modelId] = JSON.parse(key); return { providerId, modelId } }
export function modelName(ref: ModelRef | undefined, providers: Provider[]) {
  if (!ref) return '未配置'
  return `${providers.find(p => p.id === ref.providerId)?.name ?? '已移除的服务'} / ${ref.modelId}`
}
export function ModelSelect({ value, onChange, providers, label, required = false }: { value?: ModelRef; onChange: (v: ModelRef | undefined) => void; providers: Provider[]; label: string; required?: boolean }) {
  const network = useNetwork()
  const [query, setQuery] = useState('')
  const matches = (provider: Provider, modelId: string) => modelKey(value) === modelKey({ providerId: provider.id, modelId }) || `${provider.name} ${modelId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const provider = providers.find(item => item.id === value?.providerId)
  const exists = value && providers.some(p => p.id === value.providerId && p.modelIds.includes(value.modelId))
  return <div className="field"><span>{label}</span><input className="select-search" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} aria-label={`筛选候选项：${label.replace(/模型/g, '')}`} placeholder="搜索模型或服务…" value={query} onChange={event => setQuery(event.target.value)}/><div className="select-wrap"><select aria-label={label} required={required} value={modelKey(value)} onChange={e => onChange(parseModel(e.target.value))}>
    <option value="">{required ? '请选择模型' : '暂不设置'}</option>
    {value && !exists && <option value={modelKey(value)}>{modelName(value, providers)}</option>}
    {providers.filter(p => p.modelIds.some(id => matches(p, id))).map(p => <optgroup key={p.id} label={`${p.name} · ${networkLabel(p.network, network?.state)}`}>{p.modelIds.filter(id => matches(p, id)).map(modelId => <option key={modelId} value={modelKey({ providerId: p.id, modelId })}>{modelId}</option>)}</optgroup>)}
  </select><ChevronDown size={14}/></div>{provider && <div className="model-network-line"><span title={networkLabel(provider.network, network?.state)}>线路：{networkLabel(provider.network, network?.state)}</span>{network && <button type="button" className="text-button" aria-label={`设置 ${provider.name} 的服务网络`} onClick={() => network.openProvider(provider.id)}>服务网络设置</button>}</div>}</div>
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    const firstInput = dialog.querySelector<HTMLElement>('[autofocus]') ?? dialog.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? dialog.querySelector<HTMLElement>('button:not([disabled])')
    firstInput?.focus()
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])
  return <dialog ref={ref} aria-labelledby={titleId} className={`modal ${wide ? 'wide' : ''}`} onCancel={e => { e.preventDefault(); e.stopPropagation(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={20}/></button></div>{children}
  </dialog>
}
export function useTask(notify: Notify) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const run = async (task: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { await task() } catch (e) { notify(errorText(e), true) } finally { lock.current = false; setBusy(false) }
  }
  return { busy, run }
}
export function Spinner({ text = '正在处理…' }: { text?: string }) { return <span className="spinner"><LoaderCircle size={16}/>{text}</span> }
export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p>{action}</div> }
export const modeLabel = { roundtable: '圆桌讨论', free: '自由群聊', debate: '正式辩论' }
export const statusLabel = { idle: '准备就绪', running: '讨论中', paused: '已暂停', error: '需要处理', stopped: '已结束', complete: '已完成' }
