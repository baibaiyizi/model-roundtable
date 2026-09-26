// Prepare components in an explicit cache, using the same implementation as the desktop app.
import { build } from 'esbuild'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const cacheDir = resolve(value('--cache') ?? join(root, '.cache', 'components-runtime'))
await mkdir(join(root, '.cache'), { recursive: true })
const output = join(root, '.cache', 'component-manager.mjs')
await build({ entryPoints: [join(root, 'src/main/components/index.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm' })
const { RuntimeManager } = await import(pathToFileURL(output).href)
let previous = ''
const manager = new RuntimeManager({ manifestPath: join(root, 'resources/components/manifest.json'), cacheDir, emit: status => {
  const next = `${status.id}: ${status.phase} ${status.artifact ?? ''}`
  if (next !== previous) { previous = next; console.log(next) }
} })
const selected = value('--component')?.split(',') ?? (args.includes('--all') ? (await manager.list()).map(x => x.id) : [])
if (!selected.length) throw Error('请选择 --component node,python 或 --all；--cache 指定独立缓存目录；--import 接受官方原始包所在目录')
const offline = value('--import')
const paths = []
if (offline) {
  const collect = async (folder, depth = 0) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isFile()) paths.push(path)
      else if (entry.isDirectory() && depth < 1 && ['wheels','agents','documents','runtime'].includes(entry.name)) await collect(path, depth+1)
    }
  }
  await collect(resolve(offline))
}
for (const id of selected) {
  if (offline) await manager.import(id, paths)
  else await manager.prepare(id)
  console.log(JSON.stringify(await manager.resolve(id)))
}
