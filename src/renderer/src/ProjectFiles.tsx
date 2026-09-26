import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, File, Folder, FolderOpen, RefreshCw, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ProjectFile, ProjectFileContent } from '../../shared/workspace'
import type { DocumentResult, DocumentUnit } from '../../shared/documents'
import { api, errorText } from './api'
import { OpenInEditor } from './EditorIntegration'
import { Spinner, type Notify } from './common'

export function ProjectFiles({ projectId, notify, initialPath, refreshKey = '' }: { projectId: string; notify: Notify; initialPath?: string; refreshKey?: string }) {
  const [directory, setDirectory] = useState('')
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [selected, setSelected] = useState(initialPath ?? '')
  const [content, setContent] = useState<ProjectFileContent | null>(null)
  const [contentError, setContentError] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => { if (initialPath) setSelected(initialPath) }, [initialPath])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void api.readProjectFiles({ projectId, path: directory || undefined }).then(items => { if (active) setFiles(items) }).catch(e => { if (active) setError(errorText(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId, directory, tick, refreshKey])
  useEffect(() => {
    let active = true
    setContent(null); setContentError('')
    if (selected && !/\.(docx|xlsx|pptx|pdf)$/i.test(selected)) void api.readProjectFile({ projectId, path: selected }).then(file => { if (active) setContent(file) }).catch(e => { if (active) setContentError(errorText(e)) })
    return () => { active = false }
  }, [projectId, selected, tick, refreshKey])
  return <div className="project-files"><div className="file-toolbar"><button className="icon-button" aria-label="上一级目录" disabled={!directory} onClick={() => setDirectory(directory.replace(/\\/g, '/').split('/').slice(0, -1).join('/'))}><ArrowLeft size={15}/></button><span title={directory || '项目根目录'}>{directory || '项目文件'}</span><button className="icon-button" aria-label="刷新项目文件" onClick={() => setTick(t => t + 1)}><RefreshCw size={14}/></button><button className="icon-button" aria-label="在资源管理器中打开项目" onClick={() => void api.openProjectPath({ projectId, path: directory || undefined }).catch(e => notify(errorText(e), true))}><FolderOpen size={15}/></button></div>
    {error && <div className="panel-error" role="alert">{error}</div>}
    <div className={`file-list ${selected ? 'with-preview' : ''}`}>{loading ? <Spinner text="读取目录…"/> : files.length ? files.map(file => <button key={file.path} className={`file-row ${selected === file.path ? 'selected' : ''}`} title={file.path} onClick={() => { setError(''); if (file.directory) setDirectory(file.path); else setSelected(file.path) }}>{file.directory ? <Folder size={15}/> : <File size={15}/>}<span>{file.name}</span>{!file.directory && <small>{formatBytes(file.size)}</small>}</button>) : <p className="muted small file-empty">这个目录还没有文件。</p>}</div>
    {selected && <section className="file-preview"><div className="file-toolbar"><OpenInEditor projectId={projectId} path={selected} notify={notify}/><strong title={selected}>{selected.split(/[\\/]/).at(-1)}</strong><button className="icon-button" aria-label="用默认程序打开文件" onClick={() => void api.openProjectPath({ projectId, path: selected }).catch(e => notify(errorText(e), true))}><ExternalLink size={14}/></button><button className="icon-button" aria-label="关闭文件预览" onClick={() => setSelected('')}><X size={14}/></button></div>
      {/\.(docx|xlsx|pptx|pdf)$/i.test(selected) ? <div className="binary-preview"><File size={30}/><strong>{selected.split(/[\\/]/).at(-1)}</strong><DocumentInspect key={selected} projectId={projectId} path={selected} notify={notify}/></div> : contentError ? <div className="panel-error" role="alert">{contentError}</div> : !content ? <Spinner text="读取文件…"/> : content.binary ? <div className="binary-preview"><File size={30}/><strong>{selected.split(/[\\/]/).at(-1)}</strong><p>{formatBytes(content.size)} · 原始文件</p><button onClick={() => void api.openProjectPath({ projectId, path: selected }).catch(e => notify(errorText(e), true))}>打开文档</button><DocumentInspect projectId={projectId} path={selected} notify={notify}/></div> : /\.md$/i.test(selected) ? <div className="markdown file-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href) void api.openExternal(href).catch(err => notify(errorText(err), true)) }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt}]</span> }}>{content.text ?? ''}</ReactMarkdown></div> : <pre className="file-content code-preview">{content.text || '（空文件）'}</pre>}
      {content && <div className="file-integrity" title={content.sha256}>SHA256 {content.sha256.slice(0, 16)}…</div>}
    </section>}
  </div>
}

function DocumentInspect({ projectId, path, notify }: { projectId: string; path: string; notify: Notify }) {
  const [result, setResult] = useState<DocumentResult | null>(null)
  const [busy, setBusy] = useState(false)
  const supported = /\.(docx|xlsx|pptx|pdf)$/i.test(path)
  const inspect = async (preview: boolean) => {
    setBusy(true)
    try { const value = await (preview ? api.previewDocument({ projectId, path }) : api.inspectDocument({ projectId, path })); setResult(value) } catch (e) { notify(errorText(e), true) } finally { setBusy(false) }
  }
  if (!supported) return <p className="muted small">使用本机默认程序查看此文件。</p>
  return <div className="document-inspection"><div className="button-group"><button disabled={busy} onClick={() => void inspect(false)}>查看文档内容</button><button disabled={busy} onClick={() => void inspect(true)}>预览文档</button></div>{busy && <Spinner text="正在读取文档…"/>}{result && <><div className="document-inspect-meta">{result.inspection.format.toUpperCase()} · {result.inspection.totalUnits} 个内容单元</div>{result.previewError && <div role="alert" className="panel-error">预览未完成：{result.previewError}</div>}{!result.inspection.editable && result.inspection.blockedReasons.length > 0 && <div className="panel-error">{result.inspection.blockedReasons.join("；")}</div>}{result.inspection.warnings.map((w, i) => <p className="form-hint" key={i}>{w}</p>)}{result.inspection.format === 'xlsx' ? <SpreadsheetPreview units={result.inspection.units}/> : result.inspection.units.map(unit => <div className="document-unit" key={unit.id}><span>{unit.sheet ? `${unit.sheet} · ${unit.address ?? ''}` : unit.page !== undefined ? `第 ${unit.page + 1} 页` : unit.slide !== undefined ? `幻灯片 ${unit.slide + 1}` : unit.type}</span>{unit.text && !unit.rows && <p>{unit.text}</p>}{unit.rows && <div className="document-table"><table><tbody>{unit.rows.map((row, ri) => <tr key={ri}>{row.map((value, ci) => <td key={ci}>{value === null ? '' : String(value)}</td>)}</tr>)}</tbody></table></div>}{unit.formula && <p className="muted small">公式：{unit.formula} · 已有结果：{unit.cached == null ? '未提供' : String(unit.cached)}</p>}</div>)}{result.inspection.truncated && <p className="form-hint">内容较多，仅显示预览范围；请打开原件查看完整文档。</p>}</>}</div>
}

export function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }

function SpreadsheetPreview({ units }: { units: DocumentUnit[] }) {
  const sheets = [...new Set(units.flatMap(unit => unit.sheet ? [unit.sheet] : []))]
  const columnNumber = (name: string) => [...name].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0)
  return <div className="spreadsheet-preview">{sheets.map(sheet => {
    const cells = units.filter(unit => unit.sheet === sheet && /^[A-Z]+[0-9]+$/.test(unit.address ?? ''))
    const columns = [...new Set(cells.map(cell => cell.address!.match(/^[A-Z]+/)![0]))].sort((a, b) => columnNumber(a) - columnNumber(b))
    const rows = [...new Set(cells.map(cell => Number(cell.address!.match(/[0-9]+$/)![0])))].sort((a, b) => a - b)
    const indexed = new Map(cells.map(cell => [cell.address!, cell]))
    return <section className="sheet-preview" key={sheet}><h4>{sheet}</h4><div className="document-table"><table><thead><tr><th aria-label="行号"/>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row}><th>{row}</th>{columns.map(column => { const address = `${column}${row}`, cell = indexed.get(address); const value = cell?.formula ? cell.cached == null ? '未提供' : String(cell.cached) : cell?.rows?.[0]?.[0] ?? cell?.text ?? ''; return <td key={address} title={cell?.formula ? `${address}: ${cell.formula}` : address}>{String(value)}{cell?.formula && <small className="cell-formula">{cell.formula}</small>}</td> })}</tr>)}</tbody></table></div></section>
  })}</div>
}
