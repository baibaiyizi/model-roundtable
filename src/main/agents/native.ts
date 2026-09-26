import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentKind, AgentLoginInput, AgentRuntimeStatus } from '../../shared/execution'
import type { Provider, Usage } from '../../shared/types'
import type { ChatRequest, ChatResult } from '../../shared/ports'
import type { BackendContext } from '../execution/ports'
import { AgentRuntime } from './runtime'
import { killTree, runCommand, stopCommands } from './process'
import { CodexAppServer, codexThreadConfiguration } from './codex-app-server'
import type { ComponentRuntimePort } from '../../shared/components'
import type { NetworkLease, ProviderNetworkPort } from '../../shared/network'

export interface NativeAgentsOptions { runtimeDir: string; stateDir: string; getProvider(id: string): Provider | undefined; getApiKey?(providerId: string): Promise<string>; fetch?: typeof fetch; components?: ComponentRuntimePort; network?: ProviderNetworkPort }
export class NativeAgents {
  private runtime: AgentRuntime
  private logins = new Map<string, ChildProcess>()
  private authStarting = new Set<'codex' | 'claude'>()
  private lifetime = new AbortController()
  private servers = new Set<CodexAppServer>()
  private codexLogin?: { server: CodexAppServer; result: { message: string; url: string } }
  constructor(private options: NativeAgentsOptions) { this.runtime = new AgentRuntime(options.runtimeDir, options.stateDir, (input, init) => (options.fetch ?? fetch)(input, { ...init, signal: AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]) }), options.components) }
  private hold(kind: AgentKind): () => void { return this.runtime.components.acquire?.(kind === 'api' ? 'opencode' : kind) ?? (() => {}) }
  private signal(signal?: AbortSignal, timeoutMs?: number): AbortSignal { return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : []), ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]) }
  private environment(kind: 'codex' | 'claude', network: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (/^(OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|OPENCODE_)/i.test(name) || (Object.keys(network).length > 0 && /^(https?|all|no)_proxy$/i.test(name))) delete env[name]
    if (kind === 'codex') env.CODEX_HOME = this.runtime.profile(kind)
    else { env.CLAUDE_CONFIG_DIR = this.runtime.profile(kind); env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'; env.DISABLE_AUTOUPDATER = '1' }
    return { ...env, ...network }
  }
  private async route(kind: 'codex' | 'claude', signal: AbortSignal, providerId?: string, shared?: NetworkLease): Promise<{ env: NodeJS.ProcessEnv; release(): void }> {
    const target = kind === 'codex' ? 'https://chatgpt.com/backend-api/codex/responses' : 'https://api.anthropic.com/v1/messages'
    // Credential selection belongs to this service, never to ambient shell state.
    const provider = providerId ? this.options.getProvider(providerId) : undefined
    let apiKey: string | undefined
    if (kind === 'claude' && provider?.claudeAuth === 'apiKey') {
      apiKey = await this.options.getApiKey?.(providerId!)
      if (!apiKey?.trim()) throw new Error('此 Claude Code 服务尚未保存 Anthropic API Key，请在模型服务中填写；不会改用订阅账号。')
    }
    signal.throwIfAborted()
    const environment = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
      const env = this.environment(kind, overrides)
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey
      return env
    }
    if (shared && providerId) return { env: environment(await shared.environmentForProvider(providerId, target)), release() {} }
    if (!this.options.network) {
      const selection = providerId ? this.options.getProvider(providerId)?.network : undefined
      if (selection && selection.mode !== 'system') throw new Error('官方模型指定的网络线路尚未准备，未启动后台。')
      return { env: environment(), release() {} }
    }
    const lease = providerId ? await this.options.network.acquireForProviders([providerId], signal) : await this.options.network.acquireForScope('accounts', signal)
    try {
      const overrides = 'environmentForProvider' in lease ? await lease.environmentForProvider(providerId!, target) : await lease.environment(target)
      signal.throwIfAborted()
      return { env: environment(overrides), release: () => lease.release() }
    } catch (error) { lease.release(); throw error }
  }
  async prepare(kind: AgentKind): Promise<AgentRuntimeStatus> { return this.runtime.prepare(kind) }
  async status(): Promise<AgentRuntimeStatus[]> {
    return Promise.all((['api', 'codex', 'claude'] as const).map(async kind => {
      const release = this.hold(kind)
      let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
      try {
        const executable = await this.runtime.executable(kind)
        if (kind !== 'api') route = await this.route(kind, this.signal(undefined, 15000))
        const env = route?.env ?? process.env
        const version = await runCommand(executable, ['--version'], { env, signal: this.signal(undefined, 10000) })
        if (kind === 'api') return { kind, available: true, version: version.stdout.trim(), message: 'API 执行组件已就绪。' }
        await mkdir(this.runtime.profile(kind), { recursive: true })
        const auth = await runCommand(executable, kind === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], { env, signal: this.signal(undefined, 15000) })
        let authenticated = auth.code === 0
        let authMethod: AgentRuntimeStatus['authMethod']
        if (kind === 'claude' && auth.code === 0) {
          const value = JSON.parse(auth.stdout)
          authenticated = value.loggedIn === true
          if (authenticated) authMethod = value.authMethod === 'claude.ai' ? 'subscription' : ['api_key', 'console'].includes(value.authMethod) ? 'console' : 'official'
        }
        return { kind, available: true, version: version.stdout.trim(), authenticated, ...(authMethod ? { authMethod } : {}), message: authenticated ? kind === 'claude' ? `官方 CLI 认证已就绪${authMethod === 'subscription' ? '（Claude 订阅）' : authMethod === 'console' ? '（Console / API 计费）' : ''}。服务中的自有 API Key 独立使用。` : '官方账号已登录。' : kind === 'claude' ? '官方 CLI 尚未登录；已配置自有 API Key 的服务仍可使用，请在服务中测试连接。' : '尚未登录官方账号。' }
      } catch (error) { return { kind, available: false, authenticated: false, message: error instanceof Error ? error.message : String(error) } } finally { route?.release(); release() }
    }))
  }
  async login(input: AgentLoginInput): Promise<{ message: string; url?: string }> {
    const kind = input.kind
    if (kind === 'codex' && this.codexLogin) return this.codexLogin.result
    if (this.authStarting.has(kind) || this.logins.has(kind)) return { message: '官方登录或认证窗口正在运行，请完成并关闭后刷新状态。' }
    this.authStarting.add(kind)
    const releaseRuntime = this.hold(kind)
    let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
    let released = false
    const release = (): void => { if (!released) { released = true; route?.release(); releaseRuntime() } }
    try { route = await this.route(kind, this.signal(undefined, 600000)); return await this.loginHeld(input, release, route.env) } catch (error) { release(); throw error } finally { this.authStarting.delete(kind) }
  }
  private async loginHeld(input: AgentLoginInput, release: () => void, env: NodeJS.ProcessEnv): Promise<{ message: string; url?: string }> {
    const kind = input.kind
    if (kind === 'codex') {
      if (this.codexLogin) { release(); return this.codexLogin.result }
      const executable = await this.runtime.executable(kind)
      await mkdir(this.runtime.profile(kind), { recursive: true })
      const server = new CodexAppServer(executable, { cwd: this.runtime.profile(kind), env, readonly: true, signal: this.signal(undefined, 600000) })
      this.servers.add(server)
      try {
        await server.initialize()
        const response = await server.call('account/login/start', { type: 'chatgpt' })
        if (response.type !== 'chatgpt' || typeof response.authUrl !== 'string') throw new Error('官方后台未返回登录地址。')
        const result = { message: '请在浏览器中完成 ChatGPT 官方登录，然后刷新账号状态。', url: response.authUrl }
        this.codexLogin = { server, result }
        void server.waitFor('account/login/completed', value => value.loginId === response.loginId).catch(() => {}).finally(async () => { if (this.codexLogin?.server === server) this.codexLogin = undefined; this.servers.delete(server); try { await server.close() } finally { release() } })
        return result
      } catch (error) { this.servers.delete(server); await server.close(); throw error }
    }
    if (this.logins.has(kind)) { release(); return { message: '登录正在进行，请完成浏览器中的官方登录后刷新账号状态。' } }
    const executable = await this.runtime.executable(kind)
    await mkdir(this.runtime.profile(kind), { recursive: true })
    this.lifetime.signal.throwIfAborted()
    const child = spawn(executable, ['auth', 'login', input.method === 'console' ? '--console' : '--claudeai'], { env, cwd: this.runtime.profile(kind), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.logins.set(kind, child)
    const lifetime = setTimeout(() => { void killTree(child) }, 10 * 60 * 1000)
    child.once('close', () => { clearTimeout(lifetime); this.logins.delete(kind); release() })
    return new Promise((resolve, reject) => {
      let text = '', finished = false
      const settle = (): void => {
        if (finished) return; finished = true; clearTimeout(timer)
        const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim()
        const url = clean.match(/https:\/\/[^\s<>"']+/)?.[0]
        resolve({ message: `已启动 ${input.method === 'console' ? 'Anthropic Console' : 'Claude 订阅'}官方登录。请在浏览器中完成认证，然后刷新状态。`, ...(url ? { url } : {}) })
      }
      const timer = setTimeout(settle, 2500)
      const collect = (data: Buffer): void => { text += data.toString() }
      child.stdout?.on('data', collect); child.stderr?.on('data', collect)
      child.once('error', error => { clearTimeout(timer); clearTimeout(lifetime); this.logins.delete(kind); release(); if (!finished) { finished = true; reject(error) } })
      child.once('close', code => { if (code !== 0 && !finished) { finished = true; clearTimeout(timer); reject(new Error(`官方登录未完成（退出码 ${code ?? '未知'}）。可打开原版 Claude Code 窗口查看并完成认证。`)) } else settle() })
    })
  }
  async openClaude(): Promise<{ message: string }> {
    if (process.platform !== 'win32') throw new Error('官方 Claude Code 窗口目前仅支持 Windows。')
    if (this.authStarting.has('claude') || this.logins.has('claude')) throw new Error('Claude Code 登录或官方窗口正在运行，请先完成并关闭。')
    this.authStarting.add('claude')
    const releaseRuntime = this.hold('claude')
    let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
    let released = false
    const release = (): void => { if (!released) { released = true; route?.release(); releaseRuntime() } }
    try {
      route = await this.route('claude', this.signal())
      const executable = await this.runtime.executable('claude')
      await mkdir(this.runtime.profile('claude'), { recursive: true })
      this.lifetime.signal.throwIfAborted()
      if (this.logins.has('claude')) throw new Error('Claude Code 登录或官方窗口正在运行，请先完成并关闭。')
      // A fixed launcher creates the visible official console only after this
      // explicit IPC action. Paths stay in env, never interpolated as shell code.
      const launcher = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const command = "$ErrorActionPreference='Stop'; $cli = Start-Process -FilePath $env:ROUNDTABLE_CLAUDE_EXECUTABLE -WorkingDirectory $env:CLAUDE_CONFIG_DIR -WindowStyle Normal -PassThru -Wait; exit $cli.ExitCode"
      const child = spawn(launcher, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { env: { ...route.env, ROUNDTABLE_CLAUDE_EXECUTABLE: executable }, windowsHide: true, stdio: 'ignore' })
      this.logins.set('claude', child)
      child.once('close', () => { if (this.logins.get('claude') === child) this.logins.delete('claude'); release() })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', error => { if (this.logins.get('claude') === child) this.logins.delete('claude'); release(); reject(error) }) })
      return { message: '已请求打开原版 Claude Code 窗口。在其中使用 /login 或 /config 完成官方设置，关闭窗口后回到圆桌刷新状态。窗口沿用本应用的官方账号目录；自有 API Key 服务不受影响。' }
    } catch (error) { release(); throw error } finally { this.authStarting.delete('claude') }
  }
  async logout(kind: 'codex' | 'claude'): Promise<void> {
    if (this.authStarting.has(kind)) throw new Error('官方认证正在启动，请完成后再退出。')
    const release = this.hold(kind)
    let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
    try { route = await this.route(kind, this.signal(undefined, 20000)); await this.logoutHeld(kind, route.env) } finally { route?.release(); release() }
  }
  private async logoutHeld(kind: 'codex' | 'claude', env: NodeJS.ProcessEnv): Promise<void> {
    if (kind === 'codex' && this.codexLogin) { await this.codexLogin.server.close(); this.codexLogin = undefined }
    const active = this.logins.get(kind); if (active) await killTree(active)
    const executable = await this.runtime.executable(kind)
    const result = await runCommand(executable, kind === 'codex' ? ['logout'] : ['auth', 'logout'], { env, signal: this.signal(undefined, 20000) })
    if (result.code !== 0) throw new Error(`官方退出登录失败：${result.stderr.slice(-1000)}`)
  }
  async discover(providerId: string): Promise<string[]> {
    const kind = this.options.getProvider(providerId)?.kind
    if (kind !== 'codex' && kind !== 'claude') throw new Error('不是官方账号服务。')
    const release = this.hold(kind)
    let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
    try { route = await this.route(kind, this.signal(undefined, 30000), providerId); return await this.discoverHeld(providerId, route.env) } finally { route?.release(); release() }
  }
  private async discoverHeld(providerId: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    const kind = this.options.getProvider(providerId)?.kind
    if (kind !== 'codex' && kind !== 'claude') throw new Error('不是官方账号服务。')
    const executable = await this.runtime.executable(kind)
    if (kind === 'claude') {
      const help = await runCommand(executable, ['--help'], { env, signal: this.signal(undefined, 10000) })
      const supported = [...new Set([...help.stdout.matchAll(/["'](sonnet|opus|haiku)["']/g)].map(match => match[1]))]
      if (!supported.length) throw new Error('官方 CLI 未公开模型列表，请直接填写账号支持的模型 ID。')
      return supported
    }
    await mkdir(this.runtime.profile(kind), { recursive: true })
    const server = new CodexAppServer(executable, { cwd: this.runtime.profile(kind), env, readonly: true, signal: this.signal(undefined, 30000) })
    this.servers.add(server)
    try {
      await server.initialize()
      const result = await server.call('model/list', { includeHidden: false })
      const models = (result.data ?? []).map((model: { model?: string }) => model.model).filter((model: unknown): model is string => typeof model === 'string')
      if (!models.length) throw new Error('官方账号没有返回可用模型。')
      return models
    } finally { await server.close(); this.servers.delete(server) }
  }
  async chat(request: ChatRequest): Promise<ChatResult> {
    const kind = this.options.getProvider(request.model.providerId)?.kind
    if (kind !== 'codex' && kind !== 'claude') throw new Error('官方账号服务不存在。')
    const cwd = join(this.options.stateDir, 'account-chat', randomUUID()); await mkdir(cwd, { recursive: true })
    if (request.images?.length) throw new Error('官方账号对话暂不接收图片，请选择 API 视觉服务。')
    return this.invoke(kind, request.model.modelId, `${request.system}\n\n${request.prompt}`, cwd, this.signal(request.signal, this.options.getProvider(request.model.providerId)?.timeoutMs ?? 120000), true, request.maxOutputTokens, text => request.onDelta?.(text), undefined, undefined, request.model.providerId, request.network)
  }
  async execute(context: BackendContext, mcp?: { url: string; token: string }): Promise<string> {
    const kind = context.execution.backend
    if (kind !== 'codex' && kind !== 'claude') throw new Error('执行后端不是官方账号。')
    // Official CLIs do not expose a strict count of their internal HTTP requests.
    context.reserveCall()
    context.event({ kind: 'status', text: '官方账号执行：记录后台启动次数与返回用量；不能精确限制后台内部 HTTP 次数。' })
    const result = await this.invoke(kind, context.execution.executor.modelId, context.prompt, context.execution.rootPath, this.signal(context.signal), false, context.execution.maxOutputTokens, undefined, context, mcp, context.execution.executor.providerId, context.network)
    return result.text
  }
  private async invoke(kind: 'codex' | 'claude', model: string, prompt: string, cwd: string, signal: AbortSignal, readonly: boolean, maxOutputTokens: number, delta?: (text: string) => void, context?: BackendContext, mcp?: { url: string; token: string }, providerId?: string, network?: NetworkLease): Promise<ChatResult> {
    if ((this.authStarting.has(kind) || this.logins.has(kind)) && !(kind === 'claude' && providerId && this.options.getProvider(providerId)?.claudeAuth === 'apiKey')) throw new Error('官方登录或认证窗口仍在运行，请关闭后再开始任务。')
    const release = this.hold(kind)
    let route: Awaited<ReturnType<NativeAgents['route']>> | undefined
    try {
      route = await this.route(kind, signal, providerId, network)
      signal.throwIfAborted()
      return await this.invokeHeld(kind, model, prompt, cwd, signal, readonly, maxOutputTokens, route.env, delta, context, mcp)
    } finally { route?.release(); release() }
  }
  private async invokeHeld(kind: 'codex' | 'claude', model: string, prompt: string, cwd: string, signal: AbortSignal, readonly: boolean, maxOutputTokens: number, env: NodeJS.ProcessEnv, delta?: (text: string) => void, context?: BackendContext, mcp?: { url: string; token: string }): Promise<ChatResult> {
    const executable = await this.runtime.executable(kind)
    await mkdir(this.runtime.profile(kind), { recursive: true })
    if (kind === 'codex') return this.invokeCodex(executable, model, `${prompt}\n\n回答长度参考上限：${maxOutputTokens} tokens。`, cwd, signal, readonly, env, delta, context, mcp)
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens)
    env.CLAUDE_CODE_MAX_RETRIES = '0'
    const secret = env.ANTHROPIC_API_KEY
    const redact = (value: string): string => secret ? value.split(secret).join('[密钥已隐藏]').split(JSON.stringify(secret).slice(1, -1)).join('[密钥已隐藏]') : value
    const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'PowerShell']
    const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--model', model, '--permission-mode', 'dontAsk', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', readonly ? '' : allowed.join(','), '--allowedTools', readonly ? '' : [...allowed, ...(mcp ? ['mcp__documents__*'] : [])].join(',')]
    if (readonly) args.push('--safe-mode')
    // An explicit empty MCP config also prevents ambient account/project servers.
    const configFile = join(this.options.stateDir, `mcp-${randomUUID()}.json`)
    await writeFile(configFile, JSON.stringify({ mcpServers: mcp && !readonly ? { documents: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } : {} }))
    args.push('--mcp-config', configFile)
    let text = '', usage: Usage | undefined, resultSeen = false, failure: string | undefined
    let streamId = ''; const streamed = new Map<string, string>(), pendingDeltas = new Map<string, string>()
    const appendDelta = (id: string, chunk: string, flush = false): void => {
      let safe = redact((pendingDeltas.get(id) ?? '') + chunk)
      let pending = ''
      // A credential can cross two streamed chunks. Hold only a matching suffix
      // until it can no longer complete the selected key.
      if (secret && !flush) for (let length = Math.min(secret.length - 1, safe.length); length > 0; length--) {
        if (safe.endsWith(secret.slice(0, length))) { pending = safe.slice(-length); safe = safe.slice(0, -length); break }
      }
      pendingDeltas.set(id, pending)
      if (!safe) return
      const accumulated = (streamed.get(id) ?? '') + safe
      streamed.set(id, accumulated); delta?.(safe); context?.event({ kind: 'text', toolId: `claude-${id}`, text: accumulated })
    }
    const result = await runCommand(executable, args, { cwd, env, input: prompt, signal, onLine: line => {
      if (!line.trim()) return
      let value: Record<string, any>
      try { value = JSON.parse(redact(line)) } catch { throw new Error('官方后台返回了无效结构化事件。') }
        if (value.type === 'stream_event') {
          const event = value.event
          if (event?.type === 'message_start') streamId = event.message?.id ?? randomUUID()
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            appendDelta(streamId, String(event.delta.text ?? ''))
          }
          if (event?.type === 'message_stop') appendDelta(streamId, '', true)
        }
        if (value.type === 'system' && typeof value.session_id === 'string') context?.session(value.session_id)
        if (value.type === 'assistant') {
          const content = (value.message?.content ?? []) as Array<Record<string, any>>
          appendDelta(value.message.id, '', true)
          const fullText = redact(content.filter(part => part.type === 'text').map(part => String(part.text)).join(''))
          if (fullText) { text += fullText; if (!streamed.has(value.message.id)) delta?.(fullText); context?.event({ kind: 'text', toolId: `claude-${value.message.id}`, text: fullText }) }
          for (const part of content) if (part.type === 'tool_use') context?.event({ kind: 'tool', toolId: part.id, tool: part.name, state: 'running', text: JSON.stringify(part.input).slice(0, 80000) })
        }
        if (value.type === 'user') for (const part of value.message?.content ?? []) if (part.type === 'tool_result') context?.event({ kind: 'tool', toolId: part.tool_use_id, state: part.is_error ? 'failed' : 'complete', text: JSON.stringify(part.content).slice(0, 80000) })
        if (value.type === 'result') { resultSeen = true; if (value.is_error) failure = String(value.result ?? value.errors?.join('\n') ?? value.subtype); if (!text && typeof value.result === 'string') { text = value.result; delta?.(text) }; const u = value.usage; if (Number.isSafeInteger(u?.input_tokens) && Number.isSafeInteger(u?.output_tokens)) usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens, totalTokens: u.input_tokens + u.output_tokens } }
    } })
    signal.throwIfAborted()
    if (result.code !== 0 || failure || !resultSeen) throw new Error(failure ?? `官方后台未正常完成 (${result.code})：${redact(result.stderr).slice(-1500)}`)
    if (!text.trim()) throw new Error('官方后台没有返回文字结果。')
    if (usage) context?.event({ kind: 'request', text: '官方后台返回用量', usage })
    return { text: redact(text), usage }
  }
  private async invokeCodex(executable: string, model: string, prompt: string, cwd: string, signal: AbortSignal, readonly: boolean, env: NodeJS.ProcessEnv, delta?: (text: string) => void, context?: BackendContext, mcp?: { url: string; token: string }): Promise<ChatResult> {
    if (mcp) env.ROUNDTABLE_MCP_TOKEN = mcp.token
    const server = new CodexAppServer(executable, { cwd, env, readonly, signal })
    this.servers.add(server)
    let threadId: string | undefined, turnId: string | undefined, usage: Usage | undefined
    const messages = new Map<string, { text: string; phase?: string }>()
    const abort = (): void => { if (threadId && turnId) void server.call('turn/interrupt', { threadId, turnId }).catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      await server.initialize()
      const config = codexThreadConfiguration(readonly, mcp)
      const created = await server.call('thread/start', { cwd, model, modelProvider: 'openai', approvalPolicy: 'never', sandbox: readonly ? 'read-only' : 'danger-full-access', ephemeral: true, config, ...(readonly ? { environments: [], dynamicTools: [], selectedCapabilityRoots: [] } : {}), developerInstructions: readonly ? '你是模型圆桌的纯文本参与者。只根据给定资料回答，不使用工具、不读取本机、不执行命令。' : '执行用户明确授权的项目任务。只修改任务范围内的文件，不提交、推送、发布或读取密钥，除非本次任务明确要求。请自主运行必要命令并验证结果。' })
      if (created.model !== model || created.modelProvider !== 'openai') throw new Error('官方后台未使用用户指定的模型，执行已停止。')
      threadId = created.thread.id; context?.session(threadId!)
      const completion = server.waitFor('turn/completed', value => value.threadId === threadId)
      // Attach rejection immediately: server death may precede the turn/start response.
      void completion.catch(() => {})
      server.onNotification((method, value) => {
        if (value.threadId !== threadId) return
        if (method === 'turn/started') turnId = value.turn?.id
        if (method === 'item/agentMessage/delta') { const previous = messages.get(value.itemId) ?? { text: '' }; previous.text += value.delta; messages.set(value.itemId, previous); delta?.(value.delta); context?.event({ kind: 'text', toolId: value.itemId, text: previous.text }) }
        if (method === 'item/completed' && value.item?.type === 'agentMessage') { const old = messages.get(value.item.id); messages.set(value.item.id, { text: value.item.text, phase: value.item.phase }); if (!old) delta?.(value.item.text); context?.event({ kind: 'text', toolId: value.item.id, text: value.item.text }) }
        if ((method === 'item/started' || method === 'item/completed') && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(value.item?.type)) {
          if (readonly) throw new Error('讨论后台意外尝试使用工具，已终止。')
          context?.event({ kind: 'tool', toolId: value.item.id, tool: value.item.type, state: method === 'item/started' ? 'running' : value.item.status === 'failed' ? 'failed' : 'complete', text: JSON.stringify(value.item).slice(0, 80000) })
        }
        if (method === 'thread/tokenUsage/updated') { const raw = value.tokenUsage?.total; if (Number.isSafeInteger(raw?.totalTokens) && raw.totalTokens >= 0) usage = { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens } }
      })
      const started = await server.call('turn/start', { threadId, model, input: [{ type: 'text', text: prompt, text_elements: [] }] })
      turnId = started.turn?.id
      const finished = await completion
      signal.throwIfAborted()
      if (finished.turn?.status !== 'completed') throw new Error(finished.turn?.error?.message ?? `Codex 运行未完成：${finished.turn?.status}`)
      const values = [...messages.values()]; const final = values.filter(item => item.phase === 'final_answer'); const text = (final.length ? final : values).map(item => item.text).join('\n')
      if (!text.trim()) throw new Error('Codex 没有返回完成报告。')
      if (usage) context?.event({ kind: 'request', text: '官方后台返回用量', usage })
      return { text, usage }
    } finally { signal.removeEventListener('abort', abort); await server.close(); this.servers.delete(server) }
  }
  async shutdown(): Promise<void> { this.lifetime.abort(new Error('应用退出，官方后台已取消。')); await Promise.allSettled([...this.logins.values()].map(killTree)); await Promise.allSettled([...this.servers].map(server => server.close())); await stopCommands(); this.logins.clear() }
}
