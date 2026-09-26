import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, FileUp, Globe2, Plus, RefreshCw, Route, Save, ShieldCheck, Trash2 } from 'lucide-react'
import type { NetworkScopeName, NetworkSelection, NetworkState, NetworkSubscription, NetworkNodeRef, NetworkTestJob } from '../../shared/network'
import type { InstalledExtension } from '../../shared/extensions'
import { api, errorText } from './api'
import { Empty, Modal, Spinner, useTask, type Confirm, type Notify } from './common'
import { NetworkSelect, useNetwork } from './NetworkContext'
import { CollapseGroup, CollapseControls, Collapsible } from './Collapsible'
import './network.css'

const coreLabels: Record<NetworkState['core']['phase'], string> = { stopped: '尚未启动', starting: '正在准备', running: '运行中', failed: '需要处理' }
const scopes: Array<{ id: NetworkScopeName; label: string }> = [
  { id: 'search', label: '联网搜索' }, { id: 'catalog', label: '扩展商店' }, { id: 'downloads', label: '组件与扩展下载' },
  { id: 'subscriptions', label: '订阅添加与更新' }, { id: 'web', label: '网页资料与正文读取' },
  { id: 'accounts', label: '官方账号状态与登录请求' },
]
const nodeKey = (node: NetworkNodeRef) => JSON.stringify([node.subscriptionId, node.nodeId])
const matchesNode = (subscription: NetworkSubscription, name: string, filter: string) => `${subscription.name} ${name}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())

export function NetworkView({ notify, confirm }: { notify: Notify; confirm: Confirm }) {
  const network = useNetwork()
  const [adding, setAdding] = useState(false)
  const [extensions, setExtensions] = useState<InstalledExtension[]>([])
  const [extensionError, setExtensionError] = useState('')
  const [bindings, setBindings] = useState<Partial<Record<NetworkScopeName, NetworkSelection>>>({})
  const [dirty, setDirty] = useState(false)
  const [testing, setTesting] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [leaving, setLeaving] = useState(false)
  const leaveResolution = useRef<((allowed: boolean) => void) | null>(null)
  const { busy, run } = useTask(notify)
  const testLock = useRef(false)
  const state = network?.state
  const batch = state?.nodeTests
  const batchRunning = batch?.status === 'running'
  const allNodes = state?.subscriptions.flatMap(subscription => subscription.nodes.map(node => ({ subscriptionId: subscription.id, nodeId: node.id }))) ?? []
  const visibleNodes = state?.subscriptions.flatMap(subscription => subscription.nodes.filter(node => matchesNode(subscription, node.name, filter)).map(node => ({ subscriptionId: subscription.id, nodeId: node.id }))) ?? []
  const selectedNodes = allNodes.filter(node => selected.has(nodeKey(node)))
  const loadExtensions = () => api.extensionState().then(result => { setExtensions(result.installed.filter(item => item.kind === 'mcp')); setExtensionError('') }).catch(error => setExtensionError(errorText(error)))
  useEffect(() => { void network?.refresh().catch(() => {}); void loadExtensions() }, [])
  useEffect(() => { if (state && !dirty) setBindings(state.bindings) }, [state, dirty])
  useEffect(() => network?.registerLeaveGuard?.(async () => {
    if (!dirty) return true
    if (leaveResolution.current) return false
    return new Promise<boolean>(resolve => { leaveResolution.current = resolve; setLeaving(true) })
  }), [network?.registerLeaveGuard, dirty])
  useEffect(() => () => { leaveResolution.current?.(false) }, [])
  const resolveLeave = (allowed: boolean) => { const resolve = leaveResolution.current; leaveResolution.current = null; setLeaving(false); resolve?.(allowed) }
  const saveBindings = async () => { const next = await api.saveNetworkBindings(bindings); setDirty(false); received(next) }
  const revert = () => { setBindings(state?.bindings ?? {}); setDirty(false) }
  const received = (next: NetworkState) => { network?.update(next); if (next.pending) notify('设置已保存，正在运行的任务结束后应用'); else notify('网络设置已保存') }
  const testNode = async (subscriptionId: string, nodeId: string) => {
    if (testLock.current || batchRunning) return
    testLock.current = true; setTesting(`${subscriptionId}:${nodeId}`)
    try { const result = await api.testNetworkNode({ subscriptionId, nodeId }); if (result.error) notify(result.error, true); else notify(`节点延迟 ${result.delayMs ?? '—'} ms；模型服务请单独测试连接`) }
    catch (error) { notify(errorText(error), true) }
    finally { testLock.current = false; setTesting(''); await network?.refresh().catch(() => {}) }
  }
  return <CollapseGroup><div className="page network-page"><header className="page-heading"><div><div className="eyebrow">A ROUTE FOR EVERY SERVICE</div><h1>网络与订阅</h1><p>导入 Clash/Mihomo 兼容订阅，为不同服务固定选择不同节点。</p></div><div className="button-group"><button disabled={busy} onClick={() => void run(async () => { await network?.refresh(); await loadExtensions() })}><RefreshCw size={15}/>刷新状态</button><button className="primary" onClick={() => setAdding(true)}><Plus size={16}/>添加订阅</button></div></header><CollapseControls/>
    <div className="info-note"><Route size={20}/><div><strong>各个服务，各走各的线路</strong><p>在模型服务中选择“跟随系统”“直连”或订阅节点。同一服务下所有模型共用线路；节点失效时会报错，不会自动换节点或直连。</p></div></div>
    {network?.error && <p role="alert" className="panel-error">{network.error}</p>}
    {!state && !network?.error && <Spinner text="读取网络设置…"/>}
    {state && <>
      <Collapsible id="network.core" className="network-core" title={<><Globe2 size={19}/>内置代理</>} summary={<><span>Mihomo {state.core.version}</span><span className={`network-status ${state.core.phase}`}>{coreLabels[state.core.phase]}</span>{state.core.error && <span role="alert" className="panel-error">{state.core.error}</span>}</>} actions={<button type="button" disabled={busy || state.core.phase === 'starting'} onClick={() => void run(async () => { received(await api.restartNetworkCore()) })}><RefreshCw size={15}/>{state.core.phase === 'failed' ? '恢复内核' : state.core.phase === 'running' ? '重启内核' : '准备并启动'}</button>}><p>仅为模型圆桌提供连接，不修改系统代理或安装 TUN。节点延迟与模型服务可用性需要分别检测。</p></Collapsible>
      {state.pending && <p role="status" className="network-pending">有待应用的网络设置。正在运行的任务继续使用原线路，任务结束后统一启用。</p>}
      <Collapsible id="network.subscriptions" className="settings-section" title="我的订阅" defaultOpen forceOpen={!!filter.trim()} summary={<><span>{state.subscriptions.length} 份订阅 · {allNodes.length} 个节点 · 已选 {selectedNodes.length}</span>{batch && <span>{batch.status === 'running' ? '正在检测' : batch.status === 'cancelled' ? '检测已取消' : '检测结束'} {batch.items.filter(item => item.status === 'complete' || item.status === 'failed').length} / {batch.items.length} · 失败 {batch.items.filter(item => item.status === 'failed').length}</span>}{testing && <span>正在检测节点…</span>}{state.subscriptions.some(subscription => subscription.error) && <span className="network-status failed">订阅需要处理</span>}</>}><div className="subscription-filter-row"><input type="search" aria-label="筛选订阅节点" className="network-filter" placeholder="查找订阅或节点…" value={filter} onChange={event => setFilter(event.target.value)}/>{filter && <button onClick={() => setFilter('')}>清除筛选</button>}</div>
        {!!allNodes.length && <div className="network-batch"><div className="button-group"><button disabled={batchRunning} onClick={() => setSelected(previous => new Set([...previous, ...visibleNodes.map(nodeKey)]))}>全选当前筛选</button><button disabled={batchRunning} onClick={() => setSelected(previous => { const next = new Set(previous); visibleNodes.forEach(node => next.delete(nodeKey(node))); return next })}>取消当前筛选</button><button disabled={batchRunning || !selectedNodes.length} onClick={() => setSelected(new Set())}>取消选择</button><span className="muted small">已选 {selectedNodes.length} / {allNodes.length}</span></div><div className="button-group">{batchRunning ? <button disabled={busy} onClick={() => void run(() => api.cancelNetworkTests(batch.id))}>取消检测</button> : <button disabled={busy || !!testing || !selectedNodes.length} onClick={() => void run(async () => { await api.testNetworkNodes(selectedNodes); await network?.refresh() })}><Activity size={14}/>开始批量检测</button>}</div>{batch && <p role="status">{batch.status === 'running' ? '正在检测' : batch.status === 'cancelled' ? '已取消检测' : '检测结束'} · 已完成 {batch.items.filter(item => item.status === 'complete' || item.status === 'failed').length} / {batch.items.length} · 失败 {batch.items.filter(item => item.status === 'failed').length}。最多同时检测 3 个节点。</p>}</div>}
        {!state.subscriptions.length ? <Empty icon={<Globe2 size={30}/>} title="添加你的第一份订阅" action={<button onClick={() => setAdding(true)}><Plus size={15}/>添加订阅</button>}>支持订阅链接、本地 YAML 配置或节点列表，无需另外安装 Clash。</Empty> : <div className="network-subscriptions">{state.subscriptions.map(subscription => <SubscriptionCard key={subscription.id} subscription={subscription} filter={filter} busy={busy || batchRunning} testing={testing} selected={selected} batch={batch} onSelect={(nodeId, checked) => setSelected(previous => { const next = new Set(previous); const key = nodeKey({ subscriptionId: subscription.id, nodeId }); if (checked) next.add(key); else next.delete(key); return next })} onTest={nodeId => void testNode(subscription.id, nodeId)} onUpdate={() => void run(async () => { received(await api.refreshNetworkSubscription(subscription.id)) })} onRemove={() => void run(async () => { if (await confirm('删除订阅', `删除“${subscription.name}”及保存的节点。若仍有服务或应用用途绑定此订阅，请先更改对应线路，再删除订阅。`)) received(await api.removeNetworkSubscription(subscription.id)) })}/>)}</div>}
      </Collapsible>
      <Collapsible id="network.bindings" className="settings-section" title="应用联网线路" summary={<>{dirty && <span role="status" className="network-status failed">未保存</span>}<span>模型线路在对应模型服务中设置</span>{extensionError && <span role="alert" className="panel-error">MCP 列表读取失败：{extensionError}</span>}</>}><form onSubmit={event => { event.preventDefault(); void run(saveBindings) }}><div className="form-grid">{scopes.map(scope => <NetworkSelect key={scope.id} label={scope.label} value={bindings[scope.id]} disabled={busy} onChange={value => { setBindings(previous => ({ ...previous, [scope.id]: value })); setDirty(true) }}/>)}</div>
        {!!extensions.length && <><div className="section-heading"><h3>MCP 连接</h3></div><div className="form-grid">{extensions.map(extension => <NetworkSelect key={extension.id} label={`MCP · ${extension.name}`} value={bindings[`mcp:${extension.id}`]} disabled={busy} onChange={value => { setBindings(previous => ({ ...previous, [`mcp:${extension.id}`]: value })); setDirty(true) }}/>)}</div><p className="muted small">HTTP MCP 连接使用所选线路；stdio 扩展会收到相应代理设置，是否遵循取决于工具自身。终端程序自行发出的请求不保证使用此线路。</p></>}
        {extensionError && <p role="alert" className="panel-error">MCP 列表读取失败：{extensionError}</p>}
        <div className="settings-footer"><p className="muted small">订阅更新需可用线路；已有节点可以用于获取订阅。</p><button type="button" disabled={busy || !dirty} onClick={revert}>撤销本页改动</button><button className="primary" disabled={busy || !dirty}><Save size={15}/>保存应用线路</button></div>
      </form></Collapsible>
      <div className="info-note"><ShieldCheck size={19}/><div><strong>订阅与节点凭据加密保存在本机</strong><p>不会修改系统代理。开启其他软件的 TUN 时，“直连”仍可能被系统接管；远程网关访问上游模型的线路由网关管理。官方账号调用使用服务线路，系统浏览器中的登录页面使用浏览器网络。</p></div></div>
    </>}
    {adding && <SubscriptionImport onClose={() => setAdding(false)} notify={notify} onImported={next => { received(next); setAdding(false) }}/>}
    {leaving && <Modal title="网络设置尚未保存" onClose={() => resolveLeave(false)}><p>保存本页线路设置后离开，或放弃本页未保存的改动。</p><div className="modal-footer"><button disabled={busy} onClick={() => resolveLeave(false)}>继续编辑</button><button disabled={busy} onClick={() => { revert(); resolveLeave(true) }}>放弃改动</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await saveBindings(); resolveLeave(true) })}>保存并离开</button></div></Modal>}
  </div></CollapseGroup>
}

function SubscriptionCard({ subscription, filter, busy, testing, selected, batch, onSelect, onTest, onUpdate, onRemove }: { subscription: NetworkSubscription; filter: string; busy: boolean; testing: string; selected: Set<string>; batch?: NetworkTestJob; onSelect: (nodeId: string, checked: boolean) => void; onTest: (nodeId: string) => void; onUpdate: () => void; onRemove: () => void }) {
  const nodes = subscription.nodes.filter(node => matchesNode(subscription, node.name, filter))
  const testItems = batch?.items.filter(item => item.subscriptionId === subscription.id) ?? []
  const failedCount = subscription.nodes.filter(node => node.error || testItems.some(item => item.nodeId === node.id && item.status === 'failed')).length
  return <Collapsible id={`network.subscription.${subscription.id}`} className="network-subscription" title={subscription.name} forceOpen={!!filter.trim() && nodes.length > 0} summary={<><span>{subscription.source === 'file' ? '本地文件' : subscription.host || '订阅链接'} · {subscription.nodes.length} 个节点 · {new Date(subscription.updatedAt).toLocaleString('zh-CN')}</span>{subscription.pending && <span className="network-status">待应用</span>}{testItems.some(item => item.status === 'running') && <span>检测中 · {testItems.filter(item => item.status === 'complete' || item.status === 'failed').length} / {testItems.length}</span>}{testing.startsWith(`${subscription.id}:`) && <span>正在检测节点…</span>}{failedCount > 0 && <span className="network-status failed">{failedCount} 个节点检测失败</span>}{subscription.error && <span role="alert" className="panel-error">{subscription.error}</span>}</>} actions={<>{subscription.source === 'url' && <button type="button" disabled={busy || !!testing} aria-label={`更新订阅 ${subscription.name}`} onClick={onUpdate}><RefreshCw size={14}/>更新</button>}<button type="button" className="icon-button danger-hover" disabled={busy || !!testing} aria-label={`删除订阅 ${subscription.name}`} onClick={onRemove}><Trash2 size={16}/></button></>}>
    <div className="network-node-list">{nodes.map(node => { const item = batch?.items.find(item => item.subscriptionId === subscription.id && item.nodeId === node.id); return <div className="network-node" key={node.id}><input type="checkbox" aria-label={`选择节点 ${subscription.name} / ${node.name}`} disabled={busy} checked={selected.has(nodeKey({ subscriptionId: subscription.id, nodeId: node.id }))} onChange={event => onSelect(node.id, event.target.checked)}/><div><strong>{node.name}</strong><span>{node.type}{node.testedAt ? ` · ${new Date(node.testedAt).toLocaleTimeString('zh-CN')}` : ''}{item ? ` · ${{ waiting: '等待检测', running: '检测中', complete: '已完成', failed: '检测失败', cancelled: '已取消' }[item.status]}` : ''}</span>{(item?.error || node.error) && <p role="alert" className="network-node-error">{item?.error || node.error}</p>}</div><span className="network-delay">{node.error ? '检测失败' : node.delayMs !== undefined ? `${node.delayMs} ms` : '未检测'}</span><button disabled={busy || !!testing} aria-label={`检测延迟 ${subscription.name} / ${node.name}`} onClick={() => onTest(node.id)}>{testing === `${subscription.id}:${node.id}` ? <Spinner text="检测中…"/> : <><Activity size={14}/>检测延迟</>}</button></div>})}{!nodes.length && <p className="muted small">{filter ? '没有匹配的节点' : '没有可用节点'}</p>}</div>
    <p className="network-card-note">延迟检测不调用模型；模型服务是否可用，请在对应服务中测试连接。</p>
  </Collapsible>
}

function SubscriptionImport({ onClose, onImported, notify }: { onClose: () => void; onImported: (state: NetworkState) => void; notify: Notify }) {
  const [source, setSource] = useState<'url' | 'file'>('url')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const { busy, run } = useTask(notify)
  return <Modal title="添加兼容订阅" onClose={onClose}><form onSubmit={event => { event.preventDefault(); void run(async () => {
    setError('')
    try {
    let content: string | undefined
    if (source === 'file') { if (!file) throw new Error('请选择订阅文件'); if (file.size > 8 * 1024 * 1024) throw new Error('订阅文件不能超过 8 MB'); content = await file.text() }
    const state = await api.importNetworkSubscription({ name: name.trim(), ...(source === 'url' ? { url: url.trim() } : { content }) }); setUrl(''); onImported(state)
    } catch (reason) { setError(errorText(reason)); throw reason }
  }) }}><div className="form-grid"><label className="field"><span>订阅名称</span><input required maxLength={100} placeholder="例如：我的订阅" value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>导入方式</span><select aria-label="订阅导入方式" value={source} onChange={event => { setSource(event.target.value as typeof source); setUrl(''); setFile(null) }}><option value="url">订阅链接</option><option value="file">本地文件</option></select></label></div>{source === 'url' ? <label className="field"><span>订阅链接</span><input aria-label="订阅链接" required type="password" autoComplete="off" spellCheck={false} placeholder="https://…" value={url} onChange={event => setUrl(event.target.value)}/><small>链接可能含有凭据，保存后不会回显。通过“订阅添加与更新”所选线路获取。</small></label> : <label className="field"><span><FileUp size={14}/>订阅文件</span><input aria-label="订阅文件" required type="file" accept=".yaml,.yml,.txt,.conf,.json" onChange={event => setFile(event.target.files?.[0] ?? null)}/><small>支持 YAML、节点 URI 列表及 Base64 订阅，最大 8 MB。</small></label>}
    <p className="muted small">仅导入节点，不采用配置中的系统路由、脚本或控制接口。不支持的协议和嵌套资源会明确报错。</p>{error && <p role="alert" className="panel-error">{error}</p>}<div className="modal-footer"><span/><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy || !name.trim() || (source === 'url' ? !url.trim() : !file)}>{busy ? <Spinner text="正在导入…"/> : <>导入订阅 <ArrowRight size={15}/></>}</button></div></form></Modal>
}
