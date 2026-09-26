import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import type { Tool } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { ExtensionService } from '../src/main/extensions/service'
import { ExtensionCatalog } from '../src/main/extensions/catalog'
import { ExtensionInstaller, type Revision } from '../src/main/extensions/installer'
import { McpConnection } from '../src/main/extensions/connection'
import { digest } from '../src/main/extensions/util'
import { extensionRecommendations, sortCatalogEntries } from '../src/shared/extension-recommendations'
import { toolEvidence } from '../src/main/extensions/evidence'
import type { ExtensionOptions, ExtensionScope } from '../src/main/extensions/ports'
import type { ExtensionCall, ExtensionJob, InstalledExtension } from '../src/shared/extensions'
import type { ProviderNetworkPort } from '../src/shared/network'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), '圆桌扩展-')); const data = new Map<string, unknown>(); const secrets = new Map<string, string>()
  const options: ExtensionOptions = { stateDir: directory, store: { getEntity: (kind, id) => structuredClone(data.get(`${kind}:${id}`)) as any, listEntities: kind => structuredClone([...data].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => value)) as any, saveEntity: (kind, id, value) => { data.set(`${kind}:${id}`, structuredClone(value)) }, deleteEntity: (kind, id) => { data.delete(`${kind}:${id}`) }, getSecret: async id => secrets.get(id) ?? '', setSecret: async (id, value) => { secrets.set(id, value) }, getProject: id => id === 'p' ? { id, name: '项目', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' } : undefined }, runtime: { resolve: async () => { throw new Error('未请求运行时') }, ensure: async () => { throw new Error('未请求运行时') } }, emit: () => {}, openExternal: async () => {} }
  const service = new ExtensionService(options); cleanups.push(() => service.shutdown()); return { directory, data, secrets, options, service }
}
async function server() {
  const calls: unknown[] = []; let schemaVersion = 1; let block: Promise<void> | undefined
  const handler = createMcpHandler(() => { const mcp = new Server({ name: 'controlled', version: '1' }, { capabilities: { tools: {}, resources: {}, prompts: {} } }); mcp.setRequestHandler('tools/list', () => ({ tools: [{ name: 'search', description: `搜索 ${schemaVersion}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }, annotations: { readOnlyHint: true } }, { name: 'publish', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] as Tool[] })); mcp.setRequestHandler('tools/call', async request => { calls.push(request.params); if (block) await block; const output = { items: [{ title: '出处', url: 'https://example.org/source', excerpt: String(request.params.arguments?.q ?? request.params.arguments?.text) }] }; return { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] } }); mcp.setRequestHandler('resources/list', () => ({ resources: [{ name: 'fixture', uri: 'test://fixture' }] })); mcp.setRequestHandler('resources/read', request => ({ contents: [{ uri: request.params.uri, text: '可追溯资源' }] })); mcp.setRequestHandler('prompts/list', () => ({ prompts: [{ name: 'explain' }] })); mcp.setRequestHandler('prompts/get', () => ({ messages: [{ role: 'user', content: { type: 'text', text: '解释材料' } }] })); return mcp }); const node = toNodeHandler(handler); const http = createServer((req, res) => { void node(req, res) }); http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`; cleanups.push(async () => { await handler.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) }); return { url, calls, change: () => { schemaVersion++ }, block: (pending?: Promise<void>) => { block = pending } }
}
async function complete(service: ExtensionService, job: ExtensionJob): Promise<InstalledExtension> { for (let i = 0; i < 500; i++) { const state = service.state(); const current = state.jobs.find(item => item.id === job.id)!; if (current.status !== 'running') { expect(current.error).toBeUndefined(); expect(current.status).toBe('complete'); return state.installed.find(item => item.id === job.extensionId)! } await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('扩展安装超时') }
async function installHttp(service: ExtensionService, url: string) { return complete(service, service.importMcpConfiguration({ name: 'fixture', configuration: JSON.stringify({ mcpServers: { example: { url, headers: { 'X-Token': 'hidden-api-secret' } } } }) })[0]) }
function grant(service: ExtensionService, installed: InstalledExtension, external = false) { service.saveGrant({ projectId: 'p', extensionId: installed.id, enabled: true, tools: installed.tools.map(tool => ({ name: tool.name, schemaHash: tool.schemaHash, access: tool.name === 'publish' ? external ? 'external' : 'project-write' : 'read' })) }) }
const scopeInput = (mode: 'discussion' | 'execution' = 'execution', signal = new AbortController().signal) => ({ projectId: 'p', runId: 'r', attempt: 2, contextVersion: 3, mode, signal })
const alias = (scope: ExtensionScope, original: string) => scope.tools.find(tool => tool.description.includes(`· ${original}\n`))!.name

describe('扩展代理与证据', () => {
  for (const stage of ['credentials', 'environment'] as const) it(`MCP 在等待 ${stage} 时关闭，不发送迟到请求或启动子进程`, async () => {
    const upstream = await server(); const { service, options } = await setup()
    const installed = await installHttp(service, upstream.url)
    const revision = JSON.parse(await options.store.getSecret(`extension-revision:${installed.revisionId}`)) as Revision
    let resume!: () => void, entered!: () => void, released = 0, requests = 0
    const ready = new Promise<void>(resolve => { entered = resolve })
    const blocked = () => { entered(); return new Promise<string>(resolve => { resume = () => resolve('secret') }) }
    const getSecret = options.store.getSecret
    if (stage === 'credentials') {
      revision.secretKeys = ['slow']
      options.store.getSecret = async key => key === `extension-value:${revision.id}:slow` ? blocked() : getSecret(key)
    } else {
      revision.remote = undefined
      revision.command = { executable: 'must-not-start.exe', args: [], env: {}, cwd: options.stateDir }
    }
    options.network = {
      acquireForScope: async () => ({ snapshot: { selection: { mode: 'direct' }, label: '受控线路' }, fetch: async () => { requests++; throw new Error('不应发送请求') }, environment: async () => { if (stage === 'environment') await blocked(); return {} }, release: () => { released++ } }),
    } as unknown as ProviderNetworkPort
    const connection = new McpConnection(options, revision)
    const connected = connection.connect(new AbortController().signal).then(() => undefined, error => error)
    await ready; await connection.close(); resume()
    expect((await connected)?.message).toContain('扩展连接已关闭')
    expect(released).toBe(1); expect(requests).toBe(0)
  })
  it('HTTP MCP 使用自身线路快照，连接关闭释放，失败不调用默认网络', async () => {
    const upstream = await server(); const { service, options } = await setup()
    let routed = 0, defaults = 0, acquired = 0, released = 0, failed = false
    const scopes: string[] = []
    options.fetch = async () => { defaults++; throw new Error('不应使用默认网络') }
    options.network = {
      acquireForScope: async scope => {
        scopes.push(scope)
        if (failed) throw new Error('所选节点已失效')
        acquired++
        return { snapshot: { selection: { mode: 'direct' }, label: '受控线路' }, fetch: async (input, init) => { routed++; return fetch(input, init) }, environment: async () => ({}), release: () => { released++ } }
      },
    } as ProviderNetworkPort
    const [job] = await service.importMcpConfiguration({ name: '独立线路', configuration: JSON.stringify({ mcpServers: { isolated: { type: 'http', url: upstream.url } } }) })
    const installed = await complete(service, job)
    expect(routed).toBeGreaterThan(0); expect(defaults).toBe(0)
    expect(scopes.every(scope => scope === `mcp:${installed.id}`)).toBe(true)
    expect(released).toBe(acquired)
    const before = routed; failed = true
    await expect(service.test(installed.id)).rejects.toThrow('所选节点已失效')
    expect(routed).toBe(before); expect(defaults).toBe(0)
  })
  it('没有真实网页 URL 的搜索结果保存为工具证据，保留调用引用', () => {
    const binding = { projectId: 'p', extensionId: 'e', tool: 'find', schemaHash: 'a'.repeat(64), queryField: 'q', resultPath: 'items', titleField: 'title', urlField: 'url', textField: 'text', contentType: 'snippet' as const }
    const evidence = toolEvidence({ structuredContent: { items: [{ title: '内部资料', text: '数据库片段', url: 'record:42' }, { title: '普通结果', text: '没有网址' }] } }, 'c', 'e', '工具', binding, '检索'); expect(evidence.map(item => item.kind)).toEqual(['tool', 'tool']); expect(evidence.every(item => item.url === undefined && item.locator === 'mcp-call:c' && item.toolCallId === 'c')).toBe(true)
  })
  it('连接测试登记生命周期租约，卸载不能被迟到测试结果复活', async () => {
    const upstream = await server(); const { service, options } = await setup(); const installed = await installHttp(service, upstream.url); const original = options.store.getSecret; let resume!: () => void; let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve }); options.store.getSecret = async key => { if (key === `extension-revision:${installed.revisionId}`) { entered(); await new Promise<void>(resolve => { resume = resolve }) } return original(key) }
    const testing = service.test(installed.id); await ready; await expect(service.remove(installed.id)).rejects.toThrow('操作正在进行'); resume(); await testing; options.store.getSecret = original; await service.remove(installed.id); expect(service.state().installed).toHaveLength(0)
  })
  it('SDK v2 标准 stdio 子进程建立连接并可真正调用', async () => {
    const { service, directory } = await setup(); const script = join(directory, '本机服务.mjs'); const require = createRequire(import.meta.url); const serverPath = pathToFileURL(require.resolve('@modelcontextprotocol/server')).href; const stdioPath = pathToFileURL(require.resolve('@modelcontextprotocol/server/stdio')).href
    await writeFile(script, `import {Server} from ${JSON.stringify(serverPath)}; import {StdioServerTransport} from ${JSON.stringify(stdioPath)}; const s=new Server({name:'stdio',version:'1'},{capabilities:{tools:{}}}); s.setRequestHandler('tools/list',()=>({tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]})); s.setRequestHandler('tools/call',r=>({content:[{type:'text',text:r.params.arguments.text}]})); await s.connect(new StdioServerTransport());`)
    const installed = await complete(service, service.importMcpConfiguration({ name: 'stdio', configuration: JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [script] } } }) })[0]); expect(installed.status).toBe('ready'); grant(service, installed); const scope = await service.createScope(scopeInput()); cleanups.push(scope.close); const output: any = await scope.call(alias(scope, 'echo'), { text: '实际进程结果' }); expect(output.content[0].text).toBe('实际进程结果')
  })
  it('OAuth 使用标准发现、PKCE、回环回调与加密 secret 存储，密钥不进入工具记录', async () => {
    const fixture = await server(); const { service, options, secrets, data } = await setup(); let base = '', challenge = '', authorized = 0
    const oauth = createServer(async (req, res) => {
      const path = new URL(req.url!, 'http://127.0.0.1').pathname; res.setHeader('content-type', 'application/json')
      if (path.includes('oauth-protected-resource')) { res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] })); return }
      if (path.includes('oauth-authorization-server') || path.includes('openid-configuration')) { res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })); return }
      if (path === '/register') { let raw = ''; for await (const chunk of req) raw += chunk; res.end(JSON.stringify({ ...JSON.parse(raw), client_id: 'fixture-client' })); return }
      if (path === '/token') { let raw = ''; for await (const chunk of req) raw += chunk; const body = new URLSearchParams(raw); expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge); authorized++; res.end(JSON.stringify({ access_token: 'oauth-fixture-private-token', refresh_token: 'oauth-fixture-private-refresh', token_type: 'Bearer', expires_in: 3600 })); return }
      if (req.headers.authorization !== 'Bearer oauth-fixture-private-token') { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }); res.end('{}'); return }
      const body = req.method === 'POST' ? await (async () => { let body = ''; for await (const chunk of req) body += chunk; return body })() : undefined; const response = await fetch(fixture.url, { method: req.method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(req.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': String(req.headers['mcp-protocol-version']) } : {}) }, body }); res.statusCode = response.status; res.setHeader('content-type', response.headers.get('content-type') ?? 'application/json'); res.end(await response.text())
    }); oauth.listen(0, '127.0.0.1'); await once(oauth, 'listening'); base = `http://127.0.0.1:${(oauth.address() as { port: number }).port}`; cleanups.push(async () => { oauth.closeAllConnections(); await new Promise<void>(resolve => oauth.close(() => resolve())) })
    options.openExternal = async target => { const url = new URL(target); challenge = url.searchParams.get('code_challenge')!; const callback = new URL(url.searchParams.get('redirect_uri')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', base); expect((await fetch(callback)).status).toBe(200) }
    const installed = await installHttp(service, `${base}/mcp`); expect(installed.status).toBe('needs-configuration'); expect((await service.login(installed.id)).authenticated).toBe(true); expect(authorized).toBe(1); expect([...secrets.values()].some(value => value.includes('oauth-fixture-private-token'))).toBe(true); grant(service, service.state().installed[0]); const scope = await service.createScope(scopeInput()); cleanups.push(scope.close); await scope.call(alias(scope, 'search'), { q: 'oauth-fixture-private-token' }); expect(JSON.stringify([...data.values()])).not.toContain('oauth-fixture-private-token')
  })
  it('真实 HTTP MCP 发现工具、资源和提示；讨论仅放行只读授权并保存来源', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); expect(installed.status).toBe('ready'); expect(installed.tools).toHaveLength(6); grant(service, installed)
    const scope = await service.createScope(scopeInput('discussion')); cleanups.push(scope.close); expect(scope.tools.some(tool => tool.description.includes('· publish'))).toBe(false)
    const result: any = await scope.call(alias(scope, 'search'), { q: '中文检索' }); expect(result.evidence[0].kind).toBe('tool'); expect(result.evidence[0].toolCallId).toBe(result.toolCallId)
    const resource: any = await scope.call(alias(scope, 'roundtable.resources.read'), { uri: 'test://fixture' }); expect(resource.structuredContent.contents[0].text).toBe('可追溯资源')
    const call = service.state().calls[0]; expect(call.revisionId).toBe(installed.revisionId); expect(call.attempt).toBe(2); expect(call.contextVersion).toBe(3)
  })
  it('本地 schema 校验阻止错误请求；工具定义变化需要重新授权', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); grant(service, installed)
    const scope = await service.createScope(scopeInput()); await expect(scope.call(alias(scope, 'search'), { q: 4 })).rejects.toThrow('参数'); expect(upstream.calls).toHaveLength(0); await scope.close()
    upstream.change(); await expect(service.createScope(scopeInput())).rejects.toThrow('定义变化')
  })
  it('外部操作必须单次批准；凭据出现在任意文本字段也不进入记录或证据', async () => {
    const upstream = await server(); const { service, data } = await setup(); const installed = await installHttp(service, upstream.url); grant(service, installed, true); const scope = await service.createScope(scopeInput()); cleanups.push(scope.close)
    const pending = scope.call(alias(scope, 'publish'), { text: 'hidden-api-secret' }); await expect.poll(() => service.state().approvals.length).toBe(1); expect(upstream.calls).toHaveLength(0); expect(JSON.stringify(service.state().approvals)).not.toContain('hidden-api-secret')
    service.resolveApproval({ id: service.state().approvals[0].id, allow: true }); await pending; expect(upstream.calls).toHaveLength(1); expect(JSON.stringify([...data.values()])).not.toContain('hidden-api-secret')
  })
  it('拒绝审批和等待审批时取消都不触发上游；停止后调用不会复活', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); grant(service, installed, true); const controller = new AbortController(); const scope = await service.createScope(scopeInput('execution', controller.signal))
    const rejected = scope.call(alias(scope, 'publish'), { text: 'first' }).catch(error => error); await expect.poll(() => service.state().approvals.length).toBe(1); service.resolveApproval({ id: service.state().approvals[0].id, allow: false }); expect(((await rejected) as Error).message).toContain('拒绝')
    const cancelled = scope.call(alias(scope, 'publish'), { text: 'second' }).catch(error => error); await expect.poll(() => service.state().approvals.length).toBe(2); controller.abort(); await cancelled; await scope.close(); expect(service.state().approvals[1].status).toBe('cancelled'); expect(upstream.calls).toHaveLength(0); await expect(scope.call(alias(scope, 'search'), { q: 'late' })).rejects.toThrow()
  })
  it('搜索绑定只接受已授权的 schema，并把明确映射的网页片段存入调用快照', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); const tool = installed.tools.find(t => t.name === 'search')!; const binding = { projectId: 'p', extensionId: installed.id, tool: tool.name, schemaHash: tool.schemaHash, queryField: 'q', resultPath: 'items', titleField: 'title', urlField: 'url', textField: 'excerpt', contentType: 'snippet' as const }
    expect(() => service.saveSearchBinding(binding)).toThrow('只读授权'); grant(service, installed); service.saveSearchBinding(binding); const evidence = await service.searchEvidence(scopeInput('discussion'), '目标材料'); expect(evidence[0].url).toBe('https://example.org/source'); expect(evidence[0].query).toBe('目标材料'); expect(service.state().calls[0].evidence).toEqual(evidence); service.removeSearchBinding('p'); expect(service.getSearchBinding('p')).toBeUndefined()
  })
  it('绑定搜索只能走专用入口；运行中绑定保持冻结，旧 schema 必须重新绑定', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); const tool = installed.tools.find(t => t.name === 'search')!; grant(service, installed); const binding = { projectId: 'p', extensionId: installed.id, tool: tool.name, schemaHash: tool.schemaHash, queryField: 'q', resultPath: 'items', titleField: 'title', urlField: 'url', textField: 'excerpt', contentType: 'snippet' as const }; service.saveSearchBinding(binding)
    const executing = await service.createScope(scopeInput('execution')); expect(executing.tools.some(tool => tool.description.includes('· search\n'))).toBe(false); await executing.close(); const scope = await service.createScope(scopeInput('discussion')); expect(scope.tools.some(tool => tool.description.includes('· search\n'))).toBe(false); expect(scope.search).toBeDefined(); service.removeSearchBinding('p'); expect((await scope.search!('运行中固定绑定'))[0].query).toBe('运行中固定绑定'); await scope.close()
    service.saveSearchBinding(binding); upstream.change(); const tools = await service.test(installed.id); grant(service, { ...installed, tools }); const changed = await service.createScope(scopeInput('discussion')); await expect(changed.search!('不应发出')).rejects.toThrow('重新绑定'); await changed.close(); expect(upstream.calls).toHaveLength(1)
  })
  it('撤销项目授权立即中止旧 scope，之后无上游调用；其他项目不受影响', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); grant(service, installed); const scope = await service.createScope(scopeInput()); const tool = alias(scope, 'search'); service.saveGrant({ projectId: 'p', extensionId: installed.id, enabled: false, tools: [] }); await expect(scope.call(tool, { q: '撤权后不执行' })).rejects.toThrow(); await scope.close(); expect(upstream.calls).toHaveLength(0)
  })
  it('取消已发出的读取拒收迟到结果，不保存为完成证据', async () => {
    const upstream = await server(); const { service } = await setup(); const installed = await installHttp(service, upstream.url); grant(service, installed); let release!: () => void; upstream.block(new Promise<void>(resolve => { release = resolve })); const controller = new AbortController(); const scope = await service.createScope(scopeInput('discussion', controller.signal)); const pending = scope.call(alias(scope, 'search'), { q: '慢结果' }).catch(error => error); await expect.poll(() => upstream.calls.length).toBe(1); controller.abort(); release(); await pending; await scope.close(); const call = service.state().calls[0]; expect(call.status).toBe('cancelled'); expect(call.evidence).toEqual([])
  })
  it('配置生成新修订并正确应用远程 URL 参数，活动运行禁止修改', async () => {
    const upstream = await server(); const { service } = await setup()
    const installed = await installHttp(service, upstream.url); grant(service, installed); const scope = await service.createScope(scopeInput()); await expect(service.configure({ id: installed.id, values: {} })).rejects.toThrow('正在使用'); await scope.close()
    const updated = await service.configure({ id: installed.id, values: { label: '新值' }, secrets: { 'X-Token': 'new-hidden-secret' } }); expect(updated.revisionId).not.toBe(installed.revisionId); expect(updated.configuration).toEqual({ label: '新值' }); expect(updated.configuredFields).toContain('X-Token'); expect(JSON.stringify(updated)).not.toContain('new-hidden-secret'); expect((await service.details({ kind: 'mcp', id: installed.catalogId, version: updated.version })).remotes?.[0].url).toBe(upstream.url)
  })
})

