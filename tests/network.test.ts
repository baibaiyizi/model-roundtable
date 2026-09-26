import { afterEach, describe, expect, test } from 'vitest'
import { NetworkManager, applyNetworkEnvironment, proxyEnvironment, systemProxyUrl, validateNetworkSelection } from '../src/main/networking/manager'
import { downloadSubscription, prepareSubscription, rawNodeResource } from '../src/main/networking/subscriptions'
import type { NetworkStore, NetworkTransport } from '../src/main/networking/ports'
import type { ComponentRuntimePort } from '../src/shared/components'
import type { Provider } from '../src/shared/types'

class MemoryStore implements NetworkStore {
  data = new Map<string, unknown>(); secrets = new Map<string,string>(); providers: Provider[] = [{ id:'p',name:'service',baseUrl:'https://example.test',modelIds:['m'],hasKey:false,tokenParameter:'max_tokens',streamUsage:false,timeoutMs:30000,network:{mode:'direct'} }]
  getEntity<T>(kind:string,id:string): T|undefined { return this.data.get(`${kind}:${id}`) as T|undefined }
  listEntities<T>(kind:string):T[] { return [...this.data].filter(([key])=>key.startsWith(`${kind}:`)).map(([,value])=>value as T) }
  saveEntity<T>(kind:string,id:string,value:T):void { this.data.set(`${kind}:${id}`,structuredClone(value)) }
  deleteEntity(kind:string,id:string):void { this.data.delete(`${kind}:${id}`) }
  async setSecret(id:string,value:string):Promise<void> { this.secrets.set(id,value) }
  async getSecret(id:string):Promise<string> { return this.secrets.get(id)??'' }
  getProvider(id:string):Provider|undefined { return this.providers.find(provider=>provider.id===id) }
  listProviders():Provider[] { return this.providers }
}
const managers: NetworkManager[]=[]
afterEach(async()=>{for(const manager of managers.splice(0)) await manager.shutdown()})
function fixture() {
  const store=new MemoryStore(), requests:string[]=[]
  const transport:NetworkTransport={fetch:route=>async()=>{requests.push(route.mode);return new Response('ok')},resolveSystemProxy:async()=> 'DIRECT'}
  const runtime:ComponentRuntimePort={resolve:async()=>{throw new Error('not used')},ensure:async()=>{throw new Error('not used')}}
  const manager=new NetworkManager({store,transport,runtime,stateDir:'unused'});managers.push(manager)
  return {store,transport,manager,requests}
}

