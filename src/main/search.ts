import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import type { Evidence, SearchConfig } from '../shared/types'
import { DEFAULT_SEARCH } from '../shared/workspace'
import { fetchWebpage } from './knowledge/webpage'

const resultSchema = z.object({ results: z.array(z.object({ title: z.string(), url: z.url(), content: z.string().nullish().transform(value => value ?? '') })) })
export class WebSearch {
  constructor(private getKey: () => Promise<string>, private endpoint = 'https://api.tavily.com/search', private fetcher: typeof fetch = fetch) {}
  async search(query: string, signal: AbortSignal): Promise<Evidence[]> {
    signal.throwIfAborted()
    const key = await this.getKey()
    if (!key) throw new Error('请先在设置中填写 Tavily 搜索密钥。')
    const response = await this.fetcher(this.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)])
    })
    if (!response.ok) throw new Error(`联网搜索失败（HTTP ${response.status}），请检查搜索密钥、额度或网络。`)
    const data = resultSchema.parse(await response.json())
    signal.throwIfAborted()
    const seen = new Set<string>()
    return data.results.filter(r => /^https?:\/\//i.test(r.url) && !seen.has(r.url) && seen.add(r.url)).map(r => ({
      id: `web-${randomUUID()}`, title: r.title, url: r.url, text: r.content, locator: r.url,
      kind: 'web', contentType: 'snippet', query, retrievedAt: new Date().toISOString()
    }))
  }
}

export interface BrowserSearchPort { search(query: string, engine: SearchConfig['engine'], signal: AbortSignal): Promise<Evidence[]> }
export class SearchService {
  constructor(private config: () => SearchConfig | undefined, private getKey: () => Promise<string>, private browser: BrowserSearchPort, private fetcher: typeof fetch = fetch, private readFetcher: typeof fetch = fetcher) {}
  async read(url: string, signal: AbortSignal): Promise<Evidence[]> {
    const html = await fetchWebpage(url, signal, (input, init) => this.readFetcher(input, { ...init, credentials: 'omit' }))
    signal.throwIfAborted()
    const dom = new JSDOM(html, { url })
    try {
      const article = new Readability(dom.window.document).parse()
      const text = article?.textContent?.trim()
      if (!text) throw new Error('网页没有可提取的正文。')
      signal.throwIfAborted()
      return [{ id: `web-${randomUUID()}`, title: article?.title?.trim() || url, url, text: text.slice(0, 20000), locator: url, kind: 'web', contentType: 'body', retrievedAt: new Date().toISOString() }]
    } finally { dom.window.close() }
  }
  async search(query: string, signal: AbortSignal): Promise<Evidence[]> {
    const config = this.config() ?? DEFAULT_SEARCH
    let results: Evidence[]
    if (config.provider === 'browser') results = await this.browser.search(query, config.engine, signal)
    else if (config.provider === 'tavily') results = await new WebSearch(this.getKey, undefined, this.fetcher).search(query, signal)
    else {
      if (!config.searxngUrl) throw new Error('请填写 SearXNG 实例地址，并在实例中启用 JSON 搜索。')
      const url = new URL(config.searxngUrl)
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('SearXNG 地址无效。')
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/search`; url.search = ''; url.searchParams.set('q', query); url.searchParams.set('format','json')
      const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), credentials: 'omit' })
      if (!response.ok) throw new Error(`SearXNG 搜索失败（HTTP ${response.status}），请检查实例是否开放 JSON 接口。`)
      const raw = await response.text()
      if (raw.length > 2_000_000) throw new Error('搜索结果超过大小限制。')
      let data: z.infer<typeof resultSchema>
      try { data = resultSchema.parse(JSON.parse(raw)) } catch { throw new Error('SearXNG 未返回可用 JSON 结果，请检查实例配置。') }
      results = data.results.filter(r => /^https?:\/\//i.test(r.url)).slice(0,5).map(r => ({ id: `web-${randomUUID()}`, title: r.title, url: r.url, text: r.content, locator: r.url, kind: 'web', contentType: 'snippet', query, retrievedAt: new Date().toISOString() }))
    }
    signal.throwIfAborted()
    const seen = new Set<string>()
    results = results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url)).slice(0,5)
    await Promise.allSettled(results.slice(0,3).map(async result => {
      try {
        const [article] = await this.read(result.url!, signal)
        if (article.text.length < 100) throw new Error('未提取到足够正文，保留搜索摘要。')
        result.text = article.text; result.contentType = 'body'
      } catch (error) { result.fetchError = error instanceof Error ? error.message : '正文提取失败，保留搜索摘要。' }
    }))
    signal.throwIfAborted()
    return results
  }
}
