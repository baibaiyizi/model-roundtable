import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }
async function launch(directory: string): Promise<ElectronApplication> {
  const executable = process.env.ROUNDTABLE_EXECUTABLE
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  return electron.launch({ executablePath: executable, args: executable ? [] : [resolve('.')], cwd: executable ? dirname(executable) : resolve('.'), env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
}

test('免Key浏览器搜索共享正文、验证码保留窗口、停止不保存迟到证据', async () => {
  const directory = resolve('.test-data', `search-usability-${Date.now()}`); await mkdir(directory, { recursive: true })
  const upstream = createServer((request, response) => { void (async () => {
    let raw = ''; for await (const chunk of request) raw += chunk.toString()
    const body = JSON.parse(raw)
    const prompt = JSON.stringify(body.messages)
    const query = prompt.includes('验证码流程') ? 'fixture-captcha' : prompt.includes('取消流程') ? 'fixture-cancel' : 'fixture-search'
    const text = prompt.includes('只返回 JSON') ? JSON.stringify({ query }) : '已阅读共同证据。'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })().catch(() => { response.writeHead(500); response.end() }) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const port = (upstream.address() as { port: number }).port
  const desktop = await launch(directory)
  try {
    const page = await desktop.firstWindow(); await expect(page.locator('.welcome-page')).toBeVisible()
    await desktop.evaluate(({ app }) => {
      app.on('session-created', current => {
        void current.protocol.handle('https', request => {
          const url = new URL(request.url), query = url.searchParams.get('q') ?? ''
          let html = `<html><title>原文页面</title><article><h1>原文页面</h1><p>${'这是实际读取并保存的共同正文。'.repeat(80)}</p></article></html>`
          if (url.hostname === 'www.bing.com') {
            html = query.includes('captcha') ? '<html><div id="b_captcha">验证您是真人</div></html>' : query.includes('cancel') ? '<html><p>等待结果</p></html>' : '<html><div class="b_algo"><h2><a href="https://fixture.example.org/article">可引用资料</a></h2><p>搜索摘要</p></div></html>'
          }
          return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } })
        })
      })
    })
    const provider = await page.evaluate(async port => {
      await window.roundtable.saveSettings({ search: { provider: 'browser', engine: 'bing' } })
      await window.roundtable.saveNetworkBindings({ search: { mode: 'direct' }, web: { mode: 'direct' } })
      return window.roundtable.saveProvider({ name: '可控搜索模型', baseUrl: `http://127.0.0.1:${port}/v1`, modelIds: ['a', 'b'], tokenParameter: 'max_tokens', streamUsage: false, timeoutMs: 20000 })
    }, port)
    const create = (topic: string) => page.evaluate(async ({ id, topic }) => window.roundtable.createSession({ topic, mode: 'roundtable', searchEnabled: true, participants: ['a', 'b'].map(modelId => ({ id: modelId, name: modelId, model: { providerId: id, modelId }, role: '' })), moderator: { providerId: id, modelId: 'a' }, knowledgeBaseIds: [], limits: { autoTurns: 12, maxCalls: 30, maxOutputTokens: 1000, maxSearches: null, contextChars: 48000 } }), { id: provider.id, topic })
    const normal = await create('共同资料流程')
    await expect.poll(async () => (await page.evaluate(() => window.roundtable.bootstrap())).sessions.find(value => value.id === normal.id)?.status).toBe('complete')
    const saved = (await page.evaluate(() => window.roundtable.bootstrap())).sessions.find(value => value.id === normal.id)!
    expect(saved.evidence[0]).toMatchObject({ contentType: 'body', url: 'https://fixture.example.org/article' }); expect(saved.evidence[0].text).toContain('共同正文')
    expect(saved.run?.webSnapshots?.[0].source).toContain('浏览器搜索')
    const challenge = await create('验证码流程')
    await expect.poll(async () => (await page.evaluate(() => window.roundtable.bootstrap())).sessions.find(value => value.id === challenge.id)?.status, { timeout: 15000 }).toBe('error')
    expect((await page.evaluate(() => window.roundtable.bootstrap())).sessions.find(value => value.id === challenge.id)?.evidence).toEqual([])
    await expect.poll(() => desktop.windows().length).toBe(2)
    const challengeWindow = desktop.windows().find(value => value !== page)!
    await expect(challengeWindow.locator('#b_captcha')).toBeVisible()
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('fixture-captcha')) window.close() })
    await expect.poll(() => desktop.windows().length).toBe(1)
    const cancelled = await create('取消流程')
    await expect.poll(() => desktop.windows().length).toBe(2)
    await page.evaluate(id => window.roundtable.sessionAction({ sessionId: id, action: 'stop' }), cancelled.id)
    await expect.poll(() => desktop.windows().length).toBe(1)
    await expect.poll(async () => (await page.evaluate(() => window.roundtable.bootstrap())).activeSessionIds?.includes(cancelled.id)).toBe(false)
    const stopped = (await page.evaluate(() => window.roundtable.bootstrap())).sessions.find(value => value.id === cancelled.id)!
    expect(stopped.status).toBe('stopped'); expect(stopped.evidence).toEqual([])
  } finally { await desktop.close(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done())) }
})

test('真实免Key搜索实况报告（仅显式启用，不依赖云模型）', async ({}, testInfo) => {
  test.skip(process.env.ROUNDTABLE_LIVE_SEARCH !== '1', '通过 ROUNDTABLE_LIVE_SEARCH=1 进行一次真实免费搜索，网络失败如实记录。')
  const directory = resolve('.test-data', `live-search-${Date.now()}`); await mkdir(directory, { recursive: true })
  const desktop = await launch(directory)
  try {
    const page = await desktop.firstWindow(); await expect(page.locator('.welcome-page')).toBeVisible()
    const report = await page.evaluate(async () => {
      await window.roundtable.saveSettings({ search: { provider: 'browser', engine: 'bing' } })
      const startedAt = new Date().toISOString()
      try { const evidence = await window.roundtable.searchWeb('Mihomo GitHub proxy core'); return { startedAt, finishedAt: new Date().toISOString(), ok: true, engine: 'bing', results: evidence.map(item => ({ title: item.title, url: item.url, contentType: item.contentType, fetchError: item.fetchError, characters: item.text.length })) } }
      catch (error) { return { startedAt, finishedAt: new Date().toISOString(), ok: false, engine: 'bing', error: error instanceof Error ? error.message : String(error) } }
    })
    const reportPath = join(directory, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2)); await testInfo.attach('live-search-report', { path: reportPath, contentType: 'application/json' })
    expect(typeof report.ok).toBe('boolean')
  } finally { await desktop.close() }
})
