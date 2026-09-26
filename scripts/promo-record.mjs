// Release marketing capture. Uses the real app with an isolated profile and a local deterministic service.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = join(root, '.cache', 'promo')
const run = join(base, 'runs', new Date().toISOString().replace(/[:.]/g, '-'))
const project = join(run, 'demo-project')
const screenshots = join(run, 'screenshots')
await mkdir(project, { recursive: true }); await mkdir(screenshots, { recursive: true })
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(base, 'playwright')
const { _electron, chromium, expect } = await import('@playwright/test')
const wait = ms => new Promise(done => setTimeout(done, ms))
const actualFile = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的读书清单 · 演示页面</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f3eb;color:#274437;font-family:"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:72px auto;padding:0 40px}.eyebrow{font-size:13px;letter-spacing:4px;color:#83917a}h1{font-size:54px;font-weight:500;margin:18px 0}header p{color:#74816d;font-size:17px;line-height:1.9}.toolbar{display:flex;justify-content:space-between;align-items:center;margin:36px 0 24px}.toolbar span{font-size:14px;color:#7d8874}.books{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}article{padding:30px;background:#fffdf8;border:1px solid #dfe4d5;border-radius:16px}.cover{height:180px;display:flex;align-items:flex-end;padding:20px;border-radius:7px;color:#fff;font-size:26px;line-height:1.6;background:#607764}article:nth-child(2) .cover{background:#b1956e}article:nth-child(3) .cover{background:#809190}h2{font-size:20px;margin-top:25px}article p{font-size:13px;line-height:1.9;color:#7f8a74}button{border:1px solid #bdcdb5;padding:10px 16px;border-radius:8px;background:#edf2e7;color:#45613e;cursor:pointer;font:inherit;font-size:13px}button:hover{background:#dce8d1}.status{display:block;margin:20px 0 12px;font-size:13px;color:#8b987e}.read .status{color:#2e714a}.read button{background:#e4eadf}footer{border-top:1px solid #dce3d3;padding-top:22px;margin-top:38px;font-size:12px;color:#8a937e}@media(max-width:700px){.books{grid-template-columns:1fr}h1{font-size:36px}}
</style><main><header><div class="eyebrow">A LITTLE READING, EVERY DAY</div><h1>我的读书清单</h1><p>给想读的书留一个位置，也给读过的故事留一点记忆。</p></header>
<div class="toolbar"><strong>这个月，慢慢读。</strong><span id="count">3 本书 · 0 本已读</span></div>
<section class="books" aria-label="读书清单">
<article><div class="cover">春日<br>散步</div><h2>春日散步</h2><p>演示书名 · 生活随笔<br>从日常小事开始，重新观察熟悉的世界。</p><span class="status">想读</span><button type="button">标记读完</button></article>
<article><div class="cover">远山<br>来信</div><h2>远山来信</h2><p>演示书名 · 旅行笔记<br>把远方的风景，变成今天的一点好奇。</p><span class="status">想读</span><button type="button">标记读完</button></article>
<article><div class="cover">城市的<br>节奏</div><h2>城市的节奏</h2><p>演示书名 · 观察记录<br>看见人与街道，也听见自己的节奏。</p><span class="status">想读</span><button type="button">标记读完</button></article>
</section><footer>模型圆桌演示项目 · 虚构书名与内容，仅用于展示真实文件执行流程。刷新后阅读状态重置。</footer></main>
<script>document.querySelectorAll('article button').forEach(button=>button.addEventListener('click',()=>{const card=button.closest('article');const read=card.classList.toggle('read');card.querySelector('.status').textContent=read?'已读':'想读';button.textContent=read?'改为想读':'标记读完';document.querySelector('#count').textContent='3 本书 · '+document.querySelectorAll('.read').length+' 本已读'}))</script></html>
`
await writeFile(join(project, 'README.md'), '# 读书清单网页 · 演示项目\n\n这里的书名、资料和模型响应仅用于演示产品流程，不含真实用户资料。\n')
await writeFile(join(project, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>我的读书清单</title><h1>我的读书清单</h1><p>这里准备放入书籍与阅读状态。</p></html>\n')
const document = join(project, '页面需求.md')
await writeFile(document, '# 读书清单页面需求\n\n把现有 index.html 改成可直接打开的阅读清单。显示三本虚构示例书，卡片包含书名、简介和阅读状态。\n\n点击「标记读完」后，当前页面对应书卡改为「已读」，顶部计数同步更新。刷新后允许重置，不能把临时状态宣传成长期保存。\n\n保持单文件，无外部图片、字体或网络依赖，保留原有说明与需求资料。\n')
const calls = []; let toolStage = 0
const service = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ object: 'list', data: ['demo-planner','demo-critic','demo-chair','demo-executor','demo-review-a','demo-review-b','demo-embedding'].map(id => ({ id, object: 'model', owned_by: 'local-demo' })) })); return }
    let raw = ''; for await (const part of req) { raw += part; if (raw.length > 8_000_000) throw Error('Demonstration request too large') }
    const body = JSON.parse(raw || '{}'); calls.push({ path: req.url, model: body.model, at: new Date().toISOString() })
    if (req.url === '/v1/embeddings') { const texts = Array.isArray(body.input) ? body.input : [body.input]; res.setHeader('content-type','application/json'); res.end(JSON.stringify({ object:'list', data:texts.map((_,index)=>({object:'embedding',index,embedding:[0.9,0.3,0.1,0.1]})),model:body.model,usage:{prompt_tokens:20,total_tokens:20} })); return }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    const system = String(body.messages?.[0]?.content ?? '')
    const last = body.messages?.at(-1)?.content
    const prompt = typeof last === 'string' ? last : JSON.stringify(last ?? '')
    let content = ''
    let tool
    if (body.model === 'demo-executor') {
      const name=toolStage===0?'read':'write',offered = body.tools?.find(item => item.function?.name === name)
      if (offered && toolStage<2) { toolStage++; tool = { index:0,id:`demo_tool_${toolStage}`,type:'function',function:{name,arguments:JSON.stringify(name==='read'?{filePath:join(project,'index.html')}:{filePath:join(project,'index.html'),content:actualFile})} } }
      content = '已修改 **index.html**，完成读书清单网页。\n\n- 三张示例书卡，包含简介与阅读状态。\n- 「标记读完」切换状态并更新计数。\n- 单个 HTML 文件，无外部资源依赖。\n- 保留 README.md 和页面需求.md。\n\n实际写入已完成，右侧可以查看差异；刷新后状态会重置，浏览器交互仍需实测。'
    } else if (body.model?.startsWith('demo-review')) {
      content = JSON.stringify({ verdict:'pass',findings:body.model === 'demo-review-a' ? '**结构检查通过**\n\n实际差异包含三张书卡、阅读状态按钮与顶部计数。交互代码使用点击事件更新状态，符合本次完成判定。这里只审阅代码，未声称进行浏览器测试。' : '**变更范围检查通过**\n\n此次记录显示修改 index.html，原始说明与需求资料保留。页面没有外部资源依赖，并明确说明刷新后状态重置。虚构书名已标注为演示内容。' })
    } else if (prompt.includes('即将进入') && prompt.includes('query')) content = JSON.stringify({query:null})
    else if (prompt.includes('"speakerId"')) content = JSON.stringify({speakerId:'demo-planner',replyTo:'$user',instruction:'给出具体安排。'})
    else if (prompt.includes('"wantsToSpeak"')) content = JSON.stringify({wantsToSpeak:true,reason:'补充活动安排',replyTo:'$user',searchQuery:null})
    else if (body.model === 'demo-chair') content = '## 共识\n\n采用暖白与墨绿的轻量书卡布局。三张书卡展示书名、简介和阅读状态；单个 HTML 即可打开。\n\n## 分歧与待验证\n\n首版状态仅在当前页面保留，不能承诺刷新后保存。生成后需实际打开网页，核对按钮和计数。\n\n## 可执行下一步\n\n修改 index.html，保留原有资料；然后请两位审阅者核对代码与变更范围。'
    else if (body.model === 'demo-critic') content = '## 先检查这几个问题\n\n阅读状态不只是一个标签：点「标记读完」后，按钮文字和顶部计数都应该同步。\n\n先明确这是当前页面的临时状态，刷新后重置。示例书名也要标明虚构，避免被误当成书籍推荐。'
    else content = '## 一个可以直接实现的页面\n\n把三本示例书排成简洁卡片，使用 **墨绿、暖白** 的配色。每张卡片包含书名、简介、阅读状态和一个操作按钮。\n\n采用单文件 HTML、CSS、JavaScript，无外部资源依赖，保存后就能在浏览器打开。'
    const usage = {prompt_tokens:180,completion_tokens:100,total_tokens:280}
    if (body.stream) {
      res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'})
      if (tool) res.write(`data: ${JSON.stringify({id:'demo',choices:[{index:0,delta:{tool_calls:[tool]},finish_reason:null}]})}\n\n`)
      else for (const fragment of content.match(/[\s\S]{1,14}/g) ?? []) { if (res.destroyed) break; res.write(`data: ${JSON.stringify({id:'demo',choices:[{index:0,delta:{content:fragment},finish_reason:null}]})}\n\n`); await wait(48) }
      res.end(`data: ${JSON.stringify({id:'demo',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage})}\n\ndata: [DONE]\n\n`)
    } else { res.setHeader('content-type','application/json'); res.end(JSON.stringify({id:'demo',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage})) }
  } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({error:{message:String(error)}})) }
})
service.listen(0,'127.0.0.1'); await once(service,'listening')
const url = `http://127.0.0.1:${service.address().port}/v1`
const env = Object.fromEntries(Object.entries(process.env).filter(([key,value]) => value !== undefined && !/^(ELECTRON_RUN_AS_NODE|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|OPENCODE_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)))
let app; const scenes = []; let epoch; let page; let video; let outcome = 'failed'
try {
  app = await _electron.launch({ executablePath:process.env.PROMO_EXECUTABLE, args:process.env.PROMO_EXECUTABLE ? ['--force-device-scale-factor=1'] : [root,'--force-device-scale-factor=1'], cwd:process.env.PROMO_EXECUTABLE ? dirname(process.env.PROMO_EXECUTABLE) : root, env:{...env,MODEL_ROUNDTABLE_TEST:'1',MODEL_ROUNDTABLE_DATA_DIR:join(run,'profile'),MODEL_ROUNDTABLE_COMPONENTS_DIR:join(root,'.cache','components-runtime')},recordVideo:{dir:join(run,'raw'),size:{width:1440,height:900}},timeout:30000 })
  epoch = performance.now(); page = await app.firstWindow(); video = page.video(); page.setDefaultTimeout(20000)
  await page.waitForFunction(()=>!!window.roundtable)
  const version = await app.evaluate(({app})=>app.getVersion())
  if (version !== '1.0.0') throw Error(`Marketing requires an actual 1.0.0 build; found ${version}`)
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setContentSize(1440,900);win.webContents.setZoomFactor(1)})
  const errors=[];page.on('pageerror',e=>errors.push(e.message))
  await app.evaluate(({dialog},document)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[document]})},document)
  const prepared = await page.evaluate(async ({url,project,document})=>{
    const provider=await window.roundtable.saveProvider({name:'演示服务 · 受控响应',baseUrl:url,modelIds:['demo-planner','demo-critic','demo-chair','demo-executor','demo-review-a','demo-review-b','demo-embedding'],tokenParameter:'max_tokens',streamUsage:true,timeoutMs:60000,network:{mode:'direct'}})
    const kb=await window.roundtable.createKnowledgeBase({name:'读书清单 · 演示资料',embedding:{providerId:provider.id,modelId:'demo-embedding'}})
    const selected=await window.roundtable.selectFiles()
    await window.roundtable.importSources({knowledgeBaseId:kb.id,filePaths:selected})
    const p=await window.roundtable.saveProject({name:'读书清单网页 · 演示项目',directory:project,instructions:'仅修改演示项目的 index.html，保留原有资料；不使用外部资源。',knowledgeBaseIds:[kb.id]})
    return{provider,p,kb}
  },{url,project,document})
  await expect.poll(async()=>page.evaluate(()=>window.roundtable.bootstrap().then(s=>s.sources[0]?.status)),{timeout:60000}).toBe('ready')
  await page.reload(); await page.getByRole('button',{name:'项目 读书清单网页 · 演示项目',exact:true}).click()
  const model=id=>JSON.stringify([prepared.provider.id,id])
  const snapshot=async name=>{await page.screenshot({path:join(screenshots,`${name}.png`)});console.log(`Captured ${name}`)}
  const scene=async(id,action)=>{const start=(performance.now()-epoch)/1000;await action();await wait(1600);scenes.push({id,start,end:(performance.now()-epoch)/1000})}
  await scene('setup',async()=>{
    await page.getByRole('button',{name:'新建项目讨论',exact:true}).click()
    await page.getByLabel('今天，想一起讨论什么？',{exact:true}).fill('把现有页面改成读书清单网页：三张书卡，可以标记读完，并显示已读数量。')
    await page.getByLabel('成员 1 名称',{exact:true}).fill('方案设计')
    await page.getByLabel('成员 2 名称',{exact:true}).fill('风险检查')
    await page.getByLabel('成员 1 模型',{exact:true}).selectOption(model('demo-planner'))
    await page.getByLabel('成员 2 模型',{exact:true}).selectOption(model('demo-critic'))
    await page.getByLabel('主持模型（可选）',{exact:true}).selectOption(model('demo-chair'))
    await page.getByRole('checkbox',{name:/允许自动联网/}).uncheck()
    await page.getByRole('dialog').locator('.modal-heading').scrollIntoViewIfNeeded()
    await snapshot('setup')
  })
  await scene('discussion',async()=>{
    await page.getByRole('button',{name:'开始讨论',exact:true}).click()
    await expect(page.locator('.completed-card')).toBeVisible({timeout:60000})
    await snapshot('discussion')
    const messages=page.locator('.chat-message');await messages.first().scrollIntoViewIfNeeded();await wait(1800);await messages.last().scrollIntoViewIfNeeded()
  })
  await scene('handoff',async()=>{
    await page.getByRole('button',{name:'交给执行者',exact:true}).click()
    await page.getByLabel('要执行的任务',{exact:true}).fill('修改 index.html，做成墨绿暖白的读书清单网页，包含三张示例书卡、阅读状态按钮和已读计数。')
    await page.getByLabel('完成判定',{exact:true}).fill('index.html 可直接打开，按钮切换已读状态与计数；无外部依赖，明确刷新后重置；保留 README.md 与页面需求.md。')
    await page.getByLabel('执行模型',{exact:true}).selectOption(model('demo-executor'))
    await page.getByLabel('审阅模型 1',{exact:true}).selectOption(model('demo-review-a'))
    await page.getByLabel('审阅模型 2',{exact:true}).selectOption(model('demo-review-b'))
    const networking=page.getByRole('dialog').getByRole('checkbox',{name:/允许自动联网/});if(await networking.count())await networking.uncheck()
    await page.getByRole('dialog').locator('.modal-heading').scrollIntoViewIfNeeded()
    await snapshot('handoff')
  })
  await scene('execution',async()=>{
    await page.getByRole('button',{name:'创建并执行',exact:true}).click()
    await expect.poll(async()=>page.evaluate(()=>window.roundtable.bootstrap().then(s=>s.executions[0]?.error??s.executions[0]?.status)),{timeout:120000}).toBe('complete')
    if(await readFile(join(project,'index.html'),'utf8')!==actualFile)throw Error('Real output file does not match expected contents')
    await expect(page.locator('.diff-view')).toContainText('我的读书清单')
    await snapshot('execution');await wait(2200)
  })
  await scene('reviews',async()=>{
    await page.getByRole('button',{name:/独立审阅/}).click();await expect(page.locator('.review-result')).toHaveCount(2)
    await snapshot('reviews');await wait(3200)
  })
  await scene('knowledge',async()=>{
    await page.getByRole('button',{name:/^知识库/}).click()
    await page.getByLabel('知识库检索问题').fill('网页交互需要满足哪些条件？')
    await page.getByRole('button',{name:'检索',exact:true}).click();await expect(page.locator('.retrieval-result').first()).toContainText('读书')
    await page.locator('.retrieval-result').first().scrollIntoViewIfNeeded()
    await snapshot('knowledge');await wait(2800)
  })
  await page.getByRole('button',{name:'网络与订阅',exact:true}).click();await wait(600);await snapshot('network')
  await page.getByRole('button',{name:'模型与设置',exact:true}).click()
  const section=page.locator('[data-section="settings.editor"]');if(!await section.evaluate(e=>e.open))await section.locator(':scope > summary').click();await section.scrollIntoViewIfNeeded();await wait(900);await section.screenshot({path:join(screenshots,'editor.png')})
  const state=await page.evaluate(()=>window.roundtable.bootstrap())
  if(errors.length)throw Error(errors.join('\n'))
  if(!state.executions[0]?.events.some(e=>e.kind==='tool'&&e.state==='complete'))throw Error('No actual completed file tool in execution')
  const ended=(performance.now()-epoch)/1000
  await app.close();app=undefined
  const rawVideo=await video.path()
  const browser=await chromium.launch({channel:'msedge',headless:true})
  const browserContext=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,recordVideo:{dir:join(run,'result-raw'),size:{width:1440,height:900}}})
  const resultPage=await browserContext.newPage()
  const resultEpoch=performance.now()
  await resultPage.goto(new URL('file:///'+join(project,'index.html').replaceAll('\\','/')).href)
  await expect(resultPage.getByRole('heading',{name:'我的读书清单',exact:true})).toBeVisible();await wait(2000)
  await resultPage.getByRole('button',{name:'标记读完',exact:true}).first().click()
  await expect(resultPage.locator('#count')).toHaveText('3 本书 · 1 本已读')
  await resultPage.screenshot({path:join(screenshots,'result.png')});await wait(4000)
  const resultSeconds=(performance.now()-resultEpoch)/1000,resultVideo=resultPage.video()
  await browserContext.close();await browser.close()
  const resultRaw=await resultVideo.path()
  outcome='complete'
  const manifest={version,run,rawVideo,recordedSeconds:ended,scenes,screenshots,resultVideo:{path:resultRaw,durationSeconds:resultSeconds},calls,verification:{state:outcome,uiErrors:errors,actualFileSha256:createHash('sha256').update(actualFile).digest('hex'),realToolCompleted:true,actualBrowserButtonVerified:true,modelCalls: calls.filter(c=>c.path==='/v1/chat/completions').length,externalPaidCalls:0,notes:'Local controlled responses; actual UI, KB processing, OpenCode file write, review flow and real browser interaction.'}}
  await writeFile(join(run,'capture.json'),JSON.stringify(manifest,null,2));await writeFile(join(base,'capture.json'),JSON.stringify(manifest,null,2))
  await mkdir(join(root,'marketing','assets','screenshots'),{recursive:true})
  for(const name of ['setup','discussion','handoff','execution','reviews','knowledge','network','editor','result'])await copyFile(join(screenshots,`${name}.png`),join(root,'marketing','assets','screenshots',`${name}.png`))
  console.log(`Capture complete: ${run}`)
} finally {
  if(app)await app.close().catch(()=>{})
  service.closeAllConnections();await new Promise(done=>service.close(done))
  if(outcome!=='complete')await writeFile(join(run,'FAILED.txt'),'Capture did not complete. Do not publish screenshots or video from this run.\n')
}