describe('订阅输入边界',()=>{
  test('下载失败取消错误响应正文，释放正在使用的网络线路',async()=>{
    let cancelled=false
    const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('error details'))},cancel(){cancelled=true}}),{status:401})
    await expect(downloadSubscription(async()=>response,'https://example.test/sub')).rejects.toThrow('HTTP 401')
    expect(cancelled).toBe(true)
  })
  test('只提取节点与顶层HTTP/inline资源，不执行全局代理或脚本配置',async()=>{
    const calls:string[]=[]
    const result=await prepareSubscription(`tun: {enable: true}\nexternal-controller: 0.0.0.0:9090\nscript: {code: evil}\nproxies:\n - {name: 原始, type: http, server: localhost, port: 1234}\nproxy-providers:\n remote: {type: http, url: 'https://example.test/sub?token=secret'}\n local: {type: inline, payload: [{name: 内嵌, type: socks5, server: localhost, port: 1235}]}`,async(input)=>{calls.push(String(input));return new Response('ss://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTpzZWNyZXQ@127.0.0.1:1234#SS')})
    expect(result.resources).toHaveLength(3);expect(calls).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('external-controller');expect(JSON.stringify(result)).not.toContain('evil')
  })
  test('拒绝本机文件、链式依赖、重复名称和嵌套完整配置',async()=>{
    await expect(prepareSubscription('proxy-providers: {bad: {type: file, path: C:/private.key}}',fetch)).rejects.toThrow('本机文件')
    expect(()=>rawNodeResource('proxies: [{name: x, type: http, server: localhost, port: 1, dialer-proxy: other}]')).toThrow('链式')
    expect(()=>rawNodeResource('proxies: [{name: x, type: http}, {name: x, type: socks5}]')).toThrow('重名')
    await expect(prepareSubscription('proxy-providers: {remote: {type: http, url: https://example.test/sub}}',async()=>new Response('proxy-providers: {next: {type: http, url: https://other.test}}'))).rejects.toThrow('节点订阅')
  })
  test('保留URI交内核处理，识别Base64容器并拒绝HTML和未知协议',()=>{
    const uri='trojan://secret@example.test:443#node'
    expect(rawNodeResource(Buffer.from(uri).toString('base64'))).toBe(uri)
    expect(()=>rawNodeResource('<html>please login</html>')).toThrow('节点订阅')
    expect(()=>rawNodeResource('proprietary://secret')).toThrow('不支持')
  })
})
describe('线路冻结与命令行环境',()=>{
  test('订阅凭据损坏只阻断该订阅，不阻断直连服务或反复等待应用设置',async()=>{
    const {manager,store,requests}=fixture()
    store.saveEntity('network-subscription','broken',{id:'broken',name:'损坏订阅',source:'file',revision:'r1',updatedAt:new Date().toISOString(),nodes:[{id:'node',name:'节点',type:'http',resourceKey:'nodes',nativeName:'node'}]})
    store.getSecret=async()=>{throw new Error('decrypt failed')}
    const response=await manager.fetchForProvider('p')('https://example.test');await response.text()
    await manager.applyPending()
    expect(requests).toEqual(['direct']);expect(manager.getState().pending).toBe(false)
    expect(manager.getState().subscriptions[0].error).toContain('无法解密')
    store.providers[0].network={mode:'subscription',subscriptionId:'broken',nodeId:'node'}
    await expect(manager.acquireForProviders(['p'])).rejects.toThrow('无法解密')
    expect(requests).toEqual(['direct'])
  })
  test('应用新增坏订阅时仍提交无关服务的线路修改',async()=>{
    const {manager,store}=fixture(),initial=await manager.acquireForProviders(['p']);initial.release();await manager.applyPending()
    store.saveEntity('network-subscription','broken',{id:'broken',name:'损坏订阅',source:'file',revision:'r1',updatedAt:new Date().toISOString(),nodes:[]})
    store.getSecret=async()=>{throw new Error('decrypt failed')};store.providers[0].network={mode:'system'}
    await manager.applyPending()
    const next=await manager.acquireForProviders(['p'])
    expect(next.snapshots.p.selection.mode).toBe('system');expect(manager.getState().pending).toBe(false);next.release()
  })
  test('任务租约冻结旧线路，修改后待结束再应用；双重release不破坏计数',async()=>{
    const {manager,store,requests}=fixture()
    const lease=await manager.acquireForProviders(['p'])
    store.providers[0].network={mode:'system'}
    await manager.applyPending();expect(manager.getState().pending).toBe(true)
    await lease.fetchForProvider('p')('https://example.test');expect(requests).toEqual(['direct'])
    const concurrent=await manager.acquireForProviders(['p']);expect(concurrent.snapshots.p.selection.mode).toBe('direct')
    lease.release();lease.release();await manager.applyPending();expect(manager.getState().pending).toBe(true)
    concurrent.release();await manager.applyPending();expect(manager.getState().pending).toBe(false)
    const next=await manager.acquireForProviders(['p']);expect(next.snapshots.p.selection.mode).toBe('system');next.release()
  })
  test('请求租约持续到流结束，取消后才应用待生效设置',async()=>{
    const {manager,store,transport}=fixture();let controller:ReadableStreamDefaultController<Uint8Array>
    transport.fetch=()=>async()=>new Response(new ReadableStream({start(value){controller=value}}))
    const response=await manager.fetchForProvider('p')('https://example.test')
    store.providers[0].network={mode:'system'};await manager.applyPending();expect(manager.getState().pending).toBe(true)
    await response.body!.cancel();await manager.applyPending();expect(manager.getState().pending).toBe(false)
  })
  test('已返回且未继续读取的流在请求取消时释放租约并拒绝剩余读取',async()=>{
    const {manager,store,transport}=fixture();let cancelled=false
    transport.fetch=()=>async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('first chunk'))},cancel(){cancelled=true}}))
    const abort=new AbortController(),response=await manager.fetchForProvider('p')('https://example.test',{signal:abort.signal})
    store.providers[0].network={mode:'system'};await manager.applyPending();expect(manager.getState().pending).toBe(true)
    abort.abort(new Error('用户取消'));await Promise.resolve();await manager.applyPending()
    expect(cancelled).toBe(true);expect(manager.getState().pending).toBe(false)
    await expect(response.text()).rejects.toThrow('用户取消')
  })
  test('Request 自带的取消信号阻止准备和发送请求',async()=>{
    const {manager,requests}=fixture(),abort=new AbortController();abort.abort()
    await expect(manager.fetchForProvider('p')(new Request('https://example.test',{signal:abort.signal}))).rejects.toThrow()
    await expect(manager.fetchForScope('subscriptions')(new Request('https://example.test',{signal:abort.signal}))).rejects.toThrow()
    expect(requests).toEqual([])
  })
  test('并发apply和下一次acquire不越过尚未完成的应用过程',async()=>{
    const {manager,store}=fixture(); const first=await manager.acquireForProviders(['p']);first.release();await manager.applyPending()
    store.providers[0].network={mode:'system'}
    await Promise.all([manager.applyPending(),manager.applyPending()])
    const leases=await Promise.all([manager.acquireForProviders(['p']),manager.acquireForProviders(['p'])])
    expect(leases.map(lease=>lease.snapshots.p.selection.mode)).toEqual(['system','system']);leases.forEach(lease=>lease.release())
  })
  test('应用订阅快照的解密尚未结束时，新租约等待提交后才取得线路',async()=>{
    const {manager,store}=fixture();const initial=await manager.acquireForProviders(['p']);initial.release();await manager.applyPending()
    let unblock!:()=>void, entered!:()=>void
    const started=new Promise<void>(resolve=>entered=resolve), barrier=new Promise<void>(resolve=>unblock=resolve)
    store.getSecret=async()=>{entered();await barrier;return JSON.stringify({resources:[]})}
    store.saveEntity('network-subscription','new',{id:'new',name:'new',source:'file',revision:'revision',updatedAt:new Date().toISOString(),nodes:[]})
    store.providers[0].network={mode:'system'}
    const applying=manager.applyPending();await started
    let acquired=false
    const pending=manager.acquireForProviders(['p']).then(lease=>{acquired=true;return lease})
    await new Promise(resolve=>setTimeout(resolve,25));expect(acquired).toBe(false)
    unblock();await applying;const next=await pending;expect(next.snapshots.p.selection.mode).toBe('system');next.release()
  })
  test('取消启动不产生可使用的租约',async()=>{
    const {manager}=fixture();const abort=new AbortController();abort.abort()
    await expect(manager.acquireForProviders(['p'],abort.signal)).rejects.toThrow()
  })
  test('大小写代理变量全部替换，直连与订阅均没有隐式后备线路',()=>{
    const env=applyNetworkEnvironment({hTtP_pRoXy:'wrong',HTTPS_PROXY:'wrong',Path:'keep'},proxyEnvironment())
    expect(env.hTtP_pRoXy).toBeUndefined();expect(env.HTTPS_PROXY).toBe('');expect(env.NO_PROXY).toBe('*');expect(env.Path).toBe('keep')
    expect(proxyEnvironment('http://127.0.0.1:1234')).toMatchObject({HTTP_PROXY:'http://127.0.0.1:1234',http_proxy:'http://127.0.0.1:1234',NO_PROXY:'localhost,127.0.0.1,::1'})
    expect(systemProxyUrl('DIRECT')).toBeUndefined();expect(systemProxyUrl('PROXY 127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(()=>systemProxyUrl('PROXY 127.0.0.1:7890; DIRECT')).toThrow('多候选')
    expect(()=>validateNetworkSelection({mode:'subscription'})).toThrow()
  })
})
