import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('network UI imports subscriptions, binds independent service routes and preserves them after restart', async () => {
  const root = resolve('.')
  const directory = join(root, '.test-data', `network-ui-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  let response = 'proxies:\n  - name: 固定节点\n    type: http\n    server: 127.0.0.1\n    port: 19876\n'
  const subscription = createServer((_request, reply) => { reply.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); reply.end(response) })
  subscription.listen(0, '127.0.0.1'); await once(subscription, 'listening')
  const address = subscription.address() as { port: number }
  const secret = 'network-ui-synthetic-subscription-token'
  const localFile = join(directory, '中文 节点.yaml')
  await writeFile(localFile, response)
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = async () => {
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.welcome-page')).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    await page.getByRole('button', { name: '网络与订阅', exact: true }).click()
    await page.locator('.network-page').getByRole('button', { name: '全部展开', exact: true }).click()
    await expect(page.getByRole('heading', { name: '网络与订阅', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加订阅', exact: true }).first().click()
    await page.getByLabel('订阅名称', { exact: true }).fill('远程验收订阅')
    await page.getByLabel('订阅链接', { exact: true }).fill(`http://127.0.0.1:${address.port}/subscription?token=${secret}`)
    await expect(page.getByLabel('订阅链接', { exact: true })).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: '导入订阅', exact: true }).click()
    await Promise.race([expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }), page.locator('.toast-error').waitFor({ state: 'visible', timeout: 30000 }).then(async () => { throw new Error(await page.locator('.toast-error').innerText()) })])
    await expect(page.locator('.network-subscription')).toHaveCount(1)
    await expect(page.locator('.network-subscription')).toContainText('固定节点')
    await expect(page.locator('body')).not.toContainText(secret)
    const imported = await page.evaluate(() => window.roundtable.getNetworkState())
    expect(JSON.stringify(imported)).not.toContain(secret)

    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await page.getByLabel('订阅名称', { exact: true }).fill('本地验收订阅')
    await page.getByLabel('订阅导入方式', { exact: true }).selectOption('file')
    await page.getByLabel('订阅文件', { exact: true }).setInputFiles(localFile)
    await page.getByRole('button', { name: '导入订阅', exact: true }).click()
    await Promise.race([expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }), page.locator('.toast-error').waitFor({ state: 'visible', timeout: 30000 }).then(async () => { throw new Error(await page.locator('.toast-error').innerText()) })])
    await expect(page.locator('.network-subscription')).toHaveCount(2)
    const remote = imported.subscriptions[0]
    const selection = JSON.stringify([remote.id, remote.nodes[0].id])
    await page.getByLabel('联网搜索', { exact: true }).selectOption(selection)
    await expect(page.getByLabel('联网搜索', { exact: true }).locator('option:checked')).toContainText('远程验收订阅 / 固定节点')
    await page.getByLabel('扩展商店', { exact: true }).selectOption('direct')
    await page.getByRole('button', { name: '保存应用线路', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存应用线路', exact: true })).toBeDisabled()
    const configured = await page.evaluate(() => window.roundtable.getNetworkState())
    expect(configured.bindings.search).toEqual({ mode: 'subscription', subscriptionId: remote.id, nodeId: remote.nodes[0].id })
    expect(configured.bindings.catalog).toEqual({ mode: 'direct' })
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, 'network-subscriptions.png') })

    await page.getByRole('button', { name: '模型与设置', exact: true }).click()
    await page.getByRole('button', { name: '添加模型服务', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '全部展开', exact: true }).click()
    await page.getByLabel('服务名称', { exact: true }).fill('指定节点服务')
    await page.getByLabel('API 地址', { exact: true }).fill('https://example.org/v1')
    await page.getByLabel('手动输入模型 ID', { exact: true }).fill('test-model')
    await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click()
    await page.getByLabel('服务网络线路', { exact: true }).selectOption(selection)
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await Promise.race([expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }), page.locator('.toast-error').waitFor({ state: 'visible', timeout: 30000 }).then(async () => { throw new Error(await page.locator('.toast-error').innerText()) })])
    const provider = await page.evaluate(async () => (await window.roundtable.bootstrap()).providers[0])
    expect(provider.network).toEqual(configured.bindings.search)
    await page.locator('[data-section="settings.capabilities"] > summary').click()
    await page.getByLabel('默认主持 / 裁判模型', { exact: true }).selectOption(JSON.stringify([provider.id, 'test-model']))
    await expect(page.locator('.model-network-line').first()).toContainText('远程验收订阅 / 固定节点')
    await page.getByRole('button', { name: '设置 指定节点服务 的服务网络', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('管理模型服务')
    await expect(page.getByLabel('服务网络线路', { exact: true })).toHaveValue(selection)
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await Promise.race([expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }), page.locator('.toast-error').waitFor({ state: 'visible', timeout: 30000 }).then(async () => { throw new Error(await page.locator('.toast-error').innerText()) })])

    await page.getByRole('button', { name: '添加模型服务', exact: true }).click()

    await page.getByRole('dialog').getByRole('button', { name: '全部展开', exact: true }).click()
    await page.getByLabel('服务名称', { exact: true }).fill('直连服务')
    await page.getByLabel('API 地址', { exact: true }).fill('https://example.net/v1')
    await page.getByLabel('服务网络线路', { exact: true }).selectOption('direct')
    await page.getByRole('button', { name: '保存服务', exact: true }).click()
    await Promise.race([expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 }), page.locator('.toast-error').waitFor({ state: 'visible', timeout: 30000 }).then(async () => { throw new Error(await page.locator('.toast-error').innerText()) })])
    expect((await page.evaluate(() => window.roundtable.bootstrap())).providers.find(item => item.name === '直连服务')?.network).toEqual({ mode: 'direct' })
    await desktop!.close(); desktop = undefined
    page = await launch()
    const restored = await page.evaluate(() => window.roundtable.bootstrap())
    expect(restored.providers.find(item => item.id === provider.id)?.network).toEqual(provider.network)
    expect((await page.evaluate(() => window.roundtable.getNetworkState())).subscriptions).toHaveLength(2)

    await page.getByRole('button', { name: '网络与订阅', exact: true }).click()

    await page.locator('.network-page').getByRole('button', { name: '全部展开', exact: true }).click()
    response = 'proxies:\n  - name: 替换后的节点\n    type: http\n    server: 127.0.0.1\n    port: 19877\n'
    await page.getByRole('button', { name: '更新订阅 远程验收订阅', exact: true }).click()
    await expect(page.locator('.network-subscription').filter({ hasText: '远程验收订阅' })).toContainText('替换后的节点')
    await expect(page.getByLabel('联网搜索', { exact: true }).locator('option:checked')).toContainText('指定节点不可用')
    await page.getByRole('button', { name: '删除订阅 本地验收订阅', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.network-subscription')).toHaveCount(1)
    await page.getByRole('button', { name: '模型与设置', exact: true }).click()
    await expect(page.locator('.provider-card').filter({ hasText: '指定节点服务' })).toContainText('指定节点不可用')
    expect(errors).toEqual([])
  } catch (error) { if (desktop) console.log(await (await desktop.firstWindow()).locator('body').innerText()); throw error } finally { await desktop?.close(); subscription.closeAllConnections(); await new Promise<void>(resolve => subscription.close(() => resolve())) }
})
