import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, BookOpen, Check, ExternalLink, FolderOpen, Globe2, Package, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, X } from 'lucide-react'
import type { CatalogEntry, ExtensionGrant, ExtensionInputField, ExtensionKind, ExtensionPopularityResult, ExtensionSearchBinding, ExtensionState, InstalledExtension, ToolAccess } from '../../shared/extensions'
import { extensionRecommendations, sortCatalogEntries, type CatalogSort } from '../../shared/extension-recommendations'
import { api, errorText } from './api'
import { Empty, Modal, Spinner, useTask, type Confirm, type Notify } from './common'
import './extensions.css'

const emptyState: ExtensionState = { installed: [], jobs: [], grants: [], approvals: [], calls: [], searchBindings: [] }
const kindLabel = { mcp: 'MCP 工具', skill: 'Skill 技能' }
const accessLabel: Record<ToolAccess, string> = { read: '只读', 'project-write': '修改项目', external: '外部操作 · 每次审批' }
function useExtensions() {
  const [state, setState] = useState<ExtensionState>(emptyState)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const ticket = ++generation.current
    try { const value = await api.extensionState(); if (ticket === generation.current) { setState(value); setError('') } }
    catch (e) { if (ticket === generation.current) setError(errorText(e)) }
    finally { if (ticket === generation.current) setLoading(false) }
  }, [])
  useEffect(() => { void refresh(); let timer: ReturnType<typeof setTimeout> | undefined; const off = api.onEvent(event => { if (event.type === 'extensions') { clearTimeout(timer); timer = setTimeout(() => void refresh(), 100) } }); return () => { generation.current++; clearTimeout(timer); off() } }, [refresh])
  return { state, error, loading, refresh }
}
function ExternalButton({ url, children, notify }: { url?: string; children: React.ReactNode; notify: Notify }) { return url ? <button className="text-button" onClick={() => void api.openExternal(url).catch(e => notify(errorText(e), true))}>{children}<ExternalLink size={13}/></button> : null }

