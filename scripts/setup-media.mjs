import { readFile, mkdir, readdir, copyFile, writeFile, rename, rm, open, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { finished } from 'node:stream/promises'
import { root, sha256, inputHash, inside, validateImports, verifyMedia } from './verify-media.mjs'
import { publicBuildReport } from './public-build-report.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The media build requires Windows x64')
const exec = promisify(execFile)
const media = join(root, 'resources', 'media')
const manifest = JSON.parse(await readFile(join(media, 'manifest.json'), 'utf8'))
const cache = join(root, '.cache', 'media-minimal')
await mkdir(cache, { recursive: true })
const lockPath = join(cache, 'setup.lock')
try {
  const pid = Number(await readFile(lockPath, 'utf8'))
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') await rm(lockPath) }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error }
let lock
try { lock = await open(lockPath, 'wx') } catch { throw new Error(`Another media setup may be running; wait for it to exit before retrying (${lockPath})`) }
await lock.writeFile(String(process.pid))
let activeChild
let cancelled = false
const cancel = () => {
  cancelled = true
  if (activeChild?.pid) spawn('taskkill.exe', ['/pid', String(activeChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
process.once('SIGINT', cancel)
process.once('SIGTERM', cancel)
const checkCancelled = () => { if (cancelled) throw new Error('Media setup cancelled; rerun npm run media:setup to retry') }
async function run(command, args, options = {}) {
  checkCancelled()
  const log = options.log ? createWriteStream(options.log) : undefined
  const { log: _unused, ...childOptions } = options
  try {
    await new Promise((accept, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...childOptions })
      activeChild = child
      child.stdout.on('data', chunk => log ? log.write(chunk) : process.stdout.write(chunk))
      child.stderr.on('data', chunk => log ? log.write(chunk) : process.stderr.write(chunk))
      child.once('error', reject)
      child.once('close', code => code === 0 ? accept() : reject(new Error(`${command} failed (${code}); ${options.log ?? 'see output above'}`)))
    })
    checkCancelled()
  } finally {
    activeChild = undefined
    if (log) { log.end(); await finished(log) }
  }
}
async function download(item) {
  const candidates = [item.file, ...(await readdir(cache)).filter(name => name.startsWith(`${item.file}.verified-`))]
  for (const name of candidates) {
    const candidate = inside(cache, name)
    try { if (await sha256(candidate) === item.sha256) return candidate } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  // Private files protect other writers. Invalid artifacts and hard-kill leftovers are ignored on retry.
  const id = randomUUID()
  const temporary = inside(cache, `${item.file}.${id}.download`)
  const destination = inside(cache, `${item.file}.verified-${id}`)
  try {
    console.log(`Downloading ${item.file}…`)
    await run('curl.exe', ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--output', temporary, item.url])
    if (await sha256(temporary) !== item.sha256) throw new Error(`Checksum mismatch: ${item.file}`)
    checkCancelled()
    await rename(temporary, destination)
    return destination
  } finally { await rm(temporary, { force: true }) }
}
async function extract(archive, destination) {
  const { stdout } = await exec('tar.exe', ['-tf', archive], { windowsHide: true, maxBuffer: 20_000_000 })
  for (const entry of stdout.split(/\r?\n/).filter(Boolean)) {
    if (isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.split(/[\\/]/).includes('..')) throw new Error(`Unsafe archive entry: ${entry}`)
  }
  await mkdir(destination, { recursive: true })
  await run('tar.exe', ['-xf', archive, '-C', destination])
}
const posix = path => path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
async function verifySignature(source, signature, key) {
  const { stdout } = await exec('where.exe', ['git.exe'], { windowsHide: true })
  const git = stdout.trim().split(/\r?\n/)[0]
  const gpg = resolve(dirname(git), '..', 'usr', 'bin', 'gpg.exe')
  try { await stat(gpg) } catch { throw new Error('Install Git for Windows with its bundled GPG to verify the FFmpeg release signature') }
  const keyring = join(cache, 'verification-keyring')
  await mkdir(keyring, { recursive: true })
  await exec(gpg, ['--homedir', posix(keyring), '--batch', '--import', posix(key)], { windowsHide: true })
  const result = await exec(gpg, ['--homedir', posix(keyring), '--batch', '--status-fd', '1', '--verify', posix(signature), posix(source)], { windowsHide: true })
  const verification = result.stdout + result.stderr
  if (!verification.includes(`[GNUPG:] VALIDSIG ${manifest.signingKey.fingerprint} `)) throw new Error('Unexpected source signing-key fingerprint')
  await writeFile(join(cache, 'source-signature-verification.txt'), verification)
}
async function inspectBinaries(prefix, toolBin) {
  const result = []
  for (const file of manifest.binaries) {
    const path = join(prefix, 'bin', file)
    const { stdout } = await exec(join(toolBin, 'objdump.exe'), ['-p', path], { windowsHide: true, maxBuffer: 15_000_000 })
    result.push({ file, bytes: (await stat(path)).size, sha256: await sha256(path), imports: [...stdout.matchAll(/DLL Name:\s*(\S+)/g)].map(match => match[1]) })
  }
  validateImports(manifest, result)
  return result
}
async function prepare() {
  const inputs = new Map()
  for (const item of [manifest.source, manifest.signature, manifest.signingKey, manifest.toolchain, manifest.runtimeException]) inputs.set(item.file, await download(item))
  const source = inputs.get(manifest.source.file)
  await verifySignature(source, inputs.get(manifest.signature.file), inputs.get(manifest.signingKey.file))
  const toolRoot = join(cache, 'toolchain', 'w64devkit')
  const toolBin = join(toolRoot, 'bin')
  const toolReceipt = join(cache, 'toolchain', '.archive-sha256')
  let toolReady = false
  try {
    toolReady = (await readFile(toolReceipt, 'utf8')) === manifest.toolchain.sha256
    for (const executable of ['gcc.exe', 'sh.exe', 'make.exe', 'objdump.exe']) await stat(join(toolBin, executable))
  } catch { toolReady = false }
  if (!toolReady) {
    await extract(inputs.get(manifest.toolchain.file), join(cache, 'toolchain'))
    await writeFile(toolReceipt, manifest.toolchain.sha256)
  }
  const sourceDir = join(cache, `ffmpeg-${manifest.version}`)
  const prefix = join(cache, 'prefix')
  const configureArgs = [`--prefix=${prefix.replace(/\\/g, '/')}`, ...manifest.configureFlags]
  const receiptFile = join(cache, 'build-receipt.json')
  let receipt
  try {
    receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
    if (receipt.inputsSha256 !== inputHash(manifest) || JSON.stringify(receipt.configureArgs) !== JSON.stringify(configureArgs)) receipt = undefined
    if (receipt) for (const binary of receipt.binaries) if (await sha256(join(prefix, 'bin', binary.file)) !== binary.sha256) { receipt = undefined; break }
  } catch { receipt = undefined }
  if (!receipt) {
    await extract(source, cache)
    const env = { ...process.env, PATH: `${toolBin};${process.env.PATH}` }
    console.log('Configuring FFmpeg without optional external libraries…')
    await run(join(toolBin, 'sh.exe'), ['./configure', ...configureArgs], { cwd: sourceDir, env, log: join(cache, 'configure.log') })
    console.log('Compiling FFmpeg; detailed progress is in .cache/media-minimal/build.log…')
    await run(join(toolBin, 'make.exe'), ['-j10', ...manifest.makeFlags], { cwd: sourceDir, env, log: join(cache, 'build.log') })
    await run(join(toolBin, 'make.exe'), ['install', ...manifest.makeFlags], { cwd: sourceDir, env, log: join(cache, 'install.log') })
  } else console.log('Reusing the verified source-build cache.')
  const binaries = await inspectBinaries(prefix, toolBin)
  await writeFile(receiptFile, JSON.stringify({ inputsSha256: inputHash(manifest), configureArgs, binaries }, null, 2))
  const stage = inside(join(root, 'resources'), `.media-prepared-${randomUUID()}`)
  await mkdir(join(stage, 'bin'), { recursive: true })
  await mkdir(join(stage, 'sources'), { recursive: true })
  try {
    await copyFile(join(media, 'manifest.json'), join(stage, 'manifest.json'))
    for (const binary of binaries) await copyFile(join(prefix, 'bin', binary.file), join(stage, 'bin', binary.file))
    for (const item of [manifest.source, manifest.signature, manifest.signingKey]) await copyFile(inputs.get(item.file), join(stage, 'sources', item.file))
    await copyFile(join(cache, 'source-signature-verification.txt'), join(stage, 'sources', 'source-signature-verification.txt'))
    await copyFile(join(cache, 'configure.log'), join(stage, 'CONFIGURE.txt'))
    await copyFile(join(sourceDir, 'COPYING.LGPLv2.1'), join(stage, 'COPYING.LGPLv2.1'))
    await copyFile(join(sourceDir, 'COPYING.GPLv3'), join(stage, 'COPYING.GPLv3'))
    await copyFile(join(sourceDir, 'LICENSE.md'), join(stage, 'FFMPEG-LICENSE.md'))
    await copyFile(join(toolRoot, 'COPYING.MinGW-w64-runtime.txt'), join(stage, 'COPYING.MinGW-w64-runtime.txt'))
    await copyFile(inputs.get(manifest.runtimeException.file), join(stage, manifest.runtimeException.file))
    for (const name of ['ffmpeg', 'ffprobe']) {
      const result = await exec(join(stage, 'bin', `${name}.exe`), ['-version'], { windowsHide: true })
      await writeFile(join(stage, name === 'ffmpeg' ? 'BUILD.txt' : 'FFPROBE-BUILD.txt'), result.stdout + result.stderr)
    }
    const quote = value => /\s/.test(value) ? JSON.stringify(value) : value
    await writeFile(join(stage, 'BUILD-RECIPE.txt'), `FFmpeg ${manifest.version}: unmodified upstream release, Windows x64.\n\nSource: ${manifest.source.url}\nSHA256: ${manifest.source.sha256}\nSource commit: ${manifest.source.commit}\nSignature fingerprint: ${manifest.signingKey.fingerprint}\n\nBuild toolchain: ${manifest.toolchain.name}\nBinary: ${manifest.toolchain.url}\nSHA256: ${manifest.toolchain.sha256}\nToolchain source: ${manifest.toolchain.sourceUrl}\nToolchain source SHA256: ${manifest.toolchain.sourceSha256}\nToolchain recipe: ${manifest.toolchain.recipe}\n\nExtract the bundled source and the pinned portable toolchain. Prepend the toolchain bin directory to PATH for the build shell only. In ffmpeg-${manifest.version}, execute:\n\nsh ./configure ${configureArgs.map(quote).join(' ')}\nmake -j10 ${manifest.makeFlags.map(quote).join(' ')}\nmake install ${manifest.makeFlags.map(quote).join(' ')}\n\nThe prefix may be another absolute output path. LN_S copies the Windows link aliases without requiring symbolic-link permission; no source patches are applied. The build uses builtin codecs and no optional external libraries. GPL, nonfree, version3 and network support are disabled. Native Windows facilities and compiler runtime code remain in use. The portable compiler is a build prerequisite and is not part of the app distribution.\n\nSee COPYING.LGPLv2.1, FFMPEG-LICENSE.md, COPYING.MinGW-w64-runtime.txt, COPYING.GPLv3 and COPYING.GCC-RUNTIME. Compiler runtime code is covered by its own notices and GCC Runtime Library Exception; the FFmpeg code is LGPL-2.1-or-later.\n`)
    await writeFile(join(stage, 'SOURCE.txt'), `FFmpeg ${manifest.version} — matching source and build materials\n\nThis folder contains two independently replaceable programs and seven shared FFmpeg libraries. The app invokes ffmpeg.exe and ffprobe.exe as separate processes.\n\nThe complete, unmodified release source is bundled as sources/${manifest.source.file}, with its detached signature, signing public key and GPG verification record. Source URL: ${manifest.source.url}\nSource SHA256: ${manifest.source.sha256}\nSource commit: ${manifest.source.commit}\n\nBUILD-RECIPE.txt records the pinned toolchain and actual configure/make commands. CONFIGURE.txt shows no optional external libraries; BUILD-MANIFEST.json records all binary hashes and PE DLL imports. Only Windows system DLLs and the bundled FFmpeg DLLs are imported. BUILD.txt and FFPROBE-BUILD.txt record runtime versions and flags.\n\nFFmpeg license: ${manifest.license}. The source includes all upstream license material. The compiler runtime notices and GCC Runtime Library Exception are included alongside it. No toolchain executables are shipped with the app. Replaceable shared media components may be rebuilt using the included source and recipe.\n`)
    for (const name of ['CONFIGURE.txt', 'BUILD.txt', 'FFPROBE-BUILD.txt', 'BUILD-RECIPE.txt', 'sources/source-signature-verification.txt']) {
      await writeFile(join(stage, name), publicBuildReport(await readFile(join(stage, name), 'utf8'), root))
    }
    const files = {}
    async function inventory(directory, relative = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = relative + entry.name
        if (entry.isDirectory()) await inventory(join(directory, entry.name), `${name}/`)
        else if (name !== 'manifest.json') files[name] = await sha256(join(directory, entry.name))
      }
    }
    await inventory(stage)
    await writeFile(join(stage, 'BUILD-MANIFEST.json'), JSON.stringify({ inputsSha256: inputHash(manifest), binaries, files }, null, 2))
    await verifyMedia(stage)
    checkCancelled()
    // Every replacement target is verified to be a direct descendant of the media directory.
    for (const entry of await readdir(media)) if (entry !== 'manifest.json') await rm(inside(media, entry), { recursive: true, force: true })
    for (const entry of await readdir(stage)) if (entry !== 'manifest.json') await rename(inside(stage, entry), inside(media, entry))
    await verifyMedia(media)
    console.log('Media prepared and verified with matching source, licenses, signature, build recipe and binary hashes.')
  } finally { await rm(inside(join(root, 'resources'), stage), { recursive: true, force: true }) }
}
try { await prepare() } finally {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
  await lock.close()
  await rm(lockPath, { force: true })
}
