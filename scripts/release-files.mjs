import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const artifactNames = version => [
  `Model-Roundtable-${version}-win-x64.exe`, `Model-Roundtable-${version}-source.zip`,
  `model-roundtable-companion-${version}.vsix`, `model-roundtable-${version}-media-kit.zip`,
  'RELEASE_NOTES.md', 'validation.json', 'THIRD_PARTY_NOTICES.md', 'ACKNOWLEDGMENTS.md', 'LICENSE'
]
export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
export function checkSourceName(name) {
  if (!name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw new Error(`Unsafe source path: ${name}`)
  if (/(^|\/)(?:\.git|node_modules|out|release|\.cache|\.test-data|test-results|playwright-report|\.test[^/]*)(\/|$)/.test(name)
    || /(^|\/)(?:\.env(?:\..*)?|auth\.json|credentials\.json)$/.test(name) && !name.endsWith('/.env.example') && name !== '.env.example'
    || /\.(?:sqlite(?:-\w+)?|db(?:-\w+)?|log|pem|key|pfx|p12|vsix|mp4|webm|download)$/i.test(name)
    || /^resources\/(?:agents\/bin|runtime\/bin|media\/bin|documents\/(?:python|fonts|libreoffice))\//.test(name)) throw new Error(`Private or generated file in public source list: ${name}`)
}
export async function sourceFiles(root) {
  const { stdout } = await execute('git', ['-C', root, 'ls-files', '-z'], { windowsHide: true, maxBuffer: 20_000_000 })
  const tracked = stdout.split('\0').filter(Boolean)
  if (!tracked.includes('package.json')) throw new Error('A tracked project snapshot is required for source packaging')
  const files = new Set(tracked)
  const media = JSON.parse(await readFile(join(root, 'resources/media/BUILD-MANIFEST.json'), 'utf8'))
  const network = JSON.parse(await readFile(join(root, 'resources/network/manifest.json'), 'utf8'))
  const additions = [
    ...Object.entries(media.files).filter(([name]) => name.startsWith('sources/')).map(([name, hash]) => ({ name: `resources/media/${name}`, sha256: hash })),
    ...network.artifacts.filter(asset => asset.file.startsWith('sources/')).map(asset => ({ name: `resources/network/${asset.file}`, sha256: asset.sha256 }))
  ]
  for (const item of additions) {
    checkSourceName(item.name)
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || await sha256(join(root, item.name)) !== item.sha256) throw new Error(`Corresponding-source checksum mismatch: ${item.name}`)
    files.add(item.name)
  }
  const rootReal = await realpath(root)
  for (const name of files) {
    checkSourceName(name)
    const path = resolve(root, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source entry is not a regular file: ${name}`)
    const resolved = relative(rootReal, await realpath(path))
    if (resolved.startsWith('..') || isAbsolute(resolved)) throw new Error(`Source file escapes project: ${name}`)
  }
  return [...files].sort()
}
