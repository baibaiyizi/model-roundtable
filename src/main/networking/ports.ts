import type { ComponentRuntimePort } from '../../shared/components'
import type { NetworkSelection, NetworkSnapshot, NetworkScopeName, NetworkState } from '../../shared/network'
import type { Provider } from '../../shared/types'
export interface NetworkStore {
  getEntity<T>(kind: string, id: string): T | undefined
  listEntities<T>(kind: string): T[]
  saveEntity<T>(kind: string, id: string, data: T): void
  deleteEntity(kind: string, id: string): void
  setSecret(id: string, value: string): Promise<void>
  getSecret(id: string): Promise<string>
  getProvider(id: string): Provider | undefined
  listProviders(): Provider[]
}
export interface PreparedNetworkRoute {
  key: string
  mode: NetworkSelection['mode']
  proxyUrl?: string
  snapshot: NetworkSnapshot
}
export interface NetworkTransport {
  fetch(route: PreparedNetworkRoute): typeof fetch
  resolveSystemProxy(targetUrl: string): Promise<string>
  close?(): Promise<void>
}
export interface NetworkManagerOptions {
  store: NetworkStore
  runtime: ComponentRuntimePort
  stateDir: string
  transport: NetworkTransport
  isBusy?: () => boolean
  emit?: (state: NetworkState) => void
}
export type NetworkBindings = Partial<Record<NetworkScopeName, NetworkSelection>>
