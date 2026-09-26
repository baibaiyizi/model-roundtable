import type { Project } from '../../shared/workspace'
import type { Evidence } from '../../shared/types'
import type { ExtensionEvent } from '../../shared/extensions'
import type { ComponentRuntimePort } from '../../shared/components'
import type { ProviderNetworkPort } from '../../shared/network'
export interface ExtensionStore {
  getEntity<T>(kind: string, id: string): T | undefined
  listEntities<T>(kind: string): T[]
  saveEntity(kind: string, id: string, value: unknown): void
  deleteEntity(kind: string, id: string): void
  getSecret(id: string): Promise<string>
  setSecret(id: string, value: string): Promise<void>
  getProject(id: string): Project | undefined
}
export interface ExtensionOptions { store: ExtensionStore; stateDir: string; runtime: ComponentRuntimePort; fetch?: typeof fetch; network?: ProviderNetworkPort; openExternal(url: string): Promise<void>; emit(event: ExtensionEvent): void; registryUrl?: string; skillsUrl?: string; githubUrl?: string }
export interface ExtensionScopeInput { projectId: string; runId: string; attempt?: number; contextVersion?: number; mode: 'discussion' | 'execution'; signal: AbortSignal; onEvidence?(items: Evidence[]): void }
export interface ExtensionScope { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>; call(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>; search?(query: string): Promise<Evidence[]>; searchSource?: string; searchExtensionId?: string; close(): Promise<void> }
