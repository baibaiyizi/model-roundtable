import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export const inputHash = manifest => createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
export function inside(directory, name) {
  const path = resolve(directory, name)
  const child = relative(resolve(directory), path)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error(`Unsafe media path: ${name}`)
  return path
}
export function validateImports(manifest, binaries) {
  const allowed = new Set([...manifest.systemLibraries, ...manifest.binaries].map(name => name.toLowerCase()))
  if (binaries.length !== manifest.binaries.length || new Set(binaries.map(item => item.file)).size !== binaries.length) throw new Error('Media binary inventory is incomplete')
  for (const binary of binaries) {
    if (!manifest.binaries.includes(binary.file) || !binary.imports?.length) throw new Error(`Invalid media binary inventory: ${binary.file}`)
    for (const dependency of binary.imports) if (!allowed.has(dependency.toLowerCase())) throw new Error(`Unbundled media dependency: ${binary.file} -> ${dependency}`)
  }
}
export async function verifyMedia(directory = join(root, 'resources', 'media')) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const inventory = JSON.parse(await readFile(join(directory, 'BUILD-MANIFEST.json'), 'utf8'))
  if (inventory.inputsSha256 !== inputHash(manifest)) throw new Error('Media inputs changed; rebuild the media bundle')
  validateImports(manifest, inventory.binaries)
  const actual = (await readdir(join(directory, 'bin'))).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...manifest.binaries].sort())) throw new Error('Media bin directory does not match the required binaries')
  const required = [
    ...manifest.binaries.map(name => `bin/${name}`),
    ...[manifest.source, manifest.signature, manifest.signingKey].map(item => `sources/${item.file}`),
    'sources/source-signature-verification.txt', 'COPYING.LGPLv2.1', 'FFMPEG-LICENSE.md',
    'COPYING.MinGW-w64-runtime.txt', 'COPYING.GCC-RUNTIME', 'COPYING.GPLv3',
    'BUILD-RECIPE.txt', 'BUILD.txt', 'FFPROBE-BUILD.txt', 'CONFIGURE.txt', 'SOURCE.txt'
  ]
  for (const name of required) if (!inventory.files[name]) throw new Error(`Missing media inventory entry: ${name}`)
  for (const [name, expected] of Object.entries(inventory.files)) {
    if (await sha256(inside(directory, name)) !== expected) throw new Error(`Media checksum mismatch: ${name}`)
  }
  for (const binary of inventory.binaries) if (inventory.files[`bin/${binary.file}`] !== binary.sha256) throw new Error(`Inconsistent media checksum: ${binary.file}`)
  for (const item of [manifest.source, manifest.signature, manifest.signingKey]) {
    if (inventory.files[`sources/${item.file}`] !== item.sha256) throw new Error(`Media source input mismatch: ${item.file}`)
  }
  if (inventory.files[manifest.runtimeException.file] !== manifest.runtimeException.sha256) throw new Error('Compiler runtime notice mismatch')
  const signature = await readFile(join(directory, 'sources', 'source-signature-verification.txt'), 'utf8')
  if (!signature.includes(`[GNUPG:] VALIDSIG ${manifest.signingKey.fingerprint} `)) throw new Error('Source signature verification is missing')
  const configured = await readFile(join(directory, 'CONFIGURE.txt'), 'utf8')
  if (!/External libraries:\s*External libraries providing hardware acceleration:\s*Libraries:/.test(configured)) throw new Error('Optional external libraries were enabled')
  if (!/License: LGPL version 2\.1 or later/.test(configured)) throw new Error('Unexpected FFmpeg license')
  for (const name of ['ffmpeg', 'ffprobe']) {
    const { stdout, stderr } = await exec(join(directory, 'bin', `${name}.exe`), ['-version'], { windowsHide: true, timeout: 15_000 })
    const details = stdout + stderr
    if (!details.startsWith(`${name} version ${manifest.version} `) || /--enable-(gpl|nonfree|version3)(?:\s|$)/.test(details)) throw new Error(`Unexpected ${name} build`)
    const configuration = details.split(/\r?\n/).find(line => line.startsWith('configuration: '))
    if (!configuration) throw new Error(`Missing ${name} configuration`)
    for (const flag of manifest.configureFlags) if (!configuration.split(/\s+/).includes(flag)) throw new Error(`Missing ${name} configuration: ${flag}`)
  }
  return inventory
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyMedia(process.argv[2] ? resolve(process.argv[2]) : undefined)
    console.log(`Media verified: ${result.binaries.length} binaries, matching source, licenses, signature and build records.`)
  } catch (error) {
    console.error(`Media verification failed: ${error.message}\nRun npm run media:setup before packaging.`)
    process.exitCode = 1
  }
}
