import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NativeAgents } from '../src/main/agents/native'
import { DocumentsMcp } from '../src/main/execution/documents-mcp'
import { executionWebTools } from '../src/main/execution/web-tools'
import type { ComponentRuntimePort } from '../src/shared/components'
import type { NetworkLease, NetworkScopeLease, ProviderNetworkPort } from '../src/shared/network'
import type { Provider } from '../src/shared/types'
import type { Execution } from '../src/shared/execution'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (executable: string, args: string[], options: object) => {
    const match = executable.match(/^qa-network-(codex|claude)\.exe$/)
    return match ? actual.spawn(process.execPath, [resolve('tests/fixtures/native-network-cli.mjs'), match[1], ...args], options) : actual.spawn(executable, args, options)
  } }
})
afterEach(() => vi.unstubAllEnvs())
function environment(id: string) {
  return { HTTP_PROXY: id === 'direct' ? '' : `http://127.0.0.1:${id === 'accounts' ? 23401 : 23402}`, HTTPS_PROXY: id === 'direct' ? '' : `http://127.0.0.1:${id === 'accounts' ? 23401 : 23402}`, ALL_PROXY: '', NO_PROXY: id === 'direct' ? '*' : '127.0.0.1,localhost,::1' }
}
async function fixture(kind: 'codex' | 'claude') {
  const directory = await mkdtemp(join(tmpdir(), 'native-network-'))
  let held = 0
  const environments: string[] = [], targets: string[] = []
  const acquireForProviders = vi.fn(async (ids: string[]): Promise<NetworkLease> => {
    held++; let released = false
    return { snapshots: {}, fetchForProvider: () => fetch, environmentForProvider: async (id, target) => { expect(ids).toContain(id); environments.push(id); targets.push(target!); return environment(id) }, release: () => { if (!released) { released = true; held-- } } }
  })
  const acquireForScope = vi.fn(async (scope: string): Promise<NetworkScopeLease> => {
    expect(scope).toBe('accounts'); held++; let released = false
    return { fetch, snapshot: { selection: { mode: 'direct' }, label: 'accounts' }, environment: async () => { environments.push('accounts'); return environment('accounts') }, release: () => { if (!released) { released = true; held-- } } }
  })
  const network = { acquireForProviders, acquireForScope } as unknown as ProviderNetworkPort
  const components: ComponentRuntimePort = { resolve: async id => ({ id, executable: `qa-network-${kind}.exe`, directory, version: 'QA' }), ensure: async id => components.resolve(id) }
  const native = new NativeAgents({ runtimeDir: '', stateDir: directory, components, network, getProvider: id => ({ id, kind, timeoutMs: 10000 }) as Provider })
  const chat = (id: string, signal = new AbortController().signal, prompt = '受控网络环境验收') => native.chat({ model: { providerId: id, modelId: 'qa-model' }, system: '', prompt, maxOutputTokens: 200, signal })
  return { native, directory, chat, network, acquireForProviders, acquireForScope, environments, targets, held: () => held }
}

