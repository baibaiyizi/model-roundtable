// Maintainer operation: collect already checksum-verified official Go module downloads.
// Large archives remain ignored; the release source archive includes manifest.artifacts.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { createHash, X509Certificate } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import yauzl from 'yauzl'
import { t as readTar } from 'tar'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = join(root, 'resources/network')
const cache = join(root, '.cache/publication')
const sourceRoot = join(root, '.cache/license-audit/MetaCubeX-mihomo-ab405ba')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
manifest.artifacts = manifest.artifacts.slice(0, 2)
manifest.materials = []
manifest.modules = []

function parseStream(text) {
  // go mod download emits top-level JSON objects, each terminated on its own line.
  return text.replace(/^\uFEFF/, '').trim().split(/\r?\n}\r?\n(?={)/).map((part, i, all) => JSON.parse(i === all.length - 1 ? part : part + '\n}'))
}
async function material(file, bytes, source) {
  const target = resolve(directory, file)
  if (!target.startsWith(resolve(directory) + '\\')) throw new Error(`Invalid material path: ${file}`)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
  manifest.materials.push({ file, sha256: sha(bytes), bytes: bytes.length, source })
}
async function artifact(file, local, url, expected) {
  const bytes = await readFile(local)
  if (expected && sha(bytes) !== expected) throw new Error(`Source checksum mismatch: ${file}`)
  await mkdir(dirname(join(directory, file)), { recursive: true }); await cp(local, join(directory, file))
  manifest.artifacts.push({ file, url, sha256: sha(bytes) })
}
function zipEntries(file) {
  return new Promise((accept, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error)
    const entries = []
    zip.on('error', reject); zip.on('end', () => accept(entries))
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) return zip.readEntry()
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error)
        const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', () => { entries.push({ name: entry.fileName, bytes: Buffer.concat(chunks) }); zip.readEntry() })
      })
    }); zip.readEntry()
  }))
}
const noticePattern = /(?:^|\/)(?:licen[cs]e|copying|copyright|notice|patents|authors)(?:[.\-_]|$)/i
const escapeModule = value => value.replace(/[A-Z]/g, letter => '!' + letter.toLowerCase())
const downloads = parseStream(await readFile(join(cache, 'go-modules.json-stream'), 'utf8'))
const officialInfo = new Map()
async function moduleInfo(item) {
  const url = `https://proxy.golang.org/${escapeModule(item.Path)}/@v/${item.Version}.info`
  const path = join(cache, 'official-go-info', sha(Buffer.from(url)) + '.info')
  await mkdir(dirname(path), { recursive: true })
  let bytes
  try { bytes = await readFile(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await new Promise((accept, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/download-license-source.ps1'), '-Url', url, '-OutputPath', path], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''; child.stderr.on('data', chunk => { error += chunk.toString() }); child.once('error', reject)
      child.once('close', code => code === 0 ? accept() : reject(new Error(`Official Go metadata download failed: ${url}\n${error.slice(0, 500)}`)))
    })
    bytes = await readFile(path)
  }
  const published = JSON.parse(bytes)
  const cached = JSON.parse(await readFile(item.Info, 'utf8'))
  if (published.Version !== item.Version || published.Time !== cached.Time) throw new Error(`Official Go metadata does not match locked version/time: ${item.Path}`)
  // Go may enrich cached .info with Origin. Preserve the proxy response verbatim;
  // when both provide an origin, every shared field must agree.
  for (const key of Object.keys(published.Origin ?? {})) if (cached.Origin?.[key] !== undefined && JSON.stringify(published.Origin[key]) !== JSON.stringify(cached.Origin[key])) throw new Error(`Official Go metadata origin differs: ${item.Path} (${key})`)
  officialInfo.set(item.Path + '@' + item.Version, path)
}
for (let at = 0; at < downloads.length; at += 8) {
  await Promise.all(downloads.slice(at, at + 8).filter(item => item.Path !== 'github.com/RyuaNerin/testingutil').map(moduleInfo))
  console.log(`Official Go metadata: ${Math.min(at + 8, downloads.length)}/${downloads.length}`)
}
const buildInfo = (await readFile(join(cache, 'mihomo-buildinfo.txt'), 'utf8')).replace(/^.*?: go1\.26\.8/, 'mihomo-windows-amd64-compatible.exe: go1.26.8')
await material('build-info/go-buildinfo.txt', Buffer.from(buildInfo), 'go version -m on the unchanged release executable')
for (const path of ['go.mod', 'go.sum', 'Makefile', '.github/workflows/build.yml', 'component/ca/config.go']) {
  await material(`build-info/upstream/${path}`, await readFile(join(sourceRoot, path)), `https://github.com/MetaCubeX/mihomo/blob/ab405bad5beeeac8b003bb01f60f134f6df54471/${path}`)
}
const goSum = await readFile(join(sourceRoot, 'go.sum'), 'utf8')
const missing = []
manifest.omittedNonRuntimeModules = [{ path: 'github.com/RyuaNerin/testingutil', version: 'v0.1.0', revision: '433a25c27f92475ed259dd52a8bcb0116c9d2c87', reason: 'Only imported by dependency *_test.go files; absent from executable buildinfo. Upstream supplies no license, so its source is not redistributed.' }]
for (const item of downloads) {
  if (manifest.omittedNonRuntimeModules.some(omitted => omitted.path === item.Path && omitted.version === item.Version)) continue
  if (item.Error || !item.Zip || !item.Sum || !goSum.includes(`${item.Path} ${item.Version} ${item.Sum}`) || !goSum.includes(`${item.Path} ${item.Version}/go.mod ${item.GoModSum}`)) throw new Error(`Unverified Go download: ${item.Path}`)
  const entries = await zipEntries(item.Zip)
  const directoryHash = createHash('sha256').update(entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(entry => `${sha(entry.bytes)}  ${entry.name}\n`).join('')).digest('base64')
  if ('h1:' + directoryHash !== item.Sum) throw new Error(`Go module content hash mismatch: ${item.Path}`)
  const prefix = `sources/go-modules/${escapeModule(item.Path)}/@v/${item.Version}`
  for (const [extension, field] of [['zip', 'Zip'], ['mod', 'GoMod'], ['info', 'Info']]) await artifact(`${prefix}.${extension}`, extension === 'info' ? officialInfo.get(item.Path + '@' + item.Version) : item[field], `https://proxy.golang.org/${escapeModule(item.Path)}/@v/${item.Version}.${extension}`)
  const selected = entries.filter(entry => noticePattern.test(entry.name))
  const noticeFiles = []
  for (const entry of selected) {
    const relative = entry.name.slice(entry.name.indexOf('/') + 1)
    // Module root has slashes; remove the complete module@version prefix.
    const suffix = entry.name.slice(`${item.Path}@${item.Version}/`.length)
    const file = `licenses/go-modules/${escapeModule(item.Path)}@${item.Version}/${suffix || relative}`
    await material(file, entry.bytes, { archive: `${prefix}.zip`, entry: entry.name }); noticeFiles.push(file)
  }
  if (!noticeFiles.length) missing.push(item.Path + '@' + item.Version)
  manifest.modules.push({ path: item.Path, version: item.Version, sum: item.Sum, goModSum: item.GoModSum, archive: `${prefix}.zip`, noticeFiles })
}

const release = JSON.parse(await readFile(join(cache, 'patched-go-release.json'), 'utf8'))
const toolchain = release.assets.find(asset => asset.name === 'go1.26.linux-amd64.tar.gz')
const patch = release.assets.find(asset => asset.name === 'go1.26.patch')
await artifact('sources/metacubex-go1.26.8-linux-amd64.tar.gz', join(cache, 'metacubex-go1.26.linux-amd64.tar.gz'), toolchain.browser_download_url, '5f2c63d89fa1f10e0b9ce29ef166e16cdee6d7aca280e7f2fc27f3bf4945fab0')
await artifact('sources/metacubex-go1.26.patch', join(cache, 'metacubex-go1.26.patch'), patch.browser_download_url, '2de2fb90f1c74b8814912b816596a408d3c472edf75d46b3c24868688c48ceee')
await material('build-info/toolchain-release.json', Buffer.from(JSON.stringify({ repository: 'MetaCubeX/go', releaseId: release.id, assets: [toolchain, patch].map(({ id, name, updated_at, digest, browser_download_url }) => ({ id, name, updated_at, digest, browser_download_url })), sourceBranch: 'release-branch.go1.26', inspectedBranchCommit: 'fc11427d8d43eb11947d11bf67781a3d9bfa89e8', limitation: 'The upstream workflow used a mutable build release; archived source and patch are fixed by digest, but byte-for-byte reproduction of the Mihomo executable has not been established.' }, null, 2) + '\n'), 'https://api.github.com/repos/MetaCubeX/go/releases/tags/build')
const toolchainTexts = []
await readTar({ file: join(cache, 'metacubex-go1.26.linux-amd64.tar.gz'), onReadEntry(entry) {
  const path = entry.path.replace(/^\.\//, '')
  if (entry.type !== 'File' || (!noticePattern.test(path) && path !== 'go/VERSION')) return entry.resume()
  const chunks = []; entry.on('data', chunk => chunks.push(chunk)); entry.on('end', () => { toolchainTexts.push({ path, bytes: Buffer.concat(chunks) }) })
} })
for (const entry of toolchainTexts) await material(`licenses/toolchain/${entry.path}`, entry.bytes, { archive: 'sources/metacubex-go1.26.8-linux-amd64.tar.gz', entry: entry.path })
if (toolchainTexts.find(entry => entry.path === 'go/VERSION')?.bytes.toString().split('\n')[0] !== 'go1.26.8') throw new Error('Patched Go toolchain version differs from executable')

const executable = await readFile(join(root, '.cache/license-audit/mihomo/mihomo-windows-amd64-compatible.exe'))
const certificateRuns = [...executable.toString('latin1').matchAll(/(?:-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----[\r\n]*)+/g)].sort((a, b) => b[0].length - a[0].length)
if (!certificateRuns.length || certificateRuns[0][0].length === certificateRuns[1]?.[0].length) throw new Error('Cannot uniquely identify embedded CA bundle')
const run = certificateRuns[0]
const certificates = run[0].match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
for (const certificate of certificates) new X509Certificate(certificate)
if (certificates.length !== 121 || run[0].length !== 182140) throw new Error('Embedded CA bundle changed; review source snapshot')
await material('build-info/ca-certificates.crt', Buffer.from(run[0], 'latin1'), { executable: 'mihomo-windows-amd64-compatible.exe', executableSha256: sha(executable), offset: run.index, length: run[0].length, certificates: certificates.length })
const caCopyright = await readFile(join(cache, 'ca-certificates-copyright'))
const mpl = await readFile(join(cache, 'MPL-2.0.txt'))
if (!caCopyright.toString().startsWith('Format:') || !caCopyright.includes('MPL-2.0') || !mpl.toString().startsWith('Mozilla Public License Version 2.0')) throw new Error('CA notice download is not the expected license text')
await material('licenses/certificates/ca-certificates-copyright', caCopyright, 'https://sources.debian.org/data/main/c/ca-certificates/20250419/debian/copyright')
await material('licenses/certificates/MPL-2.0.txt', mpl, 'https://www.mozilla.org/media/MPL/2.0/index.txt')
await material('BUILD.md', await readFile(join(directory, 'BUILD.md')), 'Model Roundtable source redistribution and build notes')
manifest.sourceRevision = 'ab405bad5beeeac8b003bb01f60f134f6df54471'
manifest.executableSha256 = sha(executable)
manifest.toolchain = { version: 'go1.26.8', sourceArchive: 'sources/metacubex-go1.26.8-linux-amd64.tar.gz', patch: 'sources/metacubex-go1.26.patch' }
manifest.caBundle = { file: 'build-info/ca-certificates.crt', offset: run.index, bytes: run[0].length, certificates: certificates.length }
manifest.materials.sort((a, b) => a.file.localeCompare(b.file))
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ modules: manifest.modules.length, materials: manifest.materials.length, missingNotices: missing }, null, 2))
if (missing.length) throw new Error('Missing standalone module notices require review before release')
