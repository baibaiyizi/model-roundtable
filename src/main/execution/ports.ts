import type { Execution, ExecutionEvent } from '../../shared/execution'
import type { Project } from '../../shared/workspace'
import type { Provider, Session } from '../../shared/types'
import type { NetworkLease } from '../../shared/network'

export interface ExecutionStore {
  getProject(id: string): Project | undefined
  getProvider(id: string): Provider | undefined
  getSecret(id: string): Promise<string>
  getSession(id: string): Session | undefined
  getExecution(id: string): Execution | undefined
  saveExecution(execution: Execution): void
  listExecutions(): Execution[]
}
export interface DocumentTools {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  call(projectRoot: string, name: string, args: unknown, signal: AbortSignal): Promise<unknown>
}
export interface BackendContext {
  execution: Execution; prompt: string; signal: AbortSignal
  network?: NetworkLease
  event(event: Omit<ExecutionEvent, 'id' | 'at'>): void
  reserveCall(): void
  session(id: string): void
}
export interface ExecutionBackend { run(context: BackendContext): Promise<string> }
