import { createContext, useContext, useState } from 'react'
import { Search } from 'lucide-react'
import type { NetworkSelection, NetworkState } from '../../shared/network'

export interface NetworkContextValue {
  state: NetworkState | null
  error: string
  refresh: () => Promise<void>
  update: (state: NetworkState) => void
  openProvider: (id: string) => void
  openSettings: () => void
  registerLeaveGuard?: (guard: () => Promise<boolean>) => () => void
}
export const NetworkContext = createContext<NetworkContextValue | null>(null)
export const useNetwork = () => useContext(NetworkContext)

export function networkLabel(selection?: NetworkSelection, state?: NetworkState | null): string {
  if (!selection || selection.mode === 'system') return '跟随系统'
  if (selection.mode === 'direct') return '直连'
  const subscription = state?.subscriptions.find(item => item.id === selection.subscriptionId)
  const node = subscription?.nodes.find(item => item.id === selection.nodeId)
  return subscription && node ? `${subscription.name} / ${node.name}` : state ? '指定节点不可用' : '指定订阅节点'
}

const selectionKey = (selection?: NetworkSelection) => !selection || selection.mode === 'system' ? 'system' : selection.mode === 'direct' ? 'direct' : JSON.stringify([selection.subscriptionId, selection.nodeId])

export function NetworkSelect({ label, value, onChange, disabled = false }: { label: string; value?: NetworkSelection; onChange: (value: NetworkSelection) => void; disabled?: boolean }) {
  const network = useNetwork()
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const matches = (subscription: string, node: string) => `${subscription} ${node}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const available = value?.mode !== 'subscription' || network?.state?.subscriptions.some(subscription => subscription.id === value.subscriptionId && subscription.nodes.some(node => node.id === value.nodeId))
  return <div className="field network-select-field"><span>{label}</span><div className="network-select-row"><select aria-label={label} value={selectionKey(value)} disabled={disabled} onChange={event => {
    const key = event.target.value
    if (key === 'system' || key === 'direct') onChange({ mode: key })
    else { const [subscriptionId, nodeId] = JSON.parse(key) as [string, string]; onChange({ mode: 'subscription', subscriptionId, nodeId }) }
  }}><option value="system">跟随系统</option><option value="direct">直连</option>{!available && value?.mode === 'subscription' && <option value={selectionKey(value)}>{network?.state ? '指定节点不可用，请重新选择' : '正在读取指定节点…'}</option>}{network?.state?.subscriptions.map(subscription => <optgroup key={subscription.id} label={subscription.name}>{subscription.nodes.filter(node => matches(subscription.name,node.name) || (value?.mode === 'subscription' && value.subscriptionId === subscription.id && value.nodeId === node.id)).map(node => <option key={node.id} value={selectionKey({ mode: 'subscription', subscriptionId: subscription.id, nodeId: node.id })}>{subscription.name} / {node.name}{node.delayMs !== undefined ? ` · ${node.delayMs} ms` : ''}</option>)}</optgroup>)}</select><button type="button" className="icon-button" aria-label={`搜索${label}`} aria-expanded={searching} disabled={disabled} onClick={() => { setSearching(!searching); setQuery('') }}><Search size={15}/></button></div>{searching && <input type="search" autoFocus aria-label={`筛选${label}`} placeholder="搜索订阅或节点名称" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSearching(false); setQuery('') } }}/>}</div>
}
