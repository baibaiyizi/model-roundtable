import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { open } from 'yauzl'
import { createHash } from 'node:crypto'

const execute = promisify(execFile)
const archiveEntries = (path: string) => new Promise<string[]>((resolveEntries, reject) => {
  open(path, { lazyEntries: true }, (error, zip) => {
    if (error || !zip) { reject(error); return }
    const entries: string[] = []
    zip.on('entry', entry => { entries.push(entry.fileName); zip.readEntry() })
    zip.on('error', reject)
    zip.on('end', () => resolveEntries(entries))
    zip.readEntry()
  })
})

it.skipIf(process.platform !== 'win32')('archives companion sources without generated files and requires a verified same-version VSIX for immutable releases', async () => {
  const testRoot = resolve('.test-data')
  await mkdir(testRoot, { recursive: true })
  const root = await mkdtemp(join(testRoot, 'release-artifacts-'))
  const put = async (path: string, text = 'fixture') => {
    const full = join(root, path)
    await mkdir(resolve(full, '..'), { recursive: true }); await writeFile(full, text)
  }
  for (const name of ['source-archive.ps1', 'source-files.mjs', 'release-files.mjs', 'checksums.mjs', 'finalize-release.mjs']) {
    await put(`scripts/${name}`); await copyFile(resolve('scripts', name), join(root, 'scripts', name))
  }
  await put('package.json', JSON.stringify({ name: 'release-fixture', version: '0.6.0' }))
  await put('vscode-extension/package.json', JSON.stringify({ name: 'model-roundtable-companion', version: '0.6.0', description: '把本机 VS Code 的资料送到模型圆桌。' }))
  for (const name of ['README.md', 'src/app.ts', 'docs/editor-guide.md', 'vscode-extension/README.md', 'vscode-extension/.vscodeignore', 'vscode-extension/src/extension.ts', 'vscode-extension/test/host.test.ts', 'vscode-extension/scripts/test-host.cjs', 'resources/documents/worker.py']) await put(name)
  const sourceHash = createHash('sha256').update('fixture').digest('hex')
  await put('resources/media/BUILD-MANIFEST.json', JSON.stringify({ files: { 'sources/ffmpeg-source.tar.xz': sourceHash } }))
  await put('resources/network/manifest.json', JSON.stringify({ artifacts: [{ file: 'sources/mihomo-source.tar.gz', sha256: sourceHash }] }))
  await execute('git', ['init', '-b', 'main'], { cwd: root })
  await execute('git', ['add', '.'], { cwd: root })
  // Corresponding source is deliberately ignored/untracked, but must be included by exact hash.
  await put('resources/media/sources/ffmpeg-source.tar.xz')
  await put('resources/network/sources/mihomo-source.tar.gz')
  const excluded = ['vscode-extension/node_modules/large/index.js', 'vscode-extension/out/src/extension.js', 'vscode-extension/.test-vscode/Code.exe', 'vscode-extension/.test-result.json', 'vscode-extension/model-roundtable-companion-0.6.0.vsix', 'vscode-extension/src/node_modules/nested.js', 'resources/documents/python/python.exe', 'resources/documents/fonts/font.ttf', 'resources/documents/libreoffice/program/soffice.exe', 'resources/agents/bin/agent.exe', 'resources/runtime/bin/large.dll', 'resources/media/bin/ffmpeg.exe']
  for (const name of excluded) await put(name)
  for (const name of ['private-notes.md', '.env.local', 'saved.sqlite', 'docs/untracked-account.json']) await put(name, 'must not ship')
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/source-archive.ps1')], { cwd: root })
  const staging = 'release/.staging/0.6.0'
  const archive = join(root, staging, 'Model-Roundtable-0.6.0-source.zip')
  const entries = await archiveEntries(archive)
  expect(entries).toEqual(expect.arrayContaining(['vscode-extension/src/extension.ts', 'vscode-extension/test/host.test.ts', 'vscode-extension/scripts/test-host.cjs', 'vscode-extension/package.json', 'vscode-extension/.vscodeignore', 'resources/documents/worker.py']))
  for (const name of excluded) expect(entries).not.toContain(name)
  expect(entries).toEqual(expect.arrayContaining(['resources/media/sources/ffmpeg-source.tar.xz', 'resources/network/sources/mihomo-source.tar.gz']))
  for (const name of ['private-notes.md', '.env.local', 'saved.sqlite', 'docs/untracked-account.json']) expect(entries).not.toContain(name)

  const companion = 'model-roundtable-companion-0.6.0.vsix'
  await put(`${staging}/Model-Roundtable-0.6.0-win-x64.exe`)
  await put(`${staging}/RELEASE_NOTES.md`)
  await put(`${staging}/${companion}`, 'verified companion snapshot')
  for (const name of ['model-roundtable-0.6.0-media-kit.zip', 'THIRD_PARTY_NOTICES.md', 'ACKNOWLEDGMENTS.md', 'LICENSE']) await put(`${staging}/${name}`)
  await put(`${staging}/validation.json`, JSON.stringify({ version: '0.6.0', accepted: false }))
  const run = (script: string) => execute(process.execPath, [join(root, 'scripts', script)], { cwd: root })
  await run('checksums.mjs')
  await expect(run('finalize-release.mjs')).rejects.toThrow('尚未完成验收')
  await expect(readFile(join(root, 'release/latest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await put(`${staging}/validation.json`, JSON.stringify({ version: '0.6.0', accepted: true }))
  await run('checksums.mjs')
  const hashes = await readFile(join(root, staging, 'SHA256SUMS.txt'), 'utf8')
  expect(hashes).toContain(`  ${companion}`)
  await put(`${staging}/${companion}`, 'changed after checksum')
  await expect(run('finalize-release.mjs')).rejects.toThrow('交付文件已变化')
  await put(`${staging}/${companion}`, 'verified companion snapshot')
  await put('vscode-extension/package.json', JSON.stringify({ version: '0.7.0' }))
  await expect(run('finalize-release.mjs')).rejects.toThrow('版本不一致')
  await put('vscode-extension/package.json', JSON.stringify({ version: '0.6.0' }))
  await run('finalize-release.mjs')
  expect(await readFile(join(root, 'release/0.6.0', companion), 'utf8')).toBe('verified companion snapshot')
  expect(JSON.parse(await readFile(join(root, 'release/latest.json'), 'utf8')).companion).toBe(`0.6.0/${companion}`)
  await expect(run('finalize-release.mjs')).rejects.toThrow('EEXIST')
  expect(await readFile(join(root, 'release/0.6.0/SHA256SUMS.txt'), 'utf8')).toBe(hashes)
  await execute('git', ['add', '.env.local'], { cwd: root })
  await expect(execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts/source-archive.ps1')], { cwd: root })).rejects.toThrow('Private or generated file')
}, 30000)
