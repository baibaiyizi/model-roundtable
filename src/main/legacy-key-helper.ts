import { app, safeStorage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { killTree } from './agents/process'

export const LEGACY_KEY_HELPER_FLAG = '--roundtable-legacy-key-helper'
const PRIVATE_DIRECTORY_PREFIX = 'roundtable-key-'
const REQUEST_TIMEOUT = 15000
type Reply = { type: 'ready' } | { type: 'result'; id: string; value?: string; error?: string }

/** Must run before the normal app's path setup, single-instance lock and ready handlers. */
export function runLegacyKeyHelper(profile: string): void {
  if (!process.send || !profile || !isAbsolute(profile) || !basename(profile).startsWith(PRIVATE_DIRECTORY_PREFIX)) { app.exit(1); return }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.disableHardwareAcceleration()
  process.on('disconnect', () => app.exit())
  app.whenReady().then(() => {
    process.on('message', raw => {
      const request = raw as { type?: unknown; id?: unknown; ciphertext?: unknown }
      if (request.type === 'close') { app.exit(); return }
      if (request.type !== 'decrypt' || typeof request.id !== 'string' || request.id.length > 100 || typeof request.ciphertext !== 'string' || request.ciphertext.length > 100000) return
      let response: Reply
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error()
        const value = safeStorage.decryptString(Buffer.from(request.ciphertext, 'base64'))
        response = { type: 'result', id: request.id, value }
      } catch { response = { type: 'result', id: request.id, error: '旧密钥无法解密，请在原 Windows 用户下恢复并保留旧 Local State。' } }
      if (process.connected) process.send!(response)
    })
    process.send!({ type: 'ready' } satisfies Reply)
  }).catch(() => app.exit(1))
}

export interface LegacyKeyDecryptorOptions {
  sourceProfile: string
  tempRoot: string
  executablePath: string
  /** Application root for development; packaged executables load their own app. */
  appPath?: string
  packaged: boolean
}

/** Isolates the legacy Chromium key in another Electron process; plaintext travels only in private IPC. */
export class LegacyKeyDecryptor {
  private child?: ChildProcess
  private directory?: string
  private starting?: Promise<void>
  private closing?: Promise<void>
  private closed = false
  private pending = new Map<string, { resolve(value: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private options: LegacyKeyDecryptorOptions) {}
  private failPending(message: string): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
  }
  private start(): Promise<void> {
    if (!this.starting) this.starting = this.initialize().catch(async () => { if (this.child) await killTree(this.child); await this.cleanup(); throw new Error('无法打开旧配置的密钥保护状态，请保留旧 Local State 并在原 Windows 用户下重试。') })
    return this.starting
  }
  private async initialize(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('旧配置恢复只支持 Windows。')
    const source = join(resolve(this.options.sourceProfile), 'Local State')
    if ((await stat(source)).size > 4 * 1024 * 1024) throw new Error('旧 Local State 大小异常。')
    const root = resolve(this.options.tempRoot)
    await mkdir(root, { recursive: true })
    this.directory = await mkdtemp(join(root, PRIVATE_DIRECTORY_PREFIX))
    await copyFile(source, join(this.directory, 'Local State'))
    if (this.closed) throw new Error('恢复已关闭。')
    if (!this.options.packaged && !this.options.appPath) throw new Error('缺少开发应用入口。')
    const args = [...(this.options.packaged ? [] : [this.options.appPath!]), LEGACY_KEY_HELPER_FLAG, this.directory]
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_INSPECT_RESUME_ON_START
    const child = spawn(this.options.executablePath, args, { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    this.child = child
    await new Promise<void>((done, fail) => {
      let ready = false
      const timer = setTimeout(() => fail(new Error('旧密钥进程启动超时。')), REQUEST_TIMEOUT)
      child.on('message', raw => {
        const message = raw as Partial<Reply> & { id?: string; value?: string; error?: string }
        if (message.type === 'ready') { ready = true; clearTimeout(timer); done(); return }
        if (message.type !== 'result' || typeof message.id !== 'string') return
        const request = this.pending.get(message.id); if (!request) return
        this.pending.delete(message.id); clearTimeout(request.timer)
        if (typeof message.value === 'string' && message.value.length <= 100000) request.resolve(message.value)
        else request.reject(new Error('旧密钥无法解密，请在原 Windows 用户下恢复并保留旧 Local State。'))
      })
      child.once('error', () => { clearTimeout(timer); if (!ready) fail(new Error('旧密钥进程无法启动。')); this.failPending('旧密钥恢复进程已退出。') })
      child.once('close', () => { clearTimeout(timer); if (!ready) fail(new Error('旧密钥进程提前退出。')); this.failPending('旧密钥恢复进程已退出。') })
    })
  }
  async decrypt(value: Uint8Array): Promise<string> {
    if (this.closed) throw new Error('旧配置恢复已关闭。')
    if (!value.length || value.length > 64000) throw new Error('旧密钥密文大小无效。')
    await this.start()
    if (this.closed || !this.child?.connected) throw new Error('旧密钥恢复进程不可用。')
    const id = randomUUID()
    return new Promise<string>((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error('旧密钥解密超时。')); void this.close() }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve: done, reject: fail, timer })
      this.child!.send({ type: 'decrypt', id, ciphertext: Buffer.from(value).toString('base64') }, error => {
        if (!error) return
        const pending = this.pending.get(id); if (!pending) return
        this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error('旧密钥恢复通道已关闭。'))
      })
    })
  }
  private async cleanup(): Promise<void> {
    const directory = this.directory
    if (!directory) return
    if (dirname(directory) !== resolve(this.options.tempRoot) || !basename(directory).startsWith(PRIVATE_DIRECTORY_PREFIX)) throw new Error('临时恢复目录不在预期范围，未删除。')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    this.directory = undefined
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.failPending('旧配置恢复已关闭。')
    this.closing = (async () => {
      if (this.child) {
        const child = this.child
        if (child.connected) child.send({ type: 'close' }, () => {})
        await killTree(child)
      }
      await this.starting?.catch(() => {})
      if (this.child) await killTree(this.child)
      await this.cleanup()
    })()
    return this.closing
  }
}
