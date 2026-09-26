import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { stringify } from 'yaml'
import type { NetworkNode, NetworkSelection } from '../../shared/network'
import { expectedNodeCount, networkDigest, type SubscriptionResource } from './subscriptions'
import { registerCoreOwnership } from './ownership'

export const MIHOMO_VERSION = '1.19.31'
export interface CoreNode extends NetworkNode { resourceKey: string; nativeName: string }
export interface CoreResource extends SubscriptionResource { subscriptionId: string }
export interface CoreRoute { key: string; subscriptionId: string; node: CoreNode }
const providerName = (resource: Pick<CoreResource, 'subscriptionId' | 'key'>): string => `p-${networkDigest(`${resource.subscriptionId}:${resource.key}`).slice(0, 20)}`
const processEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)))
async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const value = (server.address() as import('node:net').AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return value
}
async function command(executable: string, args: string[], input = '', signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const child = spawn(executable, args, { windowsHide: true, shell: false, env: processEnvironment(), stdio: ['pipe','pipe','pipe'] })
  let text = '', overflow = false
  child.stdout.on('data', data => { text += data.toString(); if (text.length > 24 * 1024 * 1024) { overflow = true; child.kill() } })
  child.stderr.resume() // Never retain core output: invalid node diagnostics can include credentials.
  child.stdin.on('error', () => {})
  const stop = () => child.kill(); signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 30000)
  try {
    const result = new Promise<number | null>((resolve, reject) => { child.once('error', () => reject(new Error('无法启动网络内核工具，请重新安装网络组件'))); child.once('close', resolve) })
    child.stdin.end(input)
    const code = await result; signal?.throwIfAborted()
    if (code !== 0 || overflow) throw new Error('网络内核处理订阅失败，请检查节点格式或重新安装组件')
    return text
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Owns exactly one spawned child; it never enumerates or kills other proxy applications. */
export class MihomoProcess {
  private child?: ChildProcessWithoutNullStreams
  private directory?: string
  private controller = 0
  private secret = randomBytes(32).toString('hex')
  private stopping = false
  readonly routes = new Map<string, string>()
  constructor(private executable: string, private root: string, private onExit?: () => void) {}
  async start(resources: CoreResource[], routes: CoreRoute[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await mkdir(this.root, { recursive: true })
    this.directory = await mkdtemp(join(this.root, 'core-'))
    try {
      const keypair = await command(this.executable, ['age','keygen'], '', signal)
      const publicKey = /# public key: (age1\S+)/.exec(keypair)?.[1], privateKey = /^(AGE-SECRET-KEY-\S+)$/m.exec(keypair)?.[1]
      if (!publicKey || !privateKey) throw new Error('网络内核不支持所需的订阅加密功能')
      const providers: Record<string, unknown> = {}
      for (const resource of resources) {
        const name = providerName(resource)
        const encrypted = await command(this.executable, ['age','encrypt',publicKey,'-','-'], resource.content, signal)
        await writeFile(join(this.directory, `${name}.age`), encrypted, { mode: 0o600 })
        providers[name] = { type: 'file', path: `${name}.age`, 'age-secret-key': privateKey, 'health-check': { enable: false }, override: { 'additional-prefix': `${name}::` } }
      }
      this.controller = await port()
      const listeners: unknown[] = [], groups: unknown[] = []
      for (const route of routes) {
        const listeningPort = await port(), name = `route-${networkDigest(route.key).slice(0, 20)}`
        const provider = providerName({ subscriptionId: route.subscriptionId, key: route.node.resourceKey })
        groups.push({ name, type: 'select', use: [provider], filter: `^${route.node.nativeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'default-selected': route.node.nativeName, 'empty-fallback': 'REJECT' })
        listeners.push({ name: `${name}-in`, type: 'http', listen: '127.0.0.1', port: listeningPort, proxy: name })
        this.routes.set(route.key, `http://127.0.0.1:${listeningPort}`)
      }
      const config = {
        'external-controller': `127.0.0.1:${this.controller}`, secret: this.secret,
        'allow-lan': false, mode: 'rule', 'log-level': 'silent', 'ipv6': true,
        'find-process-mode': 'off', 'geo-auto-update': false,
        profile: { 'store-selected': false, 'store-fake-ip': false },
        tun: { enable: false }, dns: { enable: false },
        'proxy-providers': providers, 'proxy-groups': groups, listeners, rules: ['MATCH,REJECT'],
      }
      const child = spawn(this.executable, ['-d',this.directory,'-f','-'], { windowsHide: true, shell: false, env: processEnvironment(), stdio: ['pipe','pipe','pipe'] })
      this.child = child
      child.stdout.resume(); child.stderr.resume(); child.stdin.on('error', () => {})
      let failed = false
      child.once('error', () => { failed = true })
      child.once('exit', () => { failed = true; if (!this.stopping) this.onExit?.() })
      const abort = () => { void this.stop() }; signal?.addEventListener('abort', abort, { once: true })
      child.stdin.end(stringify(config))
      try {
        if (child.pid) await registerCoreOwnership(this.directory, this.executable, child.pid)
        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          signal?.throwIfAborted()
          if (failed) throw new Error('网络内核启动失败：订阅节点配置无效或本机端口不可用')
          try { const version = await this.api<{ version: string }>('/version'); if (version.version !== MIHOMO_VERSION && version.version !== `v${MIHOMO_VERSION}`) throw new Error('网络内核版本与应用不匹配'); return } catch (error) { if ((error as Error).message.includes('版本')) throw error }
          await sleep(100)
        }
        throw new Error('网络内核启动超时')
      } finally { signal?.removeEventListener('abort', abort) }
    } catch (error) { await this.stop(); throw error }
  }
  async api<T>(path: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: this.controller, path, method: 'GET', headers: { Authorization: `Bearer ${this.secret}` }, signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', data => { size += data.length; if (size > 8 * 1024 * 1024) req.destroy(new Error('网络内核响应超过限制')); else chunks.push(data) })
        response.on('error', reject)
        response.on('end', () => {
          if (response.statusCode !== 200) { reject(new Error(`网络内核操作失败：HTTP ${response.statusCode}`)); return }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T) } catch { reject(new Error('网络内核返回无效结果')) }
        })
      })
      req.once('error', () => reject(new Error('无法连接网络内核，请重新启动网络组件'))); req.end()
    })
  }
  async nodes(resources: CoreResource[]): Promise<Record<string, CoreNode[]>> {
    const result: Record<string, CoreNode[]> = {}
    const response = await this.api<{ providers: Record<string, { proxies: { name: string; type: string }[] }> }>('/providers/proxies')
    for (const resource of resources) {
      const name = providerName(resource), prefix = `${name}::`
      const proxies = response.providers[name]?.proxies
      if (!proxies?.length) throw new Error('订阅没有可用节点，请检查订阅格式')
      if (proxies.length !== expectedNodeCount(resource.content)) throw new Error('订阅中部分节点格式无效，内核无法完整导入；请修正订阅后重试')
      for (const proxy of proxies) {
        const displayName = proxy.name.startsWith(prefix) ? proxy.name.slice(prefix.length) : proxy.name
        ;(result[resource.subscriptionId] ??= []).push({ id: networkDigest(`${resource.key}:${displayName}`).slice(0, 24), name: displayName, nativeName: proxy.name, resourceKey: resource.key, type: proxy.type })
      }
    }
    return result
  }
  async testNode(subscriptionId: string, node: CoreNode, signal?: AbortSignal): Promise<number> {
    const provider = providerName({ subscriptionId, key: node.resourceKey })
    const result = await this.api<{ delay: number }>(`/providers/proxies/${encodeURIComponent(provider)}/${encodeURIComponent(node.nativeName)}/healthcheck?url=${encodeURIComponent('https://cp.cloudflare.com')}&timeout=5000`, signal)
    if (!Number.isFinite(result.delay) || result.delay < 0) throw new Error('节点延迟测试失败')
    return result.delay
  }
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child; this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); setTimeout(resolve, 3000).unref() })
      child.kill(); await closed
    }
    this.routes.clear()
    if (this.directory) { const directory = this.directory; this.directory = undefined; await rm(directory, { recursive: true, force: true }).catch(() => {}) }
  }
}
export function selectionKey(selection: NetworkSelection): string { return selection.mode === 'subscription' ? `subscription:${selection.subscriptionId}:${selection.nodeId}` : selection.mode }
