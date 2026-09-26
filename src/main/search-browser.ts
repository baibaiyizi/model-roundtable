import { BrowserWindow, session as electronSession, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Evidence, SearchConfig } from '../shared/types'
import type { BrowserSearchPort } from './search'

export function searchUrl(query: string, engine: SearchConfig['engine']): string {
  const url = new URL(engine === 'bing' ? 'https://www.bing.com/search' : engine === 'baidu' ? 'https://www.baidu.com/s' : 'https://www.google.com/search')
  url.searchParams.set(engine === 'baidu' ? 'wd' : 'q', query)
  return url.toString()
}
const EXTRACT = `(async () => {
  const selector = '.b_algo h2 a,.result h3 a,.c-container h3 a,h3 a.cosc-title-a,a:has(h3)';
  if (!document.querySelector(selector)) await new Promise(resolve => {
    const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new MutationObserver(() => { if (document.querySelector(selector)) done(); });
    const timer = setTimeout(done, 5000);
    observer.observe(document.documentElement, {childList:true,subtree:true});
  });
  const challenge = Boolean(document.querySelector('form[action*="sorry"],#b_captcha,iframe[src*="captcha"],#captcha,form#challenge-form')) || /验证您是真人|请输入验证码|unusual traffic|verify you are human|请完成下方验证/i.test(document.body?.innerText?.slice(0,6000) || '');
  const elements = [...document.querySelectorAll(selector)];
  const results = elements.map(a => {
    let url = a.href;
    if (url) { const u = new URL(url); if (u.pathname === '/url') url = u.searchParams.get('q') || u.searchParams.get('url') || url; }
    const container = a.closest('.b_algo,.result,.c-container,.MjjYud') || a.parentElement?.parentElement;
    const destination = container?.getAttribute('mu');
    if (destination && /^https?:/.test(destination) && /(^|\\.)baidu\\.com$/.test(location.hostname)) url = destination;
    const copy = container?.cloneNode(true);
    copy?.querySelectorAll('script,style,noscript').forEach(node => node.remove());
    return {title:(a.textContent || '').trim(),url,text:(copy?.textContent || a.textContent || '').replace(/\\s+/g,' ').trim().slice(0,4000)};
  }).filter(r => r.title && /^https?:/.test(r.url));
  return {challenge,results};
})()`

export class BrowserSearch implements BrowserSearchPort {
  private windows = new Set<BrowserWindow>()
  private closed = false
  constructor(private readonly networkSession?: () => Promise<{ session: Session; release(): void }>) {}
  async search(query: string, engine: SearchConfig['engine'], signal: AbortSignal, networkSession = this.networkSession): Promise<Evidence[]> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('搜索服务已关闭。')
    const network = await networkSession?.()
    if (signal.aborted || this.closed) { network?.release(); signal.throwIfAborted(); throw new Error('搜索服务已关闭。') }
    const isolated = network?.session ?? electronSession.fromPartition('persist:roundtable-search-v2')
    isolated.setPermissionRequestHandler((_contents,_permission,callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    let browser: BrowserWindow
    try { browser = new BrowserWindow({ width: 1080, height: 800, show: false, title: '网页搜索 · 模型圆桌', webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, navigateOnDragDrop: false } }) }
    catch (error) { network?.release(); throw error }
    this.windows.add(browser); browser.setMenuBarVisibility(false)
    browser.on('closed', () => { this.windows.delete(browser); network?.release() })
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    browser.webContents.on('will-navigate', (event,url) => { if (!/^https?:\/\//i.test(url)) event.preventDefault() })
    const combined = AbortSignal.any([signal, AbortSignal.timeout(60000)])
    let rejectAborted!: (error: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject })
    // Electron can leave executeJavaScript pending when its window is destroyed.
    // Race the operation so cancellation also releases the discussion/tool scope.
    const abort = (): void => { rejectAborted(combined.reason); if (!browser.isDestroyed()) browser.destroy() }
    combined.addEventListener('abort', abort, { once: true })
    let challenge = false
    try {
      await Promise.race([browser.loadURL(searchUrl(query, engine)), aborted])
      combined.throwIfAborted()
      const extracted = await Promise.race([browser.webContents.executeJavaScript(EXTRACT), aborted]) as { challenge: boolean; results: { title: string; url: string; text: string }[] }
      if (extracted.challenge) {
        challenge = true; browser.show()
        throw new Error('搜索引擎需要人工验证，已打开独立搜索窗口。请完成验证后返回应用重试；本次未取得联网证据。')
      }
      const seen = new Set<string>()
      const results = extracted.results.filter(r => !seen.has(r.url) && seen.add(r.url)).slice(0,5)
      if (!results.length) throw new Error('搜索页未找到可解析的结果，可能是网络限制或页面结构变化。请更换搜索引擎或手动重试。')
      return results.map(r => ({ id: `web-${randomUUID()}`, title: r.title, url: r.url, text: r.text, locator: r.url, kind: 'web', contentType: 'snippet', query, retrievedAt: new Date().toISOString() }))
    } finally {
      combined.removeEventListener('abort', abort)
      if (!challenge && !browser.isDestroyed()) browser.destroy()
    }
  }
  shutdown(): void { this.closed = true; for (const window of this.windows) if (!window.isDestroyed()) window.destroy(); this.windows.clear() }
}
