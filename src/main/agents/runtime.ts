import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentKind, AgentRuntimeStatus } from '../../shared/execution'
import type { ComponentRuntimePort } from '../../shared/components'
import { RuntimeManager } from '../components'

export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256'); for await (const data of createReadStream(path)) hash.update(data); return hash.digest('hex')
}
/** All agent binaries use the same pinned component manager. Account profiles stay separate. */
export class AgentRuntime {
  readonly components: ComponentRuntimePort
  constructor(readonly runtimeDir: string, readonly stateDir: string, fetcher: typeof fetch = fetch, components?: ComponentRuntimePort) {
    this.components = components ?? new RuntimeManager({ manifestPath: join(runtimeDir, '..', 'components', 'manifest.json'), cacheDir: join(stateDir, 'components'), fetch: fetcher })
  }
  profile(kind: 'codex' | 'claude'): string { return join(this.stateDir, 'accounts', kind) }
  async executable(kind: AgentKind | 'rg'): Promise<string> {
    const component = await this.components.resolve(kind === 'api' || kind === 'rg' ? 'opencode' : kind)
    return kind === 'rg' ? join(component.directory, 'rg', 'rg.exe') : component.executable
  }
  async prepare(kind: AgentKind): Promise<AgentRuntimeStatus> {
    const component = await this.components.ensure(kind === 'api' ? 'opencode' : kind)
    if (kind !== 'api') await mkdir(this.profile(kind), { recursive: true })
    return { kind, available: true, version: component.version, message: kind === 'api' ? 'OpenCode 与项目搜索组件已就绪。' : '官方组件已验证，请登录官方账号。' }
  }
}
