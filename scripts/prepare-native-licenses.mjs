// Maintainer-only collector. Downloads fixed official source material, never executes it.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as readTar } from 'tar'

const root = fileURLToPath(new URL('..', import.meta.url))
const cache = join(root, '.cache/license-audit/downloads')
const output = join(root, 'resources/native-licenses')
const revision = 'b2723ffae4e74e8c9df752902b137ec4061530e9'
const skiaRevision = 'a9c42c9fce77cd748805df0ec67ef5718800b1e9'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(cache, { recursive: true })
await mkdir(output, { recursive: true })
const files = [], archives = []

async function download(url, expected) {
  const path = join(cache, sha(url))
  try { const bytes = await readFile(path); if (!expected || sha(bytes) === expected) return bytes } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${path}.download`
    try {
      await new Promise((accept, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/download-license-source.ps1'), '-Url', url, '-OutputPath', temporary], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let error = ''; child.stderr.on('data', chunk => { error += chunk.toString() }); child.once('error', reject)
        child.once('close', code => code === 0 ? accept() : reject(new Error(`Download failed (${code}): ${url}\n${error.slice(0,1000)}`)))
      })
      const bytes = await readFile(temporary)
      if (expected && sha(bytes) !== expected) throw new Error(`Source checksum mismatch: ${url}`)
      await rename(temporary, path); return bytes
    } catch (error) { if (attempt === 2) throw error }
    finally { await rm(temporary, { force: true }) }
  }
}
async function save(path, bytes, source, category, component) {
  const destination = resolve(output, path)
  if (!destination.startsWith(resolve(output) + '\\')) throw new Error(`Invalid notice path: ${path}`)
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes)
  files.push({ file: path.replaceAll('\\','/'), sha256: sha(bytes), bytes: bytes.length, source, category, component })
}
async function github(repo, rev, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${rev}`
  const data = JSON.parse(await download(url)); if (data.encoding !== 'base64') throw new Error(`Not a source file: ${url}`)
  return { bytes: Buffer.from(data.content, 'base64'), url: `https://github.com/${repo}/blob/${rev}/${path}` }
}
async function gitiles(repo, rev, path) {
  const url = `${repo}/+/${rev}/${path}?format=TEXT`
  return { bytes: Buffer.from((await download(url)).toString().trim(), 'base64'), url }
}

const canvasFiles = ['LICENSE', 'Cargo.lock', 'Cargo.toml', 'build.rs', 'scripts/build-skia.js', 'scripts/release-skia-binary.mjs', '.github/workflows/CI.yaml']
for (const path of canvasFiles) { const source = await github('Brooooooklyn/canvas', revision, path); await save(`canvas-1.0.9/upstream/${path}`, source.bytes, source.url, path === 'LICENSE' ? 'license' : 'build-evidence', 'canvas') }
for (const path of ['LICENSE', 'DEPS', 'modules/skcms/LICENSE', 'gn/skia.gni']) { const source = await github('google/skia', skiaRevision, path); await save(`canvas-1.0.9/skia/${path}`, source.bytes, source.url, /LICENSE$/.test(path) ? 'license' : 'build-evidence', 'skia') }