describe('官方后台网络接线（真实受控子进程，非云账号验收）', () => {
  for (const kind of ['codex', 'claude'] as const) {
    it(`${kind} 的实际账号适配器向受控CLI提供应用搜索和网页读取，原生搜索关闭`, async () => {
      const f = await fixture(kind), signal = new AbortController()
      const execution = { backend: kind, executor: { providerId: 'direct', modelId: 'qa-model' }, rootPath: f.directory, maxOutputTokens: 200, web: { enabled: true, maxSearches: null } } as Execution
      const search = vi.fn(async () => []), read = vi.fn(async () => [])
      const mcp = new DocumentsMcp(executionWebTools(execution, { source: '受控搜索', search, read, close: async () => {} }, signal.signal, { save() {}, evidence() {}, event() {} }), f.directory, signal.signal)
      try {
        await mcp.start()
        const result = JSON.parse(await f.native.execute({ execution, prompt: 'CALL_WEB_TOOLS', signal: signal.signal, reserveCall() {}, event() {}, session() {} }, { url: mcp.url, token: mcp.token }))
        expect(result.web.names).toEqual(['web_search', 'web_read']); expect(result.web.searched.isError).not.toBe(true); expect(result.web.read.isError).not.toBe(true)
        expect(search).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(execution.searches).toBe(1)
      } finally { signal.abort(); await mcp.close(); await f.native.shutdown() }
    }, 30000)
    it(`${kind} 并发讨论与执行只继承各自指定服务的线路`, async () => {
      vi.stubEnv('HTTPS_PROXY', undefined); vi.stubEnv('hTtPs_PrOxY', 'http://ambient.invalid:9999'); vi.stubEnv('NO_PROXY', '*')
      const f = await fixture(kind)
      try {
        const [direct, proxy] = await Promise.all([f.chat('direct'), f.chat('proxied')])
        expect(JSON.parse(direct.text).proxy).toEqual(environment('direct'))
        expect(JSON.parse(proxy.text).proxy).toEqual(environment('proxied'))
        const lease = await f.network.acquireForProviders(['proxied'])
        const executed = await f.native.execute({ execution: { backend: kind, executor: { providerId: 'proxied', modelId: 'qa-model' }, rootPath: f.directory, maxOutputTokens: 200 } as Execution, prompt: '执行网络验收', signal: new AbortController().signal, network: lease, reserveCall() {}, event() {}, session() {} })
        expect(JSON.parse(executed).proxy).toEqual(environment('proxied')); expect(f.held()).toBe(1); lease.release()
        expect(f.held()).toBe(0); expect(f.environments.slice(0, 2).sort()).toEqual(['direct', 'proxied']); expect(f.environments[2]).toBe('proxied')
        expect(f.targets.every(url => url.startsWith(kind === 'codex' ? 'https://chatgpt.com/' : 'https://api.anthropic.com/'))).toBe(true)
        expect(process.env.hTtPs_PrOxY).toBe('http://ambient.invalid:9999'); expect(process.env.NO_PROXY).toBe('*')
      } finally { await f.native.shutdown() }
    }, 30000)
    it(`${kind} 模型发现使用provider；无provider的账号状态使用accounts`, async () => {
      const f = await fixture(kind)
      try {
        expect((await f.native.discover('proxied')).length).toBeGreaterThan(0)
        expect(f.environments).toEqual(['proxied'])
        await f.native.status()
        expect(f.acquireForScope.mock.calls.map(call => call[0])).toEqual(['accounts', 'accounts'])
        const audit = JSON.parse(await readFile(join(f.directory, 'accounts', kind, 'qa-network.json'), 'utf8'))
        expect(audit.proxy).toEqual(environment('accounts')); expect(f.held()).toBe(0)
      } finally { await f.native.shutdown() }
    }, 30000)
    it(`${kind} 取消官方调用释放网络lease，下一次可独立使用直连`, async () => {
      const f = await fixture(kind), controller = new AbortController()
      try {
        const result = f.chat('proxied', controller.signal, 'WAIT_UNTIL_CANCELLED').then(value => ({ value }), error => ({ error }))
        await vi.waitFor(async () => expect(await readFile(join(f.directory, 'accounts', kind, 'qa-network.json'), 'utf8')).toContain('23402'))
        const audit = JSON.parse(await readFile(join(f.directory, 'accounts', kind, 'qa-network.json'), 'utf8'))
        controller.abort(new Error('用户取消线路调用'))
        const stopped = await result
        expect('error' in stopped ? stopped.error.message : '').toContain('用户取消线路调用'); expect(f.held()).toBe(0)
        expect(() => process.kill(audit.pid, 0)).toThrow()
        expect(JSON.parse((await f.chat('direct')).text).proxy.HTTPS_PROXY).toBe('')
      } finally { await f.native.shutdown() }
    }, 30000)
  }
})