describe('技能、安装与目录', () => {
  it('导入目录保存固定副本；按需读取留证，讨论不读取脚本；更新不改变已开始运行', async () => {
    const { service, directory } = await setup(); const source = join(directory, '技能原件'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), '---\nname: 测试技能\ndescription: 测试资料\n---\n第一版'); await writeFile(join(source, 'execute.py'), 'print("never run")')
    const installed = await complete(service, service.importSkill({ kind: 'directory', source })); service.saveGrant({ projectId: 'p', extensionId: installed.id, enabled: true, tools: [] }); const scope = await service.createScope(scopeInput('discussion')); cleanups.push(scope.close)
    await writeFile(join(source, 'SKILL.md'), '---\nname: 测试技能\ndescription: 测试资料\n---\n第二版'); const updated = await complete(service, service.importSkill({ kind: 'directory', source })); expect(updated.revisionId).not.toBe(installed.revisionId)
    const output: any = await scope.call('skill_read', { skillId: installed.id }); expect(output.text).toContain('第一版'); expect(output.evidence[0].kind).toBe('tool'); expect(service.state().calls[0].revisionId).toBe(installed.revisionId); await expect(scope.call('skill_read', { skillId: installed.id, path: 'execute.py' })).rejects.toThrow('脚本'); await expect(scope.call('skill_read', { skillId: installed.id, path: '../../secret.md' })).rejects.toThrow(); await expect(service.remove(installed.id)).rejects.toThrow('运行中的任务')
  })
  it('安装后文件被改动时拒绝读取，取消安装不留下 ready 项', async () => {
    const { service, directory } = await setup(); const source = join(directory, 'skill'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), '---\nname: fixture\ndescription: description\n---\nbody'); const cancelled = service.importSkill({ kind: 'directory', source }); await service.cancelJob(cancelled.id); expect(service.state().installed).toHaveLength(0); expect(service.state().jobs[0].status).toBe('cancelled')
    const installed = await complete(service, service.importSkill({ kind: 'directory', source })); service.saveGrant({ projectId: 'p', extensionId: installed.id, enabled: true, tools: [] }); const revision = await service.revision(installed.revisionId); await writeFile(join(revision.skillRoot!, 'SKILL.md'), 'tampered'); const scope = await service.createScope(scopeInput()); cleanups.push(scope.close); await expect(scope.call('skill_read', { skillId: installed.id })).rejects.toThrow('发生变化')
  })
  it('目录搜索故障明确返回缓存状态，增量同步保留下架状态', async () => {
    const { options } = await setup(); let fail = false; const urls: string[] = []; options.fetch = async input => { urls.push(String(input)); if (fail) throw new Error('network offline'); return Response.json({ servers: [{ server: { name: 'a', description: 'desc', version: '1' }, _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true, status: urls.length > 2 ? 'deleted' : 'active' } } }] }) }; const catalog = new ExtensionCatalog(options); await catalog.search({ kind: 'mcp', query: 'a' }); fail = true; const cached = await catalog.search({ kind: 'mcp', query: 'a' }); expect(cached.cached).toBe(true); expect(cached.warning).toContain('network offline'); fail = false; await catalog.sync(new AbortController().signal); await catalog.sync(new AbortController().signal); expect(urls.at(-1)).toContain('updated_since'); expect(options.store.getEntity<any>('extension-catalog-mcp', 'a').status).toBe('deleted')
  })
  it('远程参数重新配置、密钥独立，未知安装格式明确失败', async () => {
    const { options } = await setup(); const directory = options.stateDir; const entry = { id: 'a', kind: 'mcp' as const, name: 'a', description: '', version: '1', status: 'active' as const, remotes: [{ type: 'streamable-http', url: 'https://example.org/{tenant}/mcp', variables: { tenant: { isRequired: true } } }] }; const revision: Revision = { id: 'r', extensionId: 'a', entry, directory, values: {}, secretKeys: [], tools: [] }; const installer = new ExtensionInstaller(options); await installer.install(entry, { kind: 'mcp', id: 'a', values: { tenant: 'old' } }, revision, new AbortController().signal, () => {}); await installer.configure(revision, { kind: 'mcp', id: 'a', values: { tenant: 'new' } }); expect(revision.remote?.url).toBe('https://example.org/new/mcp')
    await expect(installer.install({ ...entry, remotes: [], packages: [{ registryType: 'docker', identifier: 'x', transport: { type: 'stdio' } }] }, { kind: 'mcp', id: 'a' }, revision, new AbortController().signal, () => {})).rejects.toThrow('不支持 docker')
  })
  it('重启不重放未完成安装、外部审批或结果不确定的工具调用', async () => {
    const { options, service } = await setup(); options.store.saveEntity('extension-job', 'j', { id: 'j', status: 'running' }); options.store.saveEntity('extension-approval', 'a', { id: 'a', status: 'pending' }); options.store.saveEntity('extension-call', 'c', { id: 'c', status: 'running' } satisfies Partial<ExtensionCall>); const restarted = new ExtensionService(options); cleanups.push(() => restarted.shutdown()); expect(restarted.state().jobs[0].status).toBe('failed'); expect(restarted.state().approvals[0].status).toBe('cancelled'); expect(restarted.state().calls[0].status).toBe('unknown'); expect(service.state().calls[0].error).toContain('不自动重试')
  })
})


