import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchWebpage } from '../src/main/knowledge/webpage'
import { extractSource } from '../src/main/knowledge/parsers'

afterEach(() => { vi.restoreAllMocks() })

describe('网页资料的主进程网络入口', () => {
  it('只使用明确传入的网络栈，重定向后保留中文正文', async () => {
    const nodeFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('不得使用 Node fetch'))
    const desktopFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/article' } }))
      .mockResolvedValueOnce(new Response('<html><p>中文资料原件</p></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))
    const html = await fetchWebpage('https://example.com/start', new AbortController().signal, desktopFetch)
    expect(html).toContain('中文资料原件')
    expect(desktopFetch.mock.calls.map(([url]) => url)).toEqual(['https://example.com/start', 'https://example.com/article'])
    expect(desktopFetch.mock.calls[0][1]?.redirect).toBe('manual')
    expect(nodeFetch).not.toHaveBeenCalled()
  })

  it('重定向不能切换到本地文件协议，也不能带入网址密码', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'file:///C:/secret.txt' } }))
    await expect(fetchWebpage('https://example.com', new AbortController().signal, fetcher)).rejects.toThrow('HTTP/HTTPS')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockClear()
    await expect(fetchWebpage('https://user:pass@example.com', new AbortController().signal, fetcher)).rejects.toThrow('账号密码')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('拒绝超大网页、非HTML响应和HTTP错误', async () => {
    const signal = new AbortController().signal
    await expect(fetchWebpage('https://example.com', signal, vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(21 * 1024 * 1024), { headers: { 'content-type': 'text/html' } })))).rejects.toThrow('20 MB')
    await expect(fetchWebpage('https://example.com', signal, vi.fn<typeof fetch>().mockResolvedValue(new Response('pdf', { headers: { 'content-type': 'application/pdf' } })))).rejects.toThrow('不是 HTML')
    await expect(fetchWebpage('https://example.com', signal, vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })))).rejects.toThrow('HTTP 403')
  })

  it('取消在发起下载前生效且传递给正在执行的网络请求', async () => {
    const controller = new AbortController(), fetcher = vi.fn<typeof fetch>()
    controller.abort()
    await expect(fetchWebpage('https://example.com', controller.signal, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    const running = new AbortController()
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('网络已取消')), { once: true })
      running.abort()
    }))
    await expect(fetchWebpage('https://example.com', running.signal, fetcher)).rejects.toThrow('网络已取消')
  })

  it('解析进程只读取下载好的网页原件，不再次联网', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'roundtable-webpage-'))
    try {
      const path = join(dir, 'webpage.html')
      await writeFile(path, '<html><body><article><h1>交通资料</h1><p>' + '公共交通改善通勤效率。'.repeat(50) + '</p></article></body></html>')
      const nodeFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('解析器不得联网'))
      const parts = await extractSource({ originalPath: path, url: 'https://example.com/article', mediaDir: dir, scratchDir: dir }, { signal: new AbortController().signal, progress: vi.fn(), vision: vi.fn(), transcribe: vi.fn() })
      expect(parts[0].kind).toBe('web')
      expect(parts[0].text).toContain('公共交通')
      expect(nodeFetch).not.toHaveBeenCalled()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
