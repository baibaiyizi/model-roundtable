import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const { verifyNativeLicenses } = createRequire(import.meta.url)('../scripts/native-licenses.mjs')
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'roundtable-license-test-')); roots.push(root)
  await cp(resolve('resources/native-licenses'),join(root,'resources/native-licenses'),{recursive:true})
  const lock = JSON.parse(await readFile('package-lock.json','utf8'))
  await writeFile(join(root,'package-lock.json'),JSON.stringify(lock))
  const path = join(root,'resources/native-licenses/manifest.json')
  const manifest = JSON.parse(await readFile(path,'utf8'))
  for (const binary of manifest.binaries) {
    const content=Buffer.from(`test payload: ${binary.file}`)
    await mkdir(join(root,'node_modules/@napi-rs/canvas-win32-x64-msvc'),{recursive:true})
    await writeFile(join(root,binary.file),content)
    binary.sha256=createHash('sha256').update(content).digest('hex')
  }
  await writeFile(path,JSON.stringify(manifest))
  return {root,path,manifest,lock}
}
afterEach(async()=>{for(const root of roots.splice(0)){if(!root.startsWith(join(tmpdir(),'roundtable-license-test-')))throw new Error('Unexpected test cleanup directory');await rm(root,{recursive:true,force:true})}})

describe('release native license verification',()=>{
  it('verifies the actual shipped Canvas payload and complete local source snapshot',async()=>{
    const result=await verifyNativeLicenses(resolve('.'))
    expect(result.crates).toHaveLength(93)
    expect(result.cLibraries).toHaveLength(12)
    expect(result.files.some((item: {file:string})=>item.file.endsWith('COPYRIGHT-library.html'))).toBe(true)
  })
  it('rejects a changed original notice',async()=>{
    const {root,manifest}=await fixture()
    await writeFile(join(root,'resources/native-licenses',manifest.files[0].file),'altered notice')
    await expect(verifyNativeLicenses(root)).rejects.toThrow('checksum mismatch')
  })
  it('rejects an omitted Cargo package even if remaining notices are intact',async()=>{
    const {root,path,manifest}=await fixture();manifest.crates.pop()
    await writeFile(path,JSON.stringify(manifest))
    await expect(verifyNativeLicenses(root)).rejects.toThrow('Cargo notice inventory is incomplete')
  })
  it('rejects a missing vendored native text from the index',async()=>{
    const {root,path,manifest}=await fixture()
    manifest.files=manifest.files.filter((item:{file:string})=>!item.file.endsWith('/libavif/LICENSE'))
    await writeFile(path,JSON.stringify(manifest))
    await expect(verifyNativeLicenses(root)).rejects.toThrow('Native notice not indexed')
  })
  it('rejects a platform package update without a reviewed notice snapshot',async()=>{
    const {root,lock}=await fixture();lock.packages['node_modules/@napi-rs/canvas-win32-x64-msvc'].version='1.0.10'
    await writeFile(join(root,'package-lock.json'),JSON.stringify(lock))
    await expect(verifyNativeLicenses(root)).rejects.toThrow('Canvas package changed')
  })
  it('rejects a replaced native binary',async()=>{
    const {root,manifest}=await fixture()
    await writeFile(join(root,manifest.binaries[0].file),'different executable')
    await expect(verifyNativeLicenses(root)).rejects.toThrow('native binary does not match')
  })
})