describe('扩展任务整理与商店热度', () => {
  it('重复关闭连接等待同一轮清理，取消触发的关闭不提前释放运行任务', async () => {
    const { options } = await setup(); const revision: Revision = { id: 'r', extensionId: 'e', entry: { id: 'e', kind: 'mcp', name: 'test', version: '1', status: 'active', description: '' }, directory: options.stateDir, values: {}, secretKeys: [], tools: [] }; const connection = new McpConnection(options, revision)
    let release!: () => void, done = false; connection.client.close = () => new Promise<void>(resolve => { release = resolve })
    const first = connection.close(), second = connection.close(); expect(second).toBe(first); void second.then(() => { done = true }); await Promise.resolve(); expect(done).toBe(false); release(); await first; expect(done).toBe(true)
  })
  it('运行中的安装不能清理，完成记录可删除且不改扩展、密钥和调用记录', async () => {
    const { service, options, directory, secrets } = await setup(); const source = join(directory, '清理测试'); await mkdir(source); await writeFile(join(source, 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\n正文')
    const running = service.importSkill({ kind: 'directory', source }); expect(() => service.clearJob(running.id)).toThrow('仍在运行'); expect(service.clearFinishedJobs()).toBe(0)
    const installed = await complete(service, running); options.store.saveEntity('extension-call', 'history', { id: 'history', status: 'complete', evidence: [] }); const savedSecrets = [...secrets]
    service.clearJob(running.id); expect(service.state().jobs).toEqual([]); expect(service.state().installed).toEqual([installed]); expect(service.state().calls).toHaveLength(1); expect([...secrets]).toEqual(savedSecrets)
    options.store.saveEntity('extension-job', 'failed', { id: 'failed', status: 'failed', error: '以前的错误' }); options.store.saveEntity('extension-job', 'cancelled', { id: 'cancelled', status: 'cancelled' }); expect(service.clearFinishedJobs()).toBe(2)
    const restarted = new ExtensionService(options); cleanups.push(() => restarted.shutdown()); expect(restarted.state().jobs).toEqual([]); expect(restarted.state().installed).toHaveLength(1); expect(restarted.state().calls).toHaveLength(1)
  })
  it('失败安装只保存重新打开的来源，不持久化表单和密钥', async () => {
    const { options } = await setup(); options.fetch = async () => { throw new Error('目录不可用') }; const service = new ExtensionService(options); cleanups.push(() => service.shutdown())
    const job = service.install({ kind: 'mcp', id: 'io.example/test', secrets: { API_KEY: 'not-stored-retry-key' }, values: { foo: 'sensitive-form-value' } })
    await expect.poll(() => service.state().jobs[0].status).toBe('failed'); expect(service.state().jobs[0].source).toEqual({ kind: 'mcp', id: 'io.example/test' }); expect(JSON.stringify(service.state().jobs)).not.toContain('not-stored-retry-key'); expect(JSON.stringify(service.state().jobs)).not.toContain('sensitive-form-value'); service.clearJob(job.id); expect(service.state().jobs).toEqual([])
  })
  it('连接测试失败保留故障状态，清理安装记录不会清除，成功测试才消除旧错误', async () => {
    const { service, options } = await setup(); const upstream = await server(); const installed = await installHttp(service, upstream.url)
    let fail = true; options.network = { acquireForScope: async () => { if (fail) throw new Error('当前线路不可用'); return { fetch, snapshot: { label: '测试', selection: { mode: 'direct' } }, environment: async () => ({}), release: () => {} } } } as unknown as ProviderNetworkPort
    await expect(service.test(installed.id)).rejects.toThrow('当前线路不可用'); service.clearFinishedJobs(); expect(service.state().installed[0]).toMatchObject({ status: 'failed', error: '当前线路不可用' }); fail = false; await service.test(installed.id); expect(service.state().installed[0]).toMatchObject({ status: 'ready' }); expect(service.state().installed[0].error).toBeUndefined()
  })
  it('六个静态推荐没有安装配置，网络故障时不被当作可安装目录快照', async () => {
    expect(extensionRecommendations.filter(entry => entry.kind === 'mcp')).toHaveLength(3); expect(extensionRecommendations.filter(entry => entry.kind === 'skill')).toHaveLength(3)
    expect(extensionRecommendations.every(entry => entry.recommendation?.requirements.length && !entry.version && !entry.packages && !entry.remotes)).toBe(true)
    const { options } = await setup(); options.fetch = async () => { throw new Error('离线') }; const catalog = new ExtensionCatalog(options); await expect(catalog.details({ kind: 'mcp', id: extensionRecommendations[0].id })).rejects.toThrow('离线')
  })
  it('Stars 按仓库去重、缓存 24 小时，同仓库技能共用而未知值不记为零', async () => {
    const { options } = await setup(); let requests = 0; options.fetch = async () => { requests++; return Response.json({ stargazers_count: 125 }) }; const catalog = new ExtensionCatalog(options)
    const input = extensionRecommendations.filter(entry => entry.source === 'vercel-labs/agent-skills').map(({ kind, id }) => ({ kind, id })); const result = await catalog.popularity(input)
    expect(requests).toBe(1); expect(result.entries.map(entry => entry.repositoryStars)).toEqual([125, 125]); await catalog.popularity(input); expect(requests).toBe(1)
    options.store.saveEntity('extension-repository-stars', 'vercel-labs/agent-skills', { count: 124, at: new Date(Date.now() - 86400001).toISOString() }); await catalog.popularity(input); expect(requests).toBe(2)
    expect((await catalog.popularity([{ kind: 'mcp', id: 'unknown' }])).entries[0].repositoryStars).toBeUndefined(); expect(requests).toBe(2)
  })
  it('限流停止剩余 GitHub 请求，显示恢复时间并跨实例保留，过期缓存标注原时间', async () => {
    const { options } = await setup(); let requests = 0; options.fetch = async () => { requests++; return new Response('{}', { status: 429, headers: { 'retry-after': '120' } }) }; const catalog = new ExtensionCatalog(options)
    const at = new Date(Date.now() - 86400001).toISOString(); options.store.saveEntity('extension-repository-stars', 'upstash/context7', { count: 42, at })
    const input = extensionRecommendations.filter(entry => entry.kind === 'mcp').map(({ kind, id }) => ({ kind, id })); const result = await catalog.popularity(input)
    expect(requests).toBe(1); expect(result.warning).toContain('限流'); expect(Date.parse(result.retryAt!)).toBeGreaterThan(Date.now()); expect(result.entries[0]).toMatchObject({ repositoryStars: 42, starsFetchedAt: at }); expect(result.entries[1].repositoryStars).toBeUndefined()
    await new ExtensionCatalog(options).popularity(input); expect(requests).toBe(1)
  })
  it('Stars 并发获取同仓库只发一个请求；只允许目录中 GitHub 来源', async () => {
    const { options } = await setup(); let requests = 0; options.fetch = async () => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ stargazers_count: 0 }) }; const catalog = new ExtensionCatalog(options); const item = { kind: 'mcp' as const, id: extensionRecommendations[0].id }
    const [a, b] = await Promise.all([catalog.popularity([item]), catalog.popularity([item])]); expect(requests).toBe(1); expect(a.entries[0].repositoryStars).toBe(0); expect(b.entries).toEqual(a.entries)
    options.store.saveEntity('extension-catalog-mcp', 'untrusted', { repositoryUrl: 'https://github.com.attacker.test/repos/private' }); await catalog.popularity([{ kind: 'mcp', id: 'untrusted' }]); expect(requests).toBe(1)
  })
  it('排序保持来源序、仅排序传入已加载条目，未知值排在真实零之后', () => {
    const a = { ...extensionRecommendations[0], id: 'a', name: 'A' }, b = { ...a, id: 'b', name: 'B', repositoryStars: 0 }, c = { ...a, id: 'c', name: 'C', repositoryStars: 90 }; const entries = [a, b, c]
    expect(sortCatalogEntries(entries, 'source')).toBe(entries); expect(sortCatalogEntries(entries, 'stars').map(entry => entry.id)).toEqual(['c', 'b', 'a']); expect(entries.map(entry => entry.id)).toEqual(['a', 'b', 'c'])
  })
})
