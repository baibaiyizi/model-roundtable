import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('extension recommendations and dismissible installation records persist without hiding connection faults', async () => {
  const root = resolve('.'), directory = join(root, '.test-data', `extensions-usability-${Date.now()}`), skillDirectory = join(directory, '本地技能'), badSkillDirectory = join(directory, '无效技能')
  await mkdir(skillDirectory, { recursive: true }); await mkdir(badSkillDirectory); await writeFile(join(badSkillDirectory, 'SKILL.md'), '缺少必填的技能元数据'); await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: record-cleanup\ndescription: 安装记录清理验收\n---\n只读说明')
  const upstream = createServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"Controlled connection unavailable"}') }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
  let desktop: ElectronApplication | undefined; const errors: string[] = []
  try {
    desktop = await launch(); let page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '扩展商店', exact: true }).click(); await expect(page.getByRole('heading', { name: '常用推荐', exact: true })).toBeVisible(); await expect(page.locator('.extension-card')).toHaveCount(3); await expect(page.locator('.extension-card').first()).toContainText('Context7')
    await expect(page.locator('.extension-card').filter({ hasText: 'Brave Search' })).toContainText('需要 Brave Search API Key'); await expect(page.locator('.extension-card').filter({ hasText: 'Playwright' })).toContainText('浏览器')
    await page.getByLabel('扩展排序', { exact: true }).selectOption('name'); await expect(page.locator('.extension-card').first()).toContainText('Brave Search')
    await page.getByLabel('扩展类型', { exact: true }).selectOption('skill'); await expect(page.locator('.extension-card')).toHaveCount(3); await expect(page.getByRole('heading', { name: 'Frontend Design', exact: true })).toBeVisible(); expect((await page.evaluate(() => window.roundtable.extensionState())).installed).toEqual([])
    await page.getByRole('button', { name: '导入 Skill', exact: true }).click(); await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, badSkillDirectory); await page.getByRole('dialog').getByRole('button', { name: '选择', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始导入', exact: true }).click()
    await expect(page.locator('.extension-job')).toContainText('安装失败'); const failed = page.locator('.extension-job'); expect(await failed.locator('details').getAttribute('open')).toBeNull(); await failed.getByText('查看详情', { exact: true }).click(); await expect(failed.locator('details')).toHaveAttribute('open', ''); await failed.getByRole('button', { name: /^移除 .*安装记录$/ }).click(); await expect(page.locator('.extension-job')).toHaveCount(0)
    await page.getByRole('button', { name: '导入 Skill', exact: true }).click(); await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, skillDirectory); await page.getByRole('dialog').getByRole('button', { name: '选择', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: '开始导入', exact: true }).click()
    await page.evaluate(url => window.roundtable.importMcpConfiguration({ name: '故障连接验收', configuration: JSON.stringify({ mcpServers: { '仍然故障的连接': { url } } }) }), url)
    await expect.poll(async () => page.evaluate(async () => (await window.roundtable.extensionState()).installed.length)).toBe(2)
    await page.getByRole('tab', { name: /^已安装/ }).click(); const broken = page.locator('.extension-card').filter({ has: page.getByRole('heading', { name: '仍然故障的连接', exact: true }) }); await expect(broken).toContainText('需要配置'); expect(await broken.locator('details').getAttribute('open')).toBeNull()
    await page.getByRole('button', { name: '清除已结束记录', exact: true }).click(); await expect(page.locator('.extension-jobs')).toHaveCount(0); await expect(broken).toContainText('需要配置'); await broken.getByText('查看连接错误', { exact: true }).click(); await expect(broken.locator('details p')).not.toHaveText('')
    await broken.getByRole('button', { name: '测试连接', exact: true }).click(); await expect(broken).toContainText('连接失败')
    await page.screenshot({ path: join(directory, 'extension-errors.png') }); await desktop.close(); desktop = await launch(); page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: '扩展商店', exact: true }).click(); await expect(page.locator('.extension-jobs')).toHaveCount(0); await page.getByRole('tab', { name: /^已安装/ }).click(); await expect(page.locator('.extension-card')).toHaveCount(2); await expect(page.locator('.extension-card').filter({ hasText: '仍然故障的连接' })).toContainText('连接失败'); expect(errors).toEqual([])
  } finally { await desktop?.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})
