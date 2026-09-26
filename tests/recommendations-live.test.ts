import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RuntimeManager } from '../src/main/components/manager'
import { ExtensionService } from '../src/main/extensions/service'
import type { ExtensionOptions } from '../src/main/extensions/ports'
import type { ExtensionJob, InstalledExtension } from '../src/shared/extensions'
import { extensionRecommendations } from '../src/shared/extension-recommendations'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), '圆桌推荐扩展QA-')); const data = new Map<string, unknown>(); const secrets = new Map<string, string>(); const runtime = new RuntimeManager({ manifestPath: resolve('resources/components/manifest.json'), cacheDir: resolve('.cache/components-runtime') })
  const options: ExtensionOptions = { stateDir: directory, runtime, emit: () => {}, openExternal: async () => { throw new Error('QA 不进行账号登录') }, store: { getEntity: (kind, id) => structuredClone(data.get(`${kind}:${id}`)) as any, listEntities: kind => structuredClone([...data].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => value)) as any, saveEntity: (kind, id, value) => { data.set(`${kind}:${id}`, structuredClone(value)) }, deleteEntity: (kind, id) => { data.delete(`${kind}:${id}`) }, getSecret: async id => secrets.get(id) ?? '', setSecret: async (id, value) => { secrets.set(id, value) }, getProject: id => ({ id, name: 'QA', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }) } }
  return { service: new ExtensionService(options), runtime }
}
async function wait(service: ExtensionService, job: ExtensionJob): Promise<InstalledExtension> {
  for (let i = 0; i < 2400; i++) { const current = service.state().jobs.find(item => item.id === job.id)!; if (current.status !== 'running') { if (current.status !== 'complete') throw new Error(current.error ?? current.status); return service.state().installed.find(item => item.id === job.extensionId)! } await new Promise(resolve => setTimeout(resolve, 100)) }
  await service.cancelJob(job.id); throw new Error('在线安装超过 240 秒')
}

describe.skipIf(process.env.ROUNDTABLE_LIVE_RECOMMENDATIONS !== '1')('推荐扩展真实 Windows 安装验收', () => {
  for (const recommendation of extensionRecommendations) it(recommendation.name, async () => {
    const { service, runtime } = await harness(); let browserPage: ReturnType<typeof createServer> | undefined; const report: Record<string, unknown> = { id: recommendation.id, kind: recommendation.kind, checkedAt: new Date().toISOString(), platform: process.platform }
    try {
      const entry = await service.details({ kind: recommendation.kind, id: recommendation.id }); report.version = entry.version
      const brave = entry.id.includes('brave-search'); let installed = await wait(service, service.install({ kind: entry.kind, id: entry.id, version: entry.version, ...(entry.kind === 'mcp' ? { packageIndex: 0 } : {}), ...(brave ? { secrets: { BRAVE_API_KEY: 'roundtable-synthetic-invalid-qa-key' } } : {}) }))
      report.status = installed.status; report.tools = installed.tools.map(tool => tool.name); report.error = installed.error
      expect(installed.status, installed.error).toBe('ready')
      if (entry.id.includes('playwright') && process.env.ROUNDTABLE_QA_BROWSER === 'msedge') {
        await service.remove(installed.id)
        installed = await wait(service, service.importMcpConfiguration({ name: 'Playwright 官方 Edge 配置 QA', configuration: JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: [`@playwright/mcp@${entry.packages![0].version}`, '--browser', 'msedge', '--headless', '--isolated'] } } }) })[0]); expect(installed.status, installed.error).toBe('ready')
        report.browserConfiguration = '目录安装与握手通过；实际网页使用通过导入同版本官方 --browser msedge --headless --isolated 配置验证（本机没有 Chrome）'
        browserPage = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><title>模型圆桌浏览器验收</title><body><h1>受控网页内容</h1></body></html>') }); browserPage.listen(0, '127.0.0.1'); await once(browserPage, 'listening')
      }
      if (entry.kind === 'skill') {
        service.saveGrant({ projectId: 'qa', extensionId: installed.id, enabled: true, tools: [] }); const scope = await service.createScope({ projectId: 'qa', runId: 'qa', mode: 'discussion', signal: new AbortController().signal })
        try { const output = await scope.call('skill_read', { skillId: installed.id }) as { text: string }; expect(output.text).toContain('---'); report.usage = '安装固定提交并通过 skill_read 读取 SKILL.md；未执行脚本' } finally { await scope.close() }
      } else {
        const toolName = brave ? 'brave_web_search' : entry.id.includes('context7') ? 'resolve-library-id' : browserPage ? 'browser_navigate' : 'browser_close'; const tool = installed.tools.find(tool => tool.name === toolName); expect(tool).toBeDefined()
        if (brave) { report.usage = '合成占位 Key 仅用于本机握手与工具发现，未调用 Brave 搜索接口；真实搜索需用户 Key' }
        else {
          service.saveGrant({ projectId: 'qa', extensionId: installed.id, enabled: true, tools: [{ name: tool!.name, schemaHash: tool!.schemaHash, access: 'read' }] }); const scope = await service.createScope({ projectId: 'qa', runId: 'qa', mode: 'discussion', signal: new AbortController().signal })
          try { const alias = scope.tools.find(item => item.description.includes(`· ${toolName}\n`))!.name; const output = await scope.call(alias, entry.id.includes('context7') ? { libraryName: 'react', query: 'React useState API documentation' } : browserPage ? { url: `http://127.0.0.1:${(browserPage.address() as { port: number }).port}/` } : {}) as { content?: unknown }; report.usage = entry.id.includes('context7') ? '实际调用 resolve-library-id（无 Key）' : browserPage ? '实际通过 headless Edge 导航本机受控网页并读取页面标题' : '实际调用 browser_close；未启动浏览器或验证网页自动化'; if (browserPage) expect(JSON.stringify(output.content)).toContain('模型圆桌浏览器验收'); report.outputPreview = JSON.stringify(output.content).slice(0, 600) } finally { await scope.close() }
        }
      }
      await service.remove(installed.id); report.passed = true
    } catch (error) { report.passed = false; report.failure = error instanceof Error ? error.message : String(error); report.calls = service.state().calls.map(call => ({ tool: call.tool, status: call.status, error: call.error, output: call.output })); throw error }
    finally { await service.shutdown(); await runtime.shutdown(); if (browserPage) { browserPage.closeAllConnections(); await new Promise<void>(resolve => browserPage!.close(() => resolve())) } await mkdir(resolve('.test-data/recommendations'), { recursive: true }); await writeFile(resolve('.test-data/recommendations', recommendation.id.replaceAll('/', '_') + '.json'), JSON.stringify(report, null, 2)); console.info(JSON.stringify(report)) }
  }, 300000)
})
