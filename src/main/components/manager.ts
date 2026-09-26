import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ComponentId, ComponentRuntimePort, ComponentStatus, ResolvedComponent } from '../../shared/components'
import { bounded, command, extractArchive, rejectLinks } from './archive'
import type { ComponentArtifact, ComponentDefinition, ComponentManifest } from './manifest'

interface Options { manifestPath: string; cacheDir: string; fetch?: typeof fetch; emit?: (status: ComponentStatus) => void }
interface Installed { version: string; fingerprint: string; directory: string; files: Record<string, string>; downloadBytes: number; installedBytes: number }
export class MissingComponentError extends Error {
  constructor(readonly componentId: ComponentId, name: string) { super(`[component:${componentId}] 请先在组件中心准备“${name}”组件`); this.name = 'MissingComponentError' }
}
async function digest(path: string, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(encoding)
}
async function verify(path: string, asset: ComponentArtifact): Promise<void> {
  if (asset.sha256 && await digest(path) === asset.sha256) return
  if (asset.integrity) {
    const [algorithm, expected] = asset.integrity.split('-', 2)
    if (['sha256', 'sha512'].includes(algorithm) && await digest(path, algorithm, 'base64') === expected) return
  }
  throw new Error(`组件校验失败：${asset.filename}，未启用下载内容`)
}
export class RuntimeManager implements ComponentRuntimePort {
  private manifest?: Promise<ComponentManifest>
  private operations = new Map<ComponentId, { controller: AbortController; promise: Promise<ComponentStatus> }>()
  private states = new Map<ComponentId, ComponentStatus>()
  private leases = new Map<ComponentId, number>()
  private loaded = new Set<ComponentId>()
  private verifiedEntries = new Map<string, { size: number; modified: number; hash: string }>()
  constructor(private readonly options: Options) {}

