import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RuntimeManager } from '../src/main/components/manager'
import { ExtensionService } from '../src/main/extensions/service'
import type { ExtensionOptions } from '../src/main/extensions/ports'
import type { ExtensionJob, InstalledExtension } from '../src/shared/extensions'

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), '圆桌在线扩展QA-')); const data = new Map<string, unknown>(); const secrets = new Map<string, string>(); const runtime = new RuntimeManager({ manifestPath: resolve('resources/components/manifest.json'), cacheDir: resolve('.cache/components-runtime') })
  const options: ExtensionOptions = { stateDir: directory, runtime, emit: () => {}, openExternal: async () => { throw new Error('QA 不进行账号登录') }, store: { getEntity: (kind, id) => structuredClone(data.get(`${kind}:${id}`)) as any, listEntities: kind => structuredClone([...data].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => value)) as any, saveEntity: (kind, id, value) => { data.set(`${kind}:${id}`, structuredClone(value)) }, deleteEntity: (kind, id) => { data.delete(`${kind}:${id}`) }, getSecret: async id => secrets.get(id) ?? '', setSecret: async (id, value) => { secrets.set(id, value) }, getProject: id => ({ id, name: 'QA', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }) } }
  return { service: new ExtensionService(options), directory }
}
async function wait(service: ExtensionService, job: ExtensionJob): Promise<InstalledExtension> { for (let i = 0; i < 1800; i++) { const current = service.state().jobs.find(item => item.id === job.id)!; if (current.status !== 'running') { if (current.status !== 'complete') throw new Error(current.error ?? current.status); return service.state().installed.find(item => item.id === job.extensionId)! } await new Promise(resolve => setTimeout(resolve, 100)) } await service.cancelJob(job.id); throw new Error('在线安装超过 180 秒') }
describe.skipIf(process.env.ROUNDTABLE_LIVE_EXTENSIONS !== '1')('公开在线扩展安装验收（无用户资料、无外部写工具）', () => {
  it('skills.sh 搜索、GitHub固定提交、官方 CLI 安装、只读检查更新与卸载', async () => {
    const { service } = await harness()
    try { const search = await service.search({ kind: 'skill', query: 'find-skills' }); const found = search.entries.find(entry => entry.source === 'vercel-labs/skills' && entry.skillName === 'find-skills'); expect(found).toBeDefined(); const details = await service.details({ kind: 'skill', id: found!.id, version: found!.version }); expect(details.commit).toMatch(/^[a-f0-9]{40}$/); const installed = await wait(service, service.install({ kind: 'skill', id: details.id, version: details.commit })); expect(installed.status).toBe('ready'); expect(installed.skillFiles).toContain('SKILL.md'); const updated = await service.checkUpdates(); expect(updated[0].revisionId).toBe(installed.revisionId); expect(updated[0].updateCheckedAt).toBeTruthy(); await service.remove(installed.id); expect(service.state().installed).toHaveLength(0); console.info('公开 Skill 完成：', details.id, details.commit) }
    finally { await service.shutdown() }
  }, 240000)
  it('官方 Registry 的 npm stdio 搜索、固定包安装与真实工具发现', async () => {
    const { service, directory } = await harness()
    try { const search = await service.search({ kind: 'mcp', query: 'filesystem' }); const candidates = search.entries.filter(entry => entry.packages?.some(pkg => pkg.registryType === 'npm' && pkg.identifier === '@ai-capabilities-suite/mcp-filesystem')); expect(candidates.length).toBeGreaterThan(0); const found = candidates[0]; const details = await service.details({ kind: 'mcp', id: found.id, version: found.version }); const index = details.packages!.findIndex(pkg => pkg.registryType === 'npm' && pkg.identifier === '@ai-capabilities-suite/mcp-filesystem'); const pkg = details.packages![index]; const values: Record<string, string> = {}; values.WORKSPACE_ROOT = directory; const installed = await wait(service, service.install({ kind: 'mcp', id: details.id, version: details.version, packageIndex: index, values })); expect(installed.status, installed.error).toBe('ready'); expect((await service.test(installed.id)).length).toBeGreaterThan(0); await service.remove(installed.id); expect(service.state().installed).toHaveLength(0); console.info('公开 MCP 完成：', details.id, pkg.identifier, pkg.version) }
    finally { await service.shutdown() }
  }, 240000)
  it('标准 uvx 配置解析 PyPI 固定版本，独立 Python 环境真实建立 MCP stdio', async () => {
    const { service } = await harness()
    try { const installed = await wait(service, service.importMcpConfiguration({ name: 'PyPI QA', configuration: JSON.stringify({ mcpServers: { clock: { command: 'uvx', args: ['mcp-server-time'] } } }) })[0]); expect(installed.status, installed.error).toBe('ready'); expect((await service.test(installed.id)).some(tool => tool.name === 'get_current_time')).toBe(true); const details = await service.details({ kind: 'mcp', id: installed.catalogId }); expect(details.packages?.[0].version).toMatch(/^\d+\./); await service.remove(installed.id); expect(service.state().installed).toHaveLength(0) }
    finally { await service.shutdown() }
  }, 240000)
})
