import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store, type SecretCodec } from '../src/main/store'
import { LegacyRecovery } from '../src/main/recovery'

const roots: string[] = [], openStores: Store[] = []
afterEach(() => { for (const db of openStores.splice(0)) db.close(); for (const dir of roots.splice(0)) if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true }) })
function codec(): SecretCodec {
  const key = randomBytes(32)
  return {
    async encrypt(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), value = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), value]) },
    async decrypt(bytes) { const data = Buffer.from(bytes), cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); cipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8') },
  }
}
const oldProvider = (id = 'old', baseUrl = 'https://api.example.com/v1') => ({ id, name: '旧模型服务', baseUrl, modelIds: ['model-a', 'model-b'], tokenParameter: 'max_tokens' as const, streamUsage: false, timeoutMs: 60000, hasKey: true })
async function setup(providers = [oldProvider()], secretCodec = codec()) {
  const directory = mkdtempSync(join(tmpdir(), 'roundtable-recovery-')); roots.push(directory)
  const source = join(directory, 'roundtable.sqlite'), old = new DatabaseSync(source)
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE entities(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id)); CREATE TABLE secrets(id TEXT PRIMARY KEY,value BLOB)")
  for (const provider of providers) {
    old.prepare('INSERT INTO entities VALUES(?,?,?)').run('provider', provider.id, JSON.stringify(provider))
    old.prepare('INSERT INTO secrets VALUES(?,?)').run(`provider:${provider.id}`, await secretCodec.encrypt(`secret-${provider.id}`))
  }
  old.close()
  const store = new Store(join(directory, 'v2', 'roundtable.sqlite'), secretCodec); openStores.push(store)
  return { directory, source, store, secretCodec, recovery: new LegacyRecovery(store, source, join(directory, 'backups'), secretCodec) }
}

describe('one-time old model configuration recovery', () => {
  it('cancels an import during shutdown before backup or transaction', async () => {
    const { source, store, directory, secretCodec } = await setup()
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    const recovery = new LegacyRecovery(store, source, join(directory, 'backups'), {
      decrypt: secretCodec.decrypt,
      encrypt: async value => { reached(); await gate; return secretCodec.encrypt(value) },
    })
    const before = readFileSync(source), preview = await recovery.preview()
    const pending = recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: false }] })
    await entered
    recovery.shutdown(); release()
    await expect(pending).rejects.toThrow('未导入配置')
    expect(store.listProviders()).toEqual([])
    expect(readFileSync(source)).toEqual(before)
  })
  it('previews without rewriting old data and imports encrypted keys with an independent backup', async () => {
    const { source, store, recovery } = await setup(), before = readFileSync(source)
    const preview = await recovery.preview()
    expect(preview.entries[0]).toMatchObject({ status: 'available', keyStatus: 'ready', modelIds: ['model-a', 'model-b'] })
    expect(JSON.stringify(preview)).not.toContain('secret-old')
    expect(readFileSync(source)).toEqual(before)
    const result = await recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: false }] })
    expect(result.imported).toBe(1)
    expect(await store.getSecret(`provider:${store.listProviders()[0].id}`)).toBe('secret-old')
    expect(readFileSync(source)).toEqual(before)
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true })
    try { expect(backup.prepare("SELECT count(*) AS n FROM entities WHERE kind='provider'").get()?.n).toBe(0) } finally { backup.close() }
    const again = await recovery.preview()
    expect(again.entries[0].status).toBe('already-imported')
    expect((await recovery.import({ token: again.token, entries: [{ legacyId: 'old', asSeparate: true }] })).imported).toBe(0)
  })
  it('does not combine accounts at the same address or overwrite current credentials', async () => {
    const { store, recovery } = await setup()
    const current = await store.saveProvider({ ...oldProvider(undefined, 'https://api.example.com/v1/'), id: undefined, name: '新版账号', apiKey: 'keep-current-secret' })
    let preview = await recovery.preview()
    expect(preview.entries[0].status).toBe('address-conflict')
    expect((await recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: false }] })).imported).toBe(0)
    preview = await recovery.preview()
    expect((await recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: true }] })).imported).toBe(1)
    expect(store.listProviders()).toHaveLength(2)
    expect(await store.getSecret(`provider:${current.id}`)).toBe('keep-current-secret')
  })
  it('preserves a current record with the same ID', async () => {
    const { store, recovery } = await setup()
    store.saveEntity('provider', 'old', { ...oldProvider(), name: '已编辑版本' })
    const preview = await recovery.preview()
    expect(preview.entries[0].status).toBe('same-id')
    expect((await recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: true }] })).imported).toBe(0)
    expect(store.getProvider('old')?.name).toBe('已编辑版本')
  })
  it('reports unreadable keys without treating the original hasKey flag as a recovered secret', async () => {
    const { source, store, directory } = await setup()
    const recovery = new LegacyRecovery(store, source, join(directory, 'backups'), codec())
    const preview = await recovery.preview()
    expect(preview.entries[0].keyStatus).toBe('unreadable')
    const result = await recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: false }] })
    expect(result.keysNotRecovered).toEqual(['旧模型服务'])
    expect(store.listProviders()[0].hasKey).toBe(false)
  })
  it('rejects changed source data instead of importing a stale preview', async () => {
    const { source, store, recovery } = await setup(), preview = await recovery.preview()
    const old = new DatabaseSync(source)
    old.prepare('UPDATE entities SET payload=?').run(JSON.stringify({ ...oldProvider(), name: '预览后变更' })); old.close()
    await expect(recovery.import({ token: preview.token, entries: [{ legacyId: 'old', asSeparate: false }] })).rejects.toThrow('发生变化')
    expect(store.listProviders()).toHaveLength(0)
  })
  it('reads WAL-backed old data without modifying the database or WAL', async () => {
    const { source, recovery } = await setup(), old = new DatabaseSync(source)
    old.exec('PRAGMA journal_mode=WAL')
    old.prepare('UPDATE entities SET payload=?').run(JSON.stringify({ ...oldProvider(), name: 'WAL 中的更新' }))
    const mainBefore = readFileSync(source), walBefore = readFileSync(`${source}-wal`)
    try {
      const preview = await recovery.preview()
      expect(preview.entries[0].name).toBe('WAL 中的更新')
      expect(readFileSync(source)).toEqual(mainBefore)
      expect(readFileSync(`${source}-wal`)).toEqual(walBefore)
    } finally { old.close() }
  })
  it('leaves missing or unsupported old databases untouched', async () => {
    const { source, store, directory, secretCodec } = await setup()
    expect((await new LegacyRecovery(store, join(directory, 'missing.sqlite'), directory, secretCodec).preview()).found).toBe(false)
    const old = new DatabaseSync(source); old.exec("UPDATE meta SET value='999'"); old.close()
    const before = readFileSync(source)
    await expect(new LegacyRecovery(store, source, directory, secretCodec).preview()).rejects.toThrow('恢复范围')
    expect(readFileSync(source)).toEqual(before)
  })
})
