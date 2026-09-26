import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { startMockAPI } from '../helpers/mock-api'
import { componentTestEnv } from '../helpers/components'
import type { AppAPI } from '../../src/shared/types'
declare global { interface Window { roundtable: AppAPI } }

test('editor receipts preserve drafts and dirty snapshots without invoking models, survive restart and target exact windows',async()=>{
  test.setTimeout(210000)
  const root=resolve('.'),directory=join(root,'.test-data',`editor-${Date.now()}`),profile=join(directory,'profile'),projectDirectory=join(directory,'中文 项目')
  await mkdir(projectDirectory,{recursive:true});await writeFile(join(projectDirectory,'资料.md'),'磁盘原件');await writeFile(join(projectDirectory,'资料.csv'),'项目,说明\n太阳能,储能平衡能源供需\n')
  const targetDirectory=join(directory,'其它执行目录');await mkdir(targetDirectory)
  const mock=await startMockAPI();let desktop:ElectronApplication|undefined
  const env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined && e[0]!=='ELECTRON_RUN_AS_NODE'))
  const launch=()=>electron.launch({executablePath:process.env.ROUNDTABLE_EXECUTABLE,args:process.env.ROUNDTABLE_EXECUTABLE?[]:[root],cwd:process.env.ROUNDTABLE_EXECUTABLE?dirname(process.env.ROUNDTABLE_EXECUTABLE):root,env:{...env,...componentTestEnv,MODEL_ROUNDTABLE_DATA_DIR:profile,MODEL_ROUNDTABLE_TEST:'1'}})
  try {
    desktop=await launch();let page=await desktop.firstWindow();page.setDefaultTimeout(15000);await expect(page.locator('.welcome-page')).toBeVisible()
    await expect(page.getByRole('button',{name:/VS Code 资料/})).toHaveCount(0)
    expect((await page.evaluate(()=>window.roundtable.bootstrap())).projects).toHaveLength(0)
    let base=`http://127.0.0.1:${JSON.parse(await readFile(join(profile,'editor-bridge.json'),'utf8')).port}`
    const connection={id:randomUUID(),claim:randomBytes(32).toString('base64url'),name:'桌面流程测试 VS Code'}
    expect((await fetch(base+'/connections',{method:'POST',body:JSON.stringify(connection)})).ok).toBe(true)
    await page.getByRole('button',{name:'允许连接',exact:true}).click()
    const paired=await fetch(base+`/connections/${connection.id}`,{method:'POST',body:JSON.stringify({claim:connection.claim})}).then(r=>r.json()) as {status:string;token:string;clientId:string}
    expect(paired.status).toBe('approved')
    const request=(path:string,body?:unknown,windowId='desktop-window')=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${paired.token}`,'X-Editor-Window-Id':windowId},body:body===undefined?undefined:JSON.stringify(body)})
    const untitled={id:randomUUID(),kind:'text',text:{path:'Untitled-1',untitled:true,content:'未命名文本不需要先建项目',startLine:1,endLine:1,language:'plaintext',dirty:true,capturedAt:new Date().toISOString()}}
    expect((await request('/transfers',untitled)).status).toBe(200)
    await page.getByRole('button',{name:/VS Code 资料/}).click()
    await expect(page.getByLabel(`资料目标 ${untitled.id}`,{exact:true})).toHaveValue('discussion-new:independent')
    await page.getByRole('button',{name:'追加到草稿',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'开启一次新讨论',exact:true}).locator('textarea').first()).toContainText(untitled.text.content)
    await page.getByRole('dialog',{name:'开启一次新讨论',exact:true}).getByRole('button',{name:'取消',exact:true}).click()
    expect(mock.calls).toHaveLength(0)
    expect((await page.evaluate(()=>window.roundtable.bootstrap())).projects).toHaveLength(0)
    const setup=await page.evaluate(async({projectDirectory,url})=>{
      const p=await window.roundtable.saveProvider({name:'编辑器验收',baseUrl:url+'/v1',modelIds:['analyst','critic','embedding'],tokenParameter:'max_tokens',streamUsage:true,timeoutMs:10000})
      const project=await window.roundtable.saveProject({name:'编辑协同项目',directory:projectDirectory,instructions:'',knowledgeBaseIds:[]})
      return{project,p}
    },{projectDirectory:targetDirectory,url:mock.url})
    await page.reload();await page.getByRole('button',{name:'项目 编辑协同项目',exact:true}).click();await page.getByRole('button',{name:'新建项目讨论',exact:true}).click()
    const discussion=()=>page.getByRole('dialog',{name:'开启一次新讨论',exact:true})
    await discussion().locator('textarea').first().fill('已有的讨论问题，不应丢失。')
    await discussion().getByLabel('成员 1 名称',{exact:true}).fill('保留成员名称')
    await discussion().getByRole('button',{name:'取消',exact:true}).click()
    const input={id:randomUUID(),kind:'text',text:{path:'资料.md',filePath:join(projectDirectory,'资料.md'),content:'VS Code 中尚未保存的新内容',startLine:2,endLine:3,language:'markdown',dirty:true,capturedAt:new Date().toISOString()}}
    expect((await request('/transfers',input)).status).toBe(200);expect((await request('/transfers',input)).status).toBe(200)
    await expect(page.getByRole('button',{name:/VS Code 资料/}).locator('.nav-count')).toHaveText('1')
    await expect(page.getByRole('button',{name:/VS Code 资料/}).locator('svg')).toHaveAttribute('width','18')
    const windowSize=await desktop.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];const size=window.getSize();window.setSize(1060,700);return size})
    await expect(page.getByRole('button',{name:/VS Code 资料/})).toBeInViewport({ratio:1})
    await expect(page.getByRole('button',{name:'网络与订阅',exact:true})).toBeInViewport({ratio:1})
    await expect(page.getByRole('button',{name:'模型与设置',exact:true})).toBeInViewport({ratio:1})
    await desktop.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(size[0],size[1]),windowSize)
    await page.getByRole('button',{name:/VS Code 资料/}).click();const inbox=page.getByRole('dialog',{name:'来自 VS Code 的资料'})
    await expect(inbox.locator('.editor-transfer')).toHaveCount(1)
    await inbox.getByLabel(`资料目标筛选 ${input.id}`,{exact:true}).fill('编辑协同项目')
    await inbox.getByLabel(`资料目标 ${input.id}`,{exact:true}).selectOption(`discussion-new:${setup.project.id}`)
    await inbox.getByRole('button',{name:'追加到草稿'}).click()
    await expect(discussion().locator('textarea').first()).toContainText('已有的讨论问题')
    await expect(discussion().locator('textarea').first()).toContainText('尚未保存的新内容')
    await expect(discussion().getByLabel('成员 1 名称',{exact:true})).toHaveValue('保留成员名称')
    await expect(page.getByRole('button',{name:/VS Code 资料/})).toHaveCount(0)
    await discussion().locator('textarea').first().press('End');await discussion().locator('textarea').first().press('Control+End');await discussion().locator('textarea').first().pressSequentially('继续补充')
    await discussion().getByRole('button',{name:'取消',exact:true}).click()
    await expect.poll(async()=>JSON.parse(await page.evaluate(key=>window.roundtable.getDraft(key),`discussion-new.${setup.project.id}`)).topic as string).toContain('继续补充')
    expect(mock.calls).toHaveLength(0)
    const pending={...input,id:randomUUID(),text:{...input.text,content:'待重启后接收的任务材料'}};await request('/transfers',pending)
    await desktop.close();desktop=await launch();page=await desktop.firstWindow();await expect(page.locator('.welcome-page')).toBeVisible()
    base=`http://127.0.0.1:${JSON.parse(await readFile(join(profile,'editor-bridge.json'),'utf8')).port}`
    expect((await request('/connection')).status).toBe(200)
    await expect(page.getByRole('button',{name:/VS Code 资料/}).locator('.nav-count')).toHaveText('1')
    const saved=JSON.parse(await page.evaluate(key=>window.roundtable.getDraft(key),`discussion-new.${setup.project.id}`));expect(saved.topic).toContain('继续补充');expect(saved.topic.split('VS Code 中尚未保存的新内容')).toHaveLength(2)
    await page.getByRole('button',{name:/VS Code 资料/}).click()
    await page.getByLabel(`资料目标 ${pending.id}`,{exact:true}).selectOption(`execution-new:${setup.project.id}`)
    await page.getByRole('dialog',{name:'来自 VS Code 的资料'}).getByRole('button',{name:'追加到草稿'}).click()
    await expect(page.getByLabel('要执行的任务',{exact:true})).toContainText('待重启后接收的任务材料')
    await expect(page.getByRole('button',{name:/VS Code 资料/})).toHaveCount(0)
    const data=await page.evaluate(()=>window.roundtable.bootstrap());expect(data.executions).toHaveLength(0);expect(data.sessions).toHaveLength(0);expect(mock.calls).toHaveLength(0)
    expect(await readFile(join(projectDirectory,'资料.md'),'utf8')).toBe('磁盘原件')
    expect((await request('/windows',{name:'只有单个文件的窗口'})).ok).toBe(true)
    expect((await request('/windows',{name:'其它目录窗口',workspace:targetDirectory},'other-window')).ok).toBe(true)
    const outbox=request('/outbox',undefined,'other-window')
    await page.evaluate(async windowId=>window.roundtable.editorSend({title:'结果',text:'# 完成的总结',windowId}),`${paired.clientId}:other-window`)
    const out=await (await outbox).json() as {items:Array<{id:string;text:string}>};expect(out.items[0].text).toBe('# 完成的总结')
    expect((await request(`/outbox/${out.items[0].id}/ack`,{})).ok).toBe(false)
    expect((await request(`/outbox/${out.items[0].id}/ack`,{},'other-window')).ok).toBe(true)
    // Imported receipts remain actionable even when no pending receipt remains.
    await page.getByRole('dialog').getByRole('button',{name:/^关闭/}).click()
    const kb=await page.evaluate(providerId=>window.roundtable.createKnowledgeBase({name:'编辑器导入集合',embedding:{providerId,modelId:'embedding'}}),setup.p.id)
    const importedId=randomUUID()
    expect((await request('/transfers',{id:importedId,kind:'files',files:[join(projectDirectory,'资料.csv')]})).status).toBe(200)
    await page.getByRole('button',{name:/VS Code 资料/}).click()
    await page.getByLabel(`资料知识库 ${importedId}`).selectOption(kb.id)
    await page.getByRole('button',{name:'确认导入所选集合'}).click()
    await expect.poll(async()=>(await page.evaluate(()=>window.roundtable.bootstrap())).sources[0]?.status).toBe('ready')
    await expect(page.getByRole('button',{name:/VS Code 资料/}).locator('.nav-count')).toHaveText('1')
    const callsAfterImport=mock.calls.length
    await desktop.close();desktop=await launch();page=await desktop.firstWindow();await expect(page.locator('.welcome-page')).toBeVisible()
    await expect(page.getByRole('button',{name:/VS Code 资料/}).locator('.nav-count')).toHaveText('1')
    await page.getByRole('button',{name:/VS Code 资料/}).click()
    await expect(page.getByRole('button',{name:'使用此集合开启讨论草稿'})).toBeEnabled()
    await page.getByRole('button',{name:'移除资料接收记录'}).click()
    await expect(page.getByRole('button',{name:/VS Code 资料/})).toHaveCount(0)
    expect((await page.evaluate(()=>window.roundtable.bootstrap())).sources).toHaveLength(1)
    expect(mock.calls).toHaveLength(callsAfterImport)
  } finally {await desktop?.close();await mock.close()}
})
