// The caller supplies Electron net.fetch in production, so downloads use the
// same system proxy/session as the gateway and Tavily. This module does no I/O
// through Node's global fetch and never interprets proxy environment variables.
export async function fetchWebpage(url: string, signal: AbortSignal, fetcher: typeof fetch): Promise<string> {
  let current = new URL(url)
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)])
  for (let redirects = 0; redirects < 6; redirects++) {
    requestSignal.throwIfAborted()
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) throw new Error('网页仅支持不含账号密码的 HTTP/HTTPS 地址')
    const response = await fetcher(current.toString(), { signal: requestSignal, redirect: 'manual', headers: { Accept: 'text/html' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('网页重定向缺少地址')
      current = new URL(location, current); continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`网页读取失败：HTTP ${response.status}`) }
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) { await response.body?.cancel(); throw new Error('链接返回的不是 HTML 网页，请下载文件后导入') }
    const chunks: Uint8Array[] = []; let size = 0
    if (!response.body) throw new Error('网页响应没有内容')
    const reader = response.body.getReader()
    try {
      for (;;) {
        requestSignal.throwIfAborted()
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 20 * 1024 * 1024) throw new Error('网页超过 20 MB，已取消读取；请下载后导入')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    requestSignal.throwIfAborted()
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'utf-8'
    return new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks))
  }
  throw new Error('网页重定向次数过多')
}
