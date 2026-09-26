import type { BidBatch, SearchBatch, SearchConfig, Project, DiscussionTemplate, WorkspaceAPI } from './workspace'
import type { EditorAPI } from './editor'
import type { Execution, ExecutionAPI } from './execution'
import type { DocumentResult } from './documents'
import type { StructuredCapability, ResponseDiagnostic } from './structured'
import type { RecoveryAPI } from './recovery'
import type { ComponentsAPI, ComponentStatus } from './components'
import type { ExtensionAPI, ExtensionApproval, ExtensionCall, ExtensionJob, InstalledExtension } from './extensions'
import type { NetworkAPI, NetworkSelection, NetworkState, NetworkSnapshot } from './network'
export type * from './network'
export * from './workspace'
export * from './execution'
export * from './documents'
export interface ModelRef { providerId: string; modelId: string }
export interface Provider {
  network?: NetworkSelection
  kind?: 'api' | 'codex' | 'claude'
  claudeAuth?: 'official' | 'apiKey'
  id: string; name: string; baseUrl: string; modelIds: string[]; hasKey: boolean
  tokenParameter: 'max_tokens' | 'max_completion_tokens'
  streamUsage: boolean; timeoutMs: number
  structuredOutputs?: Record<string, StructuredCapability>
}
export type ProviderInput = Omit<Provider, 'id' | 'hasKey'> & { id?: string; apiKey?: string }
export interface Settings {
  search?: SearchConfig
  moderator?: ModelRef; vision?: ModelRef; transcription?: ModelRef; hasTavilyKey: boolean
}
export interface SettingsInput { moderator?: ModelRef; vision?: ModelRef; transcription?: ModelRef; tavilyKey?: string; search?: SearchConfig }
export type Mode = 'roundtable' | 'free' | 'debate'
export interface Participant { id: string; name: string; model: ModelRef; role: string; team?: 'pro' | 'con'; muted?: boolean }
export interface Limits { autoTurns: number; maxCalls: number; maxOutputTokens: number; maxSearches: number | null; contextChars: number }
export const DEFAULT_LIMITS: Limits = { autoTurns: 12, maxCalls: 60, maxOutputTokens: 1500, maxSearches: null, contextChars: 48000 }
export interface SessionInput {
  projectId?: string; title?: string; topic: string; mode: Mode; participants: Participant[]; moderator?: ModelRef
  knowledgeBaseIds: string[]; searchEnabled: boolean; limits: Limits
}
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens: number }
export type MessageStatus = 'streaming' | 'complete' | 'interrupted' | 'failed'
export interface Message {
  id: string; sessionId: string; runId: string; turnId: string; contextVersion: number; stepId?: string
  speakerId: string; speakerName: string; model?: ModelRef; kind: 'user' | 'assistant' | 'system'
  phase: string; content: string; status: MessageStatus; createdAt: string; usage?: Usage; error?: string
  diagnostic?: ResponseDiagnostic
  network?: NetworkSnapshot
}
export interface Evidence {
  searchSource?: string; network?: NetworkSnapshot
  contentType?: 'snippet' | 'body'; fetchError?: string
  id: string; sourceId?: string; knowledgeBaseId?: string; title: string; text: string; locator: string
  kind: 'text' | 'ocr' | 'vision' | 'transcript' | 'web' | 'tool'; url?: string; query?: string; retrievedAt: string
  toolCallId?: string; extensionId?: string
}
export interface Step {
  id: string; phase: string; speakerId: string; instruction: string; blind?: boolean; stageEnd?: boolean
}
export interface Run {
  webSnapshots?: Array<{ contextVersion: number; capturedAt: string; source: string; search?: NetworkSnapshot; web?: NetworkSnapshot }>
  networkSnapshots?: Array<{ contextVersion: number; capturedAt: string; providers: Record<string, NetworkSnapshot> }>
  toolsLoaded?: boolean; toolCalls?: number
  bidBatch?: BidBatch; searchBatch?: SearchBatch; summarySeat?: number; singleTurn?: boolean
  id: string; contextVersion: number; cursor: number; steps: Step[]; calls: number; searches: number
  autoTurns: number; pauseRequested: boolean; phase: string; error?: string; summary?: string
  summaryThrough?: string; currentTurnId?: string; searchPhases: string[]
  knowledgeLoaded?: boolean; blindContext?: string; errorTask?: 'knowledge' | 'tools' | 'search' | 'summary' | 'selection' | 'speaker' | 'bidding'
}
export type SessionStatus = 'idle' | 'running' | 'paused' | 'error' | 'stopped' | 'complete'
export interface Session extends SessionInput {
  branchOf?: { sessionId: string; messageId: string }; projectInstructions?: string
  id: string; title: string; createdAt: string; updatedAt: string; status: SessionStatus
  messages: Message[]; evidence: Evidence[]; run?: Run
}
export interface KnowledgeBase {
  id: string; name: string; embedding: ModelRef; dimensions?: number; createdAt: string
  embeddingBaseUrl: string; chunkVersion: number
}
export interface Source {
  id: string; knowledgeBaseId: string; title: string; originalPath?: string; url?: string
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled'; progress: string
  createdAt: string; error?: string; chunkCount: number
  modelDiagnostics?: { model: ModelRef; rawResponse: string; diagnostic: ResponseDiagnostic }[]
}
export interface SourceChunk extends Evidence { sourceId: string; knowledgeBaseId: string }
export interface KnowledgeBaseInput { name: string; embedding: ModelRef }
export interface ImportInput { knowledgeBaseId: string; filePaths?: string[]; url?: string }
export interface Bootstrap { activeExecutionIds?: string[]; activeSessionIds?: string[]; executions: Execution[]; projects: Project[]; templates: DiscussionTemplate[]; providers: Provider[]; settings: Settings; sessions: Session[]; knowledgeBases: KnowledgeBase[]; sources: Source[]; version: string; mediaReady: boolean }
export interface AppEvent {
  active?: boolean
  type: 'session' | 'delta' | 'source' | 'knowledge' | 'error' | 'execution' | 'component' | 'extensions' | 'network' | 'activity' | 'close-request' | 'editor'
  activeSessionIds?: string[]
  network?: NetworkState
  component?: ComponentStatus
  job?: ExtensionJob; approval?: ExtensionApproval; call?: ExtensionCall; extension?: InstalledExtension
  execution?: Execution
  session?: Session; sessionId?: string; runId?: string; turnId?: string; contextVersion?: number
  messageId?: string; delta?: string; source?: Source; error?: string
}
export interface ActionInput { sessionId: string; action: 'pause' | 'resume' | 'stop' | 'retry' | 'skip' | 'review' | 'one-turn' }
export interface InterjectInput { sessionId: string; text: string; participantId?: string }
export interface AppAPI extends WorkspaceAPI, ExecutionAPI, RecoveryAPI, ComponentsAPI, ExtensionAPI, NetworkAPI, EditorAPI {
  closeWindow(): Promise<void>
  setWindowCloseGuard(enabled: boolean): Promise<void>
  bootstrap(): Promise<Bootstrap>
  saveProvider(input: ProviderInput): Promise<Provider>
  removeProvider(id: string): Promise<void>
  discoverModels(input: { providerId: string }): Promise<string[]>
  testModel(model: ModelRef): Promise<{ text: string; usage?: Usage }>
  testToolModel(model: ModelRef): Promise<{ text: string }>
  testStructuredModel(input: { model: ModelRef; mode: 'json_object' | 'json_schema' }): Promise<StructuredCapability>
  inspectDocument(input: { projectId: string; path: string }): Promise<DocumentResult>
  previewDocument(input: { projectId: string; path: string }): Promise<DocumentResult>
  saveSettings(input: SettingsInput): Promise<Settings>
  createSession(input: SessionInput): Promise<Session>
  sessionAction(input: ActionInput): Promise<Session>
  interject(input: InterjectInput): Promise<Session>
  deleteSession(id: string): Promise<void>
  exportSession(id: string): Promise<string | null>
  createKnowledgeBase(input: KnowledgeBaseInput): Promise<KnowledgeBase>
  deleteKnowledgeBase(id: string): Promise<void>
  rebuildKnowledgeBase(input: { id: string; embedding: ModelRef }): Promise<void>
  selectFiles(): Promise<string[]>
  importSources(input: ImportInput): Promise<Source[]>
  cancelImport(id: string): Promise<void>
  deleteSource(id: string): Promise<void>
  searchKnowledge(input: { knowledgeBaseIds: string[]; query: string }): Promise<Evidence[]>
  getSourceChunks(id: string): Promise<SourceChunk[]>
  openSource(input: { sourceId: string; locator?: string }): Promise<void>
  openExternal(url: string): Promise<void>
  onEvent(callback: (event: AppEvent) => void): () => void
}
