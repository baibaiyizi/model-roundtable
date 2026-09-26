import { randomUUID } from 'node:crypto'
import type { Evidence } from '../../shared/types'
import type { ExtensionSearchBinding } from '../../shared/extensions'
export function atPath(value: unknown, path: string): unknown {
  let current: any = value
  for (const key of path.replace(/^\$\.?/, '').split('.').filter(Boolean)) { if (['__proto__', 'constructor', 'prototype'].includes(key) || !/^[\w-]+$/.test(key)) throw new Error('证据字段路径无效'); current = current?.[key] }
  return current
}
export function resultData(output: any): unknown {
  if (output.structuredContent !== undefined) return output.structuredContent
  const text = output.content?.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')
  if (text) { try { return JSON.parse(text) } catch { return { text } } }
  return output
}
export function toolEvidence(output: unknown, callId: string, extensionId: string, title: string, binding?: ExtensionSearchBinding, query?: string): Evidence[] {
  const base = { toolCallId: callId, extensionId, retrievedAt: new Date().toISOString() }
  const data = resultData(output)
  if (binding) {
    const items = atPath(data, binding.resultPath)
    if (!Array.isArray(items)) throw new Error('搜索工具结果不符合已绑定的结果列表路径，未生成网页证据')
    const seen = new Set<string>()
    return items.slice(0, 20).map((item): Evidence => {
      const url = atPath(item, binding.urlField), text = atPath(item, binding.textField), name = atPath(item, binding.titleField)
      let parsed: URL | undefined; try { if (typeof url === 'string') parsed = new URL(url) } catch { /* A server may return a non-web document identifier. Keep it as a tool result. */ }
      if (typeof url !== 'string' || !parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || typeof text !== 'string' || typeof name !== 'string') return { ...base, id: `tool-${randomUUID()}`, title: typeof name === 'string' ? name : title, text: (typeof text === 'string' ? text : JSON.stringify(item)).slice(0, 40000), locator: `mcp-call:${callId}`, query, kind: 'tool' }
      return { ...base, id: `tool-${randomUUID()}`, title: name, text: text.slice(0, 40000), locator: url, url, query, kind: 'web' as const, contentType: binding.contentType }
    }).filter(item => !seen.has(item.url ?? item.id) && seen.add(item.url ?? item.id))
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data)
  return [{ ...base, id: `tool-${randomUUID()}`, kind: 'tool', title, text: text.slice(0, 40000), locator: `mcp-call:${callId}` }]
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  const visit = (input: any): any => {
    if (typeof input === 'string') { let text = input; for (const secret of secrets) if (secret.length >= 3) text = text.split(secret).join('[已隐藏]'); return text.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]') }
    if (Array.isArray(input)) return input.map(visit)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, /password|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token/i.test(key) ? '[已隐藏]' : visit(value)]))
    return input
  }
  return visit(value)
}
