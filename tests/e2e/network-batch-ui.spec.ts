import { test, expect, _electron as electron } from '@playwright/test'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

test('批量测速保留筛选外选择，可取消且不改变应用或模型线路', async () => {
  const root = resolve('.'), directory = join(root, '.test-data', `batch-network-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const sockets = new Set<Socket>()
  const stalled = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
  stalled.listen(0, '127.0.0.1'); await once(stalled, 'listening')
  const port = (stalled.address() as { port: number }).port
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 30000 })
  try {
    const page = await desktop.firstWindow(); await expect(page.locator('.welcome-page')).toBeVisible()
    const before = await page.evaluate(async port => {
      await window.roundtable.importNetworkSubscription({ name: '批量验收', content: `proxies:\n${['A1', 'A2', 'B1', 'B2', 'C1'].map(name => `  - {name: ${name}, type: http, server: 127.0.0.1, port: ${port}}`).join('\n')}` })
      await window.roundtable.saveNetworkBindings({ search: { mode: 'direct' }, web: { mode: 'direct' } })
      return window.roundtable.getNetworkState()
    }, port)
    await page.getByRole('button', { name: '网络与订阅', exact: true }).click()
    const filter = page.getByLabel('筛选订阅节点')
    await filter.fill('A'); await page.getByRole('button', { name: '全选当前筛选', exact: true }).click()
    await filter.fill('B'); await page.getByRole('button', { name: '全选当前筛选', exact: true }).click()
    await expect(page.locator('.network-batch')).toContainText('已选 4 / 5')
    await filter.fill('A'); await page.getByRole('button', { name: '取消当前筛选', exact: true }).click()
    await expect(page.locator('.network-batch')).toContainText('已选 2 / 5')
    await page.getByRole('button', { name: '清除筛选', exact: true }).click()
    await expect(page.getByLabel('选择节点 批量验收 / B1', { exact: true })).toBeChecked()
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click()
    await page.getByRole('button', { name: '开始批量检测', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.roundtable.getNetworkState()).nodeTests?.items.filter(item => item.status === 'running').length)).toBe(3)
    const subscriptions = page.locator('[data-section="network.subscriptions"]')
    await subscriptions.locator(':scope > summary').click()
    await expect(subscriptions).not.toHaveAttribute('open')
    await expect(subscriptions.locator(':scope > summary')).toContainText('正在检测')
    await expect(subscriptions.locator(':scope > summary')).toContainText('已选 5')
    expect((await page.evaluate(() => window.roundtable.getNetworkState())).nodeTests?.status).toBe('running')
    await subscriptions.locator(':scope > summary').click()
    const beforeCancellation = (await page.evaluate(() => window.roundtable.getNetworkState())).nodeTests!
    await page.getByRole('button', { name: '取消检测', exact: true }).click()
    await expect.poll(() => page.evaluate(async () => (await window.roundtable.getNetworkState()).nodeTests?.status)).toBe('cancelled')
    const after = await page.evaluate(() => window.roundtable.getNetworkState())
    expect(after.bindings).toEqual(before.bindings)
    expect(after.nodeTests?.items.every(item => ['complete', 'failed', 'cancelled'].includes(item.status))).toBe(true)
    expect(after.nodeTests?.items.some(item => item.status === 'cancelled')).toBe(true)
    for (const completed of beforeCancellation.items.filter(item => item.status === 'complete' || item.status === 'failed')) {
      expect(after.nodeTests?.items.find(item => item.subscriptionId === completed.subscriptionId && item.nodeId === completed.nodeId)).toEqual(completed)
    }
    expect((await page.evaluate(() => window.roundtable.bootstrap())).providers).toEqual([])
    await expect(page.locator('.network-batch')).toContainText('已取消检测')
  } finally { await desktop.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => stalled.close(() => resolve())) }
})
