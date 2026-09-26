import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { killTree } from '../agents/process'

export const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export function networkEnvironment(base: Record<string, string>, overrides: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !/^(https?|all|no)_proxy$/i.test(name))), ...overrides }
}
export function httpUrl(value: string): URL { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('扩展地址必须是无内嵌凭据的 HTTP(S) 地址'); return url }
export async function jsonFetch(fetcher: typeof fetch, url: string | URL, signal?: AbortSignal): Promise<any> {
  const response = await fetcher(httpUrl(String(url)), { signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), credentials: 'omit', headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`扩展目录请求失败：HTTP ${response.status}`)
  if (!response.body) throw new Error('扩展目录返回空响应')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0
  try { while (true) { signal?.throwIfAborted(); const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 12 * 1024 * 1024) throw new Error('扩展目录响应超过 12 MB'); chunks.push(item.value) } }
  finally { await reader.cancel().catch(() => {}) }
  signal?.throwIfAborted(); return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function isolatedEnvironment(profile: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) if (process.env[key]) env[key] = process.env[key]!
  return { ...env, HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: join(profile, 'config'), XDG_DATA_HOME: join(profile, 'data'), XDG_CACHE_HOME: join(profile, 'cache'), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(profile, 'gitconfig'), DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1', SKILLS_NO_TELEMETRY: '1', CI: '1', ...extra }
}
export async function command(executable: string, args: string[], cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''; let overflow = false
  const stop = () => { void killTree(child) }; signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop()
  child.stdout.on('data', data => { output += data; if (output.length > 8 * 1024 * 1024) { overflow = true; stop() } })
  child.stderr.on('data', data => { errors = (errors + data).slice(-8000) })
  try { await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => { if (overflow) reject(new Error('扩展进程输出超过限制')); else if (code !== 0) reject(new Error(`扩展进程失败 (${code})：${errors}`)); else resolve() }) }); signal.throwIfAborted(); return output }
  finally { signal.removeEventListener('abort', stop); if (signal.aborted || overflow) await killTree(child) }
}
export async function bounded(root: string, requested: string): Promise<string> {
  if (isAbsolute(requested) || requested.includes(':')) throw new Error('扩展文件必须使用相对路径')
  const base = await realpath(root); const path = await realpath(join(base, requested)); const rel = relative(base, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('扩展文件路径越界')
  if (!(await lstat(path)).isFile()) throw new Error('扩展资源不是普通文件')
  return path
}
export async function inventory(root: string, signal: AbortSignal): Promise<Record<string, string>> {
  const result: Record<string, string> = {}; let bytes = 0
  const walk = async (dir: string): Promise<void> => { for (const item of await readdir(dir, { withFileTypes: true })) { signal.throwIfAborted(); const path = join(dir, item.name); if (item.isSymbolicLink()) throw new Error('扩展包包含符号链接，未安装'); if (item.isDirectory()) await walk(path); else if (item.isFile()) { const data = await readFile(path); bytes += data.length; if (bytes > 512 * 1024 * 1024 || Object.keys(result).length > 20000) throw new Error('扩展包超过文件数量或大小限制'); result[relative(root, path).replaceAll('\\', '/')] = createHash('sha256').update(data).digest('hex') } else throw new Error('扩展包包含不支持的文件类型') } }
  await walk(root); return result
}
