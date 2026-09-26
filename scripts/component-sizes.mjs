import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),cache=resolve(process.argv[2]??join(root,'.cache/components-runtime'))
const manifest=JSON.parse(await readFile(join(root,'resources/components/manifest.json'),'utf8')),components=[]
for(const item of manifest.components){
  const marker=JSON.parse(await readFile(join(cache,item.id,'active.json'),'utf8'))
  let installedBytes=0,downloadBytes=0,bundledBytes=0
  async function walk(path){for(const e of await readdir(path,{withFileTypes:true})){const file=join(path,e.name);if(e.isDirectory())await walk(file);else installedBytes+=(await stat(file)).size}}
  await walk(join(cache,item.id,marker.directory))
  const seen=new Set()
  for(const asset of item.artifacts){if(asset.url.startsWith('resource:')){bundledBytes+=(await stat(join(root,'resources',asset.url.slice('resource:'.length)))).size;continue}const key=createHash('sha256').update(asset.sha256??asset.integrity).digest('hex'),name=`${key}-${asset.filename}`;if(!seen.has(name)){downloadBytes+=(await stat(join(cache,'downloads',name))).size;seen.add(name)}}
  components.push({id:item.id,version:item.version,downloadBytes,...(bundledBytes?{bundledBytes}:{}),installedBytes})
}
const result={schema:1,measuredAt:new Date().toISOString(),platform:'win32-x64',note:'Measured from hash-verified official source archives and immutable installed component trees; downloads shared by components may be deduplicated.',components}
await writeFile(join(root,'resources/components/SIZES.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
