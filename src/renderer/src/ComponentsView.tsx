import { useEffect, useRef, useState } from 'react'
import { Boxes, Download, FolderOpen, RefreshCw, Trash2, X } from 'lucide-react'
import type { ComponentId, ComponentPhase, ComponentStatus } from '../../shared/components'
import { api, errorText } from './api'
import { Spinner, type Confirm, type Notify } from './common'
import './extensions.css'

const phaseLabel: Record<ComponentPhase, string> = { missing: '尚未安装', downloading: '下载中', verifying: '校验文件', extracting: '安装中', ready: '已就绪', 'restart-required': '重启后生效', cancelled: '已取消', failed: '安装失败' }
const descriptions: Record<ComponentId, string> = {
  mihomo: '内置订阅代理，无需另外安装 Clash。',
  documents: 'Word、Excel、PowerPoint 和 PDF 文档工具。', libreoffice: '文档预览与格式转换。', lancedb: '长期知识库的本机向量检索。',
  opencode: 'API 模型的 Agent 执行后台。', codex: '通过 Codex 官方账号讨论与执行。', claude: '通过 Claude Code 官方账号讨论与执行。',
  node: '运行 JavaScript MCP 扩展和 Skill 安装工具。', python: '运行 Python 扩展。', uv: '安装与运行 Python MCP 扩展。', git: '获取固定提交的 Skill 源码。', skills: '官方 Skill 安装工具，安装到本应用。'
}
const running = (phase: ComponentPhase) => ['downloading', 'verifying', 'extracting'].includes(phase)
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`

export function ComponentsView({ notify, confirm }: { notify: Notify; confirm: Confirm }) {
  const [items, setItems] = useState<ComponentStatus[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<Set<ComponentId>>(new Set())
  const locks = useRef(new Set<ComponentId>())
  const generation = useRef(0)
  const eventRevision = useRef(0)
  const updates = useRef(new Map<ComponentId, { revision: number; value: ComponentStatus }>())
  const refresh = async () => {
    const ticket = ++generation.current
    const before = eventRevision.current
    try { const result = await api.listComponents(); if (ticket === generation.current) { setItems(result.map(item => { const update = updates.current.get(item.id); return update && update.revision > before ? update.value : item })); setError('') } }
    catch (e) { if (ticket === generation.current) setError(errorText(e)) }
    finally { if (ticket === generation.current) setLoading(false) }
  }
  useEffect(() => {
    void refresh()
    const off = api.onEvent(event => { if (event.type === 'component' && event.component) { const component = event.component; updates.current.set(component.id, { revision: ++eventRevision.current, value: component }); setItems(old => old.some(item => item.id === component.id) ? old.map(item => item.id === component.id ? component : item) : [...old, component]) } })
    return () => { generation.current++; off() }
  }, [])
  const act = async (item: ComponentStatus, operation: 'prepare' | 'import' | 'remove') => {
    if (locks.current.has(item.id)) return
    locks.current.add(item.id); setPending(new Set(locks.current))
    try {
      if (operation === 'remove') { if (!await confirm('卸载可选组件', `卸载“${item.name}”后，使用此组件的功能需要重新准备环境。项目文件和讨论记录会保留。`)) return; await api.removeComponent(item.id); notify('组件已卸载') }
      else if (operation === 'import') { const paths = await api.selectComponentFiles(); if (!paths.length) return; await api.importComponent({ id: item.id, paths }); notify('离线文件校验与安装完成') }
      else { await api.prepareComponent(item.id); notify(`${item.name}已准备完成`) }
    } catch (e) { notify(errorText(e), true) }
    finally { locks.current.delete(item.id); setPending(new Set(locks.current)); await refresh() }
  }
  return <div className="page extensions-page"><header className="page-heading"><div><div className="eyebrow">OPTIONAL COMPONENTS</div><h1>可选组件</h1><p>按需准备本机能力，下载后可重复使用。</p></div><button onClick={() => void refresh()}><RefreshCw size={16}/>刷新状态</button></header>
    <div className="info-note"><Boxes size={20}/><p>首次使用相应功能时会准备所需组件。离线导入需选择该组件的全部官方原始安装包；应用会校验文件。复合组件可能需要多个文件。</p></div>
    {error && <p className="panel-error" role="alert">{error}</p>}{loading && <Spinner text="读取组件状态…"/>}
    <div className="extension-grid">{items.map(item => { const active = running(item.phase); const busy = pending.has(item.id); return <article className="extension-card" key={item.id}>
      <div className="extension-card-heading"><div className="extension-icon"><Boxes size={22}/></div><div><h3>{item.name}</h3><span className={`extension-badge ${item.phase === 'failed' ? 'is-error' : ''}`}>{phaseLabel[item.phase]}</span></div></div>
      <p>{descriptions[item.id]}</p><div className="extension-meta">版本 {item.version}{item.installedVersion && item.installedVersion !== item.version ? ` · 已安装 ${item.installedVersion}` : ''}</div>
      {active && <div className="component-progress" aria-live="polite"><div><Spinner text={phaseLabel[item.phase]}/><span>{item.receivedBytes !== undefined ? bytes(item.receivedBytes) : ''}{item.totalBytes ? ` / ${bytes(item.totalBytes)}` : ''}</span></div><progress aria-label={`${item.name}下载进度`} value={item.totalBytes && item.receivedBytes !== undefined ? item.receivedBytes : undefined} max={item.totalBytes || undefined}/>{item.artifact && <small>{item.artifact}</small>}</div>}
      {item.error && <p className="panel-error" role="alert">{item.error}</p>}
      {item.phase === 'restart-required' && <p className="extension-warning">此组件已在本次运行中加载，请关闭并重新打开应用。</p>}
      <div className="extension-actions">{active ? <button onClick={() => void api.cancelComponent(item.id).catch(e => notify(errorText(e), true))}><X size={15}/>取消</button> : <><button className={item.phase === 'ready' ? '' : 'primary'} disabled={busy || item.phase === 'restart-required'} onClick={() => void act(item, 'prepare')}><Download size={15}/>{busy ? '处理中…' : item.phase === 'ready' ? '检查准备状态' : '下载并安装'}</button><button disabled={busy || item.phase === 'restart-required'} onClick={() => void act(item, 'import')}><FolderOpen size={15}/>离线导入</button>{(item.phase === 'ready' || item.installedVersion) && <button aria-label={`卸载 ${item.name}`} disabled={busy} onClick={() => void act(item, 'remove')}><Trash2 size={15}/>卸载</button>}</>}</div>
    </article> })}</div>
  </div>
}
