import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2)
const value=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined
const cacheDir=resolve(value('--cache')??join(root,'.cache/components-runtime'))
const bundle=join(root,'.cache',`verify-components-${process.pid}.mjs`)
await mkdir(dirname(bundle),{recursive:true})
await build({entryPoints:[join(root,'src/main/components/index.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm'})
const {RuntimeManager}=await import(pathToFileURL(bundle).href)
const manager=new RuntimeManager({manifestPath:join(root,'resources/components/manifest.json'),cacheDir})
const ids=value('--component')?.split(',')??(await manager.list()).filter(x=>x.phase==='ready').map(x=>x.id)
const environment={SystemRoot:process.env.SystemRoot,windir:process.env.windir,TEMP:process.env.TEMP,TMP:process.env.TMP,USERPROFILE:process.env.USERPROFILE,PATH:join(process.env.SystemRoot??'C:\\Windows','System32')}
const execute=(path,args,input)=>execFileSync(path,args,{env:environment,input,windowsHide:true,encoding:'utf8',timeout:120000}).trim()
for(const id of ids){
  await manager.verify(id)
  const item=await manager.resolve(id)
  if(id==='lancedb'){
    const require=createRequire(join(item.directory,'probe.cjs')),lance=require('@lancedb/lancedb')
    const data=await mkdtemp(join(tmpdir(),'roundtable-lance-component-'))
    const connection=await lance.connect(data)
    try {const table=await connection.createTable('proof',[{id:'真实组件',vector:[1,0]}]);try{const result=await table.vectorSearch([1,0]).toArray();if(result[0]?.id!=='真实组件')throw Error('向量查询失败')}finally{table.close()}}finally{connection.close();await rm(data,{recursive:true,force:true})}
    console.log('lancedb isolated wrapper/native: passed')
  }else if(id==='documents'){
    console.log(execute(item.executable,['-I','-B','-X','utf8','-c','import docx,openpyxl,pptx,pypdf,reportlab,defusedxml; from PIL import Image; from lxml import etree; print("documents imports: passed")']))
  }else if(id==='skills'){
    const node=await manager.resolve('node')
    console.log('skills '+execute(node.executable,[item.executable,'--version']))
  }else if(id==='libreoffice'){
    console.log(execute(item.executable,['--version']))
  }else console.log(id+' '+execute(item.executable,[id==='mihomo'?'-v':'--version']))
  if(id==='node')console.log('npm '+execute(item.executable,[item.npmCli,'--version']))
}
await rm(bundle,{force:true})
console.log('Verified pinned files and executable probes with development PATH removed.')
