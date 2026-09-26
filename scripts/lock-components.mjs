// Explicit maintainer operation: rebuild source locks from pinned official versions.
// Runtime installation never resolves "latest", executes npm lifecycle scripts, or trusts an imported manifest.
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
const documents = await json('resources/documents/manifest.json')
const agents = await json('resources/agents/manifest.json')
const vc = await json('resources/runtime/manifest.json')
const licenseSources = (await json('resources/components/licenses/SOURCES.json')).sources
const lock = await json('package-lock.json')
const resource = async (path, destination) => ({ filename: path.split('/').at(-1), url: `resource:${path}`, sha256: createHash('sha256').update(await readFile(join(root, 'resources', path))).digest('hex'), format: 'file', destination })
const asset = (item, format, destination, extra = {}) => ({ filename: item.filename ?? item.file, url: item.url, sha256: item.sha256, format, destination, ...extra })
const components = []
components.push({ id: 'documents', name: '文档编辑 · Python 与字体', version: `${documents.python.version}-${documents.workerRevision}`, executable: 'python/python.exe', recipe: 'documents', licenses: ['https://docs.python.org/3/license.html','https://openfontlicense.org/'], artifacts: [asset(documents.python,'zip','python'), ...documents.wheels.map(w => asset(w,'zip','python/Lib/site-packages')), asset(documents.font,'file','fonts/NotoSansSC.ttf'),asset(documents.fontLicense,'file','fonts/OFL.txt'),await resource('documents/worker.py','worker.py')] })
components.push({ id: 'python', name: '扩展专用 Python', version: documents.python.version, executable: 'python.exe', recipe: 'python', licenses: ['https://docs.python.org/3/license.html'], artifacts: [asset(documents.python,'zip','.')] })
components.push({ id: 'libreoffice', name: 'Office 文档预览', version: documents.libreOffice.version, executable: 'program/soffice.com', recipe: 'libreoffice', licenses: ['https://www.libreoffice.org/about-us/licenses/'], artifacts: [asset(documents.libreOffice,'msi','.')] })
const opencode = agents.installed.find(x=>x.id==='opencode'), rg = agents.installed.find(x=>x.id==='rg')
components.push({ id: 'opencode', name: 'OpenCode 执行与项目搜索', version: opencode.version, executable:'opencode/opencode.exe', licenses:[opencode.licenseUrl,rg.licenseUrl],artifacts:[asset({...opencode,filename:'opencode-windows-x64-baseline.zip'},'zip','opencode',{pick:opencode.file}),asset({...rg,filename:'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip'},'zip','rg',{pick:rg.file})] })
for(const item of agents.optional) components.push({id:item.id,name:item.id==='codex'?'Codex 官方后台':'Claude Code 官方后台',version:item.version,executable:item.archiveFile??item.file,licenses:[item.licenseUrl],artifacts:[asset({...item,filename:item.archiveFile?`${item.archiveFile}.zip`:item.file},item.archiveFile?'zip':'file',item.archiveFile?'.':item.file,item.archiveFile?{pick:item.archiveFile}:{})]})
const nodeVersion='24.21.0', nodeFile=`node-v${nodeVersion}-win-x64.zip`
const sums=await(await fetch(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)).text()
const nodeHash=sums.split('\n').find(x=>x.endsWith(`  ${nodeFile}`))?.split(/\s+/)[0]
if(!/^[a-f0-9]{64}$/.test(nodeHash??'')) throw Error('官方 Node 校验清单缺少目标版本')
components.push({id:'node',name:'Node.js 与 npm',version:nodeVersion,executable:'node.exe',npmCli:'node_modules/npm/bin/npm-cli.js',licenses:['https://github.com/nodejs/node/blob/v24.21.0/LICENSE'],artifacts:[{filename:nodeFile,url:`https://nodejs.org/dist/v${nodeVersion}/${nodeFile}`,sha256:nodeHash,format:'zip',destination:'.',strip:1}]})
components.push({id:'git',name:'Git 项目与 Skill 下载',version:'2.55.0.5',executable:'cmd/git.exe',licenses:['https://github.com/git-for-windows/git/blob/v2.55.0.windows.5/COPYING'],artifacts:[{filename:'MinGit-2.55.0.5-64-bit.zip',url:'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip',sha256:'56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e',format:'zip',destination:'.'}]})
components.push({id:'uv',name:'Python 扩展环境管理',version:'0.12.18',executable:'uv.exe',licenses:['https://github.com/astral-sh/uv/blob/0.12.18/LICENSE-MIT'],artifacts:[{filename:'uv-x86_64-pc-windows-msvc.zip',url:'https://github.com/astral-sh/uv/releases/download/0.12.18/uv-x86_64-pc-windows-msvc.zip',sha256:'cae6a3bc25239f83dffb467a4b180508d9da23986c04639ebfa44e43e6a84bff',format:'zip',destination:'.',pick:'uv.exe'}]})
function packagePath(name, from='') {
  const parts=from.split('/'); while(parts.length) { const test=`${parts.join('/')}/node_modules/${name}`;if(lock.packages[test]) return test;parts.pop() }
  const key=`node_modules/${name}`;if(!lock.packages[key]) throw Error(`锁文件缺少 ${name}`);return key
}
async function npmClosure(seeds, overrides={}) {
  const artifacts=[],seen=new Set()
  async function visit(name,from='') {
    const path=packagePath(name,from), item=lock.packages[path]
    if(seen.has(path))return;seen.add(path)
    if(!item.resolved?.startsWith('https://registry.npmjs.org/')||!item.integrity)throw Error(`非官方锁定 npm 来源 ${name}`)
    artifacts.push({filename:`${name.replaceAll('/','-').replaceAll('@','')}-${item.version}.tgz`,url:item.resolved,integrity:item.integrity,format:'tar',destination:path,strip:1})
    for(const dep of Object.keys(item.dependencies??{}))await visit(dep,path)
  }
  for(const name of seeds) await visit(name)
  return artifacts
}
components.push({id:'lancedb',name:'长期知识库向量索引',version:'0.39.0',executable:'node_modules/@lancedb/lancedb/dist/index.js',licenses:['https://github.com/lancedb/lancedb/blob/v0.39.0/LICENSE',vc.redistributionTerms],artifacts:[...await npmClosure(['@lancedb/lancedb','@lancedb/lancedb-win32-x64-msvc','apache-arrow']),{filename:'VC_redist.x64.exe',url:vc.source.url,sha256:vc.source.sha256,format:'vc-redist',destination:'node_modules/@lancedb/lancedb-win32-x64-msvc'},await resource('runtime/licenses/LICENSE-en.rtf','licenses/VC-LICENSE-en.rtf'),await resource('runtime/licenses/LICENSE-zh-CN.rtf','licenses/VC-LICENSE-zh-CN.rtf')]})
const skills=await(await fetch('https://registry.npmjs.org/skills/1.7.0')).json()
if(!skills.dist.integrity||skills.version!=='1.7.0')throw Error('无法核对官方 skills@1.7.0')
components.push({id:'skills',name:'Skills 官方 CLI',version:'1.7.0',executable:'node_modules/skills/bin/cli.mjs',licenses:['https://github.com/vercel-labs/skills/blob/v1.7.0/LICENSE'],artifacts:[{filename:'skills-1.7.0.tgz',url:skills.dist.tarball,integrity:skills.dist.integrity,format:'tar',destination:'node_modules/skills',strip:1},...await npmClosure(['tar','yaml'])]})
for (const source of licenseSources) {
  const component = components.find(item => item.id === source.component && item.version === source.version)
  if (!component) throw Error(`License version does not match component: ${source.component}@${source.version}`)
  const artifact = await resource(`components/licenses/${source.file}`, `licenses/${source.file}`)
  if (artifact.sha256 !== source.sha256) throw Error(`Pinned license changed: ${source.file}`)
  component.artifacts.push(artifact)
}
await mkdir(join(root,'resources/components'),{recursive:true})
await writeFile(join(root,'resources/components/manifest.json'),JSON.stringify({schema:1,platform:'win32-x64',components},null,2)+'\n')
console.log(`Locked ${components.length} components from official sources`)
