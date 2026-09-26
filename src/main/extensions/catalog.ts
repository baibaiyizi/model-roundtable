import { z } from 'zod'
import type { CatalogEntry, ExtensionKind, ExtensionPopularityResult, ExtensionSearchInput, ExtensionSearchResult } from '../../shared/extensions'
import { extensionRecommendations } from '../../shared/extension-recommendations'
import type { ExtensionOptions } from './ports'
import { digest, jsonFetch } from './util'

const serverSchema = z.object({ name: z.string().min(1), description: z.string(), version: z.string(), title: z.string().optional(), websiteUrl: z.string().optional(), repository: z.object({ url: z.string().optional() }).optional(), packages: z.array(z.any()).optional(), remotes: z.array(z.any()).optional() })
export class ExtensionCatalog {
  private fetcher: typeof fetch
  private starRequests = new Map<string, Promise<{ count: number; at: string }>>()
  constructor(private options: ExtensionOptions) { this.fetcher = options.fetch ?? fetch }
  private entry(raw: any): CatalogEntry { const server = serverSchema.parse(raw.server); const meta = raw._meta?.['io.modelcontextprotocol.registry/official']; return { id: server.name, kind: 'mcp', name: server.title ?? server.name, description: server.description, version: server.version, websiteUrl: server.websiteUrl, repositoryUrl: server.repository?.url, packages: server.packages, remotes: server.remotes, status: ['deleted', 'deprecated'].includes(meta?.status) ? meta.status : 'active', updatedAt: meta?.updatedAt } }
  async search(input: ExtensionSearchInput, signal?: AbortSignal): Promise<ExtensionSearchResult> {
    const key = digest(input)
    try { const result = await this.searchOnline(input, signal); signal?.throwIfAborted(); this.options.store.saveEntity('extension-search-cache', key, result); return result }
    catch (error) { signal?.throwIfAborted(); const cached = this.options.store.getEntity<ExtensionSearchResult>('extension-search-cache', key); if (!cached) throw error; return { ...cached, cached: true, warning: `目录请求失败，显示上次缓存；安装与更新仍会重新核对来源。${error instanceof Error ? error.message : String(error)}` } }
  }
  private async searchOnline(input: ExtensionSearchInput, signal?: AbortSignal): Promise<ExtensionSearchResult> {
    const query = z.string().trim().max(200).parse(input.query)
    if (input.kind === 'skill') {
      const url = new URL('/api/search', this.options.skillsUrl ?? 'https://skills.sh'); url.searchParams.set('q', query); url.searchParams.set('limit', '50')
      const data = await jsonFetch(this.fetcher, url, signal)
      if (!Array.isArray(data.skills)) throw new Error('Skill 目录未返回技能列表')
      const entries: CatalogEntry[] = data.skills.map((item: any) => { if (typeof item.source !== 'string' || typeof item.name !== 'string') throw new Error('Skill 目录条目缺少来源或名称'); const supported = /^[\w.-]+\/[\w.-]+$/.test(item.source); return { id: item.id ?? `${item.source}/${item.name}`, kind: 'skill', name: item.name, skillName: item.skillId ?? item.name, source: item.source, description: (item.description ?? `来自 ${item.source}`) + (supported ? '' : '；此来源不属于公开 GitHub，当前不能安装'), version: 'latest', status: 'active', installs: item.installs, repositoryUrl: supported ? `https://github.com/${item.source}` : undefined, websiteUrl: `https://skills.sh/${item.id}` } })
      for (const entry of entries) this.options.store.saveEntity('extension-catalog-skill', entry.id, entry)
      return { entries }
    }
    const url = new URL(`${this.options.registryUrl ?? 'https://registry.modelcontextprotocol.io'}/v0.1/servers`); url.searchParams.set('search', query); url.searchParams.set('version', 'latest'); url.searchParams.set('limit', '100'); if (input.cursor) url.searchParams.set('cursor', input.cursor)
    const data = await jsonFetch(this.fetcher, url, signal)
    if (!Array.isArray(data.servers)) throw new Error('MCP 目录未返回服务器列表')
    const entries = data.servers.map((item: unknown) => this.entry(item))
    for (const entry of entries) this.options.store.saveEntity('extension-catalog-mcp', entry.id, entry)
    return { entries, nextCursor: data.metadata?.nextCursor }
  }
  async details(input: { kind: ExtensionKind; id: string; version?: string }, signal?: AbortSignal): Promise<CatalogEntry> {
    if (input.kind === 'mcp') {
      const url = `${this.options.registryUrl ?? 'https://registry.modelcontextprotocol.io'}/v0.1/servers/${encodeURIComponent(input.id)}/versions/${encodeURIComponent(input.version ?? 'latest')}?include_deleted=true`
      const result = this.entry(await jsonFetch(this.fetcher, url, signal)); this.options.store.saveEntity('extension-catalog-mcp', result.id, result); return result
    }
    let found = this.options.store.getEntity<CatalogEntry>('extension-catalog-skill', input.id)
    if (!found) { const parts = input.id.split('/'); if (parts.length < 3 || !parts.every(p => /^[\w.-]+$/.test(p))) throw new Error('Skill 标识必须是 owner/repository/skill'); found = { id: input.id, kind: 'skill', name: parts.slice(2).join('/'), skillName: parts.slice(2).join('/'), source: parts.slice(0, 2).join('/'), description: '', version: 'latest', status: 'active' } }
    if (!found.source || !/^[\w.-]+\/[\w.-]+$/.test(found.source)) throw new Error('当前 Skill 安装支持公开 GitHub 仓库；此来源暂不支持')
    const repo = await jsonFetch(this.fetcher, `${this.options.githubUrl ?? 'https://api.github.com'}/repos/${found.source}`, signal)
    if (repo.private !== false || !repo.default_branch) throw new Error('仅支持公开 Skill 仓库')
    const commit = await jsonFetch(this.fetcher, `${this.options.githubUrl ?? 'https://api.github.com'}/repos/${found.source}/commits/${encodeURIComponent(!input.version || input.version === 'latest' ? repo.default_branch : input.version)}`, signal)
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Skill 仓库未返回固定提交标识')
    const result = { ...found, version: commit.sha, commit: commit.sha, repositoryUrl: repo.html_url, websiteUrl: `https://skills.sh/${found.id}` }; this.options.store.saveEntity('extension-catalog-skill', result.id, result); return result
  }
  async popularity(input: Array<{ kind: ExtensionKind; id: string }>, signal?: AbortSignal): Promise<ExtensionPopularityResult> {
    input = z.array(z.object({ kind: z.enum(['mcp', 'skill']), id: z.string().min(1).max(500) }).strict()).max(300).parse(input)
    const result: ExtensionPopularityResult = { entries: [] }; const repositories = new Map<string, { count: number; at: string } | undefined>()
    for (const item of input) {
      signal?.throwIfAborted()
      const entry = this.options.store.getEntity<CatalogEntry>(`extension-catalog-${item.kind}`, item.id) ?? extensionRecommendations.find(entry => entry.kind === item.kind && entry.id === item.id)
      let repository: string | undefined
      try { const url = new URL(entry?.repositoryUrl ?? ''); const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean); if (url.protocol === 'https:' && url.hostname === 'github.com' && parts.length >= 2 && parts.slice(0, 2).every(part => /^[\w.-]+$/.test(part))) repository = parts.slice(0, 2).join('/').toLowerCase() } catch { /* Non-GitHub sources have no repository Stars. */ }
      if (repository && !repositories.has(repository)) {
        let cached = this.options.store.getEntity<{ count: number; at: string }>('extension-repository-stars', repository)
        if (!cached || Date.now() - Date.parse(cached.at) >= 86400000) {
          const blocked = this.options.store.getEntity<{ until: string }>('extension-stars-limit', 'github')
          if (blocked && Date.parse(blocked.until) > Date.now()) { result.retryAt = blocked.until; result.warning = 'GitHub 星数接口限流，已停止补充；已有星数保留并标注获取时间。' }
          else {
            try { cached = await this.repositoryStars(repository, signal) }
            catch (error) { signal?.throwIfAborted(); result.warning = error instanceof Error ? error.message : String(error); result.retryAt = this.options.store.getEntity<{ until: string }>('extension-stars-limit', 'github')?.until }
          }
        }
        repositories.set(repository, cached)
      }
      const stars = repository && repositories.get(repository)
      result.entries.push({ ...item, ...(stars ? { repositoryStars: stars.count, starsFetchedAt: stars.at } : {}) })
    }
    return result
  }
  private repositoryStars(repository: string, signal?: AbortSignal): Promise<{ count: number; at: string }> {
    const existing = this.starRequests.get(repository); if (existing) return existing
    const pending = (async () => {
      const url = `${this.options.githubUrl ?? 'https://api.github.com'}/repos/${repository}`
      const response = await this.fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), credentials: 'omit', headers: { Accept: 'application/vnd.github+json' } })
      if (response.status === 403 || response.status === 429) {
        const retry = response.headers.get('retry-after'), reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
        const retryTime = retry ? /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) : 0
        const until = new Date(Math.max(Date.now() + 60000, Number.isFinite(retryTime) ? retryTime : 0, Number.isFinite(reset) ? reset : 0)).toISOString()
        this.options.store.saveEntity('extension-stars-limit', 'github', { until }); await response.body?.cancel()
        throw new Error('GitHub 星数接口限流，已停止补充；暂无数据的条目不计为零。')
      }
      const data = await jsonFetch(async () => response, url, signal)
      if (!Number.isSafeInteger(data.stargazers_count) || data.stargazers_count < 0) throw new Error('GitHub 未返回有效的仓库星数')
      const value = { count: data.stargazers_count as number, at: new Date().toISOString() }; this.options.store.saveEntity('extension-repository-stars', repository, value); return value
    })().finally(() => this.starRequests.delete(repository))
    this.starRequests.set(repository, pending); return pending
  }
  async sync(signal: AbortSignal): Promise<void> {
    const previous = this.options.store.getEntity<{ at: string }>('extension-sync', 'mcp'); const started = new Date().toISOString(); let cursor: string | undefined
    do { signal.throwIfAborted(); const url = new URL(`${this.options.registryUrl ?? 'https://registry.modelcontextprotocol.io'}/v0.1/servers`); url.searchParams.set('limit', '100'); if (previous) url.searchParams.set('updated_since', previous.at); else url.searchParams.set('version', 'latest'); if (cursor) url.searchParams.set('cursor', cursor); const data = await jsonFetch(this.fetcher, url, signal); if (!Array.isArray(data.servers)) throw new Error('MCP 目录未返回服务器列表'); for (const raw of data.servers) { const entry = this.entry(raw); const old = this.options.store.getEntity<CatalogEntry>('extension-catalog-mcp', entry.id); if (!previous || raw._meta?.['io.modelcontextprotocol.registry/official']?.isLatest || old?.version === entry.version) this.options.store.saveEntity('extension-catalog-mcp', entry.id, entry) } cursor = data.metadata?.nextCursor } while (cursor)
    this.options.store.saveEntity('extension-sync', 'mcp', { at: started })
  }
}
