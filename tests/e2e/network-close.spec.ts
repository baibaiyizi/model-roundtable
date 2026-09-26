import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('window close and app quit preserve unsaved network changes until the user saves or discards them', async () => {
  const root = resolve('.')
  const directory = join(root, '.test-data', `network-close-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  let desktop: ElectronApplication | undefined
  const launch = async () => {
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: directory, MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(15000)
    await expect(page.locator('.welcome-page')).toBeVisible()
    await page.getByRole('button', { name: '网络与订阅', exact: true }).click()
    await page.locator('.network-page').getByRole('button', { name: '全部展开', exact: true }).click()
    await expect(page.getByLabel('联网搜索', { exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    await page.getByLabel('联网搜索', { exact: true }).selectOption('direct')
    await desktop!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    let guard = page.getByRole('dialog', { name: '网络设置尚未保存', exact: true })
    await expect(guard).toBeVisible()
    await guard.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByLabel('联网搜索', { exact: true })).toHaveValue('direct')
    expect((await page.evaluate(() => window.roundtable.getNetworkState())).bindings.search).not.toEqual({ mode: 'direct' })

    await desktop!.evaluate(({ app }) => { app.quit() })
    guard = page.getByRole('dialog', { name: '网络设置尚未保存', exact: true })
    await expect(guard).toBeVisible()
    const savedClose = desktop!.waitForEvent('close')
    await guard.getByRole('button', { name: '保存并离开', exact: true }).click()
    await savedClose
    desktop = undefined

    page = await launch()
    await expect(page.getByLabel('联网搜索', { exact: true })).toHaveValue('direct')
    await page.getByLabel('联网搜索', { exact: true }).selectOption('system')
    await desktop!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    guard = page.getByRole('dialog', { name: '网络设置尚未保存', exact: true })
    const discardedClose = desktop!.waitForEvent('close')
    await guard.getByRole('button', { name: '放弃改动', exact: true }).click()
    await discardedClose
    desktop = undefined

    page = await launch()
    await expect(page.getByLabel('联网搜索', { exact: true })).toHaveValue('direct')
    await page.reload()
    await expect(page.locator('.welcome-page')).toBeVisible()
    await page.getByRole('button', { name: '网络与订阅', exact: true }).click()
    await page.locator('.network-page').getByRole('button', { name: '全部展开', exact: true }).click()
    await expect(page.getByLabel('联网搜索', { exact: true })).toHaveValue('direct')
    const cleanClose = desktop!.waitForEvent('close')
    await desktop!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    await cleanClose
    desktop = undefined
  } finally {
    if (desktop) {
      // A failed assertion may leave a confirmation open in this isolated test profile.
      await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy() }).catch(() => {})
      await desktop.close().catch(() => {})
    }
  }
})
