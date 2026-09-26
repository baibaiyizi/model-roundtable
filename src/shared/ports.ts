import type { Evidence, KnowledgeBase, ModelRef, Provider, Session, Settings, Source, SourceChunk, Usage } from './types'
import type { StructuredMode, StructuredRequest } from './structured'
import type { NetworkLease, NetworkSnapshot } from './network'

export interface ChatRequest { model: ModelRef; system: string; prompt: string; maxOutputTokens: number; signal: AbortSignal; onDelta?: (text: string) => void; images?: string[]; structured?: StructuredRequest; network?: NetworkLease }
export interface ChatResult { text: string; usage?: Usage; finishReason?: string; refusal?: string; responseId?: string; structuredMode?: StructuredMode; network?: NetworkSnapshot }
export interface GatewayPort {
  chat(request: ChatRequest): Promise<ChatResult>
  embed(model: ModelRef, texts: string[], signal: AbortSignal): Promise<number[][]>
  transcribe(model: ModelRef, filePath: string, signal: AbortSignal): Promise<string>
}
export interface StorePort {
  getSession(id: string): Session | undefined
  saveSession(session: Session): void
  listSessions(): Session[]
  getProvider(id: string): Provider | undefined
  getSettings(): Settings
  getKnowledgeBase(id: string): KnowledgeBase | undefined
  saveKnowledgeBase(kb: KnowledgeBase): void
  listKnowledgeBases(): KnowledgeBase[]
  deleteKnowledgeBase(id: string): void
  getSource(id: string): Source | undefined
  saveSource(source: Source): void
  listSources(knowledgeBaseId?: string): Source[]
  deleteSource(id: string): void
  saveChunks(sourceId: string, chunks: SourceChunk[]): void
  getChunks(sourceId: string): SourceChunk[]
}
export interface EvidencePort {
  web?(session: Session, signal: AbortSignal, tools?: EvidenceToolScope): Promise<WebEvidenceScope>
  retrieve(knowledgeBaseIds: string[], query: string, signal: AbortSignal, beforeModelCall?: () => void): Promise<Evidence[]>
  search(query: string, signal: AbortSignal, session?: Session): Promise<Evidence[]>
  tools?(session: Session, signal: AbortSignal, onEvidence: (items: Evidence[]) => void): Promise<EvidenceToolScope>
}
export interface WebEvidenceScope {
  source: string
  snapshots?: { search?: NetworkSnapshot; web?: NetworkSnapshot }
  search(query: string, signal: AbortSignal): Promise<Evidence[]>
  read(url: string, signal: AbortSignal): Promise<Evidence[]>
  close(): Promise<void>
}
export interface EvidenceToolScope {
  searchSource?: string; searchExtensionId?: string
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  call(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
  search?(query: string): Promise<Evidence[]>
}