const cLibraries = [
  ['brotli','https://skia.googlesource.com/external/github.com/google/brotli.git','6d03dfbedda1615c4cba1211f8d81735575209c8',['LICENSE']],
  ['expat','https://chromium.googlesource.com/external/github.com/libexpat/libexpat.git','6154446fccefbf3ca644894f598969113b0c7bcd',['COPYING']],
  ['freetype','https://chromium.googlesource.com/chromium/src/third_party/freetype2.git','264b5fbf5b912b39f98d038bf75d39be0a73f21b',['LICENSE.TXT','docs/FTL.TXT','src/bdf/README','src/pcf/README','src/base/fthash.c','include/freetype/internal/fthash.h','src/gzip/zlib.h','src/autofit/ft-hb-ft.c','src/autofit/ft-hb-decls.h','src/autofit/ft-hb-types.h','src/autofit/hb-script-list.h']],
  ['harfbuzz','https://chromium.googlesource.com/external/github.com/harfbuzz/harfbuzz.git','9cb1fee51069b206effb4736e443b038d230789d',['COPYING']],
  ['highway','https://chromium.googlesource.com/external/github.com/google/highway.git','457c891775a7397bdb0376bb1031e6e027af1c48',['LICENSE']],
  ['icu','https://chromium.googlesource.com/chromium/deps/icu.git','d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738',['LICENSE']],
  ['libjpeg-turbo','https://chromium.googlesource.com/chromium/deps/libjpeg_turbo.git','e14cbfaa85529d47f9f55b0f104a579c1061f9ad',['LICENSE.md','README.ijg']],
  ['libjxl','https://chromium.googlesource.com/external/gitlab.com/wg1/jpeg-xl.git','332feb17d17311c748445f7ee75c4fb55cc38530',['LICENSE','PATENTS','AUTHORS']],
  ['libpng','https://skia.googlesource.com/third_party/libpng.git','d5515b5b8be3901aac04e5bd8bd5c89f287bcd33',['LICENSE']],
  ['libwebp','https://chromium.googlesource.com/webm/libwebp.git','845d5476a866141ba35ac133f856fa62f0b7445f',['COPYING','PATENTS','AUTHORS']],
  ['wuffs','https://skia.googlesource.com/external/github.com/google/wuffs-mirror-release-c.git','e3f919ccfe3ef542cfc983a82146070258fb57f8',['LICENSE']],
  ['zlib','https://chromium.googlesource.com/chromium/src/third_party/zlib','646b7f569718921d7d4b5b8e22572ff6c76f2596',['LICENSE']],
]
const deps = (await readFile(join(output, 'canvas-1.0.9/skia/DEPS'))).toString()
for (const [name,repo,rev,paths] of cLibraries) {
  if (!deps.includes(`${repo}@${rev}`)) throw new Error(`Native dependency no longer matches Skia DEPS: ${name}`)
  for (const path of paths) { const source = await gitiles(repo,rev,path); await save(`canvas-1.0.9/native/${name}/${path}`, source.bytes, source.url, 'license', name) }
  console.log(`Native notices: ${name}`)
}

const lock = await readFile(join(output, 'canvas-1.0.9/upstream/Cargo.lock'), 'utf8')
const crates = lock.split('[[package]]').slice(1).map(block => ({ name: block.match(/^name = "([^"]+)"/m)?.[1], version: block.match(/^version = "([^"]+)"/m)?.[1], checksum: block.match(/^checksum = "([^"]+)"/m)?.[1] })).filter(item => item.checksum)
async function collectCrate(crate) {
  const url = `https://static.crates.io/crates/${crate.name}/${crate.name}-${encodeURIComponent(crate.version)}.crate`
  const bytes = await download(url, crate.checksum), archive = join(cache, sha(url))
  const entries = new Map()
  await readTar({ file: archive, onReadEntry(entry) {
    if (entry.type !== 'File') return entry.resume()
    const path = entry.path.split('/').slice(1).join('/')
    if (/(?:^|\/)(?:licen[cs]e|copying|copyright|notice|patents|authors)(?:[.\-_]|$)/i.test(path) || /(?:^|\/)(?:Cargo.toml|README(?:\.[^/]*)?)$/i.test(path) || path === '.cargo_vcs_info.json') {
      const chunks=[]; entry.on('data',chunk=>chunks.push(chunk));entry.on('end',()=>entries.set(path,Buffer.concat(chunks)))
    } else entry.resume()
  } })
  const cargo = entries.get('Cargo.toml')?.toString() ?? ''
  const declared = cargo.match(/^license-file\s*=\s*"([^"]+)"/m)?.[1]
  const license = cargo.match(/^license\s*=\s*"([^"]+)"/m)?.[1]
  const selected = [...entries].filter(([path]) => /(?:^|\/)(?:licen[cs]e|copying|copyright|notice|patents|authors)(?:[.\-_]|$)/i.test(path) || path === declared)
  if (declared && !entries.has(declared)) throw new Error(`Missing declared license-file: ${crate.name} ${declared}`)
  let repositoryLicense
  // These workspace crates omit the repository-wide MIT text from their published archives.
  // The archive checksum authenticates .cargo_vcs_info.json; never resolve a moving branch.
  const repository = /^napi(?:-build|-derive|-derive-backend|-sys)?$/.test(crate.name) ? 'napi-rs/napi-rs' : ['base64-simd', 'vsimd'].includes(crate.name) ? 'Nugine/simd' : undefined
  if (!selected.length && repository) {
    const vcs = JSON.parse(entries.get('.cargo_vcs_info.json')?.toString() ?? '{}')
    if (!/^[0-9a-f]{40}$/.test(vcs.git?.sha1) || vcs.git?.dirty || !cargo.includes(`https://github.com/${repository}`)) throw new Error(`Unverifiable repository license: ${crate.name}`)
    repositoryLicense = await github(repository,vcs.git.sha1,'LICENSE')
    await save(`canvas-1.0.9/rust/${crate.name}-${crate.version}/LICENSE`,repositoryLicense.bytes,repositoryLicense.url,'license',`${crate.name}@${crate.version}`)
  }
  if (!selected.length && !repositoryLicense) { const readme = [...entries].find(([path,data]) => /^README(?:\.[^/]*)?$/i.test(path) && /Permission is hereby granted/i.test(data.toString())); if (readme) selected.push(readme); else throw new Error(`No license text: ${crate.name}@${crate.version}`) }
  for (const [path,data] of selected) await save(`canvas-1.0.9/rust/${crate.name}-${crate.version}/${path}`,data,{ archive:url,archiveSha256:crate.checksum,path },'license',`${crate.name}@${crate.version}`)
  archives.push({ ...crate, url, license, licenseFiles: selected.map(([path])=>path), ...(repositoryLicense ? {repositoryLicense: repositoryLicense.url} : {}), scope: 'Cargo.lock (includes build-time and non-Windows entries)' })
  console.log(`Rust notices: ${crate.name}@${crate.version} (${selected.length})`)
}
for (let at=0;at<crates.length;at+=4) await Promise.all(crates.slice(at,at+4).map(collectCrate))

