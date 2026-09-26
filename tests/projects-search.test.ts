import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../src/main/store'
import { Projects, resolveProjectPath } from '../src/main/projects'
import { SearchService } from '../src/main/search'
import type { Evidence } from '../src/shared/types'

const dirs: string[]=[]
afterEach(async()=>{ for(const dir of dirs.splice(0)) if(resolve(dir).startsWith(resolve(tmpdir())+sep)) await rm(dir,{recursive:true,force:true}) })
const codec={encrypt:async(value:string)=>Buffer.from(value),decrypt:async(value:Uint8Array)=>Buffer.from(value).toString()}
describe('project storage and path boundary',()=>{
  it('keeps project records, chat drafts and files independent, with no implicit file deletion',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'roundtable-projects-'));dirs.push(dir)
    const work=join(dir,'中文 项目');await mkdir(work);await writeFile(join(work,'README.md'),'项目资料','utf8')
    let store=new Store(join(dir,'state.sqlite'),codec)
    const service=new Projects(store)
    const project=await service.save({name:'中文项目',directory:work,instructions:'保留中文',knowledgeBaseIds:[]})
    store.saveDraft('chat-a','输入A');store.saveDraft('chat-b','输入B')
    expect(await service.files(project.id)).toMatchObject([{name:'README.md',directory:false}])
    expect(await service.file(project.id,'README.md')).toMatchObject({text:'项目资料',binary:false})
    await expect(service.file(project.id,'../state.sqlite')).rejects.toThrow('项目目录')
    await expect(resolveProjectPath(work,join(dir,'state.sqlite'))).rejects.toThrow('相对路径')
    store.close();store=new Store(join(dir,'state.sqlite'),codec)
    expect(store.listProjects()).toHaveLength(1);expect(store.getDraft('chat-a')).toBe('输入A');expect(store.getDraft('chat-b')).toBe('输入B')
    store.saveDraft(`discussion-new.${project.id}`,'待创建讨论')
    store.saveDraft(`execution-new.${project.id}.new`,'待创建任务')
    store.saveDraft('message.removed-session','插话草稿')
    store.saveDraft(`execution-new.${project.id}.removed-session`,'来源讨论任务草稿')
    store.deleteSession('removed-session')
    expect(store.getDraft('message.removed-session')).toBe('')
    expect(store.getDraft(`execution-new.${project.id}.removed-session`)).toBe('')
    store.deleteProject(project.id)
    expect(store.getDraft(`discussion-new.${project.id}`)).toBe('')
    expect(store.getDraft(`execution-new.${project.id}.new`)).toBe('')
    expect(store.getDraft('chat-a')).toBe('输入A')
    store.close()
    expect(await readFile(join(work,'README.md'),'utf8')).toBe('项目资料')
  })
})

describe('selectable search and provenance',()=>{
  const sample: Evidence={id:'web1',title:'资料',text:'搜索摘要',url:'https://source.example/article',locator:'网页',kind:'web',retrievedAt:'2026-09-24',contentType:'snippet'}
  it('defaults to browser search without touching a paid key and distinguishes fetched body',async()=>{
    const browser={search:vi.fn(async()=>[structuredClone(sample),structuredClone(sample)])}
    const key=vi.fn(async()=>{throw new Error('must not access paid key')})
    const fetcher=vi.fn(async()=>new Response(`<html><title>研究</title><article><h1>研究</h1><p>${'这是一段能够独立核对的正文材料。'.repeat(40)}</p></article></html>`,{headers:{'content-type':'text/html'}})) as unknown as typeof fetch
    const search=new SearchService(()=>undefined,key,browser,fetcher)
    const result=await search.search('中文查询',new AbortController().signal)
    expect(browser.search).toHaveBeenCalledWith('中文查询','bing',expect.any(AbortSignal));expect(key).not.toHaveBeenCalled()
    expect(result).toHaveLength(1);expect(result[0].contentType).toBe('body');expect(result[0].text).toContain('正文材料')
  })
  it('retains labeled snippets when body extraction fails and does not invent successful evidence',async()=>{
    const search=new SearchService(()=>({provider:'browser',engine:'google'}),async()=>'',{search:async()=>[structuredClone(sample)]},async()=>new Response('blocked',{status:403}))
    const result=await search.search('测试',new AbortController().signal)
    expect(result[0]).toMatchObject({contentType:'snippet',text:'搜索摘要'});expect(result[0].fetchError).toContain('403')
    const challenge=new SearchService(()=>undefined,async()=>'',{search:async()=>{throw new Error('需要验证码')}},fetch)
    await expect(challenge.search('查询',new AbortController().signal)).rejects.toThrow('验证码')
  })
  it('requires explicit SearXNG JSON support and preserves its configured path prefix',async()=>{
    const calls:string[]=[]
    const search=new SearchService(()=>({provider:'searxng',engine:'bing',searxngUrl:'https://search.example/prefix/'}),async()=>'',{search:async()=>[]},async input=>{
      calls.push(String(input));return new Response('<html>JSON disabled</html>')
    })
    await expect(search.search('中文',new AbortController().signal)).rejects.toThrow('JSON')
    const url=new URL(calls[0]);expect(url.pathname).toBe('/prefix/search');expect(url.searchParams.get('q')).toBe('中文')
  })
  it('accepts SearXNG results without an optional snippet and retains a body-fetch failure',async()=>{
    const search=new SearchService(()=>({provider:'searxng',engine:'bing',searxngUrl:'https://search.example'}),async()=>'',{search:async()=>[]},async input=>{
      if(String(input).startsWith('https://search.example')) return Response.json({results:[{title:'仅标题',url:'https://source.example/page'}]})
      return new Response(null,{status:403})
    })
    expect(await search.search('资料',new AbortController().signal)).toMatchObject([{title:'仅标题',text:'',contentType:'snippet',fetchError:expect.stringContaining('403')}])
  })
})
