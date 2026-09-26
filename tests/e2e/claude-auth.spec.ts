import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

test('Claude settings choose official billing explicitly and keep service keys independent', async () => {
  const root = resolve('.'), directory = join(root, '.test-data', `claude-auth-ui-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  let desktop: ElectronApplication | undefined
  try {
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: directory, MODEL_ROUNDTABLE_TEST: '1' }, timeout: 30000 })
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(15000)
    await expect(page.locator('.welcome-page')).toBeVisible()
    // Test the actual renderer/preload UI without opening a real account login,
    // external console, or browser. Provider storage and validation remain real.
    await desktop.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & { claudeAuthUiCalls?: unknown[] }
      state.claudeAuthUiCalls = []
      ipcMain.removeHandler('agent:status')
      ipcMain.handle('agent:status', () => ({ ok: true, value: [{ kind: 'claude', available: true, authenticated: false, version: '2.1.280', message: '官方 CLI 尚未登录；已配置自有 API Key 的服务仍可使用，请在服务中测试连接。' }] }))
      ipcMain.removeHandler('agent:login')
      ipcMain.handle('agent:login', (_event, input) => { state.claudeAuthUiCalls!.push(input); return { ok: true, value: { message: 'QA official login requested' } } })
      ipcMain.removeHandler('agent:open-claude')
      ipcMain.handle('agent:open-claude', () => { state.claudeAuthUiCalls!.push({ action: 'official-terminal' }); return { ok: true, value: { message: 'QA official terminal requested' } } })
    })
    const calls = () => desktop!.evaluate(() => (globalThis as typeof globalThis & { claudeAuthUiCalls: unknown[] }).claudeAuthUiCalls)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '模型与设置', exact: true }).click()
    const runtimes = page.locator('[data-section="settings.runtimes"]')
    await runtimes.locator(':scope > summary').click()
    await expect(runtimes).toContainText('自有 API Key 的服务仍可使用')
    expect(await calls()).toEqual([])
    await runtimes.getByRole('button', { name: '设置官方登录', exact: true }).click()
    const login = page.getByRole('dialog', { name: '设置 Claude Code 官方登录', exact: true })
    await expect(login.getByLabel('Claude 官方认证方式')).toHaveValue('subscription')
    await login.getByLabel('Claude 官方认证方式').selectOption('console')
    await expect(login).toContainText('分别计费')
    await login.getByRole('button', { name: '打开官方登录', exact: true }).click()
    await expect(login).not.toBeVisible()
    expect(await calls()).toEqual([{ kind: 'claude', method: 'console' }])
    await runtimes.getByRole('button', { name: '设置官方登录', exact: true }).click()
    await login.getByLabel('Claude 官方认证方式').selectOption('subscription')
    await login.getByRole('button', { name: '打开官方登录', exact: true }).click()
    await expect(login).not.toBeVisible()
    await runtimes.getByText('官方终端与认证说明', { exact: true }).click()
    await runtimes.getByRole('button', { name: '打开原版 Claude Code', exact: true }).click()
    await expect.poll(calls).toEqual([{ kind: 'claude', method: 'console' }, { kind: 'claude', method: 'subscription' }, { action: 'official-terminal' }])

    await page.getByRole('button', { name: '添加模型服务', exact: true }).click()
    const form = page.getByRole('dialog', { name: '添加模型服务', exact: true })
    await form.getByLabel('接入类型', { exact: true }).selectOption('claude')
    await expect(form.getByLabel('Claude Code 认证方式', { exact: true })).toHaveValue('official')
    await form.getByLabel('Claude Code 认证方式', { exact: true }).selectOption('apiKey')
    await form.getByLabel('服务名称', { exact: true }).fill('Claude 自有 Key')
    await form.getByLabel('Anthropic API Key', { exact: true }).fill('qa-ui-private-key')
    await expect(form).toContainText('不会回退到订阅')
    await page.setViewportSize({ width: 1060, height: 700 })
    await page.screenshot({ path: join(directory, 'claude-key-form.png') })
    await form.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(form).not.toBeVisible()
    const provider = (await page.evaluate(() => window.roundtable.bootstrap())).providers[0]
    expect(provider).toMatchObject({ kind: 'claude', claudeAuth: 'apiKey', hasKey: true })
    expect(JSON.stringify(provider)).not.toContain('qa-ui-private-key')
    const card = page.locator('.provider-card').filter({ hasText: 'Claude 自有 Key' })
    await expect(card).toContainText('API Key 已保存')
    await card.getByRole('button', { name: '管理服务与模型' }).click()
    const edit = page.getByRole('dialog', { name: '管理模型服务', exact: true })
    await edit.locator(`[data-section="provider.${provider.id}.connection"] > summary`).click()
    await expect(edit.getByLabel('Anthropic API Key', { exact: true })).toHaveValue('')
    await edit.getByRole('button', { name: '移除已保存密钥', exact: true }).click()
    await expect(edit).toContainText('不会改用官方账号')
    await edit.getByRole('button', { name: '保存服务', exact: true }).click()
    await expect(edit).not.toBeVisible()
    await expect(card).toContainText('未配置 API Key')
    const final = await page.evaluate(() => window.roundtable.bootstrap())
    expect(final.providers[0]).toMatchObject({ claudeAuth: 'apiKey', hasKey: false })
    expect(final.sessions).toHaveLength(0); expect(final.executions).toHaveLength(0)
    expect((await calls()).length).toBe(3)
    expect(errors).toEqual([])
  } finally { await desktop?.close() }
})