  private async definitions(): Promise<ComponentDefinition[]> {
    this.manifest ??= readFile(this.options.manifestPath, 'utf8').then(text => {
      const manifest = JSON.parse(text) as ComponentManifest
      if (manifest.schema !== 1 || manifest.platform !== 'win32-x64' || !Array.isArray(manifest.components)) throw new Error('组件清单格式不受支持')
      for (const item of manifest.components) {
        if (!/^[a-z]+$/.test(item.id) || !/^[\w.-]+$/.test(item.version) || !item.artifacts.length) throw new Error('组件清单无效')
        bounded(this.options.cacheDir, item.executable)
        for (const asset of item.artifacts) {
          if (basename(asset.filename) !== asset.filename || (!asset.sha256 && !asset.integrity)) throw new Error('组件来源缺少固定校验值')
          bounded(this.options.cacheDir, asset.destination)
        }
      }
      return manifest
    })
    return (await this.manifest).components
  }
  private async definition(id: ComponentId): Promise<ComponentDefinition> {
    const item = (await this.definitions()).find(value => value.id === id)
    if (!item) throw new Error(`未知组件：${id}`)
    return item
  }
  private fingerprint(item: ComponentDefinition): string { return createHash('sha256').update(JSON.stringify(item)).digest('hex') }
  private root(id: ComponentId): string { return bounded(resolve(this.options.cacheDir), id) }
  private update(item: ComponentDefinition, phase: ComponentStatus['phase'], detail: Partial<ComponentStatus> = {}): ComponentStatus {
    const status: ComponentStatus = { id: item.id, name: item.name, version: item.version, phase, ...detail }
    this.states.set(item.id, status); this.options.emit?.(status); return status
  }
  private async installed(item: ComponentDefinition): Promise<Installed | undefined> {
    try {
      const value = JSON.parse(await readFile(join(this.root(item.id), 'active.json'), 'utf8')) as Installed
      if (value.fingerprint !== this.fingerprint(item) || value.version !== item.version) return undefined
      const directory = bounded(this.root(item.id), value.directory)
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('组件缓存不能是目录联接')
      const path = bounded(directory, item.executable)
      const info = await stat(path)
      if (!info.isFile() || !value.files[item.executable]) return undefined
      let verified = this.verifiedEntries.get(path)
      if (!verified || verified.size !== info.size || verified.modified !== info.mtimeMs) {
        verified = { size: info.size, modified: info.mtimeMs, hash: await digest(path) }
        this.verifiedEntries.set(path, verified)
      }
      if (verified.hash !== value.files[item.executable]) return undefined
      return value
    } catch (error) { if ((error as Error).message.includes('目录联接')) throw error; return undefined }
  }
  async list(): Promise<ComponentStatus[]> {
    return Promise.all((await this.definitions()).map(async item => {
      const current = this.states.get(item.id)
      if (current && !['ready', 'missing'].includes(current.phase)) return current
      const installed = await this.installed(item)
      if (!installed) {
        try {
          const interrupted = JSON.parse(await readFile(join(this.root(item.id), 'operation.json'), 'utf8')) as { fingerprint: string; phase: string; error?: string }
          if (interrupted.fingerprint === this.fingerprint(item)) return { id: item.id, name: item.name, version: item.version, phase: interrupted.phase === 'cancelled' ? 'cancelled' : 'failed', error: interrupted.error ?? '上次组件准备未完成，请重新准备；不会自动下载或启用半成品' } as ComponentStatus
        } catch { /* No unfinished preparation was recorded. */ }
      }
      return { id: item.id, name: item.name, version: item.version, phase: installed ? 'ready' : 'missing', ...(installed ? { directory: join(this.root(item.id), installed.directory), installedVersion: installed.version, downloadBytes: installed.downloadBytes, installedBytes: installed.installedBytes } : {}) } as ComponentStatus
    }))
  }
  async resolve(id: ComponentId): Promise<ResolvedComponent> {
    const item = await this.definition(id), installed = await this.installed(item)
    if (!installed) throw new MissingComponentError(id, item.name)
    const directory = join(this.root(id), installed.directory)
    return { id, version: installed.version, directory, executable: bounded(directory, item.executable), ...(item.npmCli ? { npmCli: bounded(directory, item.npmCli) } : {}) }
  }
  async ensure(id: ComponentId, signal?: AbortSignal): Promise<ResolvedComponent> {
    try { return await this.resolve(id) } catch (error) { if (!(error instanceof MissingComponentError)) throw error }
    await this.prepare(id, signal)
    return this.resolve(id)
  }
  async verify(id: ComponentId): Promise<void> {
    const item = await this.definition(id), installed = await this.installed(item)
    if (!installed) throw new MissingComponentError(id, item.name)
    const directory = join(this.root(id), installed.directory)
    await rejectLinks(directory)
    for (const [path, expected] of Object.entries(installed.files)) if (await digest(bounded(directory, path)) !== expected) throw new Error(`组件文件校验失败：${id}/${path}`)
  }
  acquire(id: ComponentId): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1)
    let released = false
    return () => { if (!released) { released = true; this.leases.set(id, Math.max(0, (this.leases.get(id) ?? 1) - 1)) } }
  }
  markLoaded(id: ComponentId): void { this.loaded.add(id) }
  async prepare(id: ComponentId, signal?: AbortSignal): Promise<ComponentStatus> { return this.start(id, undefined, signal) }
  async import(id: ComponentId, paths: string[], signal?: AbortSignal): Promise<ComponentStatus> {
    if (!paths.length) throw new Error('请选择该组件的官方原始安装包；复合组件可一次选择多个文件')
    return this.start(id, paths, signal)
  }
  cancel(id: ComponentId): void { this.operations.get(id)?.controller.abort() }
  async shutdown(): Promise<void> {
    for (const operation of this.operations.values()) operation.controller.abort()
    await Promise.allSettled([...this.operations.values()].map(operation => operation.promise))
  }
  async remove(id: ComponentId): Promise<void> {
    const item = await this.definition(id)
    if (this.operations.has(id) || this.leases.get(id)) throw new Error('组件正在使用或准备中，请先结束相关任务')
    if (this.loaded.has(id)) throw new Error('此原生组件已加载，请重启应用后再移除')
    const target = this.root(id)
    if (existsSync(target) && (await lstat(target)).isSymbolicLink()) throw new Error('拒绝删除外部组件目录联接')
    await rm(target, { recursive: true, force: true })
    this.update(item, 'missing')
  }
  private async start(id: ComponentId, paths: string[] | undefined, signal?: AbortSignal): Promise<ComponentStatus> {
    signal?.throwIfAborted()
    const prior = this.operations.get(id)
    if (prior) return prior.promise
    const controller = new AbortController(), abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const promise = (async () => {
      const item = await this.definition(id), installed = await this.installed(item)
      if (installed) {
        try { await this.verify(id); return this.update(item, 'ready', { directory: join(this.root(id), installed.directory), installedVersion: installed.version, downloadBytes: installed.downloadBytes, installedBytes: installed.installedBytes }) } catch { /* Rebuild a damaged immutable tree from pinned sources. */ }
      }
      if (this.loaded.has(id) || this.leases.get(id)) return this.update(item, 'restart-required', { error: '组件已在使用，请结束任务并重启应用后更新' })
      return this.install(item, paths, controller.signal)
    })().finally(() => { signal?.removeEventListener('abort', abort); this.operations.delete(id) })
    this.operations.set(id, { controller, promise })
    return promise
  }
  private async install(item: ComponentDefinition, paths: string[] | undefined, signal: AbortSignal): Promise<ComponentStatus> {
    // The version tree is immutable. Only active.json publishes it, atomically.
    // MSI administrative extraction can retain a directory handle after exit on Windows.
    const root = this.root(item.id), directory = `${item.version}-${this.fingerprint(item).slice(0, 12)}-${randomUUID().slice(0, 8)}`, staging = join(root, directory)
    let published = false
    let downloadBytes = 0, installedBytes = 0
    try {
      await mkdir(staging, { recursive: true })
      await writeFile(join(root, 'operation.json'), JSON.stringify({ fingerprint: this.fingerprint(item), phase: 'installing' }), 'utf8')
      for (const asset of item.artifacts) {
        signal.throwIfAborted()
        const archive = await this.source(item, asset, paths, signal)
        if (!asset.url.startsWith('resource:')) downloadBytes += (await stat(archive)).size
        this.update(item, 'extracting', { artifact: asset.filename })
        await this.extract(asset, archive, staging, signal)
      }
      await this.finishRecipe(item, staging, signal)
      await rejectLinks(staging)
      const files: Record<string, string> = {}
      const inventory = async (directory: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          signal.throwIfAborted()
          const name = `${prefix}${entry.name}`, path = join(directory, entry.name)
          if (entry.isDirectory()) await inventory(path, `${name}/`)
          else { files[name] = await digest(path); installedBytes += (await stat(path)).size }
        }
      }
      this.update(item, 'verifying')
      await inventory(staging)
      if (!files[item.executable] || (item.npmCli && !files[item.npmCli])) throw new Error('官方包缺少组件所需执行文件')
      signal.throwIfAborted()
      const marker: Installed = { version: item.version, fingerprint: this.fingerprint(item), directory, files, downloadBytes, installedBytes }
      const markerPath = join(root, `active-${randomUUID()}.json`)
      await writeFile(markerPath, JSON.stringify(marker), 'utf8')
      signal.throwIfAborted()
      await rename(markerPath, join(root, 'active.json'))
      published = true
      await rm(join(root, 'operation.json'), { force: true }).catch(() => {})
      return this.update(item, 'ready', { directory: join(root, directory), installedVersion: item.version, downloadBytes, installedBytes })
    } catch (error) {
      const phase = signal.aborted ? 'cancelled' : 'failed', message = signal.aborted ? '组件准备已取消；已启用版本不受影响' : error instanceof Error ? error.message : String(error)
      await writeFile(join(root, 'operation.json'), JSON.stringify({ fingerprint: this.fingerprint(item), phase, error: message }), 'utf8').catch(() => {})
      this.update(item, phase, { error: message })
      throw error
    } finally { if (!published) await rm(staging, { recursive: true, force: true }).catch(() => {}) }
  }
  private async source(item: ComponentDefinition, asset: ComponentArtifact, paths: string[] | undefined, signal: AbortSignal): Promise<string> {
    if (asset.url.startsWith('resource:')) {
      const path = bounded(dirname(dirname(this.options.manifestPath)), asset.url.slice(9))
      await verify(path, asset); return path
    }
    const cache = join(this.options.cacheDir, 'downloads'), key = createHash('sha256').update(asset.sha256 ?? asset.integrity!).digest('hex')
    const destination = join(cache, `${key}-${asset.filename}`)
    await mkdir(cache, { recursive: true })
    if (existsSync(destination)) { try { await verify(destination, asset); return destination } catch { await rm(destination, { force: true }) } }
    if (paths) {
      for (const path of paths) {
        try { await verify(path, asset); await copyFile(path, destination); return destination } catch { /* Only exact pinned source bytes are accepted. */ }
      }
      throw new Error(`本地安装包缺少或校验不符：${asset.filename}`)
    }
    const response = await (this.options.fetch ?? fetch)(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]) })
    if (!response.ok || !response.body) throw new Error(`组件下载失败：${asset.filename} HTTP ${response.status}`)
    const partial = `${destination}.${randomUUID()}.download`, file = await open(partial, 'wx')
    let receivedBytes = 0, emitted = 0
    const declared = Number(response.headers.get('content-length')), totalBytes = declared > 0 ? declared : undefined
    const reader = response.body.getReader()
    try {
      while (true) {
        signal.throwIfAborted()
        const next = await reader.read(); if (next.done) break
        receivedBytes += next.value.length
        if (receivedBytes > 2 * 1024 * 1024 * 1024) throw new Error('组件下载超过单文件大小限制')
        await file.writeFile(next.value)
        if (Date.now() - emitted > 150) { emitted = Date.now(); this.update(item, 'downloading', { artifact: asset.filename, receivedBytes, totalBytes }) }
      }
      await file.close()
      this.update(item, 'verifying', { artifact: asset.filename, receivedBytes, totalBytes })
      await verify(partial, asset)
      signal.throwIfAborted()
      await rename(partial, destination)
      return destination
    } finally { reader.releaseLock(); await file.close().catch(() => {}); await rm(partial, { force: true }).catch(() => {}) }
  }
  private async extract(asset: ComponentArtifact, archive: string, staging: string, signal: AbortSignal): Promise<void> {
    const destination = bounded(staging, asset.destination)
    if (asset.format === 'file') { await mkdir(dirname(destination), { recursive: true }); await copyFile(archive, destination); return }
    await mkdir(destination, { recursive: true })
    if (asset.format === 'msi') {
      await command(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'msiexec.exe'), ['/a', archive, '/qn', `TARGETDIR=${destination}`], signal)
      for (const entry of await readdir(destination)) if (entry.toLowerCase().endsWith('.msi')) await rm(join(destination, entry))
      return
    }
    if (asset.format === 'vc-redist') {
      const data = await readFile(archive), offset = 686152, size = 24939223
      if (data.toString('ascii', offset, offset + 4) !== 'MSCF' || data.readUInt32LE(offset + 8) !== size) throw new Error('锁定的 VC Runtime Cabinet 不匹配')
      const work = join(staging, `.vc-${randomUUID()}`)
      await mkdir(work)
      try {
        await writeFile(join(work, 'attached.cab'), data.subarray(offset, offset + size))
        const expand = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'expand.exe')
        await command(expand, ['-F:a12', join(work, 'attached.cab'), work], signal)
        await command(expand, ['-F:vcruntime140.dll_amd64', join(work, 'a12'), work], signal)
        const dll = join(work, 'vcruntime140.dll_amd64')
        if (await digest(dll) !== 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066') throw new Error('VC Runtime DLL 校验失败')
        await copyFile(dll, join(destination, 'vcruntime140.dll'))
      } finally { await rm(work, { recursive: true, force: true }) }
      return
    }
    if (asset.pick) {
      const work = join(staging, `.unpack-${randomUUID()}`)
      await mkdir(work)
      try {
        await extractArchive(archive, work, asset.strip ?? 0, signal)
        const locate = async (directory: string): Promise<string | undefined> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name)
            if (entry.isFile() && entry.name === asset.pick) return path
            if (entry.isDirectory()) { const found = await locate(path); if (found) return found }
          }
        }
        const found = await locate(work)
        if (!found) throw new Error(`官方包缺少 ${asset.pick}`)
        await cp(dirname(found), destination, { recursive: true })
      } finally { await rm(work, { recursive: true, force: true }) }
    } else await extractArchive(archive, destination, asset.strip ?? 0, signal)
  }
  private async finishRecipe(item: ComponentDefinition, staging: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (item.recipe === 'python' || item.recipe === 'documents') {
      const python = item.recipe === 'documents' ? join(staging, 'python') : staging
      await writeFile(join(python, 'python313._pth'), 'python313.zip\n.\nLib/site-packages\n', 'utf8')
    }
    if (item.recipe === 'libreoffice') {
      const system = join(staging, 'System64')
      for (const name of await readdir(system)) if (name.toLowerCase().endsWith('.dll')) await copyFile(join(system, name), join(staging, 'program', name))
    }
  }
}
