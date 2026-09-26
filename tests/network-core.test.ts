import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, request, type Server } from 'node:http'
import { RuntimeManager } from '../src/main/components'
import { MihomoProcess, type CoreResource } from '../src/main/networking/core'
import { NetworkManager } from '../src/main/networking/manager'
import { Store } from '../src/main/store'

describe.skipIf(process.platform!=='win32')('随包真实Mihomo内核（仅本机受控服务）',()=>{
  let directory:string, executable:string, runtime:RuntimeManager
  const processes:MihomoProcess[]=[], servers:Server[]=[]
  beforeAll(async()=>{
    directory=await mkdtemp(join(tmpdir(),'roundtable-network-'))
    runtime=new RuntimeManager({manifestPath:resolve('resources/components/manifest.json'),cacheDir:join(directory,'components'),fetch:async()=>{throw new Error('不允许外网下载')}})
    executable=(await runtime.ensure('mihomo')).executable
  },60000)
  afterAll(async()=>{for(const core of processes)await core.stop();for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}await runtime?.shutdown();if(directory)await rm(directory,{recursive:true,force:true})})
  test('YAML/URI经内核解析，凭据仅以age密文落盘，退出清理临时目录',async()=>{
    const root=join(directory,'validation'),core=new MihomoProcess(executable,root);processes.push(core)
    const resources:CoreResource[]=[{subscriptionId:'test',key:'yaml',content:'proxies: [{name: YAML节点, type: http, server: 127.0.0.1, port: 8888, username: testuser, password: TOP_SECRET_PASSWORD}]'},{subscriptionId:'test',key:'uri',content:'trojan://TOP_SECRET_PASSWORD@127.0.0.1:443#URI'}]
    await core.start(resources,[])
    const nodes=(await core.nodes(resources)).test
    expect(nodes.map(node=>node.name)).toEqual(['YAML节点','URI'])
    const run=join(root,(await readdir(root))[0]),files=await readdir(run)
    expect(files.some(name=>name.endsWith('.age'))).toBe(true)
    for(const name of files){const content=await readFile(join(run,name),'utf8');expect(content).not.toContain('TOP_SECRET_PASSWORD');expect(content).not.toContain('AGE-SECRET-KEY-')}
    await core.stop();expect(await readdir(root)).toEqual([])
  },30000)
  test('全新管理器导入自动准备随包内核，模型与搜索不同节点可并发持有租约',async()=>{
    const store=new Store(':memory:',{encrypt:async value=>Buffer.from(value),decrypt:async value=>Buffer.from(value).toString('utf8')})
    const newRuntime=new RuntimeManager({manifestPath:resolve('resources/components/manifest.json'),cacheDir:join(directory,'fresh-components'),fetch:async()=>{throw new Error('不允许外网下载')}})
    const manager=new NetworkManager({store,runtime:newRuntime,stateDir:join(directory,'manager'),transport:{fetch:()=>async()=>new Response('fixture'),resolveSystemProxy:async()=> 'DIRECT'}})
    try {
      const result=await manager.importSubscription({name:'本地测试',content:'proxies: [{name: 模型线路, type: http, server: 127.0.0.1, port: 18888}, {name: 搜索线路, type: http, server: 127.0.0.1, port: 18889}]'})
      const subscription=result.subscriptions[0]
      const provider=await store.saveProvider({name:'模型',baseUrl:'https://example.test',modelIds:['m'],tokenParameter:'max_tokens',streamUsage:false,timeoutMs:30000,network:{mode:'subscription',subscriptionId:subscription.id,nodeId:subscription.nodes[0].id}})
      await manager.saveBindings({search:{mode:'subscription',subscriptionId:subscription.id,nodeId:subscription.nodes[1].id}})
      const model=await manager.acquireForProviders([provider.id])
      const search=await manager.acquireForScope('search')
      const modelEnv=await model.environmentForProvider(provider.id),searchEnv=await search.environment()
      expect(modelEnv.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect(modelEnv.HTTPS_PROXY).not.toBe(searchEnv.HTTPS_PROXY)
      await expect(newRuntime.remove('mihomo')).rejects.toThrow('正在使用')
      model.release();search.release()
    } finally {await manager.shutdown();await newRuntime.shutdown();store.close()}
  },45000)
  test('固定listener确实经过选中HTTP节点；节点关闭后失败而不是直连',async()=>{
    let hits=0,directHits=0
    const direct=createServer((_req,res)=>{directHits++;res.end('direct')});servers.push(direct)
    await new Promise<void>(resolve=>direct.listen(0,'127.0.0.1',resolve))
    const target=`http://127.0.0.1:${(direct.address() as {port:number}).port}/test`
    const server=createServer((_req,res)=>{hits++;res.end('through selected proxy')});servers.push(server)
    server.on('connect',(_req,socket)=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');socket.once('data',()=>{hits++;socket.end('HTTP/1.1 200 OK\r\nContent-Length: 22\r\nConnection: close\r\n\r\nthrough selected proxy')})})
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const upstream=(server.address() as {port:number}).port
    const resources:CoreResource[]=[{subscriptionId:'test',key:'nodes',content:`proxies: [{name: selected, type: http, server: 127.0.0.1, port: ${upstream}}]`}]
    const inspect=new MihomoProcess(executable,join(directory,'inspect'));processes.push(inspect);await inspect.start(resources,[])
    const node=(await inspect.nodes(resources)).test[0];await inspect.stop()
    const core=new MihomoProcess(executable,join(directory,'routing'));processes.push(core)
    await core.start(resources,[{key:'selected',subscriptionId:'test',node}])
    const proxy=new URL(core.routes.get('selected')!)
    const response=await new Promise<string>((resolve,reject)=>{
      const req=request({hostname:proxy.hostname,port:proxy.port,path:target,headers:{Host:new URL(target).host},timeout:5000},res=>{let text='';res.on('data',data=>text+=data);res.on('end',()=>resolve(text))});req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('timeout')));req.end()
    })
    expect(response).toBe('through selected proxy');expect(hits).toBe(1)
    await new Promise<void>(resolve=>server.close(()=>resolve()))
    const failure=await new Promise<number|undefined>((resolve,reject)=>{
      const req=request({hostname:proxy.hostname,port:proxy.port,path:target,headers:{Host:new URL(target).host},timeout:8000},res=>{res.resume();res.once('end',()=>resolve(res.statusCode))});req.once('error',reject);req.once('timeout',()=>req.destroy(new Error('timeout')));req.end()
    })
    expect(failure).toBe(502);expect(directHits).toBe(0)
    await core.stop()
  },30000)
})
