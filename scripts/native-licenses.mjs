import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'

const hash = data => createHash('sha256').update(data).digest('hex')
const canvasRevision = 'b2723ffae4e74e8c9df752902b137ec4061530e9'
const skiaRevision = 'a9c42c9fce77cd748805df0ec67ef5718800b1e9'
const requiredNative = ['brotli','expat','freetype','harfbuzz','highway','icu','libjpeg-turbo','libjxl','libpng','libwebp','wuffs','zlib']

/** Offline release check. A package update requires a reviewed new source/notice snapshot. */
export async function verifyNativeLicenses(root) {
  const directory = join(root, 'resources/native-licenses')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  if (manifest.schema !== 1 || manifest.canvasVersion !== '1.0.9' || manifest.canvasRevision !== canvasRevision || manifest.skiaRevision !== skiaRevision) throw new Error('Unsupported Canvas notice snapshot')
  const wrapper = lock.packages['node_modules/@napi-rs/canvas']
  const platform = lock.packages['node_modules/@napi-rs/canvas-win32-x64-msvc']
  if (wrapper?.version !== manifest.canvasVersion || platform?.version !== manifest.platformPackage.version || platform?.integrity !== manifest.platformPackage.integrity) throw new Error('Canvas package changed; native notices must be reviewed again')
  for (const [name,version] of [['saxes','6.0.0'],['isarray','1.0.0']]) if (lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Supplemental npm license version changed: ${name}`)
  const indexed = new Map()
  for (const item of manifest.files) {
    const file = resolve(directory, item.file)
    if (!file.startsWith(resolve(directory) + sep) || indexed.has(item.file) || !/^[a-f0-9]{64}$/.test(item.sha256) || !item.source) throw new Error(`Invalid native notice entry: ${item.file}`)
    const bytes = await readFile(file)
    if (!bytes.length || hash(bytes) !== item.sha256 || bytes.length !== item.bytes) throw new Error(`Native notice checksum mismatch: ${item.file}`)
    indexed.set(item.file,item)
  }
  function required(file) { if (!indexed.has(file)) throw new Error(`Native notice not indexed: ${file}`) }
  for (const file of ['canvas-1.0.9/upstream/LICENSE','canvas-1.0.9/upstream/Cargo.lock','canvas-1.0.9/upstream/scripts/build-skia.js','canvas-1.0.9/skia/LICENSE','canvas-1.0.9/skia/modules/skcms/LICENSE','canvas-1.0.9/skia/DEPS','npm/saxes-6.0.0/LICENSE','npm/isarray-1.0.0/README.md']) required(file)
  if (manifest.rustStandardLibrary?.revision !== '48a229ceaefd4985c50990b14116b6d856af0985' || manifest.rustStandardLibrary?.version !== '1.98.1') throw new Error('Rust standard-library notices are missing')
  for(const file of ['LICENSE-APACHE','LICENSE-MIT','COPYRIGHT','git-commit-hash','COPYRIGHT-library.html']) required(`canvas-1.0.9/rust-standard-library/${file}`)
  const deps = await readFile(join(directory,'canvas-1.0.9/skia/DEPS'),'utf8')
  if (manifest.cLibraries.length !== requiredNative.length || requiredNative.some(name=>!manifest.cLibraries.some(item=>item.name===name))) throw new Error('Native C/C++ dependency inventory is incomplete')
  for (const library of manifest.cLibraries) {
    if (!deps.includes(`${library.repo}@${library.revision}`) || !library.paths.length) throw new Error(`Native source does not match Skia DEPS: ${library.name}`)
    for (const path of library.paths) required(`canvas-1.0.9/native/${library.name}/${path}`)
  }
  const cargo = await readFile(join(directory,'canvas-1.0.9/upstream/Cargo.lock'),'utf8')
  const crates = cargo.split('[[package]]').slice(1).map(block=>({name:block.match(/^name = "([^"]+)"/m)?.[1],version:block.match(/^version = "([^"]+)"/m)?.[1],checksum:block.match(/^checksum = "([^"]+)"/m)?.[1]})).filter(item=>item.checksum)
  if (crates.length !== manifest.crates.length) throw new Error('Cargo notice inventory is incomplete')
  for (const crate of crates) {
    const item = manifest.crates.find(item=>item.name===crate.name && item.version===crate.version)
    if (!item || item.checksum !== crate.checksum || (!item.licenseFiles.length && !item.repositoryLicense)) throw new Error(`Missing locked Cargo notices: ${crate.name}@${crate.version}`)
    for (const path of item.licenseFiles) required(`canvas-1.0.9/rust/${crate.name}-${crate.version}/${path}`)
    if (item.repositoryLicense) required(`canvas-1.0.9/rust/${crate.name}-${crate.version}/LICENSE`)
  }
  // These are actual embedded native sources, not merely Rust wrapper metadata.
  for (const file of ['libavif-sys-0.17.0+libavif.1.0.4/libavif/LICENSE','libaom-sys-0.17.2+libaom.3.11.0/vendor/LICENSE','libaom-sys-0.17.2+libaom.3.11.0/vendor/PATENTS','libmimalloc-sys2-0.1.60/c_src/mimalloc/LICENSE']) required(`canvas-1.0.9/rust/${file}`)
  for (const binary of manifest.binaries) {
    const file = resolve(root,binary.file)
    if (!file.startsWith(resolve(root,'node_modules/@napi-rs/canvas-win32-x64-msvc') + sep) || hash(await readFile(file)) !== binary.sha256) throw new Error(`Canvas native binary does not match license snapshot: ${binary.file}`)
  }
  if (manifest.binaries.length !== 2) throw new Error('Canvas native binary inventory is incomplete')
  return manifest
}
