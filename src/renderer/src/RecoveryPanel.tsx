import { useState } from 'react'
import { ArchiveRestore, Check, DatabaseBackup, RefreshCw } from 'lucide-react'
import type { RecoveryPreview, RecoveryResult } from '../../shared/recovery'
import { api } from './api'
import { Collapsible } from './Collapsible'
import { Modal, Spinner, useTask, type Notify } from './common'

export function RecoveryPanel({ refresh, notify }: { refresh(): Promise<void>; notify: Notify }) {
  const [preview, setPreview] = useState<RecoveryPreview | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [result, setResult] = useState<RecoveryResult | null>(null)
  const [error, setError] = useState('')
  const { busy, run: task } = useTask((text, failed) => { if (failed) setError(text); notify(text, failed) })
  const run = (action: () => Promise<void>) => { setError(''); return task(action) }
  const inspect = () => void run(async () => {
    const value = await api.previewLegacyRecovery()
    setPreview(value); setResult(null)
    setSelected(value.entries.filter(entry => entry.status === 'available').map(entry => entry.legacyId))
  })
  const importSelected = () => void run(async () => {
    if (!preview) return
    const value = await api.importLegacyRecovery({ token: preview.token, entries: selected.map(legacyId => ({ legacyId, asSeparate: preview.entries.find(entry => entry.legacyId === legacyId)?.status === 'address-conflict' })) })
    setResult(value); await refresh()
    notify(`已恢复 ${value.imported} 个服务${value.keysNotRecovered.length ? '，部分密钥需要重新填写' : ''}`)
  })
  const labels = { available: '可以恢复', 'same-id': '当前版本已存在，保留当前配置', 'address-conflict': '地址相同，勾选后另存一个服务', 'already-imported': '已恢复，无需重复导入', invalid: '旧配置格式无法识别' }
  return <><Collapsible id="settings.recovery" className="settings-section" title={<><DatabaseBackup size={18}/>配置恢复</>} summary={<><span>{busy ? '正在处理…' : result ? `已恢复 ${result.imported} 个服务${result.keysNotRecovered.length ? ' · 部分密钥需要补填' : ''}` : '检查旧模型配置，预览后导入'}</span>{error && <span role="alert" className="panel-error">{error}</span>}</>} actions={<button type="button" disabled={busy} onClick={inspect}><ArchiveRestore size={15}/>检查旧模型配置</button>}>
    <p className="muted small">更新应用会继续使用现有数据目录。若从 0.1 版升级后看不到原来的模型，可在这里检查并恢复；先展示预览，再导入。</p></Collapsible>
    {preview && <Modal title="恢复旧模型配置" wide onClose={() => { if (!busy) setPreview(null) }}>
      <p className="small muted">旧库：{preview.sourcePath}</p>
      {result ? <div className="recovery-result"><h3><Check size={18}/>恢复完成</h3><p>恢复 {result.imported} 个服务，跳过 {result.skipped} 项。</p>{result.keysNotRecovered.length > 0 && <p role="alert">以下服务的旧密钥无法解密，请在模型设置中补填：{result.keysNotRecovered.join('、')}</p>}{result.backupPath && <p className="small muted">导入前备份：{result.backupPath}</p>}<div className="modal-footer"><span/><button className="primary" onClick={() => setPreview(null)}>完成</button></div></div>
        : <>{!preview.found ? <p>没有找到 0.1 版的旧模型数据库。</p> : !preview.entries.length ? <p>旧数据库中没有可恢复的模型服务。</p> : <div className="recovery-list">{preview.entries.map(entry => <label className="recovery-row" key={entry.legacyId}>
          <input type="checkbox" aria-label={`恢复 ${entry.name}`} disabled={busy || !['available', 'address-conflict'].includes(entry.status)} checked={selected.includes(entry.legacyId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, entry.legacyId] : ids.filter(id => id !== entry.legacyId))}/>
          <div><strong>{entry.name}</strong><p className="muted small">{entry.baseUrl}</p><p className="small">{entry.modelIds.length} 个模型 · {labels[entry.status]}</p><p className={`small ${entry.keyStatus === 'unreadable' ? 'error-text' : 'muted'}`}>{entry.keyStatus === 'ready' ? '密钥可恢复，会重新加密保存' : entry.keyStatus === 'missing' ? '未保存旧密钥，可恢复服务配置' : '旧密钥无法解密，仅恢复服务配置'}{entry.reason ? `；${entry.reason}` : ''}</p></div>
        </label>)}</div>}<p className="small muted">现有配置和密钥不会被覆盖。导入前自动备份当前数据库，旧数据库保持不变。</p><div className="modal-footer"><button disabled={busy} onClick={inspect}><RefreshCw size={14}/>重新检查</button><button disabled={busy} onClick={() => setPreview(null)}>关闭</button><button disabled={busy || !selected.length} className="primary" onClick={importSelected}>{busy ? <Spinner/> : `恢复所选 ${selected.length} 项`}</button></div></>}
    </Modal>}
  </>
}
