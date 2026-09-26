import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
const commands = new Set<ChildProcess>()
export async function stopCommands(): Promise<void> { await Promise.allSettled([...commands].map(killTree)) }

export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  const exit = new Promise<void>(resolve => child.once('close', () => resolve()))
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await Promise.race([once(killer, 'close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))])
  } else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000))])
}
export interface CommandOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal
  onLine?(line: string): void; onErrorLine?(line: string): void
}
export async function runCommand(executable: string, args: string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  options.signal?.throwIfAborted()
  const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  commands.add(child); child.once('close', () => commands.delete(child))
  let stdout = '', stderr = '', line = '', errorLine = ''
  let lineFailure: Error | undefined
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (data: string) => {
    stdout = (stdout + data).slice(-4 * 1024 * 1024); line += data
    const lines = line.split(/\r?\n/); line = lines.pop() ?? ''
    for (const value of lines) { try { options.onLine?.(value) } catch (error) { lineFailure = error instanceof Error ? error : new Error('后台事件无效。'); void killTree(child) } }
  })
  child.stderr.on('data', (data: string) => {
    stderr = (stderr + data).slice(-100000); errorLine += data
    const lines = errorLine.split(/\r?\n/); errorLine = lines.pop() ?? ''
    for (const value of lines) options.onErrorLine?.(value)
  })
  const cancel = (): void => { void killTree(child) }
  options.signal?.addEventListener('abort', cancel, { once: true })
  child.stdin.on('error', () => {})
  child.stdin.end(options.input ?? '')
  try {
    const [code] = await once(child, 'close') as [number | null]
    options.signal?.throwIfAborted()
    if (lineFailure) throw lineFailure
    if (line) options.onLine?.(line)
    return { stdout, stderr, code: code ?? -1 }
  } finally { options.signal?.removeEventListener('abort', cancel) }
}
