import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import { parse as yaml } from 'yaml'
import type { CatalogEntry, ExtensionInputField, ExtensionInstallInput, ExtensionTool } from '../../shared/extensions'
import type { ComponentId, ResolvedComponent } from '../../shared/components'
import type { ExtensionOptions } from './ports'
import type { NetworkScopeLease } from '../../shared/network'
import { bounded, command, httpUrl, inventory, isolatedEnvironment, jsonFetch, networkEnvironment } from './util'

export interface Revision { id: string; extensionId: string; entry: CatalogEntry; directory: string; values: Record<string, string>; secretKeys: string[]; tools: ExtensionTool[]; runtimeIds?: ComponentId[]; selection?: { packageIndex?: number; remoteIndex?: number }; command?: { executable: string; args: string[]; env: Record<string, string>; cwd: string }; remote?: { url: string; headers: ExtensionInputField[] }; environmentVariables?: ExtensionInputField[]; files?: Record<string, string>; skillRoot?: string; skillDescription?: string }
export function fieldValue(field: ExtensionInputField, values: Record<string, string>): string | undefined {
  const key = field.name ?? field.valueHint ?? ''; let value = field.value ?? values[key] ?? field.default
  if (value !== undefined) value = value.replace(/\{([^{}]+)\}/g, (_match, name: string) => { const variable = field.variables?.[name]; const supplied = values[name] ?? variable?.default; if (supplied === undefined) throw new Error(`缺少扩展配置：${name}`); if (variable?.choices && !variable.choices.includes(supplied)) throw new Error(`扩展配置选项无效：${name}`); return supplied })
  if ((value === undefined || value === '') && field.isRequired) throw new Error(`缺少扩展配置：${key || field.description}`)
  if (value !== undefined && field.choices && !field.choices.includes(value)) throw new Error(`扩展配置选项无效：${key}`)
  return value
}
function argumentsFor(fields: ExtensionInputField[] | undefined, values: Record<string, string>): string[] {
  return (fields ?? []).flatMap(field => { const value = fieldValue(field, values); if (value === undefined) return []; if (field.type === 'named' && field.name && field.format === 'boolean') { if (!['true', 'false'].includes(value)) throw new Error(`参数 ${field.name} 需要 true 或 false`); return value === 'true' ? [field.name] : [] } return field.type === 'named' && field.name ? [field.name, value] : [value] })
}
export async function unzip(path: string, directory: string, signal: AbortSignal): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) => yauzl.open(path, { lazyEntries: true }, (error, result) => error ? reject(error) : resolvePromise(result!)))
  let bytes = 0, entries = 0
  try { await new Promise<void>((done, fail) => { zip.on('error', fail); zip.on('end', done); zip.on('entry', (entry: yauzl.Entry) => { void (async () => { signal.throwIfAborted(); bytes += entry.uncompressedSize; entries++; if (entries > 20000 || bytes > 512 * 1024 * 1024) throw new Error('MCPB 包超过大小限制'); const path = resolve(directory, entry.fileName); const rel = relative(directory, path); if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || entry.fileName.includes(':') || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('MCPB 包含越界路径或符号链接'); if (entry.fileName.endsWith('/')) await mkdir(path, { recursive: true }); else { await mkdir(dirname(path), { recursive: true }); const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value!))); await pipeline(stream, createWriteStream(path, { flags: 'wx' }), { signal }) } zip.readEntry() })().catch(fail) }); zip.readEntry() }) }
  finally { zip.close() }
}
export class ExtensionInstaller {
  constructor(private options: ExtensionOptions) {}
  async configure(revision: Revision, input: ExtensionInstallInput): Promise<void> {
    const supplied = { ...input.values, ...input.secrets }; revision.values = { ...input.values }; revision.secretKeys = Object.keys(input.secrets ?? {})
    const remote = revision.entry.remotes?.[revision.selection?.remoteIndex ?? 0]
    if (revision.remote && remote) { const url = fieldValue({ value: remote.url, variables: remote.variables }, supplied)!; httpUrl(url); revision.remote.url = url; for (const field of remote.headers ?? []) fieldValue(field, supplied); return }
    const pkg = revision.entry.packages?.[revision.selection?.packageIndex ?? 0]
    if (!pkg || !revision.command) return
    const args = argumentsFor(pkg.packageArguments, supplied)
    for (const field of pkg.environmentVariables ?? []) fieldValue(field, supplied)
    if (pkg.registryType === 'npm') revision.command.args = [revision.command.args[0], ...args]
    else if (pkg.registryType === 'pypi') revision.command.args = [...revision.command.args.slice(0, 7), ...args]
    else if (pkg.registryType === 'mcpb') { const bundle = join(revision.directory, 'bundle'); const manifest = JSON.parse(await readFile(await bounded(bundle, 'manifest.json'), 'utf8')); const config = { ...manifest.server.mcp_config, ...(manifest.server.mcp_config.platforms?.win32 ?? {}) }; const values: Record<string, string> = { '${__dirname}': bundle }; for (const [name, field] of Object.entries(manifest.user_config ?? {}) as Array<[string, any]>) { const value = supplied[name] ?? field.default; if (value === undefined && field.required) throw new Error(`缺少 MCPB 配置：${name}`); if (value !== undefined) values['${user_config.' + name + '}'] = String(value) } const expand = (value: string) => { for (const [key, replacement] of Object.entries(values)) value = value.replaceAll(key, replacement); if (/\$\{[^}]+\}/.test(value)) throw new Error('MCPB 包含未支持的变量'); return value }; revision.command.args = (config.args ?? []).map(expand); for (const [key, value] of Object.entries(config.env ?? {})) revision.command.env[key] = expand(String(value)) }
  }
  async install(entry: CatalogEntry, input: ExtensionInstallInput, revision: Revision, signal: AbortSignal, progress: (text: string) => void): Promise<void> {
    const network = await this.options.network?.acquireForScope('downloads', signal)
    const releases: Array<() => void> = []; const prepare = async (id: ComponentId): Promise<ResolvedComponent> => { const runtime = await this.options.runtime.ensure(id, signal); signal.throwIfAborted(); const release = this.options.runtime.acquire?.(id); if (release) releases.push(release); return runtime }
    try { await this.installPackage(entry, input, revision, signal, progress, prepare, network) } finally { for (const release of releases) release(); network?.release() }
  }
  private async installPackage(entry: CatalogEntry, input: ExtensionInstallInput, revision: Revision, signal: AbortSignal, progress: (text: string) => void, prepare: (id: ComponentId) => Promise<ResolvedComponent>, network?: NetworkScopeLease): Promise<void> {
    const fetcher = network?.fetch ?? this.options.fetch ?? fetch
    const environment = async (base: Record<string, string>) => network ? networkEnvironment(base, await network.environment()) : base
    const directory = revision.directory; const profile = join(directory, '.profile'); await mkdir(profile, { recursive: true })
    const supplied = { ...input.values, ...input.secrets }; revision.values = { ...input.values }; revision.secretKeys = Object.keys(input.secrets ?? {})
    if (entry.kind === 'skill') {
      progress('准备固定版本 Skill 工具与 Git')
      const node = await prepare('node'), git = await prepare('git'), skills = await prepare('skills')
      if (skills.version !== '1.7.0') throw new Error('Skill 工具版本必须为 1.7.0')
      if (!entry.source || !/^[\w.-]+\/[\w.-]+$/.test(entry.source) || !entry.commit || !/^[a-f0-9]{40}$/.test(entry.commit)) throw new Error('Skill 必须来自已核对的公开固定提交')
      const env = await environment(isolatedEnvironment(profile, { ...node.environment, ...git.environment })); env.PATH = [dirname(git.executable), dirname(node.executable), env.PATH ?? env.Path ?? ''].join(';')
      progress('使用官方 Skill 工具安装固定提交')
      const result = JSON.parse(await command(node.executable, [skills.executable, 'add', `https://github.com/${entry.source}/tree/${entry.commit}`, '--skill', entry.skillName ?? entry.name, '--agent', 'universal', '--copy', '--yes', '--json'], directory, env, signal))
      if (!Array.isArray(result) || !result.length || result.some((item: any) => item.status === 'failed')) throw new Error('Skill 工具没有确认安装成功')
      const root = join(directory, '.agents', 'skills'); const children = await readdir(root, { withFileTypes: true }); const candidates: string[] = []
      for (const child of children) if (child.isDirectory() && !child.isSymbolicLink()) candidates.push(join(root, child.name))
      if (candidates.length !== 1) throw new Error('一次只允许安装一个明确选择的 Skill')
      revision.skillRoot = candidates[0]; const content = await readFile(await bounded(revision.skillRoot, 'SKILL.md'), 'utf8'); const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/); if (!match) throw new Error('Skill 缺少 YAML 元数据')
      const metadata = yaml(match[1]); if (!metadata || typeof metadata.description !== 'string') throw new Error('Skill 缺少描述'); revision.skillDescription = metadata.description
      revision.files = await inventory(revision.skillRoot, signal); return
    }
    if (input.remoteIndex !== undefined || (!entry.packages?.length && entry.remotes?.length)) {
      const remote = entry.remotes?.[input.remoteIndex ?? 0]; if (!remote || remote.type !== 'streamable-http' || !remote.url) throw new Error('仅支持 Streamable HTTP 远程 MCP')
      const url = fieldValue({ value: remote.url, variables: remote.variables }, supplied)!; httpUrl(url)
      revision.remote = { url, headers: remote.headers ?? [] }; return
    }
    const pkg = entry.packages?.[input.packageIndex ?? 0]; if (!pkg) throw new Error('此扩展没有可安装的包或远程地址')
    if (pkg.transport?.type !== 'stdio') throw new Error('本地扩展包必须使用 stdio 传输')
    const extraArgs = argumentsFor(pkg.packageArguments, supplied); revision.environmentVariables = pkg.environmentVariables ?? []
    for (const field of revision.environmentVariables) fieldValue(field, supplied)
    for (const arg of argumentsFor(pkg.runtimeArguments, supplied)) if (!['-y', '--yes'].includes(arg)) throw new Error(`此安装方式不支持运行时参数 ${arg}，未执行安装`)
    if (pkg.registryType === 'npm') {
      if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg.identifier) || !pkg.version || /[\s^~*><|]/.test(pkg.version)) throw new Error('npm 包必须指定明确名称与固定版本或公开发布标签')
      if (pkg.registryBaseUrl && new URL(pkg.registryBaseUrl).origin !== 'https://registry.npmjs.org') throw new Error('仅支持官方 npm 包源')
      if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version)) { const metadata = await jsonFetch(fetcher, `https://registry.npmjs.org/${encodeURIComponent(pkg.identifier)}/${encodeURIComponent(pkg.version)}`, signal); if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(metadata.version)) throw new Error('npm 发布标签未解析为固定版本'); pkg.version = metadata.version }
      progress('准备 Node.js 并安装 npm 扩展')
      const node = await prepare('node'); if (!node.npmCli) throw new Error('Node 组件未包含 npm')
      const env = await environment(isolatedEnvironment(profile, node.environment)); env.PATH = `${dirname(node.executable)};${env.PATH ?? env.Path ?? ''}`
      await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, name: 'roundtable-extension', version: '1.0.0' }))
      await command(node.executable, [node.npmCli, 'install', '--prefix', directory, '--registry=https://registry.npmjs.org', '--save-exact', '--omit=dev', '--no-audit', '--no-fund', `${pkg.identifier}@${pkg.version}`], directory, env, signal)
      const packageRoot = join(directory, 'node_modules', pkg.identifier); const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      const binaries = typeof metadata.bin === 'string' ? { [pkg.identifier.split('/').at(-1)!]: metadata.bin } : metadata.bin ?? {}; const selected = supplied.__binary ?? (Object.keys(binaries).length === 1 ? Object.keys(binaries)[0] : pkg.identifier.split('/').at(-1)!)
      if (typeof binaries[selected] !== 'string') throw new Error('扩展有多个或没有执行入口，请通过 __binary 指定入口')
      const script = await bounded(packageRoot, binaries[selected]); revision.runtimeIds = ['node']; revision.command = { executable: node.executable, args: [script, ...extraArgs], cwd: directory, env }; return
    }
    if (pkg.registryType === 'pypi') {
      if (!/^[\w.-]+$/.test(pkg.identifier) || !pkg.version || !/^[\w.!+-]+$/.test(pkg.version)) throw new Error('Python 包必须指定固定版本')
      if (pkg.registryBaseUrl && new URL(pkg.registryBaseUrl).origin !== 'https://pypi.org') throw new Error('仅支持官方 PyPI 包源')
      progress('准备 Python、uv 与扩展独立环境')
      const python = await prepare('python'), uv = await prepare('uv'); const env = await environment(isolatedEnvironment(profile, { ...python.environment, ...uv.environment })); const venv = join(directory, 'venv')
      await command(uv.executable, ['venv', '--python', python.executable, venv], directory, env, signal)
      const executable = join(venv, 'Scripts', 'python.exe')
      await command(uv.executable, ['pip', 'install', '--python', executable, '--index-url', 'https://pypi.org/simple', `${pkg.identifier}==${pkg.version}`], directory, env, signal)
      const entries: string[] = JSON.parse(await command(executable, ['-I', '-X', 'utf8', '-c', 'import importlib.metadata,json,sys; print(json.dumps([e.name for e in importlib.metadata.distribution(sys.argv[1]).entry_points if e.group=="console_scripts"]))', pkg.identifier], directory, env, signal))
      const entryName = supplied.__binary ?? (entries.length === 1 ? entries[0] : pkg.identifier); if (!entries.includes(entryName)) throw new Error('Python 包有多个入口，请通过 __binary 选择')
      revision.runtimeIds = ['python']; revision.command = { executable, args: ['-I', '-X', 'utf8', '-c', 'import importlib.metadata,sys; pkg,name=sys.argv[1:3]; sys.argv=[name]+sys.argv[3:]; next(e for e in importlib.metadata.distribution(pkg).entry_points if e.group=="console_scripts" and e.name==name).load()()', pkg.identifier, entryName, ...extraArgs], cwd: directory, env }; return
    }
    if (pkg.registryType === 'mcpb') {
      if (!pkg.fileSha256 || !/^[a-f0-9]{64}$/.test(pkg.fileSha256)) throw new Error('MCPB 缺少 SHA-256')
      const url = httpUrl(pkg.identifier); if (!['github.com', 'gitlab.com'].includes(url.hostname)) throw new Error('MCPB 必须来自公开 GitHub/GitLab Release')
      progress('下载并校验 MCPB 扩展')
      const response = await fetcher(url, { signal, credentials: 'omit' }); if (!response.ok || !response.body) throw new Error(`MCPB 下载失败：HTTP ${response.status}`)
      const hash = createHash('sha256'); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
      try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256 * 1024 * 1024) throw new Error('MCPB 下载超过 256 MB'); hash.update(part.value); chunks.push(part.value) } } finally { await reader.cancel().catch(() => {}) }
      if (hash.digest('hex') !== pkg.fileSha256) throw new Error('MCPB 校验失败')
      const archive = join(directory, 'bundle.mcpb'); await writeFile(archive, Buffer.concat(chunks)); const bundle = join(directory, 'bundle'); await mkdir(bundle); await unzip(archive, bundle, signal)
      const manifest = JSON.parse(await readFile(await bounded(bundle, 'manifest.json'), 'utf8')); const server = manifest.server
      for (const [name, field] of Object.entries(manifest.user_config ?? {}) as Array<[string, any]>) if (field.sensitive && input.values?.[name] !== undefined) { input.secrets ??= {}; input.secrets[name] = input.values[name]; delete input.values[name] }
      if (!server?.mcp_config?.command || (manifest.compatibility?.platforms && !manifest.compatibility.platforms.includes('win32'))) throw new Error('MCPB 不支持 Windows 或缺少服务配置')
      const config = { ...server.mcp_config, ...(server.mcp_config.platforms?.win32 ?? {}) }; const replacements: Record<string, string> = { '${__dirname}': bundle }
      for (const [name, field] of Object.entries(manifest.user_config ?? {}) as Array<[string, any]>) { const value = supplied[name] ?? field.default; if (value === undefined && field.required) throw new Error(`缺少 MCPB 配置：${name}`); if (value !== undefined) replacements['${user_config.' + name + '}'] = String(value) }
      const expand = (value: string) => { for (const [key, replacement] of Object.entries(replacements)) value = value.replaceAll(key, replacement); if (/\$\{[^}]+\}/.test(value)) throw new Error('MCPB 包含未支持的变量'); return value }
      let executable = expand(config.command); let env = isolatedEnvironment(profile)
      if (server.type === 'node') { const node = await prepare('node'); executable = node.executable; env = isolatedEnvironment(profile, node.environment); revision.runtimeIds = ['node'] }
      else if (server.type === 'python') { throw new Error('Python MCPB 依赖未标准化，请选择该扩展的 PyPI 安装方式') }
      else { const rel = relative(bundle, executable); executable = await bounded(bundle, rel) }
      revision.command = { executable, args: (config.args ?? []).map(expand), cwd: bundle, env: { ...env, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(String(value))])) } }; return
    }
    throw new Error(`此平台尚不支持 ${pkg.registryType} 包；需要作者提供 npm、PyPI、Windows MCPB 或远程 HTTP 版本`)
  }
}