export function ExtensionsView({ notify, confirm, projectId }: { notify: Notify; confirm: Confirm; projectId?: string }) {
  const { state, error, loading, refresh } = useExtensions()
  const [tab, setTab] = useState<'discover' | 'installed'>('discover')
  const [kind, setKind] = useState<ExtensionKind>('mcp')
  const [query, setQuery] = useState('')
  const [searchedQuery, setSearchedQuery] = useState('')
  const [entries, setEntries] = useState<CatalogEntry[]>(extensionRecommendations.filter(entry => entry.kind === 'mcp'))
  const [sort, setSort] = useState<CatalogSort>('source')
  const [starsWarning, setStarsWarning] = useState('')
  const [starsLoading, setStarsLoading] = useState(false)
  const [starsRefresh, setStarsRefresh] = useState(0)
  const [cursor, setCursor] = useState<string>()
  const [searching, setSearching] = useState(false)
  const [warning, setWarning] = useState('')
  const [searchError, setSearchError] = useState('')
  const [detail, setDetail] = useState<{ entry: CatalogEntry; installed?: InstalledExtension; popularityWarning?: string }>()
  const [importing, setImporting] = useState<'mcp' | 'skill'>()
  const searchVersion = useRef(0)
  const { busy, run } = useTask(notify)
  const search = async (more = false) => {
    const version = ++searchVersion.current; setSearching(true); setSearchError('')
    const text = more ? searchedQuery : query
    if (!text.trim()) { setEntries(extensionRecommendations.filter(entry => entry.kind === kind)); setCursor(undefined); setSearchedQuery(''); setWarning(''); setSearching(false); return }
    try { const result = await api.searchExtensions({ kind, query: text, cursor: more ? cursor : undefined }); if (version !== searchVersion.current) return; setEntries(old => more ? [...old, ...result.entries.filter(next => !old.some(item => item.id === next.id))] : result.entries); setCursor(result.nextCursor); setSearchedQuery(text); setWarning([result.warning, result.cached ? '当前显示缓存目录；安装时会重新核对固定版本。' : ''].filter(Boolean).join(' ')) }
    catch (e) { if (version === searchVersion.current) setSearchError(errorText(e)) }
    finally { if (version === searchVersion.current) setSearching(false) }
  }
  useEffect(() => { setEntries(extensionRecommendations.filter(entry => entry.kind === kind)); setCursor(undefined); setQuery(''); setSearchedQuery(''); setWarning(''); setSearchError(''); setSort('source'); setStarsWarning(''); searchVersion.current++; setSearching(false); return () => { searchVersion.current++ } }, [kind])
  const entryIds = JSON.stringify(entries.map(entry => ({ kind: entry.kind, id: entry.id })))
  useEffect(() => {
    if (sort !== 'stars') { setStarsWarning(''); return }
    let current = true; setStarsLoading(true); setStarsWarning('')
    void (async () => {
      const ids = JSON.parse(entryIds) as Array<{ kind: ExtensionKind; id: string }>
      for (let offset = 0; offset < ids.length && current; offset += 300) {
        const result = await api.extensionPopularity(ids.slice(offset, offset + 300)); if (!current) return
        setEntries(old => old.map(entry => ({ ...entry, ...result.entries.find(item => item.kind === entry.kind && item.id === entry.id) })))
        if (result.warning) setStarsWarning(popularityWarning(result))
      }
    })().catch(e => { if (current) setStarsWarning(errorText(e)) }).finally(() => { if (current) setStarsLoading(false) })
    return () => { current = false }
  }, [sort, entryIds, starsRefresh])
  const sortedEntries = useMemo(() => sortCatalogEntries(entries, sort), [entries, sort])
  const showDetails = (entry: Pick<CatalogEntry, 'kind' | 'id'> & { version?: string }, installed?: InstalledExtension) => void run(async () => {
    const current = installed ?? state.installed.find(item => item.kind === entry.kind && item.catalogId === entry.id)
    const selected = await api.extensionDetails({ kind: entry.kind, id: current?.catalogId ?? entry.id, version: current?.version || entry.version || undefined })
    const recommendation = extensionRecommendations.find(item => item.kind === selected.kind && item.id === selected.id)?.recommendation
    setDetail({ entry: { ...selected, recommendation }, installed: current })
    void api.extensionPopularity([{ kind: selected.kind, id: selected.id }]).then(result => setDetail(old => old?.entry.id === selected.id ? { ...old, entry: { ...old.entry, ...result.entries[0] }, popularityWarning: popularityWarning(result) } : old)).catch(e => setDetail(old => old?.entry.id === selected.id ? { ...old, popularityWarning: errorText(e) } : old))
  })
  return <div className="page extensions-page"><header className="page-heading"><div><div className="eyebrow">EXTEND YOUR WORKSPACE</div><h1>扩展商店</h1><p>发现工具与技能，按项目选择模型可以使用的能力。</p></div><div className="button-group"><button onClick={() => setImporting('mcp')}><Plus size={15}/>导入 MCP</button><button onClick={() => setImporting('skill')}><FolderOpen size={15}/>导入 Skill</button></div></header>
    <div className="extension-tabs" role="tablist" aria-label="扩展页面"><button role="tab" aria-selected={tab === 'discover'} onClick={() => setTab('discover')}>发现扩展</button><button role="tab" aria-selected={tab === 'installed'} onClick={() => setTab('installed')}>已安装 <span>{state.installed.length}</span></button></div>
    {error && <p role="alert" className="panel-error">{error}</p>}
    {state.jobs.length > 0 && <section className="extension-jobs" aria-label="安装任务"><div className="section-heading"><h2>安装任务</h2><button disabled={busy || !state.jobs.some(job => job.status !== 'running')} onClick={() => void run(async () => { await api.clearFinishedExtensionJobs(); await refresh() })}>清除已结束记录</button></div>{state.jobs.map(job => <div key={job.id} className="extension-job"><div><strong>{job.name}</strong><p>{job.status === 'failed' ? '未完成安装，可展开查看原因。' : job.progress}</p>{job.error && <details className="extension-error-details"><summary>查看详情</summary><p>{job.error}</p><small className="muted">{new Date(job.updatedAt).toLocaleString()}</small></details>}</div>{job.status === 'running' ? <><Spinner text="处理中"/><button aria-label={`取消 ${job.name}`} onClick={() => void api.cancelExtensionJob(job.id).then(refresh).catch(e => notify(errorText(e), true))}><X size={15}/>取消</button></> : <div className="extension-job-actions"><span className={`extension-badge ${job.status === 'failed' ? 'is-error' : ''}`}>{job.status === 'failed' ? '安装失败' : job.status === 'cancelled' ? '已取消' : '已完成'}</span>{job.status === 'failed' && job.source && <button disabled={busy} onClick={() => showDetails(job.source!)}>重新打开安装</button>}<button disabled={busy} aria-label={`移除 ${job.name} 安装记录`} onClick={() => void run(async () => { await api.clearExtensionJob(job.id); await refresh() })}><X size={14}/>移除记录</button></div>}</div>)}</section>}
    {tab === 'discover' ? <><form className="extension-search" onSubmit={e => { e.preventDefault(); void search() }}><select aria-label="扩展类型" value={kind} onChange={e => setKind(e.target.value as ExtensionKind)}><option value="mcp">MCP 工具</option><option value="skill">Skill 技能</option></select><input aria-label="搜索扩展" placeholder={kind === 'mcp' ? '搜索 MCP 工具名称或用途' : '搜索 Skill 名称或用途'} value={query} onChange={e => setQuery(e.target.value)}/><button className="primary" disabled={searching}><Search size={16}/>{searching ? '搜索中…' : '搜索'}</button></form>
      <p className="muted small">MCP 提供可调用工具；Skill 提供可复用的工作说明。安装后在项目中启用。</p>
      <div className="extension-sort"><h2>{searchedQuery ? '搜索结果' : '常用推荐'}</h2><label>对已加载结果排序 <select aria-label="扩展排序" value={sort} onChange={e => setSort(e.target.value as CatalogSort)}><option value="source">来源顺序</option><option value="name">名称</option>{kind === 'mcp' ? <option value="updated">最近更新</option> : <option value="installs">技能安装量</option>}<option value="stars">GitHub 仓库 Stars</option></select></label></div>
      {!searchedQuery && <p className="muted small">由应用维护的用途推荐。介绍可离线查看，详情与安装需要重新核对来源和版本。</p>}
      {sort === 'stars' && <p className="muted small">Stars 属于整个仓库，同仓库的 Skill 共用星数；热度不代表质量。{starsLoading ? ' 正在获取星数…' : <button className="text-button" onClick={() => setStarsRefresh(value => value + 1)}>重新查询</button>}</p>}
      {starsWarning && <p className="extension-warning">{starsWarning}</p>}
      {warning && <p className="extension-warning">{warning}</p>}{searchError && <p className="panel-error" role="alert">{searchError}</p>}
      {!entries.length && !searching && <Empty icon={<Search size={28}/>} title={searchedQuery ? '没有找到匹配扩展' : '从用途或名称开始搜索'}>目录信息来自官方 MCP Registry 与 skills.sh。查看来源和所需配置后，再安装到本机。</Empty>}
      <div className="extension-grid">{sortedEntries.map(entry => <article className="extension-card" key={entry.id}><div className="extension-card-heading"><div className="extension-icon">{entry.kind === 'mcp' ? <Package size={22}/> : <BookOpen size={22}/>}</div><div><h3>{entry.name}</h3><span className="extension-badge">{kindLabel[entry.kind]}</span></div></div><p>{entry.description || '此扩展未提供描述。'}</p>{entry.recommendation && <ul className="extension-requirements">{entry.recommendation.requirements.map(text => <li key={text}>{text}</li>)}</ul>}<div className="extension-meta">{entry.version ? `版本 ${entry.version}` : '版本及连接方式待核对'}{entry.installs !== undefined && ` · ${entry.installs.toLocaleString()} 次安装`}{entry.updatedAt && ` · 更新 ${new Date(entry.updatedAt).toLocaleDateString()}`}{entry.status !== 'active' && ' · 已停用'}</div><div className="extension-meta extension-source-label">来源：{entry.repositoryUrl ?? entry.source ?? entry.id}</div>{(sort === 'stars' || entry.repositoryStars !== undefined) && <Stars entry={entry}/>}<div className="extension-actions"><button disabled={busy} onClick={() => showDetails(entry)}>查看详情</button>{state.installed.some(item => item.catalogId === entry.id && item.kind === entry.kind) && <span className="extension-installed"><Check size={14}/>已安装</span>}</div></article>)}</div>
      {cursor && <div className="extension-more"><button disabled={searching} onClick={() => void search(true)}>加载更多</button></div>}
    </> : <><div className="section-heading"><h2>本机扩展</h2><div className="button-group"><button disabled={busy} onClick={() => void run(async () => { await api.checkExtensionUpdates(); await refresh(); notify('已检查扩展更新') })}><RefreshCw size={15}/>检查更新</button><button onClick={() => void refresh()}>刷新</button></div></div>{loading && <Spinner/>}
      {!loading && !state.installed.length && <Empty icon={<Package size={28}/>} title="尚未安装扩展">在发现页面搜索，或导入自己的 MCP 配置和 Skill。</Empty>}
      <div className="extension-grid">{state.installed.map(item => <article className="extension-card" key={item.id}><div className="extension-card-heading"><div className="extension-icon">{item.kind === 'mcp' ? <Package size={22}/> : <BookOpen size={22}/>}</div><div><h3>{item.name}</h3><span className={`extension-badge ${item.status !== 'ready' ? 'is-error' : ''}`}>{item.status === 'ready' ? '已就绪' : item.status === 'needs-configuration' ? '需要配置' : '连接失败'}</span></div></div><p>{item.description}</p><div className="extension-meta">{kindLabel[item.kind]} · {item.version || item.revisionId.slice(0, 12)}{item.kind === 'mcp' ? ` · ${item.tools.length} 个工具` : ` · ${item.skillFiles?.length ?? 0} 个文件`}</div>{item.error && <details className="extension-error-details"><summary>查看连接错误</summary><p className="panel-error">{item.error}</p></details>}{item.availableUpdate && <p className="extension-warning">可更新至 {item.availableUpdate}</p>}
        <div className="extension-actions"><button disabled={busy} onClick={() => showDetails(item, item)}><Settings2 size={14}/>详情与配置</button>{item.kind === 'mcp' && <button disabled={busy} onClick={() => void run(async () => { const tools = await api.testExtension(item.id); await refresh(); notify(`连接成功，发现 ${tools.length} 个工具`) })}>测试连接</button>}{item.oauth && <button disabled={busy} onClick={() => void run(async () => { const result = await api.loginExtension(item.id); notify(result.message, !result.authenticated); await refresh() })}>{item.oauth === 'connected' ? '重新授权' : '登录授权'}</button>}{item.availableUpdate && <button disabled={busy} onClick={() => void run(async () => { if (await confirm('更新扩展', `更新“${item.name}”到 ${item.availableUpdate}。工具定义发生变化时，需要重新确认项目授权。`)) { await api.updateExtension({ id: item.id }); await refresh(); notify('更新任务已开始') } })}><ArrowDownToLine size={14}/>更新</button>}<button disabled={busy} aria-label={`卸载 ${item.name}`} onClick={() => void run(async () => { if (await confirm('卸载扩展', `卸载“${item.name}”及其保存的配置和密钥。项目将无法继续调用该扩展。`)) { await api.removeExtension(item.id); await refresh() } })}><Trash2 size={14}/></button></div>
      </article>)}</div></>}
    {projectId && <ProjectExtensionsPanel projectId={projectId} notify={notify}/>}
    {detail && <ExtensionDetails key={`${detail.entry.id}:${detail.installed?.revisionId ?? 'new'}`} {...detail} notify={notify} onClose={() => setDetail(undefined)} onSaved={async () => { setDetail(undefined); setTab('installed'); await refresh() }}/>}
    {importing && <ImportExtension kind={importing} notify={notify} onClose={() => setImporting(undefined)} onSaved={async () => { setImporting(undefined); setTab('installed'); await refresh() }}/>}
  </div>
}

