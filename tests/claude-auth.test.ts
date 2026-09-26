import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ComponentRuntimePort } from '../src/shared/components'
import type { Provider } from '../src/shared/types'
import type { ProviderNetworkPort } from '../src/shared/network'
import { NativeAgents } from '../src/main/agents/native'
import { agentLoginSchema, providerSchema } from '../src/main/validation'

const { launches, terminalChildren } = vi.hoisted(() => ({ launches: [] as Array<{ executable: string; args: string[]; options: any }>, terminalChildren: [] as any[] }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (executable: string, args: string[], options: object) => {
    launches.push({ executable, args, options })
    if (executable === 'qa-claude-auth.exe') return actual.spawn(process.execPath, [resolve('tests/fixtures/claude-auth-cli.mjs'), ...args], options)
    if (executable.endsWith('powershell.exe')) {
      const child = new EventEmitter() as any
      child.pid = undefined; child.exitCode = null; child.signalCode = null
      terminalChildren.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    }
    return actual.spawn(executable, args, options)
  } }
})
afterEach(() => { vi.unstubAllEnvs(); launches.length = 0; for (const child of terminalChildren.splice(0)) child.emit('close', 0) })

const input = { kind: 'claude' as const, name: 'Claude', baseUrl: '', modelIds: ['sonnet'], tokenParameter: 'max_tokens' as const, streamUsage: false, timeoutMs: 15000 }
async function fixture(network?: ProviderNetworkPort) {
  const directory = await mkdtemp(join(tmpdir(), '圆桌-Claude-认证-'))
  const providers: Record<string, Provider> = {
    official: { ...input, id: 'official', hasKey: false },
    keyA: { ...input, id: 'keyA', hasKey: true, claudeAuth: 'apiKey' },
    keyB: { ...input, id: 'keyB', hasKey: true, claudeAuth: 'apiKey' },
    missing: { ...input, id: 'missing', hasKey: false, claudeAuth: 'apiKey' },
  }
  const keys: Record<string, string> = { keyA: 'qa-secret-service-A', keyB: 'qa-secret-service-B' }
  let leases = 0
  const components: ComponentRuntimePort = {
    resolve: async id => { if (id !== 'claude') throw new Error('QA only prepares Claude'); return { id, version: '2.1.280', directory, executable: 'qa-claude-auth.exe' } },
    ensure: async id => components.resolve(id), acquire: () => { leases++; return () => { leases-- } },
  }
  const getApiKey = vi.fn(async (id: string) => keys[id] ?? '')
  const native = new NativeAgents({ runtimeDir: '', stateDir: directory, getProvider: id => providers[id], getApiKey, components, network })
  const chat = (providerId: string, prompt = 'HELLO') => native.chat({ model: { providerId, modelId: 'sonnet' }, system: 'QA', prompt, maxOutputTokens: 64, signal: AbortSignal.timeout(15000) })
  return { directory, providers, keys, native, chat, getApiKey, leases: () => leases }
}

