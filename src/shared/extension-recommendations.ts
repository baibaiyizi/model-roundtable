import type { CatalogEntry } from './extensions'

// Editorial introductions only. Installable versions and transports are verified by the catalog.
export const extensionRecommendations: CatalogEntry[] = [
  { kind: 'mcp', id: 'io.github.upstash/context7', name: 'Context7', description: '查询库与框架的最新文档和示例，适合编程任务。', repositoryUrl: 'https://github.com/upstash/context7', websiteUrl: 'https://context7.com', recommendation: { requirements: ['本地方式需要 Node，由应用准备', '无需 Key 可试用；更高额度需 Context7 Key'] } },
  { kind: 'mcp', id: 'io.github.brave/brave-search-mcp-server', name: 'Brave Search', description: '网页、新闻与图片等搜索工具，适合为讨论补充来源。', repositoryUrl: 'https://github.com/brave/brave-search-mcp-server', websiteUrl: 'https://brave.com/search/api/', recommendation: { requirements: ['需要 Brave Search API Key', '本地方式需要 Node，由应用准备'] } },
  { kind: 'mcp', id: 'io.github.microsoft/playwright-mcp', name: 'Playwright', description: '让执行者通过网页结构浏览和操作网站；使用前按项目授权。', repositoryUrl: 'https://github.com/microsoft/playwright-mcp', websiteUrl: 'https://github.com/microsoft/playwright-mcp', recommendation: { requirements: ['需要 Node，由应用准备', '默认需要 Chrome 浏览器；用 Edge 请导入带 --browser msedge 的配置', '网页操作可能需要逐次确认'] } },
  { kind: 'skill', id: 'anthropics/skills/frontend-design', name: 'Frontend Design', skillName: 'frontend-design', source: 'anthropics/skills', description: '前端视觉设计与实现指导，帮助制作有辨识度的网页界面。', repositoryUrl: 'https://github.com/anthropics/skills', recommendation: { requirements: ['无需 API Key', '技能说明；安装不执行其中脚本', '安装所需运行环境由应用准备'] } },
  { kind: 'skill', id: 'vercel-labs/agent-skills/web-design-guidelines', name: 'Web Design Guidelines', skillName: 'web-design-guidelines', source: 'vercel-labs/agent-skills', description: '检查网页设计、可访问性及交互细节。', repositoryUrl: 'https://github.com/vercel-labs/agent-skills', recommendation: { requirements: ['无需 API Key', '检查在线规范时需要联网', '安装所需运行环境由应用准备'] } },
  { kind: 'skill', id: 'vercel-labs/agent-skills/vercel-react-best-practices', name: 'React Best Practices', skillName: 'vercel-react-best-practices', source: 'vercel-labs/agent-skills', description: 'React 与 Next.js 性能和代码组织建议，适合执行及审阅任务。', repositoryUrl: 'https://github.com/vercel-labs/agent-skills', recommendation: { requirements: ['无需 API Key', '技能说明；安装不执行其中脚本', '安装所需运行环境由应用准备'] } },
].map(entry => ({ ...entry, kind: entry.kind as CatalogEntry['kind'], version: '', status: 'active' }))

export type CatalogSort = 'source' | 'name' | 'updated' | 'installs' | 'stars'
export function sortCatalogEntries(entries: CatalogEntry[], sort: CatalogSort): CatalogEntry[] {
  if (sort === 'source') return entries
  return [...entries].sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    const value = (entry: CatalogEntry) => sort === 'stars' ? entry.repositoryStars : sort === 'installs' ? entry.installs : entry.updatedAt ? Date.parse(entry.updatedAt) : undefined
    const av = value(a), bv = value(b), knownA = av !== undefined && Number.isFinite(av), knownB = bv !== undefined && Number.isFinite(bv)
    return knownA && knownB ? bv! - av! : knownA ? -1 : knownB ? 1 : 0
  })
}