// The shipped .node exposes this rustc source revision in its standard-library paths.
const rustRevision='48a229ceaefd4985c50990b14116b6d856af0985'
const rustArchive={url:'https://static.rust-lang.org/dist/rustc-1.98.1-x86_64-pc-windows-msvc.tar.xz',sha256:'cb5370843a9d15ce6e6cf6461b4c997722220d268d0d813c2b2b86f3ed59ac24'}
await download(rustArchive.url,rustArchive.sha256)
const rustPrefix='rustc-1.98.1-x86_64-pc-windows-msvc'
for(const path of ['LICENSE-APACHE','LICENSE-MIT','COPYRIGHT','git-commit-hash','git-commit-info','version','rustc/share/doc/rust/COPYRIGHT-library.html']) {
  const bytes=execFileSync('tar',['-xOf',join(cache,sha(rustArchive.url)),`${rustPrefix}/${path}`],{maxBuffer:8*1024*1024,windowsHide:true})
  if(path==='git-commit-hash' && bytes.toString().trim()!==rustRevision) throw new Error('Rust distribution revision mismatch')
  await save(`canvas-1.0.9/rust-standard-library/${path.split('/').at(-1)}`,bytes,{archive:rustArchive.url,archiveSha256:rustArchive.sha256,path:`${rustPrefix}/${path}`},/LICENSE|COPYRIGHT/.test(path)?'license':'build-evidence','Rust Standard Library 1.98.1')
}

const saxes = await github('lddubeau/saxes','211fa0ebec9b628affc09219199639887174bfc3','LICENSE')
await save('npm/saxes-6.0.0/LICENSE',saxes.bytes,saxes.url,'license','saxes@6.0.0')
for (const [name,version,path] of [['isarray','1.0.0','README.md']]) {
  const bytes=await readFile(join(root,'node_modules',name,path))
  if (!/licen[cs]e/i.test(bytes.toString())) throw new Error(`Missing embedded npm license: ${name}`)
  await save(`npm/${name}-${version}/${path}`,bytes,{npm:`${name}@${version}`,path,integrity:JSON.parse(await readFile(join(root,'package-lock.json'),'utf8')).packages[`node_modules/${name}`].integrity},'license',`${name}@${version}`)
}
const platform='node_modules/@napi-rs/canvas-win32-x64-msvc',packageLock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'))
const binaries=[]
for (const file of ['skia.win32-x64-msvc.node','icudtl.dat']) binaries.push({file:`${platform}/${file}`,sha256:sha(await readFile(join(root,platform,file)))})
if(!(await readFile(join(root,platform,'skia.win32-x64-msvc.node'))).includes(Buffer.from(rustRevision)))throw new Error('Rust source revision is absent from shipped Canvas binary')
const manifest={schema:1,canvasVersion:'1.0.9',canvasRevision:revision,skiaRevision,rustStandardLibrary:{version:'1.98.1',revision:rustRevision,...rustArchive},platformPackage:{name:'@napi-rs/canvas-win32-x64-msvc',version:'1.0.9',integrity:packageLock.packages[platform].integrity},binaries,cLibraries:cLibraries.map(([name,repo,revision,paths])=>({name,repo,revision,paths})),crates:archives.sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)),files:files.sort((a,b)=>a.file.localeCompare(b.file))}
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(`Prepared ${files.length} fixed original files; ${crates.length} Cargo packages.`)