function popularityWarning(result: ExtensionPopularityResult): string { return [result.warning, result.retryAt && `可再次查询时间：${new Date(result.retryAt).toLocaleString()}`].filter(Boolean).join(' ') }
function Stars({ entry }: { entry: Pick<CatalogEntry, 'repositoryStars' | 'starsFetchedAt'> }) {
  return <div className="extension-meta">GitHub 仓库 Stars：{entry.repositoryStars === undefined ? '暂无数据' : entry.repositoryStars.toLocaleString()}{entry.starsFetchedAt && <small className="extension-stars-time">获取于 {new Date(entry.starsFetchedAt).toLocaleString()}</small>}</div>
}

type ConfigField = ExtensionInputField & { key: string }
function fieldsFor(entry: CatalogEntry, selection: string): ConfigField[] {
  const found = new Map<string, ConfigField>()
  const add = (field: ExtensionInputField, key?: string) => {
    for (const [name, variable] of Object.entries(field.variables ?? {})) add(variable, name)
    const name = key ?? field.name ?? field.valueHint
    if (!name || field.value !== undefined) return
    const previous = found.get(name); found.set(name, { ...previous, ...field, key: name, isSecret: previous?.isSecret || field.isSecret, isRequired: previous?.isRequired || field.isRequired })
  }
  const [type, index] = selection.split(':')
  if (type === 'remote') { const remote = entry.remotes?.[Number(index)]; for (const [key, value] of Object.entries(remote?.variables ?? {})) add(value, key); for (const field of remote?.headers ?? []) add(field) }
  else { const pkg = entry.packages?.[Number(index)]; for (const field of [...(pkg?.environmentVariables ?? []), ...(pkg?.packageArguments ?? []), ...(pkg?.runtimeArguments ?? [])]) add(field) }
  return [...found.values()]
}
function ExtensionDetails({ entry, installed, popularityWarning, notify, onClose, onSaved }: { entry: CatalogEntry; installed?: InstalledExtension; popularityWarning?: string; notify: Notify; onClose: () => void; onSaved: () => Promise<void> }) {
  const [selection, setSelection] = useState(installed?.remoteIndex !== undefined ? `remote:${installed.remoteIndex}` : installed?.packageIndex !== undefined ? `package:${installed.packageIndex}` : entry.packages?.length ? 'package:0' : 'remote:0')
  const [values, setValues] = useState<Record<string, string>>(installed?.configuration ?? {})
  const [customFields, setCustomFields] = useState<Array<{ id: number; name: string; value: string; secret: boolean }>>([])
  const nextField = useRef(0)
  const { busy, run } = useTask(notify)
  const fields = fieldsFor(entry, selection)
  for (const key of installed?.configuredFields ?? []) if (!fields.some(field => field.key === key)) fields.push({ key, isSecret: !Object.hasOwn(installed?.configuration ?? {}, key) })
  const selectedPackage = selection.startsWith('package:') ? entry.packages?.[Number(selection.split(':')[1])] : undefined
  const selectedRemote = selection.startsWith('remote:') ? entry.remotes?.[Number(selection.split(':')[1])] : undefined
  const manual = !!installed && !entry.packages?.length && !entry.remotes?.length
  const supported = manual || entry.kind === 'skill' || !!selectedPackage && ['npm', 'pypi', 'mcpb'].includes(selectedPackage.registryType) && selectedPackage.transport.type === 'stdio' || selectedRemote?.type === 'streamable-http'
  return <Modal title={entry.name} onClose={onClose} wide><p className="extension-description">{entry.description}</p><div className="extension-meta">{kindLabel[entry.kind]} · 版本 {entry.version || '由固定提交确定'}{entry.status !== 'active' && ' · 目录已停用'}</div><div className="extension-actions"><ExternalButton url={entry.websiteUrl} notify={notify}>主页</ExternalButton><ExternalButton url={entry.repositoryUrl ?? (entry.source && /^[\w.-]+\/[\w.-]+$/.test(entry.source) ? `https://github.com/${entry.source}` : undefined)} notify={notify}>源码</ExternalButton></div>{entry.commit && <p className="extension-source">固定提交：{entry.commit}</p>}
    {entry.recommendation && <ul className="extension-requirements">{entry.recommendation.requirements.map(text => <li key={text}>{text}</li>)}</ul>}<Stars entry={entry}/>{popularityWarning && <p className="extension-warning">{popularityWarning}</p>}
    <form onSubmit={e => { e.preventDefault(); void run(async () => { const plain: Record<string, string> = Object.create(null), secrets: Record<string, string> = Object.create(null); for (const field of fields) { const value = values[field.key]; if (value !== undefined && !(installed && field.isSecret && value === '')) (field.isSecret ? secrets : plain)[field.key] = value }
      const names = new Set(fields.map(field => field.key)); for (const field of customFields) { const name = field.name.trim(); if (!name || name.length > 200 || /[\u0000\r\n]/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name) || names.has(name)) throw new Error('自定义配置名称为空、无效或与已有字段重复。'); names.add(name); (field.secret ? secrets : plain)[name] = field.value }
      if (installed) { await api.configureExtension({ id: installed.id, values: plain, secrets }); notify('扩展配置已保存') }
      else { const [type, index] = selection.split(':'); await api.installExtension({ kind: entry.kind, id: entry.id, version: entry.version || undefined, ...(entry.kind === 'mcp' ? type === 'package' ? { packageIndex: Number(index) } : { remoteIndex: Number(index) } : {}), values: plain, secrets }); notify('安装任务已开始') }
      await onSaved()
    }) }}>
      {entry.kind === 'mcp' && (manual ? <p className="muted small">手工本地 MCP 配置；修改命令或参数请重新导入。</p> : <label className="field"><span>连接方式</span><select aria-label="扩展连接方式" value={selection} disabled={!!installed} onChange={e => { setSelection(e.target.value); setValues({}) }}>{entry.packages?.map((pkg, i) => <option key={`package:${i}`} value={`package:${i}`}>{pkg.registryType} · {pkg.identifier} {pkg.version}</option>)}{entry.remotes?.map((remote, i) => <option key={`remote:${i}`} value={`remote:${i}`}>{remote.type} · {remote.url}</option>)}</select></label>)}
      {!supported && entry.kind === 'mcp' && <p className="extension-warning">此连接方式尚不支持。可选 npm、PyPI、MCPB 本地包或 Streamable HTTP 远程服务。</p>}
      <div className="form-grid">{fields.map(field => <label className="field full" key={field.key}><span>{field.key}{field.isRequired && ' *'}{field.isSecret && ' · 密钥'}</span>{field.choices ? <select aria-label={field.key} value={values[field.key] ?? field.default ?? ''} required={field.isRequired && !installed?.configuredFields.includes(field.key)} onChange={e => setValues(old => ({ ...old, [field.key]: e.target.value }))}><option value="">请选择</option>{field.choices.map(choice => <option key={choice}>{choice}</option>)}</select> : <input aria-label={field.key} autoComplete="off" type={field.isSecret ? 'password' : 'text'} required={field.isRequired && !installed?.configuredFields.includes(field.key)} placeholder={installed?.configuredFields.includes(field.key) ? '已保存 · 留空保持不变' : field.default ?? field.description} value={values[field.key] ?? ''} onChange={e => setValues(old => ({ ...old, [field.key]: e.target.value }))}/>}<small className="muted">{field.description}</small></label>)}</div>
      {entry.kind === 'mcp' && <details className="extension-tool-list"><summary>高级自定义配置</summary><p className="muted small">按照扩展说明填写额外配置，例如 MCPB 的必填字段或选择程序入口的 __binary。敏感值请保留密钥标记。</p>{customFields.map((field, i) => <div key={field.id} className="extension-custom-field"><label className="field"><span>配置名 {i + 1}</span><input required maxLength={200} value={field.name} onChange={e => setCustomFields(old => old.map(item => item.id === field.id ? { ...item, name: e.target.value } : item))}/></label><label className="field"><span>配置值 {i + 1}</span><input autoComplete="off" type={field.secret ? 'password' : 'text'} value={field.value} onChange={e => setCustomFields(old => old.map(item => item.id === field.id ? { ...item, value: e.target.value } : item))}/></label><label className="check-label"><input type="checkbox" checked={field.secret} onChange={e => setCustomFields(old => old.map(item => item.id === field.id ? { ...item, secret: e.target.checked } : item))}/>密钥</label><button type="button" aria-label={`移除配置 ${i + 1}`} onClick={() => setCustomFields(old => old.filter(item => item.id !== field.id))}><X size={14}/></button></div>)}<button type="button" disabled={customFields.length >= 30} onClick={() => setCustomFields(old => [...old, { id: ++nextField.current, name: '', value: '', secret: true }])}><Plus size={14}/>添加配置项</button></details>}
      {installed?.tools.length ? <details className="extension-tool-list" open><summary>{installed.tools.length} 个可用工具</summary>{installed.tools.map(tool => <div key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p><details><summary>参数结构</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></div>)}</details> : null}
      {!!installed?.skillFiles?.length && <details className="extension-tool-list"><summary>已安装的 Skill 文件</summary><ul>{installed.skillFiles.map(path => <li key={path}>{path}</li>)}</ul></details>}
      <div className="modal-footer"><span className="muted small">{installed ? '更改配置后可测试连接。' : '安装在本应用内，项目授权单独设置。'}</span><button type="button" onClick={onClose}>关闭</button>{(!installed || fields.length > 0 || customFields.length > 0) && <button className="primary" disabled={busy || !supported || !installed && entry.status !== 'active'}>{busy ? <Spinner/> : installed ? '保存配置' : '安装扩展'}</button>}</div>
    </form></Modal>
}

