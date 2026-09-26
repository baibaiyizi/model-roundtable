import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactNames } from './release-files.mjs'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const directory = resolve(fileURLToPath(new URL(`../release/.staging/${version}/`, import.meta.url)))
const allowed = [...artifactNames(version), `Model-Roundtable-${version}-win-x64.exe.blockmap`]
const names = (await readdir(directory)).filter(name => allowed.includes(name)).sort()
const lines = []
for (const name of names) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk)
  lines.push(`${hash.digest('hex')}  ${name}`)
}
await writeFile(join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
console.log(`Wrote SHA256 checksums for ${names.length} release artifacts.`)
