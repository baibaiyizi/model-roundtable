// Explicit integration check using an isolated copy of local encrypted provider rows.
// Never prints keys, service addresses, prompts, or full model responses.
import { _electron as electron, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!process.argv.includes('--from-local-profile')) throw new Error('此检查会发起真实模型调用；显式传入 --from-local-profile 才运行。')
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const plannerId = option('--planner'), participantIds = option('--participants')?.split(',').filter(Boolean)
if (!plannerId || participantIds?.length !== 2) throw new Error('请指定已保存的模型：--planner <模型ID> --participants <模型ID1>,<模型ID2>；三者须属于同一服务。')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = new DatabaseSync(join(process.env.APPDATA, 'model-roundtable/v2/roundtable.sqlite'), { readOnly: true })
const providers = source.prepare("SELECT id,payload FROM entities WHERE kind='provider'").all()
const provider = providers.map(row => JSON.parse(row.payload)).find(p => [plannerId, ...participantIds].every(id => p.modelIds.includes(id)) && (!option('--provider') || p.id === option('--provider')))
if (!provider) { source.close(); throw new Error('验收所需的已配置模型不存在，未发出请求。') }
const secret = source.prepare('SELECT value FROM secrets WHERE id=?').get(`provider:${provider.id}`)?.value
source.close()
if (!secret) throw new Error('所选服务没有已保存密钥，未发出请求。')
const directory = join(root, '.test-data', `live-models-${Date.now()}`); await mkdir(directory, { recursive: true })
await copyFile(join(process.env.APPDATA, 'model-roundtable/v2/Local State'), join(directory, 'Local State'))
const db = new DatabaseSync(join(directory, 'roundtable.sqlite'))
db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE entities(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id)); CREATE TABLE secrets(id TEXT PRIMARY KEY,value BLOB); INSERT INTO meta VALUES('schema_version','2');")
db.prepare('INSERT INTO entities VALUES(?,?,?)').run('provider', provider.id, JSON.stringify({ ...provider, structuredOutputs: undefined }))
db.prepare('INSERT INTO secrets VALUES(?,?)').run(`provider:${provider.id}`, secret); db.close()
const executable = process.env.ROUNDTABLE_EXECUTABLE ?? join(root, `release/.staging/${version}/win-unpacked/模型圆桌.exe`)
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'))
const desktop = await electron.launch({ executablePath: executable, args: [], cwd: dirname(executable), env: { ...env, NODE_PATH: '', MODEL_ROUNDTABLE_DATA_DIR: directory, MODEL_ROUNDTABLE_TEST: '1' }, timeout: 30000 })
try {
  const page = await desktop.firstWindow(); await page.waitForLoadState('domcontentloaded')
  const participants = participantIds.map((modelId, index) => ({ id: `seat-${index}`, name: `参会者${index + 1}`, role: '请用100字以内作答，明确回应可见的其他成员观点。', model: { providerId: provider.id, modelId } }))
  const limits = { maxCalls: 1, maxOutputTokens: 1500, autoTurns: 12, maxSearches: 1, contextChars: 24000 }
  const input = { title: `${version} 搜索规划真实验收`, topic: '只做离线逻辑题，不需要外部事实或搜索：1+1是否等于2？', mode: 'roundtable', participants, moderator: { providerId: provider.id, modelId: plannerId }, knowledgeBaseIds: [], searchEnabled: true, limits }
  const planning = await page.evaluate(input => window.roundtable.createSession(input), input)
  await expect.poll(() => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.status, planning.id), { timeout: 180000, intervals: [500, 1000] }).not.toBe('running')
  const planned = await page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id), planning.id)
  const message = planned.messages.find(m => m.phase === 'search')
  expect(message?.status, planned.run.error).toBe('complete')
  console.log('真实模型搜索规划解析通过。')
  const discussion = await page.evaluate(input => window.roundtable.createSession(input), { ...input, title: '0.3.0 双模型真实验收', topic: '讨论给初学者解释 TypeScript 的建议：先讲静态类型还是先运行小例子？先独立回答，再明确回应对方。每次100字以内。', moderator: undefined, searchEnabled: false, limits: { ...limits, maxCalls: 4, maxOutputTokens: 2048 } })
  await expect.poll(() => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.status, discussion.id), { timeout: 300000, intervals: [500, 1000] }).not.toBe('running')
  const completed = await page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id), discussion.id)
  expect(completed.status, completed.run.error).toBe('complete')
  expect(completed.messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(4)
  const report = { version, passed: true, calls: planned.run.calls + completed.run.calls, models: [plannerId, ...participantIds], planning: { status: message.status, finishReason: message.diagnostic?.finishReason, normalizations: message.diagnostic?.normalizations ?? [], rawChars: message.content.length }, discussion: { status: completed.status, phases: completed.messages.filter(m => m.kind === 'assistant').map(m => m.phase), usage: completed.messages.filter(m => m.usage).map(m => m.usage) }, profile: directory }
  await writeFile(join(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
} finally { await desktop.close() }
