export type NetworkSelection = { mode: 'system' } | { mode: 'direct' } | { mode: 'subscription'; subscriptionId: string; nodeId: string }
export type NetworkScopeName = 'search' | 'catalog' | 'downloads' | 'subscriptions' | 'web' | 'accounts' | `mcp:${string}`
export interface NetworkNode { id: string; name: string; type: string; delayMs?: number; testedAt?: string; error?: string }
export interface NetworkSubscription { id: string; name: string; source: 'url' | 'file'; host?: string; updatedAt: string; nodes: NetworkNode[]; error?: string; pending?: boolean }
export interface NetworkSnapshot { selection: NetworkSelection; label: string; coreVersion?: string; nodeName?: string; subscriptionName?: string; subscriptionRevision?: string }
export interface NetworkNodeRef { subscriptionId: string; nodeId: string }
export interface NetworkNodeTest extends NetworkNodeRef { status: 'waiting' | 'running' | 'complete' | 'failed' | 'cancelled'; result?: NetworkNode; error?: string }
export interface NetworkTestJob { id: string; status: 'running' | 'complete' | 'cancelled'; items: NetworkNodeTest[] }
export interface NetworkState {
  subscriptions: NetworkSubscription[]
  bindings: Partial<Record<NetworkScopeName, NetworkSelection>>
  core: { phase: 'stopped' | 'starting' | 'running' | 'failed'; version: string; error?: string }
  pending: boolean
  nodeTests?: NetworkTestJob
}
export interface ImportSubscriptionInput { name: string; url?: string; content?: string }
export interface NetworkAPI {
  getNetworkState(): Promise<NetworkState>
  importNetworkSubscription(input: ImportSubscriptionInput): Promise<NetworkState>
  refreshNetworkSubscription(id: string): Promise<NetworkState>
  removeNetworkSubscription(id: string): Promise<NetworkState>
  testNetworkNode(input: { subscriptionId: string; nodeId: string }): Promise<NetworkNode>
  testNetworkNodes(nodes: NetworkNodeRef[]): Promise<NetworkTestJob>
  cancelNetworkTests(id: string): Promise<void>
  saveNetworkBindings(bindings: Partial<Record<NetworkScopeName, NetworkSelection>>): Promise<NetworkState>
  restartNetworkCore(): Promise<NetworkState>
}

/** Main-process only capabilities; never serialized over IPC. */
export interface NetworkLease {
  fetchForProvider(id: string): typeof fetch
  environmentForProvider(id: string, targetUrl?: string): Promise<Record<string, string>>
  snapshots: Record<string, NetworkSnapshot>
  release(): void
}
export interface NetworkScopeLease {
  fetch: typeof fetch
  environment(targetUrl?: string): Promise<Record<string, string>>
  snapshot: NetworkSnapshot
  release(): void
}
export interface ProviderNetworkPort {
  fetchForProvider(id: string): typeof fetch
  fetchForScope(scope: NetworkScopeName): typeof fetch
  environmentForProvider(id: string, targetUrl?: string): Promise<Record<string, string>>
  environmentForScope(scope: NetworkScopeName, targetUrl?: string): Promise<Record<string, string>>
  acquireForProviders(ids: string[], signal?: AbortSignal): Promise<NetworkLease>
  acquireForScope(scope: NetworkScopeName, signal?: AbortSignal): Promise<NetworkScopeLease>
}
