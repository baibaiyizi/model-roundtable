import { createReadStream } from 'node:fs'
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, relative, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import type { FileChange } from '../../shared/execution'

export interface FileSnapshot { hash: string; size: number; text?: string }
export interface DirectorySnapshot { files: Record<string, FileSnapshot>; warnings: string[] }
const excluded = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__'])
export async function captureDirectory(root: string, signal?: AbortSignal): Promise<DirectorySnapshot> {
  const files: DirectorySnapshot['files'] = {}
  const warnings: string[] = []
  let fileCount = 0
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      const path = join(directory, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) { warnings.push(`未读取链接：${name}`); continue }
      if (entry.isDirectory()) { if (!excluded.has(entry.name)) await walk(path); continue }
      if (!entry.isFile()) continue
      if (fileCount >= 20000) throw new Error('项目超过 20000 个文件，请绑定更具体的工作目录。')
      try {
        const info = await lstat(path)
        if (info.isSymbolicLink()) { warnings.push(`未读取链接：${name}`); continue }
        const hash = createHash('sha256')
        const stream = createReadStream(path, { signal })
        for await (const chunk of stream) hash.update(chunk)
        const item: FileSnapshot = { hash: hash.digest('hex'), size: info.size }
        const sensitive = /^(\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|auth\.json|id_(rsa|ed25519|ecdsa|dsa)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$/i.test(basename(name)) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)
        if (info.size <= 256 * 1024 && !sensitive) {
          const data = await readFile(path)
          if (!data.includes(0)) {
            const decoded = new TextDecoder('utf-8', { fatal: true })
            try { item.text = decoded.decode(data) } catch { /* Binary/non UTF-8 files are reported by hash. */ }
          }
        }
        files[name] = item
        fileCount += 1
      } catch (error) {
        signal?.throwIfAborted()
        warnings.push(`无法读取 ${name}：${error instanceof Error ? error.message : '读取失败'}`)
      }
    }
  }
  await walk(root)
  return { files, warnings }
}
export function compareSnapshots(before: DirectorySnapshot, after: DirectorySnapshot): FileChange[] {
  const changes: FileChange[] = []
  for (const path of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const a = before.files[path], b = after.files[path]
    if (a?.hash === b?.hash) continue
    const binary = (a !== undefined && a.text === undefined) || (b !== undefined && b.text === undefined)
    changes.push({ path, kind: !a ? 'added' : !b ? 'deleted' : 'modified', beforeHash: a?.hash, afterHash: b?.hash, binary, bytes: b?.size,
      ...(!binary ? { diff: createTwoFilesPatch(path, path, a?.text ?? '', b?.text ?? '', '', '', { context: 4 }).slice(0, 100000) } : {}) })
  }
  return changes
}
