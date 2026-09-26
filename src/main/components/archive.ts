import { spawn } from 'node:child_process'
import { isAbsolute, join, resolve, relative, sep } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'

export function bounded(root: string, requested: string): string {
  if (!requested || requested.includes('\0') || requested.includes(':') || isAbsolute(requested) || requested.split(/[\\/]/).includes('..')) throw new Error('组件文件路径无效或超出组件目录')
  const result = resolve(root, requested), rel = relative(root, result)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('组件文件路径超出组件目录')
  return result
}
export function command(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    let output = '', errors = '', failed: Error | undefined
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stop = () => {
      failed = new DOMException('组件准备已取消', 'AbortError')
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else child.kill()
    }
    signal?.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8').on('data', value => { output += value; if (output.length > 32 * 1024 * 1024) { failed = new Error('组件解包清单过大'); child.kill() } })
    child.stderr.setEncoding('utf8').on('data', value => { errors = (errors + value).slice(-6000) })
    child.once('error', error => { failed = error })
    child.once('close', code => { signal?.removeEventListener('abort', stop); if (failed) reject(failed); else if (code !== 0) reject(new Error(`组件解包失败 (${code})：${errors}`)); else resolvePromise(output) })
  })
}
export async function extractArchive(archive: string, destination: string, strip: number, signal?: AbortSignal): Promise<void> {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const names = await command(tar, ['-tf', archive], signal)
  for (const name of names.split(/\r?\n/).filter(Boolean)) {
    if (name.startsWith('/') || name.startsWith('\\') || name.includes(':') || name.split(/[\\/]/).includes('..')) throw new Error('组件压缩包包含越界路径')
  }
  const detail = await command(tar, ['-tvf', archive], signal)
  if (detail.split(/\r?\n/).some(line => /^[lh]/.test(line))) throw new Error('组件压缩包不能包含符号链接或硬链接')
  await command(tar, ['-xf', archive, '-C', destination, ...(strip ? ['--strip-components', String(strip)] : [])], signal)
  await rejectLinks(destination)
}
export async function rejectLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('组件目录不能包含符号链接或联接')
    if (info.isDirectory()) await rejectLinks(path)
  }
}
