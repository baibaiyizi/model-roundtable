import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupOrphanedCores, registerCoreOwnership } from '../src/main/networking/ownership'

test.skipIf(process.platform !== 'win32')('残留内核按完整身份识别，不结束不匹配进程', async () => {
  const root = await mkdtemp(join(tmpdir(), '圆桌网络归属-'))
  const owned = join(root, 'owned'), unrelated = join(root, 'unrelated')
  await mkdir(owned); await mkdir(unrelated)
  const first = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '-d', owned], { windowsHide: true, stdio: 'ignore' })
  const second = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '-d', unrelated], { windowsHide: true, stdio: 'ignore' })
  await Promise.all([once(first, 'spawn'), once(second, 'spawn')])
  try {
    await registerCoreOwnership(owned, process.execPath, first.pid!)
    await registerCoreOwnership(unrelated, process.execPath, second.pid!)
    const path = join(unrelated, 'owner.json'), marker = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...marker, created: 'different process creation time' }))
    const closed = once(first, 'exit')
    await cleanupOrphanedCores(root)
    await closed
    expect(second.exitCode).toBeNull(); expect(second.signalCode).toBeNull()
    expect(await readFile(path, 'utf8')).toContain('different process creation time')
  } finally {
    if (first.exitCode === null && first.signalCode === null) first.kill()
    if (second.exitCode === null && second.signalCode === null) { const closed = once(second, 'exit'); second.kill(); await closed }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
