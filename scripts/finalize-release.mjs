import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactNames } from './release-files.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const extension = JSON.parse(await readFile(join(root, 'vscode-extension', 'package.json'), 'utf8'))
if (extension.version !== version) throw new Error('应用与伴随扩展版本不一致，不能归档')
const companion = `model-roundtable-companion-${version}.vsix`
const staging = join(root, 'release', '.staging', version)
const destination = join(root, 'release', version)
const validation = JSON.parse(await readFile(join(staging, 'validation.json'), 'utf8'))
if (validation.version !== version || validation.accepted !== true) throw new Error('本版本尚未完成验收，不能更新 latest.json')
const required = [...artifactNames(version), 'SHA256SUMS.txt']
for (const name of required) if (!(await stat(join(staging, name))).isFile()) throw new Error(`缺少交付文件 ${name}`)
const lines = (await readFile(join(staging, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')
const verified = new Set()
for (const line of lines) {
  const match = /^([a-f0-9]{64})  ([\w.-]+)$/.exec(line)
  if (!match) throw new Error('校验清单格式无效')
  if (verified.has(match[2]) || !(required.includes(match[2]) || match[2] === `Model-Roundtable-${version}-win-x64.exe.blockmap`)) throw new Error('校验清单包含重复或非当前交付文件')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(staging, match[2]))) hash.update(chunk)
  if (hash.digest('hex') !== match[1]) throw new Error(`交付文件已变化：${match[2]}`)
  verified.add(match[2])
}
for (const name of required.filter(name => name !== 'SHA256SUMS.txt')) if (!verified.has(name)) throw new Error(`交付文件没有校验值：${name}`)
const artifacts = (await readdir(staging)).filter(name => required.includes(name) || name.endsWith('.blockmap'))
for (const name of artifacts.filter(name => name !== 'SHA256SUMS.txt')) if (!verified.has(name)) throw new Error(`交付文件没有校验值：${name}`)
await mkdir(destination) // Existing releases are immutable; never overwrite them.
for (const name of artifacts) await copyFile(join(staging, name), join(destination, name), constants.COPYFILE_EXCL)
const latest = { version, acceptedAt: new Date().toISOString(), installer: `${version}/${required[0]}`, source: `${version}/${required[1]}`, companion: `${version}/${companion}`, mediaKit: `${version}/model-roundtable-${version}-media-kit.zip`, notes: `${version}/RELEASE_NOTES.md`, checksums: `${version}/SHA256SUMS.txt`, validation: `${version}/validation.json` }
const temporary = join(root, 'release', 'latest.json.tmp')
await writeFile(temporary, JSON.stringify(latest, null, 2) + '\n')
await rename(temporary, join(root, 'release', 'latest.json'))
console.log(`已归档 ${version} 并更新唯一最新入口。`)
