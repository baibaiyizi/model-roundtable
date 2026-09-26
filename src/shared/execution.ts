import type { Evidence, Message, ModelRef, Usage } from './types'
import type { ResponseDiagnostic } from './structured'
import type { NetworkSnapshot } from './network'
export type AgentKind = 'api' | 'codex' | 'claude'
export type ExecutionStatus = 'ready' | 'running' | 'reviewing' | 'stopping' | 'stopped' | 'failed' | 'complete' | 'needs_attention'
export interface ExecutionInput {
  web?: { enabled: boolean; maxSearches: number | null }
  projectId: string; sessionId?: string; task: string; acceptance: string; executor: ModelRef; reviewers: ModelRef[]
  /** API: exact admitted upstream attempts. Official CLIs: agent invocations, not internal HTTP calls. */
  maxCalls: number
  /** API request parameter hard cap; Claude applies its documented setting to most requests; Codex is a length hint. */
  maxOutputTokens: number; timeoutMs: number; maxRepairRounds: 0 | 1 | 2
}
export const DEFAULT_EXECUTION_LIMITS = { maxCalls: 60, maxOutputTokens: 8192, timeoutMs: 1800000, maxRepairRounds: 2 as const }
export interface HandoffSnapshot {
  capturedAt: string; projectInstructions: string; sessionId?: string; contextVersion?: number; topic?: string; transcript: string; messages: Message[]; evidence: Evidence[]
}
export interface ExecutionEvent {
  id: string; at: string; kind: 'status' | 'text' | 'tool' | 'request' | 'error' | 'review'
  text: string; tool?: string; toolId?: string; state?: 'running' | 'complete' | 'failed'; usage?: Usage
}
export interface FileChange {
  path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string
  diff?: string; binary: boolean; bytes?: number
}
export interface ReviewResult {
  id: string; round: number; model: ModelRef; verdict: 'pass' | 'changes_requested' | 'failed'; findings: string
  createdAt: string; usage?: Usage
  rawResponse?: string; diagnostic?: ResponseDiagnostic
}
export interface Execution extends ExecutionInput {
  searches?: number
  webSnapshots?: Array<{ attempt: number; capturedAt: string; source: string; search?: NetworkSnapshot; web?: NetworkSnapshot }>
  networkSnapshots?: Array<{ attempt: number; capturedAt: string; providers: Record<string, NetworkSnapshot> }>
  id: string; rootPath: string; backend: AgentKind; status: ExecutionStatus; attempt: number; repairRound: number
  calls: number; createdAt: string; updatedAt: string; handoff: HandoffSnapshot; events: ExecutionEvent[]
  changes: FileChange[]; reviews: ReviewResult[]; result?: string; error?: string; backendSessionId?: string
  snapshotWarnings: string[]
  toolEvidence?: Evidence[]
}
export interface AgentRuntimeStatus {
  kind: AgentKind; available: boolean; version?: string; authenticated?: boolean; message: string
  authMethod?: 'subscription' | 'console' | 'official'
}
export type AgentLoginInput = { kind: 'codex' } | { kind: 'claude'; method: 'subscription' | 'console' }
export interface ExecutionAppEvent { type: 'execution'; execution: Execution; active?: boolean }
export interface ExecutionAPI {
  createExecution(input: ExecutionInput): Promise<Execution>
  executionAction(input: { id: string; action: 'start' | 'stop' | 'retry' }): Promise<Execution>
  deleteExecution(id: string): Promise<void>
  agentStatus(): Promise<AgentRuntimeStatus[]>
  agentPrepare(kind: AgentKind): Promise<AgentRuntimeStatus>
  agentLogin(input: AgentLoginInput): Promise<{ message: string; url?: string }>
  agentOpenClaude(): Promise<{ message: string }>
  agentLogout(kind: 'codex' | 'claude'): Promise<void>
}