function ImportExtension({ kind, notify, onClose, onSaved }: { kind: ExtensionKind; notify: Notify; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [configuration, setConfiguration] = useState('')
  const [sourceKind, setSourceKind] = useState<'directory' | 'zip' | 'github'>('directory')
  const [source, setSource] = useState('')
  const [skillName, setSkillName] = useState('')
  const [ref, setRef] = useState('')
  const { busy, run } = useTask(notify)
  return <Modal title={kind === 'mcp' ? '导入 MCP 配置' : '导入 Skill'} onClose={onClose} wide><form onSubmit={e => { e.preventDefault(); void run(async () => { if (kind === 'mcp') { JSON.parse(configuration); await api.importMcpConfiguration({ name: name.trim(), configuration }) } else await api.importSkill({ kind: sourceKind, source: source.trim(), skillName: skillName.trim() || undefined, ref: ref.trim() || undefined }); notify('导入任务已开始'); await onSaved() }) }}>
    {kind === 'mcp' ? <><label className="field"><span>配置名称</span><input required value={name} onChange={e => setName(e.target.value)} placeholder="例如：我的搜索服务"/></label><label className="field"><span>MCP JSON 配置</span><textarea className="extension-code-input" required rows={12} spellCheck={false} value={configuration} onChange={e => setConfiguration(e.target.value)} placeholder={'{ "mcpServers": { "example": { "command": "npx", "args": ["-y", "example-server@1.0.0"] } } }'}/></label><p className="muted small">支持 stdio 与 Streamable HTTP 配置。导入后可测试工具，再按项目授权。配置中的密钥保存在本机。</p></> : <><label className="field"><span>导入来源</span><select value={sourceKind} onChange={e => { setSourceKind(e.target.value as typeof sourceKind); setSource('') }}><option value="directory">本地 Skill 目录</option><option value="zip">本地 ZIP 压缩包</option><option value="github">GitHub 仓库</option></select></label><label className="field"><span>{sourceKind === 'github' ? 'GitHub 仓库地址' : '本地路径'}</span><div className="inline-input"><input required readOnly={sourceKind !== 'github'} value={source} onChange={e => setSource(e.target.value)} placeholder={sourceKind === 'github' ? 'https://github.com/owner/repository' : '请选择包含 SKILL.md 的目录或 ZIP'}/>{sourceKind !== 'github' && <button type="button" disabled={busy} onClick={() => void run(async () => { const chosen = sourceKind === 'directory' ? await api.selectDirectory() : (await api.selectComponentFiles())[0]; if (chosen) setSource(chosen) })}><FolderOpen size={15}/>选择</button>}</div></label><label className="field"><span>{sourceKind === 'github' ? 'Skill 名称（GitHub 导入必填）' : 'Skill 名称（可选）'}</span><input required={sourceKind === 'github'} value={skillName} onChange={e => setSkillName(e.target.value)}/></label>{sourceKind === 'github' && <label className="field"><span>提交或分支（可选）</span><input value={ref} onChange={e => setRef(e.target.value)} placeholder="安装时解析并固定到具体提交"/></label>}<p className="muted small">每次导入一个明确的 Skill。安装到本应用后，可在项目中启用。</p></>}
    <div className="modal-footer"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? <Spinner/> : '开始导入'}</button></div>
  </form></Modal>
}

