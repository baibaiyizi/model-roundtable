import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { listPackage, extractFile } from '@electron/asar'
import { createHash } from 'node:crypto'

const requested=resolve(process.argv[2]??'')
if(!process.argv[2]||!existsSync(requested))throw Error('请传入已解包或已安装目录，或 模型圆桌.exe 绝对路径')
const executable=(await stat(requested)).isDirectory()?join(requested,'模型圆桌.exe'):requested
assert(existsSync(executable),'目录中缺少 模型圆桌.exe')
const root=dirname(executable),resources=join(root,'resources'),asar=join(resources,'app.asar')
const files=listPackage(asar).map(x=>x.replaceAll('\\','/'))
for(const fragment of ['/node_modules/@lancedb/','/node_modules/apache-arrow/','/node_modules/@huggingface/','/node_modules/onnxruntime-'])assert(!files.some(x=>x.includes(fragment)),`核心包仍包含可选/未使用依赖 ${fragment}`)
for(const name of ['agents/bin','documents/python','documents/libreoffice','documents/fonts'])assert(!existsSync(join(resources,name)),`核心包仍包含大型组件 ${name}`)
for(const name of ['components/manifest.json','documents/worker.py','media/bin/ffmpeg.exe','runtime/licenses/LICENSE-en.rtf'])assert(existsSync(join(resources,name)),`核心包缺少 ${name}`)
assert(files.includes('/ACKNOWLEDGMENTS.md'), '核心包缺少逐项致谢')
const licenseInventory=JSON.parse(await readFile(join(resources,'licenses/inventory.json'),'utf8'))
for(const item of licenseInventory){
  assert(item.noticeFiles?.length, `依赖缺少许可证 ${item.name}`)
  for(const name of item.noticeFiles)assert(existsSync(join(resources,'licenses',item.name.replace(/[^A-Za-z0-9._-]/g,'_'),name)),`核心包缺少 ${item.name}/${name}`)
}
const nativeLicenses=JSON.parse(await readFile(join(resources,'licenses/native/manifest.json'),'utf8'))
for(const item of nativeLicenses.files){
  const path=resolve(resources,'licenses/native',item.file)
  assert(path.startsWith(resolve(resources,'licenses/native')+'\\'), '原生许可路径越界')
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),item.sha256,`原生许可损坏 ${item.file}`)
}
for(const suffix of ['pdfjs-dist/legacy/build/pdf.mjs','pdfjs-dist/legacy/build/pdf.worker.mjs'])assert(files.some(x=>x.endsWith(suffix)),`缺少 PDF 解析运行时 ${suffix}`)
assert(files.some(x=>x.includes('@napi-rs/canvas-win32-x64-msvc')&&x.endsWith('.node')),'缺少图片/扫描页 Canvas 原生模块')
const manifest=JSON.parse(await readFile(join(resources,'components/manifest.json'),'utf8'))
assert.equal(manifest.components.length,12)
assert(manifest.components.some(component => component.id === 'mihomo' && component.version === '1.19.31'), '缺少锁定网络内核')
for(const name of ['network/LICENSE','network/manifest.json','network/README.md'])assert(existsSync(join(resources,name)),`网络组件缺少 ${name}`)
const networkManifest=JSON.parse(await readFile(join(resources,'network/manifest.json'),'utf8'))
assert(networkManifest.materials?.length, '缺少代理内核对应源码/许可材料清单')
for(const item of networkManifest.materials){
  const path=resolve(resources,'network',item.file)
  assert(path.startsWith(resolve(resources,'network')+'\\'), '网络许可路径越界')
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),item.sha256,`网络许可材料损坏 ${item.file}`)
}
for(const component of manifest.components)for(const asset of component.artifacts){assert(asset.sha256||asset.integrity,`${component.id} 缺少锁定哈希`);if(asset.url.startsWith('resource:'))assert(existsSync(join(resources,asset.url.slice(9))),`组件缺少内置资源 ${asset.url}`)}
let bytes=0,filesCount=0
async function inventory(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await inventory(path);else{bytes+=(await stat(path)).size;filesCount++}}}
await inventory(root)
console.log(JSON.stringify({executable,version:JSON.parse(extractFile(asar,'package.json')).version,unpackedBytes:bytes,files:filesCount,components:manifest.components.map(x=>`${x.id}@${x.version}`),result:'core contains required resources; large runtimes are external components'},null,2))
