import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeManager } from '../src/main/components'
import type { ComponentManifest } from '../src/main/components'
const cleanup: string[] = [], servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) } for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture(options: { corrupt?: boolean; slow?: boolean; destination?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'roundtable-components-')); cleanup.push(directory)
  const source = join(directory, 'source'); await mkdir(source); await writeFile(join(source, 'tool.txt'), 'official fixture bytes')
  const archive = join(directory, 'fixture.zip')
  execFileSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-caf', archive, '-C', source, 'tool.txt'])
  const bytes = await readFile(archive), hash = createHash('sha256').update(bytes).digest('hex')
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'content-length': bytes.length }); if (options.slow) res.write(bytes.subarray(0, 10)); else res.end(options.corrupt ? Buffer.alloc(bytes.length) : bytes) })
  servers.push(server); await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture.zip`
  const manifest: ComponentManifest = { schema: 1, platform: 'win32-x64', components: [{ id: 'python', name: '测试组件', version: '1.0.0', executable: 'tool.txt', licenses: [], artifacts: [{ filename: 'fixture.zip', url, sha256: hash, format: 'zip', destination: options.destination ?? '.' }] }] }
  const manifestPath = join(directory, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest))
  const manager = new RuntimeManager({ manifestPath, cacheDir: join(directory, 'components') })
  return { manager, archive, directory, manifestPath, requests: () => requests }
}
describe('按需组件原子安装', () => {
  test('缺组件明确报错，HTTP 下载校验后启用；并发准备只有一次请求', async () => {
    const { manager, requests } = await fixture()
    await expect(manager.resolve('python')).rejects.toThrow('[component:python]')
    const result = await Promise.all([manager.prepare('python'), manager.prepare('python')])
    expect(result.map(x => x.phase)).toEqual(['ready', 'ready']); expect(requests()).toBe(1)
    expect(await readFile((await manager.resolve('python')).executable, 'utf8')).toBe('official fixture bytes')
    const release = manager.acquire('python'); await expect(manager.remove('python')).rejects.toThrow('正在使用'); release()
    await manager.remove('python'); await expect(manager.resolve('python')).rejects.toThrow('[component:python]')
  })
  test('官方原始包离线导入不发网络请求；失败哈希不启用', async () => {
    const { manager, archive, requests } = await fixture()
    await manager.import('python', [archive]); expect(requests()).toBe(0)
    const bad = await fixture({ corrupt: true })
    await expect(bad.manager.prepare('python')).rejects.toThrow('校验失败')
    await expect(bad.manager.resolve('python')).rejects.toThrow('[component:python]')
    expect((await readdir(join(bad.directory, 'components', 'python'))).some(x => x.startsWith('.staging'))).toBe(false)
  })
  test('响应开始后取消下载仍中止，不发布半成品', async () => {
    const { manager, manifestPath, directory } = await fixture({ slow: true })
    const pending = manager.prepare('python'); const rejected = expect(pending).rejects.toThrow()
    await new Promise(done => setTimeout(done, 100)); manager.cancel('python'); await rejected
    expect((await manager.list())[0].phase).toBe('cancelled')
    const restarted = new RuntimeManager({ manifestPath, cacheDir: join(directory, 'components') })
    expect((await restarted.list())[0].phase).toBe('cancelled')
    await expect(manager.resolve('python')).rejects.toThrow('[component:python]')
  })
  test('拒绝越界清单；原生模块加载后不能卸载', async () => {
    const invalid = await fixture({ destination: '../outside' })
    await expect(invalid.manager.prepare('python')).rejects.toThrow('超出')
    const valid = await fixture(); await valid.manager.import('python', [valid.archive]); valid.manager.markLoaded('python')
    await expect(valid.manager.remove('python')).rejects.toThrow('重启')
  })
})
