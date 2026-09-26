import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CodexAppServer, codexThreadConfiguration } from '../src/main/agents/codex-app-server'
import { AgentRuntime } from '../src/main/agents/runtime'
import { runCommand } from '../src/main/agents/process'
import { testComponents } from './helpers/components'
import { DocumentsMcp } from '../src/main/execution/documents-mcp'

describe.skipIf(process.platform !== 'win32')('固定官方 Codex 运行时（不调用付费模型）', () => {
  it('真实 AppServer 在空账号线程中鉴权连接本机统一 MCP 并发现扩展工具', async () => {
    const state = await mkdtemp(join(tmpdir(), 'codex-MCP-discovery-'))
    const runtime = new AgentRuntime(resolve('resources/agents'), state, fetch, testComponents)
    await runtime.prepare('codex')
    const controller = new AbortController()
    let discoveries = 0, calls = 0
    const bridge = new DocumentsMcp({ get tools() { discoveries++; return [{ name: 'ext_qa_read', description: '读取本项目材料', inputSchema: { type: 'object', properties: {} } }] }, call: async () => { calls++; return { text: '材料' } } }, state, controller.signal)
    await bridge.start()
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: runtime.profile('codex'), ROUNDTABLE_MCP_TOKEN: bridge.token }
    for (const name of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|CODEX_(?!HOME))/i.test(name)) delete env[name]
    const server = new CodexAppServer(await runtime.executable('codex'), { cwd: state, env, signal: AbortSignal.timeout(45000), readonly: false })
    try {
      await server.initialize()
      const created = await server.call('thread/start', { cwd: state, model: 'gpt-6-astra', modelProvider: 'openai', ephemeral: true, sandbox: 'danger-full-access', approvalPolicy: 'never', config: codexThreadConfiguration(false, { url: bridge.url, token: bridge.token }) })
      const status = await server.call('mcpServerStatus/list', { threadId: created.thread.id, limit: 20 })
      expect(status.data.map((item: { name: string }) => item.name)).toEqual(['documents'])
      expect(JSON.stringify(status.data[0].tools)).toContain('ext_qa_read')
      expect(discoveries).toBeGreaterThan(0); expect(calls).toBe(0)
      expect(JSON.stringify(status)).not.toContain(bridge.token)
      expect((await server.call('account/read', { refreshToken: false })).account).toBeNull()
    } finally { controller.abort(); await server.close(); await bridge.close() }
  }, 60000)
  it('从校验过的完整分发包准备组件，真实 AppServer 接受环境隔离及指定模型', async () => {
    const state = await mkdtemp(join(tmpdir(), 'codex-协议-'))
    const runtime = new AgentRuntime(resolve('resources/agents'), state, fetch, testComponents)
    await runtime.prepare('codex')
    const executable = await runtime.executable('codex')
    expect(existsSync(join(dirname(executable), 'codex-command-runner.exe'))).toBe(true)
    const env = { ...process.env, CODEX_HOME: runtime.profile('codex') }
    for (const name of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|CODEX_(?!HOME))/i.test(name)) delete (env as NodeJS.ProcessEnv)[name]
    const server = new CodexAppServer(executable, { cwd: state, env, signal: AbortSignal.timeout(30000), readonly: true })
    try {
      const initialized = await server.initialize()
      expect(initialized.userAgent).toContain('0.156.1')
      const result = await server.call('thread/start', { cwd: state, model: 'gpt-6-astra', modelProvider: 'openai', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: codexThreadConfiguration(true), environments: [], dynamicTools: [], selectedCapabilityRoots: [] })
      expect(result.model).toBe('gpt-6-astra')
      expect(result.modelProvider).toBe('openai')
      expect(result.thread.id).toBeTruthy()
      const account = await server.call('account/read', { refreshToken: false })
      expect(account.account).toBeNull()
    } finally { await server.close() }
  }, 60000)
})
describe.skipIf(process.platform !== 'win32')('固定官方 Claude 运行时（不登录不调用模型）', () => {
  it('校验下载文件，实际CLI公开无工具、安全模式、账号登录选项', async () => {
    const state = await mkdtemp(join(tmpdir(), 'claude-协议-'))
    const runtime = new AgentRuntime(resolve('resources/agents'), state, fetch, testComponents)
    await runtime.prepare('claude')
    const executable = await runtime.executable('claude')
    const result = await runCommand(executable, ['--help'], { signal: AbortSignal.timeout(15000) })
    expect(result.code).toBe(0); expect(result.stdout).toContain('--safe-mode'); expect(result.stdout).toContain('--strict-mcp-config'); expect(result.stdout).toContain('Use "" to disable all')
    const status = await runCommand(executable, ['auth', 'status', '--json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: runtime.profile('claude') }, signal: AbortSignal.timeout(15000) })
    expect(JSON.parse(status.stdout).loggedIn).toBe(false)
  }, 45000)
})
