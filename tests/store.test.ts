import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { Store, type SecretCodec } from '../src/main/store'
import { DEFAULT_LIMITS, type Session } from '../src/shared/types'
import { exportMarkdown } from '../src/main/export'

function codec(): SecretCodec {
  const key = randomBytes(32)
  return {
    async encrypt(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm',key,iv); const data = Buffer.concat([c.update(value,'utf8'),c.final()]); return Buffer.concat([iv,c.getAuthTag(),data]) },
    async decrypt(value) { const b = Buffer.from(value); const c = createDecipheriv('aes-256-gcm',key,b.subarray(0,12)); c.setAuthTag(b.subarray(12,28)); return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString('utf8') }
  }
}
function fixture(): Session {
  return { id: 'session', title: '中文历史', topic: '讨论题', mode: 'roundtable', participants: [], moderator: { providerId: 'p', modelId: 'chair' }, knowledgeBaseIds: [], searchEnabled: false, limits: DEFAULT_LIMITS, createdAt: '2026-09-23', updatedAt: '2026-09-23', status: 'running', evidence: [], messages: [{ id: 'm', sessionId: 'session', runId: 'r', turnId: 't', contextVersion: 1, speakerId: 'p', speakerName: '分析者', kind: 'assistant', phase: 'opening', content: '保留已生成内容', status: 'streaming', createdAt: '2026-09-23' }], run: { id: 'r', contextVersion: 1, cursor: 0, steps: [], calls: 1, searches: 0, autoTurns: 0, pauseRequested: false, phase: 'opening', searchPhases: [] } }
}
describe('local persistence', () => {
  it('stores Claude service keys encrypted and does not reuse a key across backend types', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'roundtable-claude-key-')); const filename = join(dir, 'data.sqlite'); const c = codec()
    let store: Store | undefined
    try {
      store = new Store(filename, c)
      const input = { kind: 'claude' as const, claudeAuth: 'apiKey' as const, name: 'Claude Key', baseUrl: '', modelIds: ['sonnet'], tokenParameter: 'max_tokens' as const, streamUsage: false, timeoutMs: 60000 }
      const provider = await store.saveProvider({ ...input, apiKey: 'qa-claude-secret' })
      expect(provider.hasKey).toBe(true)
      expect(JSON.stringify(store.listProviders())).not.toContain('qa-claude-secret')
      store.close(); store = undefined
      expect(readFileSync(filename).includes(Buffer.from('qa-claude-secret'))).toBe(false)
      store = new Store(filename, c)
      expect(store.getProvider(provider.id)?.claudeAuth).toBe('apiKey')
      expect(await store.getSecret(`provider:${provider.id}`)).toBe('qa-claude-secret')
      await store.saveProvider({ ...input, id: provider.id, apiKey: '' })
      expect(store.getProvider(provider.id)).toMatchObject({ claudeAuth: 'apiKey', hasKey: false })
      const apiProvider = await store.saveProvider({ ...input, kind: 'api', claudeAuth: undefined, baseUrl: 'https://api.example.com', apiKey: 'another-service-key' })
      await store.saveProvider({ ...input, id: apiProvider.id })
      expect(await store.getSecret(`provider:${apiProvider.id}`)).toBe('')
    } finally { store?.close(); if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true }) }
  })
  it('protects secrets and recovers unfinished work without reissuing requests', async () => {
    const dir = mkdtempSync(join(tmpdir(),'roundtable-store-')); const filename = join(dir,'中文.sqlite'); const c = codec()
    try {
      let store = new Store(filename,c)
      const provider = await store.saveProvider({ name: '私有服务', baseUrl: 'http://localhost:9000/v1', apiKey: 'private-secret-example', modelIds: ['test'], tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 60000 })
      expect(JSON.stringify(store.listProviders())).not.toContain('private-secret-example')
      expect(await store.getSecret(`provider:${provider.id}`)).toBe('private-secret-example')
      store.saveSession(fixture())
      store.saveSource({ id: 's', title: '导入中', knowledgeBaseId: 'k', status: 'processing', progress: '处理中', createdAt: '', chunkCount: 0 })
      store.close()
      expect(readFileSync(filename).includes(Buffer.from('private-secret-example'))).toBe(false)
      store = new Store(filename,c)
      const session = store.getSession('session')!
      expect(session.status).toBe('paused')
      expect(session.messages[0].status).toBe('interrupted')
      expect(session.messages[0].content).toBe('保留已生成内容')
      expect(store.getSource('s')?.status).toBe('failed')
      expect(exportMarkdown(session)).toContain('保留已生成内容')
      store.close()
    } finally { if (resolve(dir).startsWith(resolve(tmpdir())+sep)) rmSync(dir,{recursive:true,force:true}) }
  })
  it('refuses unknown data versions without rewriting records', () => {
    const dir = mkdtempSync(join(tmpdir(),'roundtable-version-')); const filename = join(dir,'data.sqlite')
    try {
      const raw = new DatabaseSync(filename); raw.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','999')"); raw.close()
      expect(() => new Store(filename,codec())).toThrow('数据版本')
      const inspect = new DatabaseSync(filename); expect(inspect.prepare('SELECT value FROM meta').get()?.value).toBe('999'); inspect.close()
    } finally { if (resolve(dir).startsWith(resolve(tmpdir())+sep)) rmSync(dir,{recursive:true,force:true}) }
  })
})
