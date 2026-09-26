import { APP_VERSION } from '../../shared/build'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { killTree } from './process'

type RpcValue = Record<string, any>
interface Pending { resolve(value: RpcValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export class CodexAppServer {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private sequence = 0
  private listeners = new Set<(method: string, params: RpcValue) => void>()
  private failure?: Error
  private failures = new Set<(error: Error) => void>()
  private stderr = ''
  private activeTurn?: { threadId: string; turnId: string }
  constructor(executable: string, options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; readonly: boolean }) {
    this.child = spawn(executable, ['app-server', '--stdio', '--strict-config'], { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (data: string) => {
      if (this.failure) return
      buffer += data
      if (buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Codex 事件超过大小限制。')); return }
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as RpcValue
          if ('id' in value && !value.method) {
            const pending = this.pending.get(value.id)
            if (!pending) continue
            this.pending.delete(value.id); clearTimeout(pending.timer)
            if (value.error) pending.reject(new Error(value.error.message ?? JSON.stringify(value.error)))
            else pending.resolve(value.result ?? {})
          } else if ('id' in value && typeof value.method === 'string') {
            // The task authorizes local execution; discussion has no local environment.
            if (value.method === 'item/commandExecution/requestApproval' || value.method === 'item/fileChange/requestApproval') this.send({ id: value.id, result: { decision: options.readonly ? 'cancel' : 'accept' } })
            else this.send({ id: value.id, error: { code: -32601, message: '此任务未授权该交互请求。' } })
          } else if (typeof value.method === 'string') {
            if (value.method === 'turn/started' && value.params?.threadId && value.params?.turn?.id) this.activeTurn = { threadId: value.params.threadId, turnId: value.params.turn.id }
            for (const listener of this.listeners) listener(value.method, value.params ?? {})
          }
        } catch (error) { this.fail(error instanceof Error ? error : new Error('Codex 事件解析失败。')) }
      }
    })
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-2000) })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.once('error', error => this.fail(error))
    this.child.once('close', code => this.fail(new Error(`Codex App Server 已退出 (${code})。${this.stderr}`)))
    const abort = (): void => { if (this.activeTurn) this.send({ id: ++this.sequence, method: 'turn/interrupt', params: this.activeTurn }); this.fail(options.signal.reason instanceof Error ? options.signal.reason : new Error('已取消。')); void killTree(this.child) }
    options.signal.addEventListener('abort', abort, { once: true })
    this.child.once('close', () => options.signal.removeEventListener('abort', abort))
    if (options.signal.aborted) abort()
  }
  private send(value: RpcValue): void { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(value)}\n`) }
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const listener of this.failures) listener(error)
  }
  async initialize(): Promise<RpcValue> {
    const result = await this.call('initialize', { clientInfo: { name: 'model_roundtable', title: '模型圆桌', version: APP_VERSION }, capabilities: { experimentalApi: true } })
    this.send({ method: 'initialized', params: {} })
    return result
  }
  call(method: string, params: RpcValue): Promise<RpcValue> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时。`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params })
    })
  }
  onNotification(listener: (method: string, params: RpcValue) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  waitFor(method: string, predicate: (value: RpcValue) => boolean): Promise<RpcValue> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const cleanup = (): void => { this.listeners.delete(receive); this.failures.delete(failed) }
      const receive = (name: string, value: RpcValue): void => { if (name === method && predicate(value)) { cleanup(); resolve(value) } }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      this.listeners.add(receive); this.failures.add(failed)
    })
  }
  async close(): Promise<void> { await killTree(this.child) }
}

/** Names are verified against the pinned 0.156.1 config schema. */
export function codexThreadConfiguration(readonly: boolean, mcp?: { url: string; token: string }): Record<string, unknown> {
  return {
    web_search: 'disabled', model_provider: 'openai', project_doc_max_bytes: 0,
    tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
    features: { shell_tool: !readonly, apply_patch_freeform: !readonly, view_image: !readonly, multi_agent: false, multi_agent_v2: false, apps: false, plugins: false, hooks: false, codex_hooks: false, plugin_hooks: false, skip_host_skill_discovery: true, skill_search: false, tool_suggest: false, recommended_plugins: false, workspace_dependencies: false, browser_use: false, browser_use_external: false, computer_use: false, js_repl: false, image_generation: false, code_mode: false, code_mode_only: false, request_permissions_tool: false, deferred_executor: false, sleep_tool: false, memory_tool: false, memories: false },
    mcp_servers: !readonly && mcp ? { documents: { url: mcp.url, bearer_token_env_var: 'ROUNDTABLE_MCP_TOKEN' } } : {}
  }
}