describe('Claude authentication validation', () => {
  it('keeps official as the default and accepts a key only for the explicit Claude key mode', () => {
    expect(providerSchema.parse(input).claudeAuth).toBeUndefined()
    expect(providerSchema.parse({ ...input, claudeAuth: 'apiKey', apiKey: 'qa-key' }).claudeAuth).toBe('apiKey')
    for (const value of [{ ...input, apiKey: 'qa-key' }, { ...input, kind: 'codex', claudeAuth: 'apiKey' }, { ...input, claudeAuth: 'apiKey', apiKey: 'key\nline' }]) expect(providerSchema.safeParse(value).success).toBe(false)
    expect(providerSchema.parse({ ...input, claudeAuth: 'apiKey', apiKey: '' }).apiKey).toBe('')
    expect(agentLoginSchema.parse({ kind: 'claude', method: 'console' })).toEqual({ kind: 'claude', method: 'console' })
    expect(agentLoginSchema.safeParse({ kind: 'claude' }).success).toBe(false)
    expect(agentLoginSchema.safeParse({ kind: 'claude', method: 'console', args: ['--anything'] }).success).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('Claude native credential boundary, controlled real child processes', () => {
  it('runs subscription and Console through the unmodified official login command, without inherited keys', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-secret')
    const f = await fixture()
    try {
      for (const method of ['subscription', 'console'] as const) {
        const result = await f.native.login({ kind: 'claude', method })
        expect(result.url).toBe(`https://claude.ai/qa-auth/${method}`)
        const audit = JSON.parse(await readFile(join(f.directory, 'accounts/claude/qa-login.json'), 'utf8'))
        expect(audit.argv).toEqual(['auth', 'login', method === 'console' ? '--console' : '--claudeai'])
        expect(audit.credentialNames).toEqual([])
        expect(audit.profile).toBe(join(f.directory, 'accounts/claude'))
      }
      expect(f.getApiKey).not.toHaveBeenCalled()
      expect(f.leases()).toBe(0)
    } finally { await f.native.shutdown() }
  })

  it('serializes concurrent official authentication starts before a network lease is ready', async () => {
    let releaseRoute!: () => void
    const ready = new Promise<void>(resolve => { releaseRoute = resolve })
    const network = { acquireForScope: async () => { await ready; return { environment: async () => ({}), release() {} } } } as unknown as ProviderNetworkPort
    const f = await fixture(network)
    try {
      const first = f.native.login({ kind: 'claude', method: 'subscription' })
      expect((await f.native.login({ kind: 'claude', method: 'console' })).message).toContain('正在运行')
      await expect(f.native.openClaude()).rejects.toThrow('正在运行')
      await expect(f.native.logout('claude')).rejects.toThrow('正在启动')
      releaseRoute()
      await first
      expect(launches.filter(launch => launch.args[0] === 'auth' && launch.args[1] === 'login')).toHaveLength(1)
      expect(f.leases()).toBe(0)
    } finally { releaseRoute(); await f.native.shutdown() }
  })

  it('isolates concurrent service keys, preserves proxy scope, and redacts outputs and errors', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-secret'); vi.stubEnv('OPENAI_API_KEY', 'ambient-openai')
    const routes: string[] = []
    const network = { acquireForProviders: async (ids: string[]) => ({ environmentForProvider: async (id: string) => { routes.push(id); return { HTTPS_PROXY: `http://127.0.0.1:${id === 'keyA' ? 20001 : 20002}`, NO_PROXY: '127.0.0.1' } }, release() {} }) } as unknown as ProviderNetworkPort
    const f = await fixture(network)
    try {
      const result = await Promise.all([f.chat('keyA'), f.chat('keyB'), f.chat('official')])
      expect(result.map(value => value.text)).toEqual(['Key access: [密钥已隐藏]', 'Key access: [密钥已隐藏]', 'Official profile access'])
      expect(routes.sort()).toEqual(['keyA', 'keyB', 'official'])
      expect(f.getApiKey.mock.calls.map(call => call[0]).sort()).toEqual(['keyA', 'keyB'])
      const directories = await readdir(join(f.directory, 'account-chat'))
      const audits = await Promise.all(directories.map(directory => readFile(join(f.directory, 'account-chat', directory, 'qa-auth.json'), 'utf8').then(value => JSON.parse(value))))
      expect(audits.map(value => value.keyHash).sort()).toEqual([null, ...Object.values(f.keys).map(key => createHash('sha256').update(key).digest('hex'))].sort())
      for (const audit of audits) {
        expect(audit.argv[audit.argv.indexOf('--setting-sources') + 1]).toBe('')
        expect(audit.argv).toContain('--strict-mcp-config')
        expect(audit.argv).toContain('--safe-mode')
        expect(audit.credentialNames).toEqual(audit.keyHash ? ['ANTHROPIC_API_KEY'] : [])
        expect(audit.profile).toBe(join(f.directory, 'accounts/claude'))
      }
      const failed = await f.chat('keyA', 'FAIL').then(() => '', error => error.message)
      expect(failed).toContain('[密钥已隐藏]'); expect(failed).not.toContain(f.keys.keyA)
      expect(JSON.stringify({ result, audits, failed })).not.toContain('ambient-secret')
      for (const key of Object.values(f.keys)) expect(JSON.stringify({ result, audits, failed })).not.toContain(key)
      expect(f.leases()).toBe(0)
    } finally { await f.native.shutdown() }
  })

  it('refuses a missing or deleted key before starting a CLI and never falls back to the official account', async () => {
    const f = await fixture()
    try {
      await expect(f.chat('missing')).rejects.toThrow('不会改用订阅')
      expect(launches).toHaveLength(0)
      f.keys.keyA = ''
      await expect(f.chat('keyA')).rejects.toThrow('不会改用订阅')
      expect(launches).toHaveLength(0)
      expect(f.leases()).toBe(0)
    } finally { await f.native.shutdown() }
  })

  it('redacts a credential split across streamed chunks before renderer events receive it', async () => {
    const f = await fixture()
    try {
      const deltas: string[] = []
      const result = await f.native.chat({ model: { providerId: 'keyA', modelId: 'sonnet' }, system: 'QA', prompt: 'STREAM', maxOutputTokens: 64, signal: AbortSignal.timeout(15000), onDelta: text => { deltas.push(text) } })
      expect(result.text).toBe('Key access: [密钥已隐藏]')
      expect(deltas.join('')).toBe(result.text)
      expect(JSON.stringify({ deltas, result })).not.toContain(f.keys.keyA)
    } finally { await f.native.shutdown() }
  })

  it('keeps global official status separate from per-service key availability', async () => {
    const f = await fixture()
    try {
      const claude = (await f.native.status()).find(value => value.kind === 'claude')!
      expect(claude).toMatchObject({ available: true, authenticated: false })
      expect(claude.message).toContain('自有 API Key 的服务仍可使用')
      expect(f.getApiKey).not.toHaveBeenCalled()
      expect((await f.chat('keyA')).text).toContain('Key access')
    } finally { await f.native.shutdown() }
  })

  it('opens an official console only on the explicit action, using a fixed launcher and the same account profile', async () => {
    const f = await fixture()
    try {
      expect(launches).toHaveLength(0)
      const result = await f.native.openClaude()
      expect(result.message).toContain('原版 Claude Code')
      const launch = launches[0]
      expect(launch.executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
      expect(launch.args[launch.args.length - 1]).toContain('-WindowStyle Normal')
      expect(launch.args[launch.args.length - 1]).not.toContain('qa-claude-auth.exe')
      expect(launch.options.env.ROUNDTABLE_CLAUDE_EXECUTABLE).toBe('qa-claude-auth.exe')
      expect(launch.options.env.CLAUDE_CONFIG_DIR).toBe(join(f.directory, 'accounts/claude'))
      expect(launch.options.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(f.leases()).toBe(1)
      await expect(f.native.openClaude()).rejects.toThrow('正在运行')
      await expect(f.chat('official')).rejects.toThrow('窗口仍在运行')
      expect((await f.chat('keyA')).text).toContain('Key access')
      terminalChildren[0].emit('close', 0)
      expect(f.leases()).toBe(0)
    } finally { await f.native.shutdown() }
  })
})
