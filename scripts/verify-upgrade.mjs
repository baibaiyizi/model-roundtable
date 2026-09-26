import { _electron as electron, expect } from '@playwright/test'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rmdir, stat, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version, build: packaging } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (process.platform !== 'win32' || packaging.appId !== 'org.modelroundtable.desktop' || packaging.nsis.perMachine !== false || packaging.nsis.deleteAppDataOnUninstall !== false) throw new Error('验收要求固定应用标识、Windows 按用户安装并保留数据')
const fromVersion = process.env.ROUNDTABLE_UPGRADE_FROM ?? '0.6.2'
if (!/^\d+\.\d+\.\d+$/.test(fromVersion)) throw new Error('升级起始版本无效')
const oldInstaller = process.env.ROUNDTABLE_UPGRADE_INSTALLER
if (!oldInstaller || !isAbsolute(oldInstaller)) throw new Error('请通过 ROUNDTABLE_UPGRADE_INSTALLER 指定归档旧安装包的绝对路径')
const newInstaller = join(root, `release/.staging/${version}/Model-Roundtable-${version}-win-x64.exe`)
for (const path of [oldInstaller, newInstaller]) if (!(await stat(path)).isFile()) throw new Error('验收安装包必须是文件')
const directory = join(root, '.test-data', `upgrade-${Date.now()}`)
const profile = join(directory, 'model-roundtable', 'v2')
const installDirectory = await mkdtemp(join(tmpdir(), 'model-roundtable-upgrade-'))
await mkdir(directory, { recursive: true })
const helper = join(directory, 'mock.mjs')
await build({ entryPoints: [join(root, 'tests/helpers/mock-api.ts')], outfile: helper, bundle: true, platform: 'node', format: 'esm' })
const { startMockAPI } = await import(pathToFileURL(helper).href)
const mock = await startMockAPI()
const run = (executable, args, overrides = {}) => new Promise((resolvePromise, reject) => {
  let detail = ''
  // Windows PowerShell must locate its own modules instead of inheriting a
  // PowerShell 7 module path from the shell that launched Node.
  const env = Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  const child = spawn(executable, args, { env, cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => { detail = (detail + chunk.toString()).slice(-16000) })
  child.once('error', reject); child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`${basename(executable)} 退出 ${code}${detail ? `\n${detail}` : ''}`)))
})
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'))
const shellState = mode => run(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/upgrade-shell-state.ps1'), '-Mode', mode, '-BackupRoot', join(directory, 'shell-backup'), '-InstallDirectory', installDirectory])
const install = async installer => { await shellState('Verify'); await run(installer, ['/S', '/currentuser', '--updated', `/D=${installDirectory}`]) }
let desktop
let shellBackedUp = false
let report
let failure
const cleanupFailures = []
const launch = async () => {
  desktop = await electron.launch({ executablePath: join(installDirectory, '模型圆桌.exe'), args: [], cwd: installDirectory, env: { ...environment, NODE_PATH: '', MODEL_ROUNDTABLE_DATA_DIR: profile, MODEL_ROUNDTABLE_TEST: '1', MODEL_ROUNDTABLE_COMPONENTS_DIR: join(root, '.cache/components-runtime') }, timeout: 30000 })
  const page = await desktop.firstWindow(); await page.waitForLoadState('domcontentloaded')
  await expect.poll(() => page.evaluate(() => window.roundtable.bootstrap().then(data => data.version))).toBeTruthy()
  return page
}
const checksum = async path => createHash('sha256').update(await readFile(path)).digest('hex')
try {
  await shellState('Snapshot'); shellBackedUp = true
  await shellState('Detach')
  console.log('旧版本临时安装与测试资料准备')
  await install(oldInstaller)
  let page = await launch()
  expect((await page.evaluate(() => window.roundtable.bootstrap())).version).toBe(fromVersion)
  const projectPath = join(directory, '中文 项目'); await mkdir(projectPath); await writeFile(join(projectPath, '保留.md'), '项目文件不随覆盖安装改变。')
  const data = await page.evaluate(async ({ url, directory }) => {
    const api = window.roundtable
    const provider = await api.saveProvider({ name: '升级验收模型', baseUrl: `${url}/v1`, apiKey: 'upgrade-fixture-secret', modelIds: ['analyst', 'critic', 'embedding', 'slow'], tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 30000 })
    const project = await api.saveProject({ name: '升级验收项目', directory, instructions: '保留项目、草稿与资料', knowledgeBaseIds: [] })
    const kb = await api.createKnowledgeBase({ name: '升级知识库', embedding: { providerId: provider.id, modelId: 'embedding' } })
    await api.saveDraft({ id: project.id, text: '数据库中的未发送草稿' })
    localStorage.setItem('upgrade-draft', '界面草稿')
    const execution = await api.createExecution({ projectId: project.id, task: '待执行任务，不自动执行', acceptance: '明确启动后才运行', executor: { providerId: provider.id, modelId: 'analyst' }, reviewers: [], maxCalls: 10, maxOutputTokens: 500, timeoutMs: 30000, maxRepairRounds: 0 })
    return { provider, project, kb, execution }
  }, { url: mock.url, directory: projectPath })
  const original = join(directory, '中文能源资料.txt'); await writeFile(original, '太阳能和储能可以平衡能源供需。')
  await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, original)
  await page.evaluate(async kbId => { const filePaths = await window.roundtable.selectFiles(); await window.roundtable.importSources({ knowledgeBaseId: kbId, filePaths }) }, data.kb.id)
  await expect.poll(() => page.evaluate(async () => (await window.roundtable.bootstrap()).sources[0]?.status), { timeout: 30000 }).toBe('ready')
  const config = { projectId: data.project.id, topic: '用共同资料讨论能源', mode: 'roundtable', participants: ['analyst', 'critic'].map((id, i) => ({ id, name: `成员${i}`, role: '', model: { providerId: data.provider.id, modelId: id } })), knowledgeBaseIds: [data.kb.id], searchEnabled: false, limits: { autoTurns: 12, maxCalls: 30, maxOutputTokens: 500, maxSearches: 5, contextChars: 48000 } }
  const session = await page.evaluate(input => window.roundtable.createSession(input), config)
  await expect.poll(() => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.status, session.id), { timeout: 30000 }).toBe('complete')
  const before = await page.evaluate(() => window.roundtable.bootstrap())
  expect(before.sessions[0].evidence.length).toBeGreaterThan(0)
  const subscription = await page.evaluate(async () => {
    const state = await window.roundtable.importNetworkSubscription({ name: '覆盖安装保留订阅', content: 'proxies:\n  - name: 固定节点\n    type: http\n    server: 127.0.0.1\n    port: 19878\n    password: synthetic-upgrade-node-secret\n' })
    const saved = state.subscriptions[0]
    await window.roundtable.saveNetworkBindings({ catalog: { mode: 'subscription', subscriptionId: saved.id, nodeId: saved.nodes[0].id } })
    return saved
  })
  await page.evaluate(() => window.roundtable.editorEnable(true))
  let descriptor = JSON.parse(await readFile(join(profile, 'editor-bridge.json'), 'utf8'))
  expect(descriptor.protocol).toBe(2)
  const bridgeRequest = async (path, body, token) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    expect(response.ok).toBe(true)
    return response.json()
  }
  const connection = { id: randomUUID(), claim: randomBytes(32).toString('base64url'), name: '覆盖安装 VS Code' }
  expect(await bridgeRequest('/connections', connection)).toMatchObject({ status: 'pending' })
  await page.evaluate(requestId => window.roundtable.editorResolveConnection({ requestId, allow: true }), connection.id)
  const client = await bridgeRequest(`/connections/${connection.id}`, { claim: connection.claim })
  expect(client.status).toBe('approved')
  expect(client.token).toBeTruthy()
  const transferId = randomUUID()
  await bridgeRequest('/transfers', { id: transferId, kind: 'text', text: { path: '保留.md', filePath: join(projectPath, '保留.md'), content: '未保存缓冲区也必须保留。', startLine: 1, endLine: 1, language: 'markdown', dirty: true, capturedAt: new Date().toISOString() } }, client.token)
  await writeFile(join(projectPath, '保留.csv'), '项目,说明\n太阳能,旧文件引用可以继续导入\n')
  const fileTransferId = randomUUID()
  await bridgeRequest('/transfers', { id: fileTransferId, kind: 'files', files: [join(projectPath, '保留.csv')] }, client.token)
  await page.evaluate(() => localStorage.setItem('roundtable.section.settings.editor', 'open'))
  const editorBefore = await page.evaluate(() => window.roundtable.editorState())
  const verifyEditorRetention = async () => {
    descriptor = JSON.parse(await readFile(join(profile, 'editor-bridge.json'), 'utf8'))
    expect(descriptor.protocol).toBe(2)
    const editorAfter = await page.evaluate(() => window.roundtable.editorState())
    expect(editorAfter.running).toBe(true)
    expect(editorAfter.clients).toEqual(editorBefore.clients.map(({ id, name, createdAt }) => ({ id, name, createdAt })))
    expect(editorAfter.transfers).toEqual(editorBefore.transfers)
    expect(editorAfter.transfers.find(t => t.id === transferId)).toMatchObject({ status: 'pending', text: { dirty: true, content: '未保存缓冲区也必须保留。' } })
    expect(await bridgeRequest('/connection', undefined, client.token)).toMatchObject({ clientId: client.clientId })
    expect(await page.evaluate(() => localStorage.getItem('roundtable.section.settings.editor'))).toBe('open')
    await expect(page.getByRole('button', { name: /VS Code 资料/ })).toHaveText(/VS Code 资料\s*2/)
  }
  const release = mock.holdSlowStreams()
  await page.evaluate(input => window.roundtable.createSession(input), { ...config, topic: '升级前未完成的讨论', knowledgeBaseIds: [], participants: config.participants.map(p => ({ ...p, model: { ...p.model, modelId: 'slow' } })) })
  await expect.poll(() => mock.calls.filter(c => c.body.model === 'slow').length).toBe(1)
  await page.evaluate(() => window.roundtable.editorEnable(false))
  await desktop.close(); desktop = undefined; release()
  const markerFiles = ['accounts/codex/qa-profile.txt', 'document-jobs/qa-backup/before.docx', 'executions/qa-log/journal.json']
  for (const name of markerFiles) { const path = join(profile, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `保留数据 ${name}`) }
  const markers = await Promise.all(markerFiles.map(name => checksum(join(profile, name))))
  const sourceHash = await checksum(before.sources[0].originalPath)
  const callsBefore = mock.calls.length
  console.log('覆盖升级与数据、令牌、线路、真实向量保留检查')
  await install(newInstaller)
  page = await launch()
  const after = await page.evaluate(() => window.roundtable.bootstrap())
  expect(after.version).toBe(version)
  expect((await page.evaluate(() => window.roundtable.editorState())).enabled).toBe(false)
  await page.evaluate(() => window.roundtable.editorEnable(true))
  await verifyEditorRetention()
  expect(mock.calls.length).toBe(callsBefore)
  expect(after.providers).toEqual(before.providers)
  expect(after.sources).toEqual(before.sources)
  expect(after.sessions.find(s => s.id === session.id)).toEqual(before.sessions[0])
  expect(after.sessions.find(s => s.topic === '升级前未完成的讨论').status).toBe('paused')
  expect(after.executions[0].status).toBe('ready')
  expect(after.executions[0].web).toBeUndefined()
  expect(after.sessions.find(s => s.id === session.id).limits.maxSearches).toBe(5)
  const upgradedNetwork = await page.evaluate(() => window.roundtable.getNetworkState())
  expect(upgradedNetwork.subscriptions[0]).toEqual(subscription)
  expect(upgradedNetwork.bindings.catalog).toEqual({ mode: 'subscription', subscriptionId: subscription.id, nodeId: subscription.nodes[0].id })
  expect(await page.evaluate(id => window.roundtable.getDraft(id), data.project.id)).toBe('数据库中的未发送草稿')
  expect(await page.evaluate(() => localStorage.getItem('upgrade-draft'))).toBe('界面草稿')
  expect(await checksum(after.sources[0].originalPath)).toBe(sourceHash)
  expect(await Promise.all(markerFiles.map(name => checksum(join(profile, name))))).toEqual(markers)
  expect(await readFile(join(projectPath, '保留.md'), 'utf8')).toContain('不随覆盖安装改变')
  await page.evaluate(model => window.roundtable.testModel(model), { providerId: data.provider.id, modelId: 'analyst' })
  expect(mock.calls.at(-1).authorization).toBe('Bearer upgrade-fixture-secret')
  const evidence = await page.evaluate(id => window.roundtable.searchKnowledge({ knowledgeBaseIds: [id], query: '光伏能源供需' }), data.kb.id)
  expect(evidence[0].text).toContain('太阳能')
  const callsBeforeReinstall = mock.calls.length
  await desktop.close(); desktop = undefined
  console.log('同版重新安装与显式接收资料检查')
  await install(newInstaller)
  page = await launch()
  const restoredNetwork = await page.evaluate(() => window.roundtable.getNetworkState())
  expect(restoredNetwork.subscriptions[0]).toEqual(subscription)
  expect(restoredNetwork.bindings.catalog).toEqual({ mode: 'subscription', subscriptionId: subscription.id, nodeId: subscription.nodes[0].id })
  expect(restoredNetwork.core.phase).toBe('stopped')
  expect((await page.evaluate(() => window.roundtable.bootstrap())).providers).toEqual(after.providers)
  await verifyEditorRetention()
  expect(mock.calls.length).toBe(callsBeforeReinstall)
  await page.evaluate(async ({ transferId, knowledgeBaseId }) => { await window.roundtable.editorImport({ transferId, knowledgeBaseId }) }, { transferId: fileTransferId, knowledgeBaseId: data.kb.id })
  await expect.poll(() => page.evaluate(async () => (await window.roundtable.bootstrap()).sources.filter(source => source.status === 'ready').length), { timeout: 30000 }).toBe(2)
  const callsAfterExplicitImport = mock.calls.length
  await page.getByRole('button', { name: /VS Code 资料/ }).click()
  await page.getByRole('dialog', { name: '来自 VS Code 的资料' }).locator('.editor-transfer').filter({ hasText: '未保存缓冲区也必须保留。' }).getByRole('button', { name: '追加到草稿', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '开启一次新讨论', exact: true }).locator('textarea').first()).toContainText('未保存缓冲区也必须保留。')
  expect(mock.calls.length).toBe(callsAfterExplicitImport)
  expect(await page.evaluate(() => window.roundtable.getDraft('discussion-new.independent'))).toContain('未保存缓冲区也必须保留。')
  await desktop.close(); desktop = undefined
  const database = new DatabaseSync(join(profile, 'roundtable.sqlite'), { readOnly: true })
  expect(database.prepare('SELECT count(*) AS n FROM secrets').get().n).toBe(3); database.close()
  report = { from: fromVersion, to: version, passed: true, installers: { before: await checksum(oldInstaller), after: await checksum(newInstaller) }, data: ['encrypted-model-key', 'discussion-and-citations', 'originals-and-real-vector-retrieval', 'database-and-renderer-drafts', 'account-profile-markers', 'document-backups', 'execution-records', 'project-files', 'no-replay-on-restart', 'subscription-and-route-after-upgrade-and-reinstallation', 'saved-search-limits-and-old-execution-default-retained', 'protocol-2-editor-token-and-pending-dirty-snapshot-after-upgrade-and-reinstallation', 'explicit-editor-disable-retained', 'confirmed-file-snapshot-imported-after-upgrade', 'pending-text-received-into-independent-draft-without-model-call', 'collapse-preferences-after-upgrade-and-reinstallation'], authenticatedAccountsTested: false }
  if (process.env.ROUNDTABLE_UPGRADE_E2E === '1') {
    console.log('覆盖升级检查通过，开始临时安装版完整桌面测试')
    const output = join(directory, 'installed-playwright.json')
    await run(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=json'], { ROUNDTABLE_EXECUTABLE: join(installDirectory, '模型圆桌.exe'), PLAYWRIGHT_JSON_OUTPUT_FILE: output })
    const { stats } = JSON.parse(await readFile(output, 'utf8'))
    expect(stats.unexpected).toBe(0)
    expect(stats.expected).toBeGreaterThan(0)
    report.installedDesktopTests = { passed: stats.expected, failed: stats.unexpected, flaky: stats.flaky, skipped: stats.skipped }
  }
} catch (error) { failure = error }
finally {
  try { await desktop?.close() } catch (error) { cleanupFailures.push(error) }
  try { await mock.close() } catch (error) { cleanupFailures.push(error) }
  try {
    const uninstaller = join(installDirectory, 'Uninstall 模型圆桌.exe')
    const exists = await stat(uninstaller).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (exists) {
      await shellState('Verify')
      // Use NSIS's synchronous _?= form, also used by electron-builder's own
      // upgrade helper. Otherwise its detached self-copy may outlive run().
      const cleanupUninstaller = join(directory, 'shell-backup', 'qa-uninstaller.exe')
      await copyFile(uninstaller, cleanupUninstaller)
      expect(await checksum(cleanupUninstaller)).toBe(await checksum(uninstaller))
      // Keep shell identities/pins until the backed-up shortcuts are restored.
      await run(cleanupUninstaller, ['/S', '/currentuser', '/KEEP_APP_DATA', '--keep-shortcuts', `_?=${installDirectory}`])
      const deadline = Date.now() + 45000
      while (Date.now() < deadline && await stat(installDirectory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })) await new Promise(resolve => setTimeout(resolve, 300))
      if (await stat(installDirectory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })) throw new Error('临时安装尚未卸载完成，需要检查验收目录')
    } else if ((await readdir(installDirectory)).length === 0) await rmdir(installDirectory)
    else throw new Error('临时安装不完整且缺少卸载器，已保留文件供检查')
  } catch (error) { cleanupFailures.push(error) }
  try { if (shellBackedUp) await shellState('Restore') } catch (error) { cleanupFailures.push(error) }
}
const result = { ...(report ?? { from: fromVersion, to: version }), passed: !failure && cleanupFailures.length === 0, shellIntegrationRestored: shellBackedUp && cleanupFailures.length === 0, temporaryInstallationRemoved: cleanupFailures.length === 0, failureCount: Number(!!failure) + cleanupFailures.length }
await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
console.log(`本机验收记录：${relative(root, join(directory, 'result.json'))}`)
if (failure || cleanupFailures.length) throw new AggregateError([failure, ...cleanupFailures].filter(Boolean), '覆盖升级验收未通过；本机日志包含具体原因')
