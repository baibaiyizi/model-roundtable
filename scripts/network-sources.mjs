import { readFile } from 'node:fs/promises'
import { createHash, X509Certificate } from 'node:crypto'
import { resolve, sep, join } from 'node:path'

export function buildDependencies(text) {
  const dependencies = []
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split('\t')
    if (fields[0] === 'dep') dependencies.push({ path: fields[1], version: fields[2], sum: fields[3] })
    if (fields[0] === '=>') {
      if (!dependencies.length) throw new Error('Replacement without a Go dependency')
      dependencies[dependencies.length - 1].replacement = { path: fields[1], version: fields[2], sum: fields[3] }
    }
  }
  return dependencies
}

/** Offline release gate for retained source and runtime notice material. */
export async function verifyNetworkSources(directory, manifest) {
  if (manifest.sourceRevision !== 'ab405bad5beeeac8b003bb01f60f134f6df54471' || manifest.toolchain?.version !== 'go1.26.8') throw new Error('Mihomo source/toolchain snapshot is missing or changed')
  if (!Array.isArray(manifest.materials) || !manifest.materials.length || manifest.modules?.length !== 176) throw new Error('Mihomo source/notice inventory is incomplete')
  const indexed = new Map()
  for (const item of manifest.materials) {
    const file = resolve(directory, item.file)
    if (!file.startsWith(resolve(directory) + sep) || indexed.has(item.file) || !item.source) throw new Error(`Invalid Mihomo material: ${item.file}`)
    const bytes = await readFile(file)
    if (!bytes.length || bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Mihomo source/notice checksum mismatch: ${item.file}`)
    indexed.set(item.file, item)
  }
  for (const file of ['build-info/go-buildinfo.txt', 'build-info/upstream/go.mod', 'build-info/upstream/go.sum', 'build-info/upstream/Makefile', 'build-info/upstream/.github/workflows/build.yml', 'build-info/upstream/component/ca/config.go', 'build-info/toolchain-release.json', 'build-info/ca-certificates.crt', 'licenses/toolchain/go/LICENSE', 'licenses/toolchain/go/PATENTS', 'licenses/toolchain/go/VERSION']) if (!indexed.has(file)) throw new Error(`Missing Mihomo source material: ${file}`)
  const buildInfo = await readFile(join(directory, 'build-info/go-buildinfo.txt'), 'utf8')
  if (!buildInfo.includes(`vcs.revision=${manifest.sourceRevision}`) || !buildInfo.includes('vcs.modified=true') || !buildInfo.includes('go1.26.8')) throw new Error('Mihomo build provenance does not match the shipped executable')
  const goSum = await readFile(join(directory, 'build-info/upstream/go.sum'), 'utf8')
  const archived = new Map(manifest.artifacts.map(item => [item.file, item]))
  for (const module of manifest.modules) {
    if (!goSum.includes(`${module.path} ${module.version} ${module.sum}`) || !goSum.includes(`${module.path} ${module.version}/go.mod ${module.goModSum}`)) throw new Error(`Mihomo Go sum mismatch: ${module.path}`)
    for (const extension of ['zip', 'mod', 'info']) if (!archived.has(module.archive.replace(/\.zip$/, '.' + extension))) throw new Error(`Mihomo Go source missing: ${module.path}`)
    if (!module.noticeFiles.length || module.noticeFiles.some(file => !indexed.has(file))) throw new Error(`Mihomo Go notices missing: ${module.path}`)
  }
  const dependencies = buildDependencies(buildInfo)
  if (dependencies.length < 100) throw new Error('Mihomo executable dependency inventory is incomplete')
  for (const dependency of dependencies) {
    const selected = dependency.replacement ?? dependency
    if (!manifest.modules.some(module => module.path === selected.path && module.version === selected.version && module.sum === selected.sum)) throw new Error(`Mihomo executable dependency source missing: ${selected.path}`)
  }
  for (const file of [manifest.toolchain.sourceArchive, manifest.toolchain.patch, 'sources/mihomo-v1.19.31.tar.gz']) if (!archived.has(file)) throw new Error(`Mihomo build archive missing: ${file}`)
  const ca = await readFile(join(directory, manifest.caBundle.file), 'utf8')
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  if (Buffer.byteLength(ca) !== manifest.caBundle.bytes || certificates.length !== 121 || manifest.caBundle.certificates !== 121) throw new Error('Mihomo embedded CA snapshot is incomplete')
  for (const certificate of certificates) new X509Certificate(certificate)
  return { modules: manifest.modules.length, dependencies: dependencies.length, materials: indexed.size }
}
