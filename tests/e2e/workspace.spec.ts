import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { startMockAPI } from '../helpers/mock-api'
import { componentTestEnv } from '../helpers/components'
import type { AppAPI, Provider } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('projects isolate drafts, preserve running chats, branch templates and hand a discussion to a real file executor with two reviewers', async () => {
  test.setTimeout(240000)
  const root = resolve('.')
  const directory = join(root, '.test-data', `workspace-${Date.now()}`)
  const projectDirectory = join(directory, '中文 项目')
  await mkdir(projectDirectory, { recursive: true })
  await writeFile(join(projectDirectory, '说明.md'), '# 项目说明\n\n这是桌面执行验收项目。')
  const mock = await startMockAPI()
  let toolRequested = false
  const executionCalls: string[] = []
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk.toString()
    const body = JSON.parse(raw)
    executionCalls.push(body.model)
    const reviewer = /^review/.test(body.model)
    const tool = body.tools?.find((item: { function?: { name: string } }) => item.function?.name === 'write')
    const wantsTool = !!tool && !toolRequested && !reviewer
    if (wantsTool) toolRequested = true
    const content = reviewer ? JSON.stringify({ verdict: 'pass', findings: '已核对 proof.txt 的实际新增差异，完成判定通过。' }) : '已完成，proof.txt 包含真实工具已执行。'
    const delta = wantsTool ? { tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: join(projectDirectory, 'proof.txt'), content: '真实工具已执行' }) } }] } : { content }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'answer', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ id: 'answer', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: wantsTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'answer', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })) }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  const launch = async (): Promise<Page> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, ...componentTestEnv, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', e => errors.push(e.message))
    await expect(page.locator('.welcome-page')).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    const providers = await page.evaluate(async ({ url, upstreamUrl }) => {
      const settings = { apiKey: 'local-test-secret', tokenParameter: 'max_tokens' as const, streamUsage: true, timeoutMs: 30000 }
      const discussion = await window.roundtable.saveProvider({ ...settings, name: '讨论服务', baseUrl: `${url}/v1`, modelIds: ['analyst', 'critic', 'slow'] })
      const execution = await window.roundtable.saveProvider({ ...settings, name: '执行服务', baseUrl: upstreamUrl, modelIds: ['executor', 'review-one', 'review-two'] })
      return { discussion, execution }
    }, { url: mock.url, upstreamUrl })
    await page.reload()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.getByLabel('项目名称', { exact: true }).fill('研究与执行项目')
    await desktop!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, projectDirectory)
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await expect(page.getByLabel('工作目录', { exact: true })).toHaveValue(projectDirectory)
    await page.getByLabel('项目说明', { exact: true }).fill('保留原有说明文件，新增成果必须说明验证结果。')
    await page.getByRole('button', { name: '保存项目', exact: true }).click()
    await expect(page.locator('.project-home h1')).toHaveText('研究与执行项目')
    const project = await page.evaluate(async () => (await window.roundtable.bootstrap()).projects[0])
    const model = (provider: Provider, id: string) => JSON.stringify([provider.id, id])
    const create = async (title: string, mode: 'roundtable' | 'free', slow = false) => {
      await page.locator('.new-discussion').click()
      if (mode === 'free') await page.getByRole('dialog').getByRole('button', { name: /自由群聊/ }).click()
      await expect(page.getByLabel('主持模型（可选）')).toHaveValue('')
      await page.getByLabel('今天，想一起讨论什么？').fill(title)
      await page.getByLabel('成员 1 模型').selectOption(model(providers.discussion, slow ? 'slow' : 'analyst'))
      await page.getByLabel('成员 2 模型').selectOption(model(providers.discussion, 'critic'))
      if (mode === 'free') { await page.getByText('讨论与费用限制', { exact: true }).click(); await page.getByLabel('连续发言后暂停').fill('1') }
      await page.getByRole('checkbox', { name: '允许自动联网' }).uncheck()
    await page.getByRole('button', { name: '开始讨论', exact: true }).click()
    }
    const release = mock.holdSlowStreams()
    await create('后台持续讨论', 'roundtable', true)
    await expect(page.locator('.is-streaming')).toHaveCount(1)
    await page.getByRole('button', { name: '项目 研究与执行项目', exact: true }).click()
    await expect(page.locator('.project-home')).toBeVisible()
    release()
    await expect.poll(async () => page.evaluate(async () => (await window.roundtable.bootstrap()).sessions.find(s => s.title === '后台持续讨论')?.status), { timeout: 20000 }).toBe('complete')
    await create('项目群聊 A', 'free')
    await expect(page.locator('.session-status')).toHaveText('已暂停')
    await page.getByLabel('加入讨论').fill('会话 A 的独立草稿')
    await create('项目群聊 B', 'free')
    await expect(page.locator('.session-status')).toHaveText('已暂停')
    await expect(page.getByLabel('加入讨论')).toHaveValue('')
    await page.getByLabel('加入讨论').fill('会话 B 的独立草稿')
    await page.getByRole('tab', { name: '项目群聊 A', exact: true }).click()
    await expect(page.getByLabel('加入讨论')).toHaveValue('会话 A 的独立草稿')
    await page.getByRole('button', { name: /静音 / }).first().click()
    await expect(page.getByRole('button', { name: /恢复 / })).toHaveCount(1)
    const before = await page.evaluate(async () => (await window.roundtable.bootstrap()).sessions.find(s => s.title === '项目群聊 A')!)
    await page.getByRole('button', { name: '单次发言', exact: true }).click()
    await expect.poll(async () => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(s => s.id === id)?.messages.filter(m => m.kind === 'assistant' && m.status === 'complete').length, before.id)).toBe(2)
    await expect(page.locator('.session-status')).toHaveText('已暂停')
    await page.getByRole('button', { name: '更多会话操作' }).click()
    await page.getByRole('button', { name: '保存讨论模板', exact: true }).click()
    await page.getByLabel('模板名称', { exact: true }).fill('项目审议组')
    await page.getByRole('button', { name: '保存模板', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('讨论模板已保存')
    await page.locator('.new-discussion').click()
    await page.getByLabel('使用讨论模板').selectOption({ label: '项目审议组' })
    await expect(page.getByLabel('成员 1 模型')).toHaveValue(model(providers.discussion, 'analyst'))
    await expect(page.getByLabel('主持模型（可选）')).toHaveValue('')
    await expect(page.locator('.mode-card.selected')).toContainText('自由群聊')
    await page.getByRole('button', { name: '关闭开启一次新讨论' }).click()
    await page.getByRole('button', { name: /从 .* 的发言创建分支/ }).last().click()
    await expect.poll(async () => page.evaluate(async () => (await window.roundtable.bootstrap()).sessions.filter(s => s.branchOf).length)).toBe(1)
    await page.getByRole('tab', { name: '后台持续讨论', exact: true }).click()
    await expect(page.locator('.completed-card')).toBeVisible()
    await page.getByRole('button', { name: '交给执行者', exact: true }).click()
    await expect(page.getByLabel('最大修复轮数')).toHaveValue('2')
    await expect(page.locator('.reviewer-row')).toHaveCount(2)
    await page.getByLabel('要执行的任务', { exact: true }).fill('创建 proof.txt 并写入真实工具已执行')
    await page.getByLabel('完成判定', { exact: true }).fill('项目根目录存在 proof.txt，内容为真实工具已执行，并保留说明.md。')
    await page.getByLabel('执行模型', { exact: true }).selectOption(model(providers.execution, 'executor'))
    await page.getByLabel('审阅模型 1', { exact: true }).selectOption(model(providers.execution, 'review-one'))
    await page.getByLabel('审阅模型 2', { exact: true }).selectOption(model(providers.execution, 'review-two'))
    await page.getByRole('button', { name: '创建并执行', exact: true }).click()
    await expect.poll(async () => page.evaluate(async () => { const e = (await window.roundtable.bootstrap()).executions[0]; return e?.error ?? e?.status }), { timeout: 90000 }).toBe('complete')
    await expect(page.locator('.execution-result')).toContainText('真实工具已执行')
    await expect(page.locator('.diff-view')).toContainText('+真实工具已执行')
    expect(await readFile(join(projectDirectory, 'proof.txt'), 'utf8')).toBe('真实工具已执行')
    expect(await readFile(join(projectDirectory, '说明.md'), 'utf8')).toContain('桌面执行验收项目')
    await page.getByRole('button', { name: /独立审阅/ }).click()
    await expect(page.locator('.review-result')).toHaveCount(2)
    await expect(page.locator('.review-result').first()).toContainText('初审 · 通过')
    await page.getByRole('button', { name: '查看当前文件 →' }).click()
    await expect(page.locator('.code-preview')).toHaveText('真实工具已执行')
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, '07-execution.png') })
    const execution = await page.evaluate(async () => (await window.roundtable.bootstrap()).executions[0])
    expect(execution.projectId).toBe(project.id)
    expect(JSON.stringify(execution.handoff)).toContain('后台持续讨论')
    expect(executionCalls).toContain('review-one')
    expect(executionCalls).toContain('review-two')
    expect(execution.events.some(e => e.kind === 'tool' && e.state === 'complete')).toBe(true)
    await page.getByRole('tab', { name: '项目群聊 B', exact: true }).click()
    await expect(page.getByLabel('加入讨论')).toHaveValue('会话 B 的独立草稿')
    await page.setViewportSize({ width: 1100, height: 800 })
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, '08-project-chat-1100.png') })
    await desktop!.close(); desktop = undefined
    page = await launch()
    await page.getByRole('button', { name: '项目 研究与执行项目', exact: true }).click()
    await page.locator('.session-item').filter({ hasText: '项目群聊 B' }).click()
    await expect(page.getByLabel('加入讨论')).toHaveValue('会话 B 的独立草稿')
    const restored = await page.evaluate(() => window.roundtable.bootstrap())
    expect(restored.projects).toHaveLength(1)
    expect(restored.sessions).toHaveLength(4)
    expect(restored.executions[0].status).toBe('complete')
    expect(restored.templates[0].name).toBe('项目审议组')
    const draftSession = restored.sessions.find(s => s.title === '项目群聊 B')!
    await expect.poll(async () => page.evaluate(id => window.roundtable.getDraft(`message.${id}`), draftSession.id)).toContain('会话 B 的独立草稿')
    await page.getByRole('button', { name: '更多会话操作' }).click()
    await page.getByRole('button', { name: '删除讨论', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.project-home')).toBeVisible()
    await expect.poll(async () => page.evaluate(id => window.roundtable.getDraft(`message.${id}`), draftSession.id)).toBe('')
    expect(await page.evaluate(id => localStorage.getItem(`roundtable.draft.message.${id}`), draftSession.id)).toBeNull()
    await page.getByRole('button', { name: '移除项目', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.welcome-page')).toBeVisible()
    const removed = await page.evaluate(() => window.roundtable.bootstrap())
    expect(removed.projects).toHaveLength(0); expect(removed.sessions).toHaveLength(0); expect(removed.executions).toHaveLength(0)
    expect(await page.evaluate(({ projectId, sessionIds }) => Object.keys(localStorage).filter(key => key.startsWith('roundtable.draft.') && [projectId, ...sessionIds].some(id => key.includes(id))), { projectId: project.id, sessionIds: restored.sessions.map(s => s.id) })).toEqual([])
    expect(await page.evaluate(id => window.roundtable.getDraft(`discussion-new.${id}`), project.id)).toBe('')
    expect(await readFile(join(projectDirectory, 'proof.txt'), 'utf8')).toBe('真实工具已执行')
    expect(errors).toEqual([])
  } finally {
    await desktop?.close()
    await mock.close()
    upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done()))
  }
})
