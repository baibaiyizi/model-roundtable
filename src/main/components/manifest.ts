import type { ComponentId } from '../../shared/components'

export interface ComponentArtifact {
  filename: string
  url: string
  sha256?: string
  integrity?: string
  format: 'zip' | 'tar' | 'msi' | 'file' | 'vc-redist'
  destination: string
  strip?: number
  pick?: string
}
export interface ComponentDefinition {
  id: ComponentId
  name: string
  version: string
  executable: string
  npmCli?: string
  recipe?: 'python' | 'documents' | 'libreoffice'
  artifacts: ComponentArtifact[]
  licenses: string[]
}
export interface ComponentManifest { schema: 1; platform: 'win32-x64'; components: ComponentDefinition[] }
