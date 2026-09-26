export type ComponentId = 'documents' | 'libreoffice' | 'lancedb' | 'opencode' | 'codex' | 'claude' | 'node' | 'python' | 'uv' | 'git' | 'skills' | 'mihomo'
export type ComponentPhase = 'missing' | 'downloading' | 'verifying' | 'extracting' | 'ready' | 'restart-required' | 'cancelled' | 'failed'
export interface ComponentStatus {
  id: ComponentId
  name: string
  version: string
  phase: ComponentPhase
  receivedBytes?: number
  totalBytes?: number
  artifact?: string
  error?: string
  directory?: string
  installedVersion?: string
  downloadBytes?: number
  installedBytes?: number
}
export interface ResolvedComponent {
  id: ComponentId
  version: string
  directory: string
  executable: string
  npmCli?: string
  environment?: Record<string, string>
}
export interface ComponentRuntimePort {
  resolve(id: ComponentId): Promise<ResolvedComponent>
  ensure(id: ComponentId, signal?: AbortSignal): Promise<ResolvedComponent>
  acquire?(id: ComponentId): () => void
  markLoaded?(id: ComponentId): void
}
export interface ComponentsAPI {
  listComponents(): Promise<ComponentStatus[]>
  prepareComponent(id: ComponentId): Promise<ComponentStatus>
  importComponent(input: { id: ComponentId; paths: string[] }): Promise<ComponentStatus>
  selectComponentFiles(): Promise<string[]>
  cancelComponent(id: ComponentId): Promise<void>
  removeComponent(id: ComponentId): Promise<void>
}
