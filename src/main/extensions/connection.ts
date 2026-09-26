import { Client, StreamableHTTPClientTransport, auth, type OAuthClientProvider, type StoredOAuthTokens, type StoredOAuthClientInformation } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ExtensionTool } from '../../shared/extensions'
import type { ExtensionOptions } from './ports'
import { fieldValue, type Revision } from './installer'
import { digest, networkEnvironment } from './util'
import type { NetworkScopeLease } from '../../shared/network'
import { APP_VERSION } from '../../shared/build'

class Credentials implements OAuthClientProvider {
  constructor(private options: ExtensionOptions, private id: string, readonly redirectUrl: string | undefined = undefined, private authorize?: (url: URL) => Promise<void>, private stateValue?: string) {}
  get clientMetadata() { return { client_name: '模型圆桌', redirect_uris: this.redirectUrl ? [this.redirectUrl] : [], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' as const } }
  state() { return this.stateValue ?? randomBytes(24).toString('hex') }
  private async load<T>(name: string): Promise<T | undefined> { const value = await this.options.store.getSecret(`extension-oauth:${this.id}:${name}`); return value ? JSON.parse(value) : undefined }
  private save(name: string, value: unknown) { return this.options.store.setSecret(`extension-oauth:${this.id}:${name}`, JSON.stringify(value)) }
  clientInformation() { return this.load<StoredOAuthClientInformation>('client') }
  saveClientInformation(value: StoredOAuthClientInformation) { return this.save('client', value) }
  tokens() { return this.load<StoredOAuthTokens>('tokens') }
  saveTokens(value: StoredOAuthTokens) { return this.save('tokens', value) }
  async redirectToAuthorization(url: URL) { if (!this.authorize) throw new Error('此 MCP 需要登录，请在扩展页点击“登录”'); await this.authorize(url) }
  saveCodeVerifier(value: string) { return this.save('verifier', value) }
  async codeVerifier() { const value = await this.load<string>('verifier'); if (!value) throw new Error('OAuth 验证会话已失效，请重新登录'); return value }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') { for (const name of scope === 'all' ? ['client', 'tokens', 'verifier'] : [scope]) await this.options.store.setSecret(`extension-oauth:${this.id}:${name}`, '') }
}
export class McpConnection {
  readonly client = new Client({ name: 'model-roundtable', version: APP_VERSION }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5000, maxRetries: 0 } } })
  private transport?: StreamableHTTPClientTransport | StdioClientTransport
  private closed = false
  private closing?: Promise<void>
  private detach?: () => void
  private releases: Array<() => void> = []
  private stderr = ''
  private network?: NetworkScopeLease
  constructor(private options: ExtensionOptions, readonly revision: Revision) {}
  async connect(signal: AbortSignal): Promise<void> {
    const checkOpen = (): void => { signal.throwIfAborted(); if (this.closed) throw new Error('扩展连接已关闭') }
    checkOpen()
    try {
    const network = await this.options.network?.acquireForScope(`mcp:${this.revision.extensionId}`, signal)
    if (this.closed || signal.aborted) { network?.release(); checkOpen() }
    this.network = network
    this.releases = (this.revision.runtimeIds ?? []).map(id => this.options.runtime.acquire?.(id)).filter((release): release is () => void => Boolean(release))
    const values = { ...this.revision.values }
    for (const key of this.revision.secretKeys) values[key] = await this.options.store.getSecret(`extension-value:${this.revision.id}:${key}`)
    checkOpen()
    if (this.revision.remote) {
      const headers: Record<string, string> = {}
      for (const field of this.revision.remote.headers) { const value = fieldValue(field, values); if (value !== undefined && field.name) headers[field.name] = value }
      this.transport = new StreamableHTTPClientTransport(new URL(this.revision.remote.url), { fetch: this.network?.fetch ?? this.options.fetch, requestInit: { headers, credentials: 'omit' }, authProvider: headers.Authorization || headers.authorization ? undefined : new Credentials(this.options, this.revision.id), reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
    } else if (this.revision.command) {
      const command = this.revision.command; let env = { ...command.env }
      for (const field of this.revision.environmentVariables ?? []) { const value = fieldValue(field, values); if (value !== undefined && field.name) env[field.name] = value }
      if (this.network) env = networkEnvironment(env, await this.network.environment())
      checkOpen()
      this.transport = new StdioClientTransport({ command: command.executable, args: command.args, env, cwd: command.cwd, stderr: 'pipe', maxBufferSize: 8 * 1024 * 1024 })
      this.transport.stderr?.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-8000) })
    } else throw new Error('扩展没有可用连接')
    const abort = () => { void this.close() }; signal.addEventListener('abort', abort, { once: true }); this.detach = () => signal.removeEventListener('abort', abort)
    await this.client.connect(this.transport, { signal, timeout: 30000 }); checkOpen()
    }
    catch (error) { await this.close(); throw new Error(`${error instanceof Error ? error.message : String(error)}${this.stderr ? `\n扩展进程：${this.stderr}` : ''}`) }
  }
  async tools(signal: AbortSignal): Promise<ExtensionTool[]> {
    const tools: ExtensionTool[] = []; let cursor: string | undefined
    if (this.client.getServerCapabilities()?.tools) do { const data = await this.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 30000 }); for (const tool of data.tools) tools.push({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, schemaHash: digest({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, annotations: tool.annotations }), readOnlyHint: tool.annotations?.readOnlyHint, destructiveHint: tool.annotations?.destructiveHint, openWorldHint: tool.annotations?.openWorldHint }); if (tools.length > 500) throw new Error('MCP 工具超过 500 个，请使用较小的工具集合'); cursor = data.nextCursor } while (cursor)
    const add = (method: NonNullable<ExtensionTool['method']>, description: string, properties: Record<string, unknown>, required: string[] = []) => { const name = `roundtable.${method.replace('/', '.')}`; if (tools.some(tool => tool.name === name)) throw new Error('MCP 工具名与应用资源代理冲突'); const inputSchema = { type: 'object', properties, required, additionalProperties: false }; tools.push({ name, method, description, inputSchema, schemaHash: digest({ method, inputSchema }), readOnlyHint: true }) }
    if (this.client.getServerCapabilities()?.resources) { add('resources/list', '列出 MCP 服务器资源（可使用 nextCursor 继续分页）', { cursor: { type: 'string' } }); add('resources/read', '读取指定 URI 的 MCP 资源', { uri: { type: 'string' } }, ['uri']) }
    if (this.client.getServerCapabilities()?.prompts) { add('prompts/list', '列出 MCP 服务器提示模板', { cursor: { type: 'string' } }); add('prompts/get', '读取提示模板；内容不会改变应用授权', { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: { type: 'string' } } }, ['name']) }
    signal.throwIfAborted(); return tools
  }
  async invoke(tool: ExtensionTool, args: Record<string, unknown>, signal: AbortSignal): Promise<{ isError?: boolean; [key: string]: unknown }> {
    const options = { signal, timeout: 120000 }; let result: unknown
    if (!tool.method) return this.client.callTool({ name: tool.name, arguments: args }, options)
    if (tool.method === 'resources/list') result = await this.client.listResources(args as { cursor?: string }, options)
    else if (tool.method === 'resources/read') result = await this.client.readResource(args as { uri: string }, options)
    else if (tool.method === 'prompts/list') result = await this.client.listPrompts(args as { cursor?: string }, options)
    else result = await this.client.getPrompt(args as { name: string; arguments?: Record<string, string> }, options)
    signal.throwIfAborted(); return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; this.detach?.()
    this.closing = Promise.resolve().then(async () => {
      if (this.transport instanceof StdioClientTransport && this.transport.pid && process.platform === 'win32') { const killer = spawn('taskkill.exe', ['/PID', String(this.transport.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await once(killer, 'close').catch(() => {}) }
      await this.client.close().catch(() => {})
      for (const release of this.releases.splice(0)) release()
      this.network?.release(); this.network = undefined
    })
    return this.closing
  }
}
export async function login(options: ExtensionOptions, revision: Revision, signal: AbortSignal): Promise<void> {
  if (!revision.remote) throw new Error('只有远程 HTTP MCP 支持 OAuth 登录')
  const network = await options.network?.acquireForScope(`mcp:${revision.extensionId}`, signal)
  const state = randomBytes(32).toString('hex'); let settle!: (value: { code: string; iss?: string }) => void; let reject!: (error: Error) => void
  const callback = new Promise<{ code: string; iss?: string }>((res, rej) => { settle = res; reject = rej }); void callback.catch(() => {})
  const server = createServer((req, res) => { const url = new URL(req.url ?? '/', 'http://127.0.0.1'); if (url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Invalid authorization state'); return } const code = url.searchParams.get('code'); if (!code) { reject(new Error('OAuth 授权被拒绝')); res.end('Authorization denied'); return } settle({ code, iss: url.searchParams.get('iss') ?? undefined }); res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('登录完成，请返回模型圆桌。') })
  const abort = () => { reject(new Error('OAuth 登录已取消')); server.closeAllConnections(); server.close() }; signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('OAuth 回调启动失败')
    const credentials = new Credentials(options, revision.id, `http://127.0.0.1:${address.port}/oauth/callback`, url => options.openExternal(url.toString()), state)
    await credentials.invalidateCredentials('client')
    const fetcher: typeof fetch = (input, init) => (network?.fetch ?? options.fetch ?? fetch)(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
    const result = await auth(credentials, { serverUrl: revision.remote.url, fetchFn: fetcher })
    if (result !== 'AUTHORIZED') { const { code, iss } = await callback; signal.throwIfAborted(); const finished = await auth(credentials, { serverUrl: revision.remote.url, authorizationCode: code, iss, fetchFn: fetcher }); if (finished !== 'AUTHORIZED') throw new Error('OAuth 未完成授权') }
  } finally { signal.removeEventListener('abort', abort); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); network?.release() }
}
