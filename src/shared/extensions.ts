import type { Evidence } from './types'

export type ExtensionKind = 'mcp' | 'skill'
export type ToolAccess = 'read' | 'project-write' | 'external'
export interface ExtensionInputField { name?: string; description?: string; value?: string; default?: string; isRequired?: boolean; isSecret?: boolean; choices?: string[]; format?: string; type?: 'named' | 'positional'; valueHint?: string; isRepeated?: boolean; variables?: Record<string, ExtensionInputField> }
export interface ExtensionPackage { registryType: string; identifier: string; version?: string; registryBaseUrl?: string; fileSha256?: string; runtimeHint?: string; runtimeArguments?: ExtensionInputField[]; packageArguments?: ExtensionInputField[]; environmentVariables?: ExtensionInputField[]; transport: ExtensionRemote }
export interface ExtensionRemote { type: string; url?: string; headers?: ExtensionInputField[]; variables?: Record<string, ExtensionInputField> }
export interface CatalogEntry { id: string; kind: ExtensionKind; name: string; description: string; version: string; websiteUrl?: string; repositoryUrl?: string; status: 'active' | 'deprecated' | 'deleted'; packages?: ExtensionPackage[]; remotes?: ExtensionRemote[]; source?: string; skillName?: string; commit?: string; installs?: number; updatedAt?: string; repositoryStars?: number; starsFetchedAt?: string; recommendation?: { requirements: string[] } }
export interface ExtensionPopularityResult { entries: Array<{ kind: ExtensionKind; id: string; repositoryStars?: number; starsFetchedAt?: string }>; warning?: string; retryAt?: string }
export interface ExtensionSearchInput { kind: ExtensionKind; query: string; cursor?: string }
export interface ExtensionSearchResult { entries: CatalogEntry[]; nextCursor?: string; cached?: boolean; warning?: string }
export interface ExtensionTool { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; schemaHash: string; readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; method?: 'resources/list' | 'resources/read' | 'prompts/list' | 'prompts/get' }
export interface InstalledExtension { id: string; kind: ExtensionKind; catalogId: string; name: string; description: string; version: string; revisionId: string; source: string; installedAt: string; updatedAt: string; tools: ExtensionTool[]; status: 'ready' | 'needs-configuration' | 'failed'; error?: string; availableUpdate?: string; updateCheckedAt?: string; configuredFields: string[]; configuration?: Record<string, string>; oauth?: 'required' | 'connected'; skillFiles?: string[]; packageIndex?: number; remoteIndex?: number }
export interface ExtensionInstallInput { kind: ExtensionKind; id: string; version?: string; packageIndex?: number; remoteIndex?: number; values?: Record<string, string>; secrets?: Record<string, string> }
export interface ExtensionUpdateInput { id: string; values?: Record<string, string>; secrets?: Record<string, string> }
export interface ExtensionSearchBinding { projectId: string; extensionId: string; tool: string; schemaHash: string; queryField: string; resultPath: string; titleField: string; urlField: string; textField: string; contentType: 'snippet' | 'body'; fixedArguments?: Record<string, unknown> }
export interface SkillImportInput { kind: 'directory' | 'zip' | 'github'; source: string; skillName?: string; ref?: string }
export interface ExtensionJob { id: string; extensionId?: string; name: string; operation: 'install' | 'update'; status: 'running' | 'complete' | 'failed' | 'cancelled'; progress: string; error?: string; createdAt: string; updatedAt: string; source?: { kind: ExtensionKind; id: string } }
export interface ExtensionGrant { projectId: string; extensionId: string; enabled: boolean; tools: Array<{ name: string; schemaHash: string; access: ToolAccess }>; updatedAt?: string }
export interface ExtensionApproval { id: string; projectId: string; runId: string; extensionId: string; tool: string; arguments: unknown; status: 'pending' | 'approved' | 'denied' | 'cancelled'; createdAt: string; resolvedAt?: string }
export interface ExtensionCall { id: string; projectId: string; runId: string; attempt?: number; contextVersion?: number; extensionId: string; revisionId: string; tool: string; arguments: unknown; status: 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown'; startedAt: string; finishedAt?: string; output?: unknown; error?: string; evidence: Evidence[] }
export interface ExtensionState { installed: InstalledExtension[]; jobs: ExtensionJob[]; grants: ExtensionGrant[]; approvals: ExtensionApproval[]; calls: ExtensionCall[]; searchBindings: ExtensionSearchBinding[] }
export interface ExtensionEvent { type: 'extensions'; job?: ExtensionJob; approval?: ExtensionApproval; call?: ExtensionCall; extension?: InstalledExtension }
export interface ExtensionAPI {
  extensionState(): Promise<ExtensionState>
  searchExtensions(input: ExtensionSearchInput): Promise<ExtensionSearchResult>
  extensionDetails(input: { kind: ExtensionKind; id: string; version?: string }): Promise<CatalogEntry>
  installExtension(input: ExtensionInstallInput): Promise<ExtensionJob>
  updateExtension(input: ExtensionUpdateInput): Promise<ExtensionJob>
  removeExtension(id: string): Promise<void>
  cancelExtensionJob(id: string): Promise<void>
  clearExtensionJob(id: string): Promise<void>
  clearFinishedExtensionJobs(): Promise<number>
  extensionPopularity(input: Array<{ kind: ExtensionKind; id: string }>): Promise<ExtensionPopularityResult>
  testExtension(id: string): Promise<ExtensionTool[]>
  configureExtension(input: { id: string; values: Record<string, string>; secrets?: Record<string, string> }): Promise<InstalledExtension>
  saveExtensionGrant(input: ExtensionGrant): Promise<void>
  resolveExtensionApproval(input: { id: string; allow: boolean }): Promise<void>
  checkExtensionUpdates(): Promise<InstalledExtension[]>
  loginExtension(id: string): Promise<{ authenticated: boolean; message: string }>
  importMcpConfiguration(input: { name: string; configuration: string }): Promise<ExtensionJob[]>
  importSkill(input: SkillImportInput): Promise<ExtensionJob>
  saveExtensionSearchBinding(input: ExtensionSearchBinding): Promise<void>
  removeExtensionSearchBinding(projectId: string): Promise<void>
}
