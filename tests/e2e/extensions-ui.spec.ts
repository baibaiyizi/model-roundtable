import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

test('extension UI imports real MCP and local Skill, saves project grants and search mapping, and inspects optional components', async () => {
  const root = resolve('.')
  const directory = join(root, '.test-data', `extensions-ui-${Date.now()}`)
  const projectDirectory = join(directory, '中文 扩展项目')
  const skillDirectory = join(directory, '本地技能')
  await mkdir(projectDirectory, { recursive: true }); await mkdir(skillDirectory)
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: local-review\ndescription: 检查项目文档的引用与清晰度\n---\n请检查用户指定材料中的引用，并保留来源。\n')
  const handler = createMcpHandler(() => {
    const server = new Server({ name: 'fixture-search', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'search_fixture', description: '只读搜索验收资料', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } }] }))
    server.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [{ title: '验收资料', url: 'https://example.org/evidence', text: '实际 MCP 返回的中文资料。' }] }) }] }))
    return server
  })
  const nodeHandler = toNodeHandler(handler)
  const rawDiagnostic = '<think>这是合成的脱敏思考。</think>\n下面是计划：这不是 JSON。'
  const upstream = createServer(async (req, res) => {
    if (req.url === '/v1/chat/completions') {
      for await (const _chunk of req) { /* consume the request body */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ id: 'diagnostic-fixture', choices: [{ index: 0, delta: { content: rawDiagnostic }, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ id: 'diagnostic-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`)
      return
    }
    void nodeHandler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const address = upstream.address() as { port: number }
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.welcome-page')).toBeVisible()
    await page.getByRole('button', { name: '扩展商店', exact: true }).click()
    await page.getByRole('button', { name: '导入 MCP', exact: true }).click()
    await page.getByLabel('配置名称').fill('本地验收')
    await page.getByLabel('MCP JSON 配置').fill(JSON.stringify({ mcpServers: { '资料搜索': { type: 'http', url: `http://127.0.0.1:${address.port}/mcp` } } }))
    await page.getByRole('button', { name: '开始导入', exact: true }).click()
    const card = page.locator('.extension-card').filter({ has: page.getByRole('heading', { name: '资料搜索', exact: true }) })
    await expect(card).toContainText('已就绪')
    await expect(card).toContainText('1 个工具')
    await card.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('发现 1 个工具')
    await card.getByRole('button', { name: '详情与配置' }).click()
    await expect(page.getByRole('dialog')).toContainText('search_fixture')
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '导入 Skill', exact: true }).click()
    await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, skillDirectory)
    await page.getByRole('dialog').getByRole('button', { name: '选择', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '开始导入', exact: true }).click()
    await expect(page.locator('.extension-card').filter({ has: page.getByRole('heading', { name: 'local-review', exact: true }) })).toContainText('已就绪')

    await page.getByRole('button', { name: '讨论空间', exact: true }).click()
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.getByLabel('项目名称', { exact: true }).fill('扩展验收项目')
    await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, projectDirectory)
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await page.getByRole('button', { name: '保存项目', exact: true }).click()
    const grant = page.locator('.extension-grant').filter({ has: page.getByRole('checkbox', { name: '资料搜索', exact: true }) })
    await grant.getByRole('checkbox', { name: '资料搜索', exact: true }).check()
    await page.getByLabel('资料搜索 search_fixture 权限').selectOption('read')
    await grant.getByRole('button', { name: '保存授权', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('项目授权已保存')
    await page.locator('.extension-search-panel').getByRole('button', { name: '刷新', exact: true }).click()
    const installed = await page.evaluate(async () => (await window.roundtable.extensionState()).installed.find(item => item.name === '资料搜索')!)
    await page.getByLabel('项目搜索工具', { exact: true }).selectOption(JSON.stringify([installed.id, 'search_fixture']))
    await page.getByLabel('查询参数字段').selectOption('query')
    await page.getByLabel('结果数组路径（根数组可留空）').fill('results')
    await page.getByRole('button', { name: '保存搜索绑定', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('项目搜索绑定已保存')
    const state = await page.evaluate(() => window.roundtable.extensionState())
    expect(state.grants[0].tools[0].access).toBe('read')
    expect(state.searchBindings[0]).toMatchObject({ tool: 'search_fixture', queryField: 'query', resultPath: 'results', contentType: 'snippet' })
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, 'project-extensions.png') })

    const session = await page.evaluate(async url => {
      const project = (await window.roundtable.bootstrap()).projects[0]
      const provider = await window.roundtable.saveProvider({ name: '诊断验收模型', apiKey: 'synthetic-test-key', baseUrl: `${url}/v1`, modelIds: ['synthetic-planner'], tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 10000 })
      const model = { providerId: provider.id, modelId: 'synthetic-planner' }
      return window.roundtable.createSession({ title: 'MCP 资料引用验收', topic: '检验原始响应诊断与实际 MCP 搜索证据。', projectId: project.id, mode: 'roundtable', participants: [{ id: 'one', name: '成员一', role: '', model }, { id: 'two', name: '成员二', role: '', model }], knowledgeBaseIds: [], searchEnabled: true, limits: { autoTurns: 12, maxCalls: 20, maxOutputTokens: 500, maxSearches: 3, contextChars: 16000 } })
    }, `http://127.0.0.1:${address.port}`)
    await expect.poll(async () => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(item => item.id === id)?.status, session.id)).toBe('error')
    await page.locator('.session-item').filter({ hasText: 'MCP 资料引用验收' }).click()
    const diagnostic = page.locator('.system-details')
    await expect(diagnostic).toContainText('synthetic-planner')
    await expect(diagnostic).toContainText('invalid_json')
    await expect(diagnostic).toContainText('结束原因：stop')
    await expect(diagnostic.locator('pre')).toHaveText(rawDiagnostic)
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click()
    await page.getByRole('button', { name: '补充联网查询', exact: true }).click()
    await page.getByLabel('搜索问题', { exact: true }).fill('中文 MCP 实际搜索')
    await page.getByRole('button', { name: '查询并加入证据', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const searched = await page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(item => item.id === id)!, session.id)
    expect(searched.evidence[0]).toMatchObject({ kind: 'web', contentType: 'snippet', query: '中文 MCP 实际搜索', title: '验收资料', url: 'https://example.org/evidence', text: '实际 MCP 返回的中文资料。', extensionId: installed.id })
    expect(searched.messages.find(message => message.status === 'failed')).toMatchObject({ content: rawDiagnostic, diagnostic: { code: 'invalid_json', finishReason: 'stop', responseId: 'diagnostic-fixture' } })
    const calls = await page.evaluate(() => window.roundtable.extensionState())
    expect(calls.calls.at(-1)).toMatchObject({ tool: 'search_fixture', status: 'complete', arguments: { query: '中文 MCP 实际搜索' } })
    await page.getByRole('button', { name: /^证据/ }).click()
    await expect(page.locator('.evidence-card')).toContainText('验收资料')
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, 'diagnostic-and-evidence.png') })

    await page.getByRole('button', { name: '组件中心', exact: true }).click()
    await expect(page.getByRole('heading', { name: '可选组件', exact: true })).toBeVisible()
    await expect(page.locator('.extension-card')).toHaveCount(12)
    await expect(page.getByRole('button', { name: '离线导入', exact: true }).first()).toBeEnabled()
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, 'components.png') })
    await page.getByRole('button', { name: '扩展商店', exact: true }).click()
    await page.getByRole('tab', { name: /^已安装/ }).click()
    await page.getByRole('button', { name: '卸载 local-review', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await expect(page.locator('.extension-card').filter({ has: page.getByRole('heading', { name: 'local-review', exact: true }) })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await desktop?.close(); await handler.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})
