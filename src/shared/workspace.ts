import type { Evidence, ModelRef, SessionInput } from './types'

export interface Project {
  id: string; name: string; directory: string; instructions: string; knowledgeBaseIds: string[]
  createdAt: string; updatedAt: string
}
export type ProjectInput = Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }
export interface ProjectFile { path: string; name: string; directory: boolean; size: number }
export interface ProjectFileContent { path: string; text?: string; binary: boolean; size: number; sha256: string }
export interface DiscussionTemplate { id: string; name: string; config: SessionInput; createdAt: string }
export interface BranchInput { sessionId: string; messageId: string; title?: string }
export interface SearchConfig { provider: 'browser' | 'tavily' | 'searxng'; engine: 'bing' | 'baidu' | 'google'; searxngUrl?: string }
export const DEFAULT_SEARCH: SearchConfig = { provider: 'browser', engine: 'bing' }
export interface SpeakingBid { participantId: string; wantsToSpeak: boolean; reason: string; replyTo: string | null; searchQuery: string | null }
export interface BidBatch { context: string; version: number; pendingIds: string[]; bids: SpeakingBid[]; errors: Record<string, string> }
export interface SearchBatch { phase: string; context: string; proposals: Record<string, string | null>; executed: string[] }
export interface WorkspaceAPI {
  saveProject(input: ProjectInput): Promise<Project>
  removeProject(id: string): Promise<void>
  selectDirectory(): Promise<string | null>
  readProjectFiles(input: { projectId: string; path?: string }): Promise<ProjectFile[]>
  readProjectFile(input: { projectId: string; path: string }): Promise<ProjectFileContent>
  openProjectPath(input: { projectId: string; path?: string }): Promise<void>
  saveDraft(input: { id: string; text: string }): Promise<void>
  getDraft(id: string): Promise<string>
  saveTemplate(input: { name: string; sessionId: string }): Promise<DiscussionTemplate>
  deleteTemplate(id: string): Promise<void>
  branchSession(input: BranchInput): Promise<import('./types').Session>
  muteParticipant(input: { sessionId: string; participantId: string; muted: boolean }): Promise<import('./types').Session>
  summarizeSession(input: { sessionId: string; model: ModelRef }): Promise<import('./types').Session>
  searchSession(input: { sessionId: string; query: string }): Promise<import('./types').Session>
  searchWeb(query: string): Promise<Evidence[]>
}
