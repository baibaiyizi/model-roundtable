import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ComponentRuntimePort } from '../src/shared/components'
import type { BackendContext } from '../src/main/execution/ports'
import type { Execution } from '../src/shared/execution'
import type { Provider } from '../src/shared/types'
import { createHash } from 'node:crypto'
import { NativeAgents } from '../src/main/agents/native'
import { DocumentsMcp } from '../src/main/execution/documents-mcp'

// Only redirect our explicit QA executable names; real process spawn, stdio,
// cancellation, MCP HTTP server/client and NativeAgents remain in use.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (executable: string, args: string[], options: object) => {
    const match = executable.match(/^qa-(codex|claude)\.exe$/)
    return match ? actual.spawn(process.execPath, [resolve('tests/fixtures/native-mcp-cli.mjs'), match[1], ...args], options) : actual.spawn(executable, args, options)
  } }
})

afterEach(() => vi.unstubAllEnvs())

async function fixture(kind: 'codex' | 'claude', blocked = false, apiKey?: string) {
  const directory = await mkdtemp(join(tmpdir(), `圆桌-${kind}-MCP-`))
  const controller = new AbortController()
  let leases = 0, entered = 0, completed = 0, cancelled = 0
  const components: ComponentRuntimePort = {
    resolve: async id => ({ id, version: 'QA-protocol-peer', directory, executable: `qa-${kind}.exe` }),
    ensure: async id => components.resolve(id),
    acquire: () => { leases++; return () => { leases-- } },
  }
  const native = new NativeAgents({ runtimeDir: '', stateDir: directory, getProvider: () => apiKey ? { id: 'qa-provider', kind, claudeAuth: 'apiKey' } as Provider : undefined, getApiKey: async () => apiKey ?? '', components })
  const execution = { id: 'qa-task', projectId: 'qa-project', rootPath: directory, backend: kind, executor: { providerId: 'qa-provider', modelId: 'qa-explicit-model' }, maxOutputTokens: 1024 } as Execution
  const events: Array<Parameters<BackendContext['event']>[0]> = []
  let calls = 0, session = ''
  const bridge = new DocumentsMcp({ tools: [{ name: 'ext_qa_read', description: '读取本项目材料', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }], call: async (root, name, args, signal) => {
    entered++; expect(root).toBe(directory); expect(name).toBe('ext_qa_read'); expect(args).toEqual({ query: '中文材料' })
    if (blocked) await new Promise<void>((_resolve, reject) => {
      const abort = () => { cancelled++; reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
    signal.throwIfAborted(); completed++; return { text: '可追溯的中文材料', source: 'qa://project/material' }
  } }, directory, controller.signal)
  await bridge.start()
  const context: BackendContext = { execution, prompt: '请使用项目已授权工具读取中文材料。', signal: controller.signal, event: event => events.push(event), reserveCall: () => { calls++ }, session: value => { session = value } }
  return { directory, native, bridge, controller, events, context, metrics: () => ({ leases, entered, completed, cancelled, calls, session }), close: async () => { controller.abort(); await native.shutdown(); await bridge.close() } }
}

describe.skipIf(process.platform !== 'win32')('官方后台协议的受控子进程桥接（不代表真实云账号验收）', () => {
  it('Claude service API key keeps the same scoped MCP execution path without entering argv or evidence', async () => {
    const key = 'qa-scoped-claude-execution-key'
    const f = await fixture('claude', false, key)
    try {
      const result = await f.native.execute(f.context, { url: f.bridge.url, token: f.bridge.token })
      const audit = JSON.parse(await readFile(join(f.directory, 'qa-native.json'), 'utf8'))
      expect(audit.inheritedCredentialNames).toEqual(['ANTHROPIC_API_KEY'])
      expect(audit.anthropicKeyHash).toBe(createHash('sha256').update(key).digest('hex'))
      expect(audit.names).toEqual(['documents'])
      expect(audit.argv[audit.argv.indexOf('--setting-sources') + 1]).toBe('')
      expect(audit.argv).not.toContain('--safe-mode')
      expect(f.metrics()).toMatchObject({ completed: 1, calls: 1, leases: 0 })
      expect(JSON.stringify({ result, audit, events: f.events })).not.toContain(key)
    } finally { await f.close() }
  }, 30000)
  for (const kind of ['codex', 'claude'] as const) {
    it(`${kind}: 实际传递唯一代理配置并调用真实 HTTP MCP；凭据不进入 argv、提示或执行记录`, async () => {
      vi.stubEnv('OPENAI_API_KEY', 'qa-ambient-openai-secret')
      vi.stubEnv('ANTHROPIC_API_KEY', 'qa-ambient-anthropic-secret')
      const f = await fixture(kind)
      try {
        const unauthenticated = await fetch(f.bridge.url, { method: 'POST', body: '{}' })
        expect(unauthenticated.status).toBe(403)
        const result = await f.native.execute(f.context, { url: f.bridge.url, token: f.bridge.token })
        expect(result).toBe('真实 MCP 材料已读取')
        expect(f.metrics()).toMatchObject({ entered: 1, completed: 1, calls: 1, leases: 0 })
        expect(f.metrics().session).toContain(`qa-${kind}`)
        const audit = JSON.parse(await readFile(join(f.directory, 'qa-native.json'), 'utf8'))
        expect(audit.names).toEqual(['documents']); expect(audit.inheritedCredentialNames).toEqual([])
        expect(audit.profile).toBe(join(f.directory, 'accounts', kind))
        if (kind === 'codex') {
          expect(audit.argv).toEqual(['app-server', '--stdio', '--strict-config'])
          expect(audit.config.mcp_servers.documents).toEqual({ url: f.bridge.url, bearer_token_env_var: 'ROUNDTABLE_MCP_TOKEN' })
          expect(audit.model).toBe('qa-explicit-model')
        } else {
          expect(audit.argv).toContain('--strict-mcp-config'); expect(audit.transport).toBe('http')
          expect(audit.argv[audit.argv.indexOf('--setting-sources') + 1]).toBe('')
          expect(audit.argv[audit.argv.indexOf('--allowedTools') + 1]).toContain('mcp__documents__*')
          expect(audit.maxOutputTokens).toBe('1024')
        }
        expect(f.events.some(event => event.kind === 'tool' && event.state === 'complete')).toBe(true)
        expect(f.events.find(event => event.kind === 'request')?.usage?.totalTokens).toBe(16)
        const visible = JSON.stringify({ audit, events: f.events, result, prompt: f.context.prompt })
        for (const secret of [f.bridge.token, 'qa-ambient-openai-secret', 'qa-ambient-anthropic-secret']) expect(visible).not.toContain(secret)
      } finally { await f.close() }
    }, 30000)

    it(`${kind}: 工具进行中停止会退出子进程、取消代理并释放组件，不产生完成结果`, async () => {
      const f = await fixture(kind, true)
      try {
        const result = f.native.execute(f.context, { url: f.bridge.url, token: f.bridge.token }).then(value => ({ value }), error => ({ error }))
        await expect.poll(() => f.metrics().entered, { timeout: 10000 }).toBe(1)
        const pid = JSON.parse(await readFile(join(f.directory, 'qa-native.json'), 'utf8')).pid
        f.controller.abort(new Error('QA 用户停止'))
        const stopped = await result
        expect('error' in stopped ? stopped.error?.message : undefined).toContain('QA 用户停止')
        expect(f.metrics()).toMatchObject({ completed: 0, cancelled: 1, calls: 1, leases: 0 })
        expect(() => process.kill(pid, 0)).toThrow()
        expect(f.events.some(event => event.kind === 'tool' && event.state === 'complete')).toBe(false)
        expect((await fetch(f.bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${f.bridge.token}` }, body: '{}' })).status).toBe(403)
      } finally { await f.close() }
    }, 30000)
  }
})
