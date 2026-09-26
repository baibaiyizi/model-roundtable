import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { startMockAPI } from '../helpers/mock-api'
import { componentTestEnv } from '../helpers/components'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('desktop onboarding, discussion, isolated import worker and persisted history', async () => {
  const root = resolve('.')
  const testDir = join(root, '.test-data', `desktop-${Date.now()}`)
  await mkdir(testDir, { recursive: true })
  const mock = await startMockAPI()
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  const launch = async (): Promise<Page> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, ...componentTestEnv, MODEL_ROUNDTABLE_DATA_DIR: join(testDir, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    desktop.process().stderr?.on('data', buffer => { const line = String(buffer); if (/Error|failed|Cannot/i.test(line)) console.log(line) })
    const page = await desktop.firstWindow()
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByRole('button', { name: '连接我的模型' })).toBeVisible({ timeout: 15000 })
    return page
  }
  try {
    let page = await launch()
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '01-welcome.png') })
    await page.getByRole('button', { name: '连接我的模型' }).click()
    await page.getByRole('button', { name: '添加模型服务', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '全部展开', exact: true }).click()
    await page.getByLabel('服务名称', { exact: true }).fill('本机验收服务')
    await page.getByLabel('API 地址', { exact: true }).fill(`${mock.url}/v1`)
    await page.getByLabel('API 密钥', { exact: true }).fill('test-desktop-secret')
    await page.getByRole('button', { name: '保存并获取模型' }).click()
    for (const id of ['analyst','critic','chair','embedding','vision','transcribe']) await page.getByRole('checkbox', { name: id, exact: true }).check()
    await page.getByLabel('选择连接测试模型').selectOption('analyst')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.locator('.test-result')).toContainText('连接成功')
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    const provider = await page.evaluate(async () => (await window.roundtable.bootstrap()).providers[0])
    await page.locator('[data-section="settings.capabilities"] > summary').click()
    await page.getByLabel('默认主持 / 裁判模型').selectOption(JSON.stringify([provider.id, 'chair']))
    await page.getByLabel('视觉模型（图片和扫描页）').selectOption(JSON.stringify([provider.id, 'vision']))
    await page.getByLabel('转录模型（音频和视频）').selectOption(JSON.stringify([provider.id, 'transcribe']))
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('设置已保存')
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '02-settings.png') })
    // Existing provider edits must not accidentally pass hasKey into the strict input schema.
    await page.getByRole('button', { name: '管理服务与模型' }).click()
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('模型服务已保存')

    await page.getByRole('button', { name: /新建讨论/ }).click()
    await page.getByLabel('今天，想一起讨论什么？').fill('城市是否应该优先投资太阳能与储能？')
    await page.getByLabel('成员 1 模型').selectOption(JSON.stringify([provider.id, 'analyst']))
    await page.getByLabel('成员 2 模型').selectOption(JSON.stringify([provider.id, 'critic']))
    await page.getByLabel('主持模型（可选）').selectOption(JSON.stringify([provider.id, 'chair']))
    await page.getByRole('checkbox', { name: '允许自动联网' }).uncheck()
    await page.getByRole('button', { name: '开始讨论', exact: true }).click()
    await expect(page.locator('.completed-card')).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('button', { name: '模型与设置', exact: true })).not.toHaveAttribute('aria-current')
    await expect(page.locator('.session-item[aria-current="page"]')).toHaveCount(1)
    await expect(page.locator('.chat-message')).toHaveCount(6)
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '03-discussion.png') })
    const snapshot = await page.evaluate(async () => (await window.roundtable.bootstrap()).sessions[0])
    expect(snapshot.messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(5)

    const exportPath = join(testDir, '讨论记录.md')
    await desktop!.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }) }, exportPath)
    await page.getByRole('button', { name: '导出 Markdown' }).click()
    await expect.poll(async () => { try { return await readFile(exportPath, 'utf8') } catch { return '' } }).toContain('## 讨论记录')

    await page.getByRole('button', { name: /^知识库/ }).click()
    await page.getByRole('button', { name: '新建知识库', exact: true }).click()
    await page.getByLabel('知识库名称').fill('能源研究')
    await page.getByLabel('Embedding 模型').selectOption(JSON.stringify([provider.id, 'embedding']))
    await page.getByRole('dialog').getByRole('button', { name: '创建知识库', exact: true }).click()
    const fixture = join(testDir, '中文能源资料.txt')
    await writeFile(fixture, '太阳能发电依赖日照，储能可以平衡电力供需。\n\n应同时关注成本、可靠性和季节性变化。', 'utf8')
    await desktop!.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }) }, fixture)
    await page.getByRole('button', { name: '选择文件', exact: true }).click()
    await expect(page.locator('.source-status.ready')).toHaveCount(1, { timeout: 20000 })
    await page.getByLabel('知识库检索问题').fill('如何平衡光伏能源供需？')
    await page.getByRole('button', { name: '检索', exact: true }).click()
    await expect(page.locator('.retrieval-result').first()).toContainText('太阳能')
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '04-knowledge.png') })
    const kb = await page.evaluate(async () => (await window.roundtable.bootstrap()).knowledgeBases[0])
    const cited = await page.evaluate(async input => window.roundtable.createSession({ topic: '根据资料分析太阳能', mode: 'roundtable', participants: [{ id: 'one', name: '分析者', role: '', model: { providerId: input.providerId, modelId: 'analyst' } }, { id: 'two', name: '质疑者', role: '', model: { providerId: input.providerId, modelId: 'critic' } }], moderator: { providerId: input.providerId, modelId: 'chair' }, knowledgeBaseIds: [input.kbId], searchEnabled: false, limits: { autoTurns: 12, maxCalls: 60, maxOutputTokens: 500, maxSearches: 5, contextChars: 48000 } }), { providerId: provider.id, kbId: kb.id })
    await expect.poll(async () => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.status, cited.id)).toBe('complete')
    const evidence = await page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.evidence, cited.id)
    expect(evidence?.[0].locator).toContain('段落')
    expect(errors).toEqual([])
    await desktop!.close(); desktop = undefined

    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(testDir, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    page = await desktop.firstWindow()
    await expect(page.getByRole('button', { name: '开启一场讨论' })).toBeVisible()
    const restored = await page.evaluate(() => window.roundtable.bootstrap())
    expect(restored.sessions).toHaveLength(2)
    expect(restored.sources[0].status).toBe('ready')
    expect(restored.providers[0].hasKey).toBe(true)
    expect(JSON.stringify(restored)).not.toContain('test-desktop-secret')
  } finally {
    await desktop?.close()
    await mock.close()
  }
})
