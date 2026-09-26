export interface RecoveryEntry {
  legacyId: string
  name: string
  baseUrl: string
  modelIds: string[]
  status: 'available' | 'same-id' | 'address-conflict' | 'already-imported' | 'invalid'
  keyStatus: 'ready' | 'missing' | 'unreadable'
  reason?: string
}
export interface RecoveryPreview {
  token: string
  found: boolean
  sourcePath: string
  entries: RecoveryEntry[]
}
export interface RecoveryResult {
  imported: number
  skipped: number
  keysNotRecovered: string[]
  backupPath?: string
}
export interface RecoveryAPI {
  previewLegacyRecovery(): Promise<RecoveryPreview>
  importLegacyRecovery(input: { token: string; entries: { legacyId: string; asSeparate: boolean }[] }): Promise<RecoveryResult>
}
