import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { open } from 'yauzl'
import { sourceFiles, checkSourceName } from './release-files.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const [app, extension, appLock, extensionLock] = await Promise.all(['package.json', 'vscode-extension/package.json', 'package-lock.json', 'vscode-extension/package-lock.json'].map(async path => JSON.parse(await readFile(resolve(root, path), 'utf8'))))
if (![extension.version, appLock.version, appLock.packages[''].version, extensionLock.version, extensionLock.packages[''].version].every(version => version === app.version)) throw new Error('Application, companion and lockfile versions differ')

function inspect(name, bytes) {
  if (bytes.subarray(0, 4096).includes(0) || /\.(?:png|jpg|jpeg|webp|ico|zip|gz|xz|woff2?|ttf|otf|mp4|webm)$/i.test(name)) return
  const content = bytes.toString('utf8')
  const secret = /\b(?:sk-(?:proj-|ant-api\d\d-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  if (secret.test(content)) throw new Error(`Possible credential in ${name}; inspect locally, do not print its contents`)
  // Real user-profile paths have no place in our reports or shipped UI. Dependency notices remain verbatim.
  if (!/^(?:tests\/|resources\/(?:licenses|native-licenses)\/)/.test(name) && /[A-Za-z]:[\\/]Users[\\/](?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|<|\{|\$)[A-Za-z0-9._-]+[\\/]/i.test(content)) throw new Error(`Personal absolute path in ${name}`)
}
const files = await sourceFiles(root)
for (const name of files) inspect(name, await readFile(resolve(root, name)))

async function inspectZip(path, source) {
  await new Promise((accept, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error)
      zip.on('error', reject)
      zip.on('end', accept)
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
        try { if (source) checkSourceName(entry.fileName) } catch (error) { zip.close(); reject(error); return }
        if (entry.uncompressedSize > 32_000_000 || /\.(?:zip|gz|xz|png|jpg|mp4|webm)$/i.test(entry.fileName)) { zip.readEntry(); return }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { reject(error); return }
          const chunks = []
          stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject)
          stream.on('end', () => { try { inspect(entry.fileName, Buffer.concat(chunks)); zip.readEntry() } catch (error) { zip.close(); reject(error) } })
        })
      })
      zip.readEntry()
    })
  })
}
const archiveIndex = process.argv.indexOf('--archive')
if (archiveIndex !== -1) {
  const archive = process.argv[archiveIndex + 1]
  if (!archive) throw new Error('--archive requires a ZIP/VSIX path')
  await inspectZip(resolve(archive), /-source\.zip$/i.test(archive))
}
const packagedIndex = process.argv.indexOf('--packaged')
if (packagedIndex !== -1) {
  const directory = process.argv[packagedIndex + 1]
  if (!directory) throw new Error('--packaged requires an unpacked or installed application directory')
  const resources = resolve(directory, 'resources')
  const { listPackage, extractFile, statFile } = await import('@electron/asar')
  const asar = join(resources, 'app.asar')
  for (const entry of listPackage(asar)) {
    const archiveName = entry.slice(1)
    const name = entry.replaceAll('\\', '/').replace(/^\//, '')
    if ((name.startsWith('out/') || ['package.json', 'ACKNOWLEDGMENTS.md', 'THIRD_PARTY_NOTICES.md'].includes(name)) && !statFile(asar, archiveName).files) inspect(name, extractFile(asar, archiveName))
  }
  async function inspectResources(directory, prefix = 'resources') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`, path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Unexpected link in packaged resources: ${name}`)
      if (entry.isDirectory()) { await inspectResources(path, name); continue }
      if (/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials\.json)$|\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|key|pfx|p12)$/i.test(name)) throw new Error(`Private data filename in packaged resources: ${name}`)
      if (/\.(?:json|md|txt|js|mjs|cjs|py|html|css|svg|xml|ya?ml)$/i.test(name) || /(?:^|\/)(?:LICENSE|NOTICE|COPYING)[^/]*$/.test(name)) inspect(name, await readFile(path))
    }
  }
  await inspectResources(resources)
}
console.log(`Publication checks passed: version ${app.version}; ${files.length} allowlisted source files; no detected credentials or personal paths${archiveIndex !== -1 ? '; archive inspected' : ''}${packagedIndex !== -1 ? '; packaged application inspected' : ''}.`)
