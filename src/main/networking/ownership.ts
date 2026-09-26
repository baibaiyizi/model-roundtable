import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'

const execute = promisify(execFile)
interface Owner { pid: number; executable: string; directory: string; created: string }
async function powershell(script: string): Promise<string> {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}
function payload(owner: Partial<Owner>): string { return Buffer.from(JSON.stringify(owner), 'utf8').toString('base64') }

/** The executable identity and process creation time protect against Windows PID reuse. */
export async function registerCoreOwnership(directory: string, executable: string, childPid: number): Promise<void> {
  if (process.platform !== 'win32') return
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error('无法确认内核进程身份')
  const created = await powershell(`$ErrorActionPreference='Stop'; $coreProcess=Get-CimInstance Win32_Process -Filter 'ProcessId = ${childPid}'; if ($coreProcess) { $coreProcess.CreationDate.ToUniversalTime().ToString('o') }`)
  if (!created) throw new Error('网络内核在注册前已退出')
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ pid: childPid, executable: resolve(executable), directory: resolve(directory), created } satisfies Owner), 'utf8')
}

export async function cleanupOrphanedCores(root: string): Promise<void> {
  if (process.platform !== 'win32') return
  const boundary = resolve(root)
  const entries = await readdir(boundary, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = resolve(boundary, entry.name), rel = relative(boundary, directory)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || (await lstat(directory)).isSymbolicLink()) continue
    let owner: Owner
    try { owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as Owner } catch { continue }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.directory !== directory || typeof owner.executable !== 'string' || typeof owner.created !== 'string') continue
    const result = await powershell(`$ErrorActionPreference='Stop'; $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload(owner)}')) | ConvertFrom-Json; $coreProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$expected.pid); if (-not $coreProcess) { 'absent'; exit }; $argument='(?:^|\\s)-d\\s+(?:"'+[regex]::Escape($expected.directory)+'"|'+[regex]::Escape($expected.directory)+')(?=\\s|$)'; if ($coreProcess.ExecutablePath -ieq $expected.executable -and $coreProcess.CreationDate.ToUniversalTime().ToString('o') -eq $expected.created -and $coreProcess.CommandLine -match $argument) { $result=Invoke-CimMethod -InputObject $coreProcess -MethodName Terminate; if ($result.ReturnValue -eq 0) { 'stopped' } }`)
    if (!['absent', 'stopped'].includes(result)) continue
    // Only this validated, immediate child of the private runtime root is removed.
    await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
