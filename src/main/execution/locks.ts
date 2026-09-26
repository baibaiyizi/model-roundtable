import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

export async function canonicalDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('项目目录必须是绝对路径。')
  const path = await realpath(directory)
  if (!(await stat(path)).isDirectory()) throw new Error('项目目录不存在。')
  return resolve(path)
}
function key(path: string): string { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value }
function contains(parent: string, child: string): boolean { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }
export class DirectoryLocks {
  private held = new Map<string, { directory: string; owner: string }>()
  async acquire(directory: string, owner: string): Promise<() => void> {
    const canonical = await canonicalDirectory(directory)
    const target = key(canonical)
    for (const value of this.held.values()) {
      if (contains(value.directory, target) || contains(target, value.directory)) throw new Error('该目录或其父子目录已有执行任务，请等待它结束。')
    }
    const lease = `${owner}:${crypto.randomUUID()}`
    this.held.set(lease, { directory: target, owner })
    return () => { this.held.delete(lease) }
  }
}