export function ProjectExtensionsPanel({ projectId, notify }: { projectId: string; notify: Notify }) {
  const { state, error, loading, refresh } = useExtensions()
  return <section className="settings-section extension-project-panel"><div className="section-heading"><h2><ShieldCheck size={19}/>项目扩展授权</h2><button onClick={() => void refresh()}><RefreshCw size={14}/>刷新</button></div><p className="muted small">讨论与审阅只使用已授权的只读工具。执行可以使用项目修改工具；外部操作在调用时单独确认。Skill 作为工作说明提供给模型。</p>
    {error && <p className="panel-error" role="alert">{error}</p>}{loading && <Spinner/>}{!loading && !state.installed.length && <p className="muted small extension-placeholder">先在扩展商店安装 MCP 或 Skill，再回到此项目启用。</p>}
    {state.installed.map(extension => { const grant = state.grants.find(item => item.projectId === projectId && item.extensionId === extension.id); return <GrantEditor key={`${projectId}:${extension.id}:${extension.revisionId}:${grant?.updatedAt ?? ''}`} extension={extension} projectId={projectId} initial={grant} notify={notify} onSaved={refresh}/> })}
    {state.calls.some(call => call.projectId === projectId) && <details className="extension-call-history"><summary>最近的 MCP 工具调用</summary>{state.calls.filter(call => call.projectId === projectId).slice(-20).reverse().map(call => <article key={call.id}><div className="extension-card-heading"><strong>{call.tool}</strong><span className="extension-badge">{({ running: '运行中', complete: '已完成', failed: '失败', cancelled: '已取消', unknown: '结果未确认' })[call.status]}</span></div><small className="muted">{new Date(call.startedAt).toLocaleString()} · 运行 {call.runId.slice(0, 8)}</small>{call.error && <p className="panel-error">{call.error}</p>}<details><summary>参数与工具结果</summary><pre>{JSON.stringify({ arguments: call.arguments, output: call.output }, null, 2)}</pre></details>{call.evidence.length > 0 && <p className="muted small">保存 {call.evidence.length} 条工具来源证据</p>}</article>)}</details>}
  </section>
}
function GrantEditor({ extension, projectId, initial, notify, onSaved }: { extension: InstalledExtension; projectId: string; initial?: ExtensionGrant; notify: Notify; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? false)
  const [granted, setGranted] = useState<Record<string, ToolAccess | ''>>(() => Object.fromEntries(extension.tools.map(tool => { const grant = initial?.tools.find(item => item.name === tool.name && item.schemaHash === tool.schemaHash); return [tool.name, grant?.access ?? ''] })))
  const { busy, run } = useTask(notify)
  const changedDefinition = initial?.tools.some(tool => !extension.tools.some(current => current.name === tool.name && current.schemaHash === tool.schemaHash))
  return <form className="extension-grant" onSubmit={e => { e.preventDefault(); void run(async () => { await api.saveExtensionGrant({ projectId, extensionId: extension.id, enabled, tools: extension.tools.filter(tool => granted[tool.name]).map(tool => ({ name: tool.name, schemaHash: tool.schemaHash, access: granted[tool.name] as ToolAccess })) }); await onSaved(); notify('项目授权已保存') }) }}>
    <div className="extension-grant-heading"><label className="check-label"><input type="checkbox" checked={enabled} disabled={extension.status !== 'ready' && !enabled} onChange={e => setEnabled(e.target.checked)}/><strong>{extension.name}</strong></label><span className="extension-badge">{kindLabel[extension.kind]}</span><button disabled={busy}>{busy ? <Spinner/> : '保存授权'}</button></div>
    {extension.status !== 'ready' && <p className="extension-warning">扩展尚未就绪，请先在商店检查配置与连接。</p>}{changedDefinition && <p className="extension-warning">工具定义已更新。变化的工具已取消勾选，请核对后重新授权。</p>}
    {extension.kind === 'mcp' && enabled && <div className="extension-grant-tools">{extension.tools.map(tool => <div key={tool.name}><div><strong>{tool.name}</strong><p>{tool.description}</p>{(tool.destructiveHint || tool.openWorldHint) && <small className="extension-warning">服务声明：{[tool.destructiveHint && '可能执行破坏性操作', tool.openWorldHint && '可与外部系统交互'].filter(Boolean).join('；')}</small>}</div><select aria-label={`${extension.name} ${tool.name} 权限`} value={granted[tool.name] ?? ''} onChange={e => setGranted(old => ({ ...old, [tool.name]: e.target.value as ToolAccess | '' }))}><option value="">不授权</option>{Object.entries(accessLabel).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></div>)}{!extension.tools.length && <p className="muted small">尚未发现工具，请先测试连接。</p>}</div>}
  </form>
}

export function ExtensionApprovalsPanel({ projectId, runId, projects = [], notify }: { projectId?: string; runId?: string; projects?: Array<{ id: string; name: string }>; notify: Notify }) {
  const { state, error, refresh } = useExtensions()
  const { busy, run } = useTask(notify)
  const pending = state.approvals.filter(item => item.status === 'pending' && (!projectId || item.projectId === projectId) && (!runId || item.runId === runId))
  if (!pending.length && !error) return null
  return <section className="extension-approvals" aria-label="待确认的外部操作"><h3><ShieldCheck size={18}/>外部操作等待确认</h3>{error && <p className="panel-error" role="alert">{error}</p>}{pending.map(approval => <article key={approval.id}><strong>{state.installed.find(item => item.id === approval.extensionId)?.name ?? approval.extensionId} · {approval.tool}</strong><p className="muted small">项目：{projects.find(project => project.id === approval.projectId)?.name ?? approval.projectId} · 运行：{approval.runId.slice(0, 12)}</p><p className="muted small">仅批准这一次工具调用。下面是模型提交的参数，密钥等敏感值已隐藏。</p><pre>{JSON.stringify(approval.arguments, null, 2)}</pre><div className="extension-actions"><button disabled={busy} onClick={() => void run(async () => { await api.resolveExtensionApproval({ id: approval.id, allow: false }); await refresh() })}>拒绝本次操作</button><button className="primary" disabled={busy} onClick={() => void run(async () => { await api.resolveExtensionApproval({ id: approval.id, allow: true }); await refresh() })}>允许本次操作</button></div></article>)}</section>
}

export function ExtensionSearchBindingPanel({ projectId, notify }: { projectId: string; notify: Notify }) {
  const { state, error, loading, refresh } = useExtensions()
  const binding = state.searchBindings.find(item => item.projectId === projectId)
  return <section className="settings-section extension-search-panel"><div className="section-heading"><h2><Globe2 size={19}/>项目搜索工具</h2><button onClick={() => void refresh()}>刷新</button></div><p className="muted small">将已授权的只读 MCP 工具用作项目联网搜索。明确查询参数与结果字段，保存来源链接和摘要或正文。</p>{error && <p className="panel-error" role="alert">{error}</p>}{loading ? <Spinner/> : <SearchBindingEditor key={`${projectId}:${JSON.stringify(binding)}`} projectId={projectId} state={state} initial={binding} notify={notify} onSaved={refresh}/>}</section>
}
function SearchBindingEditor({ projectId, state, initial, notify, onSaved }: { projectId: string; state: ExtensionState; initial?: ExtensionSearchBinding; notify: Notify; onSaved: () => Promise<void> }) {
  const options = state.installed.filter(extension => extension.status === 'ready' && extension.kind === 'mcp').flatMap(extension => extension.tools.filter(tool => state.grants.some(grant => grant.projectId === projectId && grant.extensionId === extension.id && grant.enabled && grant.tools.some(allowed => allowed.name === tool.name && allowed.schemaHash === tool.schemaHash && allowed.access === 'read'))).map(tool => ({ extension, tool, key: JSON.stringify([extension.id, tool.name]) })))
  const [choice, setChoice] = useState(initial ? JSON.stringify([initial.extensionId, initial.tool]) : '')
  const [form, setForm] = useState({ queryField: initial?.queryField ?? '', resultPath: initial?.resultPath ?? '', titleField: initial?.titleField ?? 'title', urlField: initial?.urlField ?? 'url', textField: initial?.textField ?? 'text', contentType: initial?.contentType ?? 'snippet' as 'snippet' | 'body' })
  const [fixed, setFixed] = useState(JSON.stringify(initial?.fixedArguments ?? {}, null, 2))
  const { busy, run } = useTask(notify)
  const selected = options.find(item => item.key === choice)
  const properties = selected?.tool.inputSchema.properties
  const queryFields = properties && typeof properties === 'object' ? Object.entries(properties).filter(([, schema]) => schema && typeof schema === 'object' && (schema as { type?: string }).type === 'string').map(([key]) => key) : []
  const valid = selected && (!initial || initial.schemaHash === selected.tool.schemaHash || choice !== JSON.stringify([initial.extensionId, initial.tool]))
  return <form onSubmit={e => { e.preventDefault(); void run(async () => { if (!selected) throw new Error('请选择已授权的只读工具'); const fixedArguments: unknown = JSON.parse(fixed || '{}'); if (!fixedArguments || typeof fixedArguments !== 'object' || Array.isArray(fixedArguments)) throw new Error('固定参数必须是 JSON 对象'); await api.saveExtensionSearchBinding({ projectId, extensionId: selected.extension.id, tool: selected.tool.name, schemaHash: selected.tool.schemaHash, ...form, fixedArguments: fixedArguments as Record<string, unknown> }); await onSaved(); notify('项目搜索绑定已保存') }) }}>
    <label className="field"><span>搜索工具</span><select required aria-label="项目搜索工具" value={choice} onChange={e => { setChoice(e.target.value); setForm(old => ({ ...old, queryField: '' })) }}><option value="">请选择</option>{initial && !options.some(item => item.key === choice) && <option value={choice}>原绑定不可用，请重新授权或更换工具</option>}{options.map(item => <option key={item.key} value={item.key}>{item.extension.name} / {item.tool.name}</option>)}</select></label>
    {!options.length && <p className="extension-warning">先在项目扩展授权中启用 MCP，并将搜索工具设为只读。</p>}
    {selected && <><details className="extension-tool-list"><summary>工具参数与结果结构</summary><pre>{JSON.stringify({ inputSchema: selected.tool.inputSchema, outputSchema: selected.tool.outputSchema }, null, 2)}</pre></details>{!valid && <p className="extension-warning">当前工具定义已变化。核对下方字段后重新保存即可更新绑定。</p>}<div className="form-grid"><label className="field"><span>查询参数字段</span>{queryFields.length ? <select required value={form.queryField} onChange={e => setForm(old => ({ ...old, queryField: e.target.value }))}><option value="">请选择查询字段</option>{queryFields.map(key => <option key={key}>{key}</option>)}</select> : <input required value={form.queryField} onChange={e => setForm(old => ({ ...old, queryField: e.target.value }))} placeholder="例如 query"/>}</label><label className="field"><span>结果数组路径（根数组可留空）</span><input value={form.resultPath} onChange={e => setForm(old => ({ ...old, resultPath: e.target.value }))} placeholder="例如 results 或 data.results"/></label>{([{ key: 'titleField', label: '单条结果的标题字段' }, { key: 'urlField', label: '单条结果的链接字段' }, { key: 'textField', label: '单条结果的内容字段' }] as const).map(field => <label className="field" key={field.key}><span>{field.label}</span><input required value={form[field.key]} onChange={e => setForm(old => ({ ...old, [field.key]: e.target.value }))}/></label>)}<label className="field"><span>返回内容的性质</span><select value={form.contentType} onChange={e => setForm(old => ({ ...old, contentType: e.target.value as 'snippet' | 'body' }))}><option value="snippet">搜索摘要</option><option value="body">来源正文</option></select></label></div><label className="field"><span>额外固定参数（JSON 对象）</span><textarea className="extension-code-input" rows={4} value={fixed} onChange={e => setFixed(e.target.value)} spellCheck={false}/></label></>}
    <div className="extension-actions"><button className="primary" disabled={busy || !selected}>保存搜索绑定</button>{initial && <button type="button" disabled={busy} onClick={() => void run(async () => { await api.removeExtensionSearchBinding(projectId); await onSaved(); notify('已恢复项目默认搜索') })}>移除绑定</button>}</div>
  </form>
}
