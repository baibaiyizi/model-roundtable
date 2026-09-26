import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { Store, SecretCodec } from './store'
import type { Provider } from '../shared/types'
import type { RecoveryEntry, RecoveryPreview, RecoveryResult } from '../shared/recovery'

const legacyProvider = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(100),
  baseUrl: z.url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }),
  modelIds: z.array(z.string().min(1).max(300)).max(5000),
  tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']), streamUsage: z.boolean(), timeoutMs: z.number().int().min(1000).max(900000),
})
interface LegacyRow { id: string; payload: string; key?: Uint8Array }
interface Snapshot { rows: LegacyRow[]; fingerprint: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function address(value: string): string { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.toString().replace(/\/$/, '') }

/** A one-time, read-only v1 configuration reader; never constructs the current Store on an old file. */
export class LegacyRecovery {
  private previewState?: { token: string; fingerprint: string; expires: number }
  private importing = false
  private closed = false
  readonly sourcePath: string
  constructor(private store: Store, sourcePath: string, private backupDir: string, private codec: SecretCodec) { this.sourcePath = resolve(sourcePath) }
  private read(): Snapshot {
    if (!existsSync(this.sourcePath)) return { rows: [], fingerprint: 'missing' }
    const db = new DatabaseSync(this.sourcePath, { readOnly: true })
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value
      if (version !== '1') throw new Error(`旧配置的数据版本 ${String(version)} 不属于本次恢复范围；文件未修改。`)
      const raw = db.prepare("SELECT e.id,e.payload,s.value FROM entities e LEFT JOIN secrets s ON s.id='provider:'||e.id WHERE e.kind='provider' ORDER BY e.id").all()
      const rows = raw.map(row => ({ id: String(row.id), payload: String(row.payload), ...(row.value instanceof Uint8Array ? { key: new Uint8Array(row.value) } : {}) }))
      return { rows, fingerprint: digest(JSON.stringify(rows.map(row => [row.id, row.payload, row.key ? Buffer.from(row.key).toString('base64') : null]))) }
    } finally { db.close() }
  }
  private marker(id: string): string { return digest(`${this.sourcePath.toLowerCase()}\n${id}`) }
  private async entry(row: LegacyRow): Promise<RecoveryEntry> {
    let provider: z.infer<typeof legacyProvider>
    try { provider = legacyProvider.parse(JSON.parse(row.payload)); if (provider.id !== row.id) throw new Error() }
    catch { return { legacyId: row.id, name: '无法识别的旧服务', baseUrl: '', modelIds: [], status: 'invalid', keyStatus: 'unreadable', reason: '配置格式无效，未读取密钥。' } }
    let keyStatus: RecoveryEntry['keyStatus'] = 'missing'
    if (row.key) { try { keyStatus = await this.codec.decrypt(row.key) ? 'ready' : 'missing' } catch { keyStatus = 'unreadable' } }
    const existing = this.store.listProviders()
    const status: RecoveryEntry['status'] = this.store.getEntity('recovery', this.marker(row.id)) ? 'already-imported'
      : existing.some(p => p.id === row.id) ? 'same-id'
      : existing.some(p => (!p.kind || p.kind === 'api') && address(p.baseUrl) === address(provider.baseUrl)) ? 'address-conflict' : 'available'
    return { legacyId: row.id, name: provider.name, baseUrl: provider.baseUrl, modelIds: provider.modelIds, status, keyStatus }
  }
  async preview(): Promise<RecoveryPreview> {
    if (this.closed) throw new Error('应用正在退出，旧配置恢复已取消。')
    if (this.importing) throw new Error('旧配置正在恢复，请等待完成。')
    const snapshot = this.read(), token = randomUUID()
    this.previewState = { token, fingerprint: snapshot.fingerprint, expires: Date.now() + 15 * 60_000 }
    const entries = await Promise.all(snapshot.rows.map(row => this.entry(row)))
    if (this.closed) throw new Error('应用正在退出，旧配置恢复已取消。')
    return { token, found: snapshot.fingerprint !== 'missing', sourcePath: this.sourcePath, entries }
  }
  async import(input: { token: string; entries: { legacyId: string; asSeparate: boolean }[] }): Promise<RecoveryResult> {
    if (this.closed) throw new Error('应用正在退出，旧配置恢复已取消。')
    if (this.importing) throw new Error('旧配置正在恢复，请等待完成。')
    this.importing = true
    try {
      const state = this.previewState
      if (!state || state.token !== input.token || state.expires < Date.now()) throw new Error('恢复预览已失效，请重新检查旧配置。')
      const snapshot = this.read()
      if (snapshot.fingerprint !== state.fingerprint) throw new Error('旧配置在预览后发生变化，请重新检查；未导入任何内容。')
      if (new Set(input.entries.map(row => row.legacyId)).size !== input.entries.length) throw new Error('恢复列表含有重复服务。')
      const rows: { marker: string; provider: Provider; encryptedKey?: Uint8Array; asSeparate: boolean; legacyId: string }[] = []
      const keysNotRecovered: string[] = []
      let skipped = 0
      for (const selection of input.entries) {
        const row = snapshot.rows.find(value => value.id === selection.legacyId)
        if (!row) throw new Error('所选旧服务不在恢复预览中。')
        const entry = await this.entry(row)
        if (['invalid', 'already-imported', 'same-id'].includes(entry.status) || (entry.status === 'address-conflict' && !selection.asSeparate)) { skipped++; continue }
        const parsed = legacyProvider.parse(JSON.parse(row.payload))
        let encryptedKey: Uint8Array | undefined
        if (row.key) {
          try { const key = await this.codec.decrypt(row.key); if (key) encryptedKey = await this.codec.encrypt(key) }
          catch { keysNotRecovered.push(parsed.name) }
        }
        const provider: Provider = { ...parsed, id: randomUUID(), kind: 'api', name: entry.status === 'address-conflict' ? `${parsed.name.slice(0, 92)}（恢复）` : parsed.name, hasKey: Boolean(encryptedKey) }
        rows.push({ marker: this.marker(row.id), provider, encryptedKey, asSeparate: selection.asSeparate, legacyId: row.id })
      }
      // Recheck after the asynchronous codec work; no await occurs between this check and COMMIT.
      if (this.closed) throw new Error('应用正在退出，旧配置恢复已取消；未导入配置。')
      const current = this.store.listProviders()
      const accepted = rows.filter(row => {
        const duplicate = this.store.getEntity('recovery', row.marker) || current.some(p => p.id === row.legacyId)
          || (!row.asSeparate && current.some(p => (!p.kind || p.kind === 'api') && address(p.baseUrl) === address(row.provider.baseUrl)))
        if (duplicate) skipped++
        return !duplicate
      })
      if (!accepted.length) return { imported: 0, skipped, keysNotRecovered }
      const backupPath = join(this.backupDir, `before-config-recovery-${Date.now()}-${randomUUID()}.sqlite`)
      this.store.backup(backupPath)
      const imported = this.store.importRecoveredProviders(accepted)
      this.previewState = undefined
      return { imported, skipped: skipped + accepted.length - imported, keysNotRecovered, backupPath }
    } finally { this.importing = false }
  }
  shutdown(): void { this.closed = true; this.previewState = undefined }
}
