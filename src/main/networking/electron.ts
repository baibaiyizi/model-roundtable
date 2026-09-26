import { session, type Session } from 'electron'
import type { NetworkTransport, PreparedNetworkRoute } from './ports'
import { fetchWithSession } from "../network"
import { networkDigest } from './subscriptions'

/** A route owns an immutable session. Concurrent model calls never change a shared global proxy. */
export class ElectronNetworkTransport implements NetworkTransport {
  private sessions = new Map<string, Promise<Session>>()
  sessionForRoute(route: PreparedNetworkRoute): Promise<Session> {
    let promise = this.sessions.get(route.key)
    if (!promise) {
      promise = (async () => {
        const ses = session.fromPartition(`roundtable-network-${networkDigest(route.key).slice(0,24)}`, { cache: false })
        if (route.mode === 'subscription') {
          if (!route.proxyUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(route.proxyUrl)) throw new Error('订阅网络入口无效')
          await ses.setProxy({ mode: 'fixed_servers', proxyRules: route.proxyUrl, proxyBypassRules: '<-loopback>' })
        } else await ses.setProxy({ mode: route.mode === 'direct' ? 'direct' : 'system' })
        return ses
      })()
      this.sessions.set(route.key, promise)
      void promise.catch(() => this.sessions.delete(route.key))
    }
    return promise
  }
  async resolveSystemProxy(targetUrl: string): Promise<string> {
    const ses = await this.sessionForRoute({ key:'system',mode:'system',snapshot:{ selection:{mode:'system'},label:'跟随系统' } })
    return ses.resolveProxy(targetUrl)
  }
  fetch(route: PreparedNetworkRoute): typeof fetch {
    return async (input,init) => {
      const ses = await this.sessionForRoute(route)
      return fetchWithSession(ses)(input, init)
    }
  }
  async close(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map(async promise => { await (await promise).closeAllConnections() })); this.sessions.clear() }
}
