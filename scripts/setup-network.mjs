import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { verifyNetworkSources } from './network-sources.mjs'

const root = fileURLToPath(new URL('../resources/network/', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
const hash = data => createHash('sha256').update(data).digest('hex')
for (const asset of manifest.artifacts) {
  const path = resolve(root, asset.file)
  if (!path.startsWith(resolve(root) + sep) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.url.startsWith('https://')) throw new Error(`无效的组件来源：${asset.file}`)
  try { if (hash(await readFile(path)) === asset.sha256) continue } catch { /* A missing source must be prepared explicitly. */ }
  if (process.argv.includes('--verify')) throw new Error(`缺少或损坏的代理组件：${asset.file}；运行 npm run network:setup`)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.download`
  try {
    if (process.platform === 'win32') {
      // Use the system-configured HTTPS proxy for official build downloads only.
      await new Promise((accept, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./download-license-source.ps1', import.meta.url)), '-Url', asset.url, '-OutputPath', temporary], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
        let error = ''; child.stderr.on('data', chunk => { error += chunk.toString() }); child.once('error', reject)
        child.once('close', code => code === 0 ? accept() : reject(new Error(`下载 ${asset.file} 失败：${error.slice(0, 1000)}`)))
      })
    } else {
      const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'model-roundtable-build' } })
      if (!response.ok) throw new Error(`下载 ${asset.file} 失败：HTTP ${response.status}`)
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()))
    }
    if (hash(await readFile(temporary)) !== asset.sha256) throw new Error(`官方资源校验不符：${asset.file}，未启用`)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
if (!(await readFile(join(root, 'LICENSE'), 'utf8')).includes('GNU GENERAL PUBLIC LICENSE')) throw new Error('缺少内核许可证')
const verified = await verifyNetworkSources(root, manifest)
console.log(`Mihomo ${manifest.version}：内核、${verified.modules} 个 Go 源码包、${verified.dependencies} 个二进制依赖及 ${verified.materials} 份构建/许可材料校验完成`)
