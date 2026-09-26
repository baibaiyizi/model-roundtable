import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { LegacyKeyDecryptor } from '../../src/main/legacy-key-helper'

async function seedProfile(profile: string, values: string[]): Promise<Buffer[]> {
  await mkdir(profile, { recursive: true })
  const seed = join(dirname(profile), 'seed.cjs')
  await writeFile(seed, `const {app,safeStorage}=require('electron'); app.setPath('userData',process.argv[2]);app.setPath('sessionData',process.argv[2]);app.disableHardwareAcceleration();app.whenReady().then(()=>{ process.on('message',message=>{const values=message.map(value=>safeStorage.encryptString(value).toString('base64'));process.send({values},()=>app.quit())});process.send({ready:true})});`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const executable = createRequire(join(resolve('.'), 'package.json'))('electron') as string
  const child = spawn(executable, [seed, profile], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let encrypted: Buffer[] = []
  child.on('message', raw => { const message = raw as { ready?: boolean; values?: string[] }; if (message.ready) child.send(values); if (message.values) encrypted = message.values.map(value => Buffer.from(value, 'base64')) })
  const timeout = setTimeout(() => child.kill(), 15000)
  const code = await new Promise<number | null>((done, fail) => { child.once('close', done); child.once('error', fail) }); clearTimeout(timeout)
  expect(code).toBe(0); expect(encrypted).toHaveLength(values.length)
  return encrypted
}

test('real Electron decrypts legacy credentials with an isolated Local State copy and removes its helper profile', async () => {
  test.skip(process.platform !== 'win32', 'Windows DPAPI profile-key regression')
  const root = resolve('.')
  const directory = join(root, '.test-data', `recovery-keys-${Date.now()}`)
  const legacy = join(directory, 'legacy'), unrelated = join(directory, 'unrelated'), temporary = join(directory, 'temporary')
  await Promise.all([legacy, unrelated, temporary].map(path => mkdir(path, { recursive: true })))
  const electronPath = createRequire(join(root, 'package.json'))('electron') as string
  const values = [`synthetic-legacy-${randomUUID()}`, `synthetic-secondary-${randomUUID()}`]
  const encrypted = await seedProfile(legacy, values)
  await seedProfile(unrelated, ['synthetic-unrelated'])
  const digest = async (profile: string) => createHash('sha256').update(await readFile(join(profile, 'Local State'))).digest('hex')
  const before = await digest(legacy)
  const options = { tempRoot: temporary, executablePath: process.env.ROUNDTABLE_EXECUTABLE ?? electronPath, appPath: root, packaged: Boolean(process.env.ROUNDTABLE_EXECUTABLE) }
  const correct = new LegacyKeyDecryptor({ ...options, sourceProfile: legacy })
  try {
    expect(await Promise.all(encrypted.map(value => correct.decrypt(value)))).toEqual(values)
    expect((await readdir(temporary)).length).toBe(1)
    await expect(correct.decrypt(Buffer.from('not-a-valid-cipher'))).rejects.toThrow('旧密钥无法解密')
  } finally { await correct.close() }
  expect(await readdir(temporary)).toEqual([])
  expect(await digest(legacy)).toBe(before)

  const wrong = new LegacyKeyDecryptor({ ...options, sourceProfile: unrelated })
  try { await expect(wrong.decrypt(encrypted[0])).rejects.toThrow('旧密钥无法解密') } finally { await wrong.close() }
  expect(await readdir(temporary)).toEqual([])
  const missing = new LegacyKeyDecryptor({ ...options, sourceProfile: join(directory, 'missing') })
  try { await expect(missing.decrypt(encrypted[0])).rejects.toThrow('旧配置的密钥保护状态') } finally { await missing.close() }
  const cancelled = new LegacyKeyDecryptor({ ...options, sourceProfile: legacy })
  const pending = cancelled.decrypt(encrypted[0]); const rejection = expect(pending).rejects.toThrow()
  await cancelled.close(); await rejection
  expect(await readdir(temporary)).toEqual([])
  expect(await digest(legacy)).toBe(before)
})

test('old model recovery previews genuine encrypted keys, imports explicitly and reconnects after restart without overwriting current credentials', async () => {
  test.skip(process.platform !== 'win32', 'Windows DPAPI profile-key regression')
  const root = resolve('.'), directory = join(root, '.test-data', `recovery-ui-${Date.now()}`), oldProfile = join(directory, 'profile'), newProfile = join(oldProfile, 'v2')
  const legacySecret = `synthetic-old-${randomUUID()}`, currentSecret = `synthetic-current-${randomUUID()}`
  const [encrypted] = await seedProfile(oldProfile, [legacySecret])
  const calls: Array<{ path: string; authorized: boolean }> = []
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text), old = req.url?.startsWith('/legacy/')
    const authorized = req.headers.authorization === `Bearer ${old ? legacySecret : currentSecret}`
    calls.push({ path: req.url ?? '', authorized })
    if (!authorized) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'controlled credentials rejected' } })); return }
    if (body.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ id: 'recovery-test', choices: [{ index: 0, delta: { content: '连接成功' }, finish_reason: null }] })}\n\n`); res.end(`data: ${JSON.stringify({ id: 'recovery-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'recovery-test', choices: [{ index: 0, message: { role: 'assistant', content: '连接成功' }, finish_reason: 'stop' }] })) }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const oldDatabase = join(oldProfile, 'roundtable.sqlite')
  const old = new DatabaseSync(oldDatabase)
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','1'); CREATE TABLE entities(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id)); CREATE TABLE secrets(id TEXT PRIMARY KEY,value BLOB)")
  old.prepare('INSERT INTO entities VALUES(?,?,?)').run('provider', 'legacy-provider', JSON.stringify({ id: 'legacy-provider', name: '原来的模型服务', baseUrl: `${url}/legacy/v1`, modelIds: ['legacy-model'], tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 10000, hasKey: true }))
  old.prepare('INSERT INTO secrets VALUES(?,?)').run('provider:legacy-provider', encrypted); old.close()
  const hashes = async () => Promise.all([oldDatabase, join(oldProfile, 'Local State')].map(async file => createHash('sha256').update(await readFile(file)).digest('hex')))
  const before = await hashes()
  let desktop: ElectronApplication | undefined
  const launch = async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined && item[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: newProfile, MODEL_ROUNDTABLE_TEST: '1' } })
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); await expect(page.locator('.welcome-page')).toBeVisible(); return page
  }
  try {
    let page = await launch()
    const current = await page.evaluate(async input => window.roundtable.saveProvider({ name: '当前模型服务', baseUrl: `${input.url}/current/v1`, modelIds: ['current-model'], apiKey: input.key, tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 10000 }), { url, key: currentSecret })
    await page.getByRole('button', { name: '模型与设置', exact: true }).click()
    await page.getByRole('button', { name: '检查旧模型配置', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('密钥可恢复，会重新加密保存')
    await expect(page.getByRole('dialog').getByRole('checkbox', { name: '恢复 原来的模型服务', exact: true })).toBeChecked()
    expect((await page.evaluate(() => window.roundtable.bootstrap())).providers).toHaveLength(1)
    await page.getByRole('button', { name: '恢复所选 1 项', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('恢复 1 个服务')
    await expect(page.getByRole('dialog')).not.toContainText('旧密钥无法解密')
    await page.getByRole('button', { name: '完成', exact: true }).click()
    const restored = (await page.evaluate(() => window.roundtable.bootstrap())).providers.find(provider => provider.name === '原来的模型服务')!
    expect(restored.hasKey).toBe(true); expect(restored.id).not.toBe(current.id)
    await desktop!.close(); desktop = undefined
    page = await launch()
    expect(await page.evaluate(async ids => (await Promise.all(ids.map(model => window.roundtable.testModel(model)))).map(result => result.text), [{ providerId: restored.id, modelId: 'legacy-model' }, { providerId: current.id, modelId: 'current-model' }])).toEqual(['连接成功', '连接成功'])
    expect(calls).toHaveLength(2)
    expect(calls).toEqual(expect.arrayContaining([{ path: '/legacy/v1/chat/completions', authorized: true }, { path: '/current/v1/chat/completions', authorized: true }]))
    expect(await hashes()).toEqual(before)
    const saved = new DatabaseSync(join(newProfile, 'roundtable.sqlite'), { readOnly: true })
    try { const bytes = saved.prepare('SELECT value FROM secrets WHERE id=?').get(`provider:${restored.id}`)?.value as Uint8Array; expect(Buffer.from(bytes).equals(encrypted)).toBe(false) } finally { saved.close() }
  } finally { await desktop?.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())) }
  expect(await hashes()).toEqual(before)
})
