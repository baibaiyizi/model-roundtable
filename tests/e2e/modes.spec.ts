import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { startMockAPI } from '../helpers/mock-api'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('desktop free chat, directed interjection, stop and complete formal debate', async () => {
  const root = resolve('.')
  const testDir = join(root, '.test-data', `modes-${Date.now()}`)
  await mkdir(testDir, { recursive: true })
  const mock = await startMockAPI()
  let desktop: ElectronApplication | undefined
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(testDir, 'profile'), MODEL_ROUNDTABLE_TEST: '1' } })
    const page = await desktop.firstWindow()
    await page.waitForFunction(() => !!window.roundtable)
    const provider = await page.evaluate(async url => {
      const p = await window.roundtable.saveProvider({ name: '讨论验收', baseUrl: `${url}/v1`, apiKey: 'local-test-only', modelIds: ['slow', 'critic', 'chair'], tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 30000 })
      await window.roundtable.saveSettings({ moderator: { providerId: p.id, modelId: 'chair' } })
      return p
    }, mock.url)
    await page.reload()
    const create = async (mode: 'free' | 'debate') => {
      await page.getByRole('button', { name: /新建讨论/ }).click()
      await page.getByRole('button', { name: mode === 'free' ? /自由群聊/ : /正式辩论/ }).click()
      await page.getByLabel(mode === 'free' ? '今天，想一起讨论什么？' : '辩题', { exact: true }).fill(mode === 'free' ? '自由群聊验收：城市储能' : '正式辩论验收：应优先投入城市储能')
      await page.getByLabel('成员 1 模型').selectOption(JSON.stringify([provider.id, 'slow']))
      await page.getByLabel('成员 2 模型').selectOption(JSON.stringify([provider.id, 'critic']))
      if (mode === 'free') await page.getByLabel('主持模型（可选）').selectOption(JSON.stringify([provider.id, 'chair']))
      await page.getByText('讨论与费用限制', { exact: true }).click()
      await page.getByLabel('连续发言后暂停').fill('2')
      await page.getByRole('checkbox', { name: '允许自动联网' }).uncheck()
    await page.getByRole('button', { name: '开始讨论', exact: true }).click()
    }
    await create('free')
    await expect(page.locator('.session-status')).toHaveText('已暂停', { timeout: 20000 })
    const free = await page.evaluate(async () => (await window.roundtable.bootstrap()).sessions[0])
    expect(free.messages.filter(m => m.kind === 'assistant' && m.status === 'complete')).toHaveLength(2)
    await page.getByLabel('点名成员', { exact: true }).selectOption(free.participants[1].id)
    await page.getByLabel('加入讨论').fill('请质疑者具体讨论电网可靠性。')
    await page.getByRole('button', { name: '发送发言', exact: true }).click()
    // Wait for this new round in the backend: the renderer can still show the prior pause
    // while the directed reply is streaming. Holding the next stream too early deadlocks the test.
    await expect.poll(async () => page.evaluate(async ({ id, target }) => {
      const current = (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)!
      const completed = current.messages.filter(m => m.kind === 'assistant' && m.status === 'complete')
      return { status: current.status, completed: completed.length, directed: completed.some(m => m.phase === 'interjection' && m.speakerId === target) }
    }, { id: free.id, target: free.participants[1].id }), { timeout: 20000 }).toEqual({ status: 'paused', completed: 4, directed: true })
    await expect(page.locator('.session-status')).toHaveText('已暂停', { timeout: 20000 })
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '05-free-chat.png') })
    const release = mock.holdSlowStreams()
    await page.getByRole('button', { name: '继续讨论', exact: true }).click()
    await expect(page.locator('.is-streaming')).toBeVisible()
    await page.getByLabel('加入讨论').fill('立刻中断，先确认假设。')
    await page.getByRole('button', { name: '插话', exact: true }).click()
    await expect(page.locator('.chat-message').filter({ hasText: '已中断' })).toHaveCount(1)
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect(page.locator('.session-status')).toHaveText('已结束')
    const count = mock.calls.length
    release()
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(mock.calls).toHaveLength(count)
    await expect(page.getByLabel('加入讨论')).toBeDisabled()

    await create('debate')
    await expect(page.locator('.completed-card')).toBeVisible({ timeout: 30000 })
    const debate = await page.evaluate(async () => (await window.roundtable.bootstrap()).sessions.find(s => s.mode === 'debate')!)
    expect(debate.messages.filter(m => m.kind === 'assistant').map(m => m.phase)).toEqual(['opening', 'opening', 'question', 'answer', 'question', 'answer', 'rebuttal', 'rebuttal', 'closing', 'closing', 'verdict'])
    await expect(page.getByLabel('加入讨论')).toBeDisabled()
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(testDir, '06-debate.png') })
  } finally {
    await desktop?.close()
    await mock.close()
  }
})
