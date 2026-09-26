import { readFile, readdir, mkdir, copyFile, writeFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyNativeLicenses } from './native-licenses.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const nativeManifest = await verifyNativeLicenses(root)
// These devDependencies are embedded in the shipped renderer/main bundles.
// Build/test tools are deliberately not roots of this license closure.
const bundledRoots = ['react', 'react-dom', 'react-markdown', 'remark-gfm', 'lucide-react', '@opencode-ai/sdk']
const selected = new Set(Object.entries(lock.packages).filter(([location, entry]) => location && !entry.dev).map(([location]) => location))
function dependencyLocation(name, from = '') {
  const parts = from.split('/')
  while (parts.length) {
    const location = `${parts.join('/')}/node_modules/${name}`
    if (lock.packages[location]) return location
    parts.pop()
  }
  const location = `node_modules/${name}`
  if (!lock.packages[location]) throw new Error(`Bundled dependency missing from lock: ${name}`)
  return location
}
const visited = new Set()
function includeBundled(name, from = '') {
  const location = dependencyLocation(name, from)
  if (visited.has(location)) return
  visited.add(location); selected.add(location)
  for (const dependency of Object.keys(lock.packages[location].dependencies ?? {})) includeBundled(dependency, location)
}
for (const name of bundledRoots) includeBundled(name)
const licenseSources = JSON.parse(await readFile(join(root, 'resources/components/licenses/SOURCES.json'), 'utf8')).sources
const dest = join(root, 'resources', 'licenses')
if (relative(root, resolve(dest)).replaceAll('\\', '/') !== 'resources/licenses') throw new Error('Invalid generated license directory')
await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })
const records = []
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!selected.has(location) || !existsSync(join(root, location, 'package.json'))) continue
  const pkg = JSON.parse(await readFile(join(root, location, 'package.json'), 'utf8'))
  // These optional local-model dependencies are excluded from the desktop build.
  if (/^(?:@huggingface\/|onnxruntime-|sharp$|@img\/)/.test(pkg.name)) continue
  const name = `${pkg.name}@${pkg.version}`
  const target = join(dest, name.replace(/[^A-Za-z0-9._-]/g, '_'))
  const files = (await readdir(join(root, location), { withFileTypes: true })).filter(file => file.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name))
  if (files.length) {
    await mkdir(target, { recursive: true })
    for (const file of files) await copyFile(join(root, location, file.name), join(target, file.name))
  }
  const noticeFiles = files.map(file => file.name)
  const noticeSources = []
  // The SDK's npm archive omits LICENSE; use its matching repository tag.
  if (pkg.name === '@opencode-ai/sdk') {
    const source = licenseSources.find(item => item.component === 'opencode' && item.version === pkg.version && item.file === 'opencode-LICENSE.txt')
    if (!source) throw new Error(`Missing pinned repository license for ${name}`)
    const bytes = await readFile(join(root, 'resources/components/licenses', source.file))
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('Pinned OpenCode license changed')
    await mkdir(target, { recursive: true }); await writeFile(join(target, 'LICENSE'), bytes)
    if (!noticeFiles.includes('LICENSE')) noticeFiles.push('LICENSE')
    noticeSources.push({ url: source.url, sha256: source.sha256 })
  }
  if (pkg.name === 'saxes' || pkg.name === 'isarray') {
    const relativeFile = pkg.name === 'saxes' ? 'npm/saxes-6.0.0/LICENSE' : 'npm/isarray-1.0.0/README.md'
    const source = nativeManifest.files.find(item => item.file === relativeFile)
    if (!source || source.component !== name) throw new Error(`Missing supplemental npm license: ${name}`)
    const filename = pkg.name === 'saxes' ? 'LICENSE' : 'README-LICENSE.md'
    await mkdir(target,{recursive:true}); await copyFile(join(root,'resources/native-licenses',relativeFile),join(target,filename))
    noticeFiles.push(filename); noticeSources.push(source)
  }
  if (pkg.name === '@napi-rs/canvas' || pkg.name === '@napi-rs/canvas-win32-x64-msvc') {
    await mkdir(target,{recursive:true}); await copyFile(join(root,'resources/native-licenses/README.md'),join(target,'NATIVE-NOTICES.md'))
    noticeFiles.push('NATIVE-NOTICES.md')
    noticeSources.push({ manifest: '../native/manifest.json', directory: '../native/canvas-1.0.9' })
  }
  if (!noticeFiles.length) throw new Error(`No license text collected for shipped dependency: ${name}`)
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  records.push({ name, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'See package metadata'), repository: repository ?? pkg.homepage ?? '', noticeFiles, ...(noticeSources.length ? { noticeSources } : {}) })
}
records.sort((a,b) => a.name.localeCompare(b.name))
await cp(join(root,'resources/native-licenses'),join(dest,'native'),{recursive:true})
await writeFile(join(dest, 'inventory.json'), JSON.stringify(records, null, 2))
await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), `# Third-party notices\n\nModel Roundtable original source code is MIT licensed. The following dependencies retain their respective licenses. Top-level license and notice files from installed production packages and the dependency closure of explicit bundled roots (React, React DOM, React Markdown, remark-gfm, lucide-react and the OpenCode SDK) are collected under resources/licenses. Build/test-only devDependencies are excluded. The inventory.json file records the collected npm texts. Native Canvas components are checked separately against the pinned resources/native-licenses manifest; missing texts, hash mismatches or package drift stop generation.\n\nMihomo 1.19.31 is an unmodified, independently runnable GPLv3 program. Its license, official download URLs, SHA-256 hashes and build/source instructions are in resources/network. The matching source archive is included in the accompanying versioned source distribution under resources/network/sources.\n\nCanvas 1.0.9 includes native Skia, ICU and other C/C++ and Rust components. Their original notices, exact source revisions and checksums are under resources/licenses/native. This includes the checksum-verified Cargo package inventory, vendored native libraries and the corresponding Rust standard-library notices. This product uses the FreeType Project under the FreeType License, and is based in part on the work of the Independent JPEG Group. The native inventory conservatively includes build-time and other-platform Cargo entries; it does not label every listed package as linked into the Windows binary.\n\nElectron includes Chromium and Node.js and ships its own LICENSE.electron.txt and LICENSES.chromium.html in the distribution.\n\nFFmpeg 8.1.3 is built from unmodified official release source as independently replaceable programs and shared libraries, under LGPL-2.1-or-later. Optional external libraries, network support, GPL, nonfree and version3 are disabled. The complete matching source archive, detached signature, release public key, GPG verification record, actual build recipe, configuration and per-file checksums are bundled under resources/media. BUILD-MANIFEST.json also records PE imports: Windows system libraries and the bundled FFmpeg libraries only.\n\nFFmpeg license texts, MinGW runtime notices and the GCC Runtime Library Exception are included in resources/media. The pinned w64devkit toolchain is used only for building and is not installed with the application. SOURCE.txt and BUILD-RECIPE.txt explain how to locate and rebuild the independently replaceable media components.\n\nOpenCode, ripgrep, LanceDB, Node.js, Python, Git, uv and the skills CLI are independently downloaded components with pinned sources, versions and checksums under resources/components. The core installer does not bundle their executable payloads. License files supplied in the original archives are retained. OpenCode, Codex and uv additionally install unmodified license/notice texts from their exact repository version tags, pinned under resources/components/licenses/SOURCES.json. Optional Codex and Claude Code components are original official distributions downloaded only when the user prepares them, and retain their own terms. The on-demand shared document runtime includes CPython, python-docx, openpyxl, python-pptx, pypdf, ReportLab, lxml, Pillow, other locked wheels, Noto fonts and LibreOffice; their original notices and fixed source locations are retained in the installed packages and resources/components/manifest.json, with development build records under resources/documents. LibreOffice is a separate process and can be replaced with a matching compatible build. These components are not relicensed under the application MIT license.\n\nProduct research and workflow references are listed in [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md), separately from incorporated libraries, independently distributed components and recommended external integrations. Acknowledgement does not replace the applicable license conditions.\n\n| Dependency | License | Source |\n| --- | --- | --- |\n${records.map(r => `| ${r.name} | ${r.license.replaceAll('|','/')} | ${r.repository} |`).join('\n')}\n`)
console.log(`Collected production and bundled dependency notices: ${records.length}; explicit bundled roots: ${bundledRoots.join(', ')}`)

