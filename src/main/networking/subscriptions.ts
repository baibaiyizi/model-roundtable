import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'

export interface SubscriptionResource { key: string; content: string }
export interface SubscriptionContent { resources: SubscriptionResource[] }
const MAX_BYTES = 8 * 1024 * 1024
const uriSchemes = new Set(['ss','ssr','vmess','vless','trojan','hysteria','hysteria2','hy2','hysteria2+realm','hy2+realm','tuic','socks','socks5','socks5h','http','https','anytls','mierus'])
export const networkDigest = (text: string): string => createHash('sha256').update(text).digest('hex')

export function subscriptionUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('订阅地址不是有效的 HTTP(S) URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('订阅地址必须使用 HTTP(S)，不能在地址中嵌入用户名和密码')
  return url
}
export async function downloadSubscription(fetcher: typeof fetch, value: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
  const response = await fetcher(subscriptionUrl(value), { headers, credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`订阅下载失败：HTTP ${response.status}`)
  }
  if (!response.body) throw new Error('订阅返回空内容')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BYTES) throw new Error('订阅内容超过 8 MB'); chunks.push(next.value) }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).toString('utf8')
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function inspectNode(value: unknown): void {
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.type !== 'string') throw new Error('订阅节点缺少名称或协议')
  if (['direct','reject','reject-drop','dns','pass','compatible'].includes(value.type.toLowerCase())) throw new Error('订阅必须提供实际代理节点，不能用直连或内置策略冒充节点')
  if (value['dialer-proxy']) throw new Error('订阅包含依赖其他节点的链式代理；请提供可独立连接的节点')
  // Node parsers accept some local certificate/key paths. Imported subscriptions cannot name local files.
  const visit = (record: unknown): void => {
    if (Array.isArray(record)) { record.forEach(visit); return }
    if (!object(record)) return
    for (const [key, item] of Object.entries(record)) {
      if (['private-key-path','certificate-path','ca-path','config-path','private-key-file','certificate-file'].includes(key)) throw new Error('订阅节点引用了本机文件，不能自动导入')
      if (['certificate','private-key','ca'].includes(key) && typeof item === 'string' && item && !item.includes('-----BEGIN ') && !(key === 'private-key' && value.type === 'wireguard' && /^[A-Za-z0-9+/]{43}=$/.test(item))) throw new Error('订阅节点引用了非内嵌证书或密钥；请使用完整内嵌配置')
      visit(item)
    }
  }
  visit(value)
}
function nodeYaml(nodes: unknown): string {
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 1000) throw new Error('订阅需包含 1 至 1000 个节点')
  nodes.forEach(inspectNode)
  const names = nodes.map(node => (node as Record<string, unknown>).name)
  if (new Set(names).size !== names.length) throw new Error('同一节点列表内存在重名，请先修正订阅')
  return stringify({ proxies: nodes })
}
function parseDocumentValue(content: string): unknown {
  const document = parseDocument(content, { uniqueKeys: true, strict: true })
  if (document.errors.length) throw new Error('订阅 YAML 格式错误')
  try { return document.toJS({ maxAliasCount: 50 }) } catch { throw new Error('订阅 YAML 别名超过限制') }
}
/** Validate only the container; URI protocol conversion belongs to the pinned Mihomo core. */
export function rawNodeResource(content: string): string {
  if (!content.trim() || Buffer.byteLength(content) > MAX_BYTES) throw new Error('订阅内容为空或超过 8 MB')
  let decoded = content.trim()
  if (/^[A-Za-z0-9+/_=\s-]+$/.test(decoded)) {
    const possible = Buffer.from(decoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
    if (possible.includes('://')) decoded = possible.trim()
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) {
    const lines = decoded.split(/\r?\n/).filter(line => line.trim())
    if (lines.length > 1000) throw new Error('订阅节点数量超过 1000')
    for (const line of lines) { const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line.trim()); if (!match || !uriSchemes.has(match[1].toLowerCase())) throw new Error('订阅包含当前内核不支持的节点链接格式') }
    return decoded
  }
  const value = parseDocumentValue(content)
  if (!object(value) || !Array.isArray(value.proxies)) throw new Error('需要 Clash/Mihomo 节点订阅；网页、嵌套配置或商业 VPN 登录链接不能作为节点列表导入')
  return nodeYaml(value.proxies)
}
export function expectedNodeCount(content: string): number {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(content.trim())) return content.trim().split(/\r?\n/).filter(line => line.trim()).length
  const value = parseDocumentValue(content)
  return object(value) && Array.isArray(value.proxies) ? value.proxies.length : 0
}
export async function prepareSubscription(content: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<SubscriptionContent> {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('订阅内容超过 8 MB')
  let document: unknown
  try { document = parseDocumentValue(content) } catch { return { resources: [{ key: 'nodes', content: rawNodeResource(content) }] } }
  if (!object(document)) return { resources: [{ key: 'nodes', content: rawNodeResource(content) }] }
  const resources: SubscriptionResource[] = []
  if (Array.isArray(document.proxies) && document.proxies.length) resources.push({ key: 'nodes', content: nodeYaml(document.proxies) })
  if (document['proxy-providers'] !== undefined) {
    const providers = document['proxy-providers']
    if (!object(providers) || Object.keys(providers).length > 20) throw new Error('订阅的节点提供者格式错误或超过 20 个')
    for (const [name, provider] of Object.entries(providers)) {
      signal?.throwIfAborted()
      if (!object(provider)) throw new Error('订阅的节点提供者格式错误')
      if (provider['override'] || provider['dialer-proxy'] || provider['age-secret-key']) throw new Error('订阅提供者包含覆盖、链式代理或加密依赖，请提供独立节点订阅')
      if (provider.type === 'inline') resources.push({ key: `provider-${networkDigest(name).slice(0, 16)}`, content: nodeYaml(provider.payload) })
      else if (provider.type === 'http' && typeof provider.url === 'string') {
        const headers: Record<string, string> = {}
        if (provider.header !== undefined) {
          if (!object(provider.header)) throw new Error('订阅下载请求头格式错误')
          for (const [key, value] of Object.entries(provider.header)) {
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || ['host','connection','content-length'].includes(key.toLowerCase())) throw new Error('订阅下载请求头不受支持')
            const text = Array.isArray(value) ? value.join(', ') : String(value)
            if (/[\r\n]/.test(text)) throw new Error('订阅下载请求头不合法')
            headers[key] = text
          }
        }
        resources.push({ key: `provider-${networkDigest(name).slice(0, 16)}`, content: rawNodeResource(await downloadSubscription(fetcher, provider.url, signal, headers)) })
      } else throw new Error('只支持 HTTP 和 inline 节点提供者；不能读取远程配置指定的本机文件')
    }
  }
  if (!resources.length) throw new Error('订阅没有可用节点；仅支持 Clash/Mihomo 节点资源，不执行完整代理配置')
  if (resources.reduce((bytes, resource) => bytes + Buffer.byteLength(resource.content), 0) > MAX_BYTES) throw new Error('合并后的订阅超过 8 MB')
  return { resources }
}
