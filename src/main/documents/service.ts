import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DocumentChange, DocumentFormat, DocumentInspection, DocumentRequest, DocumentResult } from '../../shared/documents'
import { DOCUMENT_SCHEMAS } from './tools'
import type { ComponentRuntimePort } from '../../shared/components'
import type { ExtractedPart } from '../knowledge/protocol'
import { z } from 'zod'

export interface DocumentServiceOptions { runtimeDir: string; stateDir: string; libreOfficePath?: string; timeoutMs?: number; components?: ComponentRuntimePort }
interface WorkerResult { ok: boolean; error?: string; inspection: DocumentInspection; changes: DocumentChange[] }
const FORMATS = new Set(['txt', 'md', 'json', 'csv', 'docx', 'xlsx', 'pptx', 'pdf'])
const abortError = () => new DOMException('文档操作已取消', 'AbortError')
const hashFile = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError() }
const PPTX_EXTRACTION = z.object({ ok: z.literal(true), complete: z.literal(true), slides: z.number().int().positive().max(1000), parts: z.array(z.object({ text: z.string(), locator: z.string().min(1), kind: z.literal('text') }).strict()).max(100000) }).strict()

/** One service shared by UI and all execution backends; no provider-specific document code. */
export class DocumentService {
  private locks = new Set<string>()
  private active = new Set<AbortController>()
  private closing = false
  constructor(private readonly options: DocumentServiceOptions) {}

  async callTool(projectRoot: string, name: string, args: unknown, signal?: AbortSignal): Promise<DocumentResult> {
    if (!(name in DOCUMENT_SCHEMAS)) throw new Error(`未知文档工具：${name}`)
    const parsed = DOCUMENT_SCHEMAS[name as keyof typeof DOCUMENT_SCHEMAS].parse(args)
    return this.execute(projectRoot, { ...parsed, action: name.slice('document_'.length) } as DocumentRequest, signal)
  }

  async execute(projectRoot: string, request: DocumentRequest, externalSignal?: AbortSignal): Promise<DocumentResult> {
    if (this.closing) throw new Error('应用正在退出，不能启动文档任务')
    checkAbort(externalSignal)
    const controller = new AbortController()
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    this.active.add(controller)
    let release: (() => void) | undefined
    try {
      // Missing optional tools fail before backups or project-directory changes.
      await this.options.components?.resolve('documents')
      checkAbort(controller.signal)
      release = this.options.components?.acquire?.('documents')
      return await this.executeRequest(projectRoot, request, controller.signal)
    } finally {
      release?.()
      externalSignal?.removeEventListener('abort', abort)
      this.active.delete(controller)
    }
  }

  /** Read-only knowledge import. Callers must bind the path to their current saved original. */
  async extractPptx(originalPath: string, externalSignal?: AbortSignal, progress: (text: string) => void = () => {}): Promise<ExtractedPart[]> {
    if (this.closing) throw new Error('应用正在退出，不能启动文档任务')
    checkAbort(externalSignal)
    const controller = new AbortController(), abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    this.active.add(controller)
    let release: (() => void) | undefined
    try {
      if (!isAbsolute(originalPath) || extname(originalPath).toLowerCase() !== '.pptx') throw new Error('PPTX 提取必须指定已保存原件的绝对路径')
      const info = await lstat(originalPath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) throw new Error('PPTX 原件必须是 50 MB 以内的普通文件')
      const originalHash = await hashFile(originalPath)
      checkAbort(controller.signal)
      progress('准备 PPTX 文档组件')
      const runtimeDir = this.options.components ? (await this.options.components.ensure('documents', controller.signal)).directory : this.options.runtimeDir
      checkAbort(controller.signal)
      release = this.options.components?.acquire?.('documents')
      progress('提取 PPTX 全部幻灯片文字和表格（不执行 OCR）')
      const { stdout } = await this.run(join(runtimeDir, 'python', 'python.exe'), ['-I', '-B', '-X', 'utf8', join(runtimeDir, 'worker.py')], JSON.stringify({ action: 'extract-pptx', path: originalPath, format: 'pptx' }), controller.signal)
      checkAbort(controller.signal)
      let value: unknown
      try { value = JSON.parse(stdout) } catch { throw new Error('PPTX 提取结果不完整或无法解析，未加入知识库') }
      const parsed = PPTX_EXTRACTION.safeParse(value)
      if (!parsed.success) throw new Error('PPTX 提取结果未完整通过验证，未加入知识库')
      if (!parsed.data.parts.some(part => part.text.trim())) throw new Error('PPTX 没有可索引的文字或表格；纯图片幻灯片暂不执行 OCR')
      if (await hashFile(originalPath) !== originalHash) throw new Error('PPTX 原件在提取期间发生变化，未加入知识库')
      checkAbort(controller.signal)
      progress(`已完整提取 ${parsed.data.slides} 张幻灯片，${parsed.data.parts.length} 个文字或表格片段`)
      return parsed.data.parts
    } finally {
      release?.()
      externalSignal?.removeEventListener('abort', abort)
      this.active.delete(controller)
    }
  }

  private async executeRequest(projectRoot: string, request: DocumentRequest, signal: AbortSignal): Promise<DocumentResult> {
    // Runtime validation applies to IPC callers as well as MCP callers.
    const { action, ...args } = request
    const schema = DOCUMENT_SCHEMAS[`document_${action}`]
    if (!schema) throw new Error('未知文档操作')
    schema.parse(args)
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 4 * 1024 * 1024) throw new Error('一次文档操作的输入不能超过 4 MB')
    checkAbort(signal)
    const root = await realpath(projectRoot)
    const path = await this.resolveBounded(root, request.path, action === 'create')
    checkAbort(signal)
    const format = extname(path).slice(1).toLowerCase() as DocumentFormat
    if (!FORMATS.has(format)) throw new Error('不支持此文档格式；旧 Office 和宏格式只能只读导入知识库，不能自动转换或覆盖')
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (this.locks.has(key)) throw new Error('此文件已有文档任务运行，请等待完成')
    this.locks.add(key)
    const jobId = randomUUID()
    const jobDir = join(this.options.stateDir, jobId)
    const temporary = join(dirname(path), `.roundtable-${jobId}${extname(path)}`)
    const journalPath = join(jobDir, 'journal.json')
    let committed = false
    let backupPath: string | undefined
    let oldHash: string | undefined
    try {
      checkAbort(signal)
      await mkdir(jobDir, { recursive: true })
      if (action !== 'create') {
        const info = await stat(path)
        if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new Error('文档必须是 50 MB 以内的普通文件')
        oldHash = await hashFile(path)
        if ('expectedHash' in request && request.expectedHash && request.expectedHash !== oldHash) throw new Error('文件已被其他操作修改；请重新检查后再提交修改')
      }
      let worker: WorkerResult
      if (action === 'create' || action === 'edit') {
        if (action === 'edit') {
          backupPath = join(jobDir, `before${extname(path)}`)
          await copyFile(path, backupPath, constants.COPYFILE_EXCL)
          if (await hashFile(backupPath) !== oldHash) throw new Error('备份时文件发生变化，操作已中止')
        }
        await writeFile(journalPath, JSON.stringify({ jobId, action, projectRoot: root, path: request.path, status: 'processing', oldHash, backupPath, startedAt: new Date().toISOString() }, null, 2), 'utf8')
        const materialized = await this.snapshotInputs(root, request, jobDir, signal)
        worker = await this.worker({ action, path: temporary, format, ...(materialized.action === 'create' ? { content: materialized.content } : materialized.action === 'edit' ? { source: backupPath, edits: materialized.edits } : {}) }, signal)
        checkAbort(signal)
        // A second parser pass reads the bytes actually written, not in-memory objects.
        const verified = await this.worker({ action: 'inspect', path: temporary, format }, signal)
        worker.inspection = verified.inspection
        await this.resolveBounded(root, request.path, action === 'create')
        if (action === 'edit' && await hashFile(path) !== oldHash) throw new Error('生成期间原文件被外部修改，已保留原件并拒绝覆盖')
        if (action === 'create') {
          // Hardlink creation is an atomic no-replace publication on this same volume.
          const { link } = await import('node:fs/promises')
          checkAbort(signal)
          await link(temporary, path)
          await rm(temporary)
        } else {
          checkAbort(signal)
          await rename(temporary, path)
        }
        committed = true
        if (action === 'create') worker.changes = [{ location: request.path, before: '', after: `新建 ${format} 文档` }]
      } else {
        worker = await this.worker({ action: 'inspect', path, format }, signal)
      }
      const result: DocumentResult = { jobId, action, path: relative(root, path), sha256: await hashFile(path), status: 'complete', inspection: worker.inspection, changes: worker.changes, backupPath, journalPath }
      if (action === 'preview' || ((action === 'create' || action === 'edit') && (format === 'docx' || format === 'pptx'))) {
        try {
          if (worker.inspection.blockedReasons.some(reason => reason.includes('外部加载资源'))) throw new Error('文档包含外部加载资源，已阻止自动预览；请先将资源嵌入文档')
          result.previewPath = await this.preview(path, format, jobDir, signal)
        } catch (error) {
          if (!committed) throw error
          result.status = 'preview-failed'
          result.previewError = error instanceof Error ? error.message : String(error)
        }
      }
      if (!committed) {
        checkAbort(signal)
        if (await hashFile(path) !== oldHash) throw new Error('读取期间文件发生变化，请重新检查')
      }
      await writeFile(journalPath, JSON.stringify({ ...result, projectRoot: root, oldHash, finishedAt: new Date().toISOString() }, null, 2), 'utf8')
      return result
    } catch (error) {
      await writeFile(journalPath, JSON.stringify({ jobId, action, path: request.path, projectRoot: root, oldHash, backupPath, committed, status: signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error) }, null, 2), 'utf8').catch(() => {})
      if (committed) throw new Error(`文件 ${request.path} 已写入，但完成记录失败：${error instanceof Error ? error.message : String(error)}；前版本仍保存在 ${backupPath ?? '任务记录'}`)
      throw error
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
      this.locks.delete(key)
    }
  }

  private async snapshotInputs(root: string, request: DocumentRequest, jobDir: string, signal: AbortSignal): Promise<DocumentRequest> {
    const snapshot = structuredClone(request)
    let count = 0
    const asset = async (requested: string, type: 'image' | 'pdf') => {
      checkAbort(signal)
      const source = await this.resolveBounded(root, requested, false)
      if (!(type === 'pdf' ? ['.pdf'] : ['.png', '.jpg', '.jpeg']).includes(extname(source).toLowerCase())) throw new Error(type === 'pdf' ? '合并源必须是本项目 PDF' : '插图仅支持本项目中的 PNG/JPEG')
      if ((await stat(source)).size > 50 * 1024 * 1024) throw new Error('文档输入资料超过 50 MB')
      const before = await hashFile(source)
      const destination = join(jobDir, `input-${++count}${extname(source)}`)
      await copyFile(source, destination, constants.COPYFILE_EXCL)
      if (before !== await hashFile(destination) || before !== await hashFile(source)) throw new Error('读取插图或合并来源时文件发生变化')
      return destination
    }
    const block = async (item: import('../../shared/documents').DocumentBlock) => {
      if (item.type === 'image') {
        if (!item.path) throw new Error('图片内容块缺少 path')
        item.path = await asset(item.path, 'image')
      }
    }
    const slide = async (item: import('../../shared/documents').SlideContent) => {
      for (const image of item.images ?? []) image.path = await asset(image.path, 'image')
    }
    if (snapshot.action === 'create') {
      for (const item of snapshot.content.blocks ?? []) await block(item)
      for (const item of snapshot.content.slides ?? []) await slide(item)
    } else if (snapshot.action === 'edit') {
      for (const edit of snapshot.edits) {
        if (edit.kind === 'word.image') edit.path = await asset(edit.path, 'image')
        if (edit.kind === 'word.append') await block(edit.block)
        if (edit.kind === 'slide.add') await slide(edit.slide)
        if (edit.kind === 'slide.image') edit.image.path = await asset(edit.image.path, 'image')
        if (edit.kind === 'pdf.merge') for (let i = 0; i < edit.paths.length; i++) edit.paths[i] = await asset(edit.paths[i], 'pdf')
      }
    }
    return snapshot
  }

  private async resolveBounded(root: string, requested: string, creating: boolean): Promise<string> {
    if (isAbsolute(requested) || requested.includes(':') || requested.includes('\0')) throw new Error('文档路径必须是项目内相对路径')
    const path = resolve(root, requested)
    const rel = relative(root, path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文档路径超出项目目录')
    // Resolve every existing ancestor before creating a directory; junctions cannot escape the project.
    let current = root
    for (const part of relative(root, dirname(path)).split(sep).filter(Boolean)) {
      current = join(current, part)
      try { await access(current) } catch { if (creating) await mkdir(current); else throw new Error('文档目录不存在') }
      const actual = await realpath(current)
      const actualRelative = relative(root, actual)
      if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error('符号链接或目录联接指向项目外部')
    }
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('文档目标不能是符号链接或目录')
      if (creating) throw new Error('目标文件已存在；修改时请使用检查得到的 SHA256')
      const actual = await realpath(path)
      const actualRelative = relative(root, actual)
      if (actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) throw new Error('文档指向项目外部')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !creating) throw error
    }
    return path
  }

  private async worker(request: Record<string, unknown>, signal: AbortSignal): Promise<WorkerResult> {
    const runtimeDir = this.options.components ? (await this.options.components.resolve('documents')).directory : this.options.runtimeDir
    const python = join(runtimeDir, 'python', 'python.exe')
    const script = join(runtimeDir, 'worker.py')
    const { stdout } = await this.run(python, ['-I', '-B', '-X', 'utf8', script], JSON.stringify(request), signal)
    let result: WorkerResult
    try { result = JSON.parse(stdout) } catch { throw new Error('文档运行时返回了无效结果') }
    if (!result.ok) throw new Error(result.error || '文档处理失败')
    return result
  }

  private async preview(path: string, format: DocumentFormat, jobDir: string, signal: AbortSignal): Promise<string> {
    if (format !== 'docx' && format !== 'pptx') return path
    const executable = this.options.components ? (await this.options.components.resolve('libreoffice')).executable : this.options.libreOfficePath ?? join(this.options.runtimeDir, 'libreoffice', 'program', 'soffice.com')
    try { await access(executable) } catch { throw new Error('缺少随应用分发的 LibreOffice 预览运行时；文档已保留，预览未完成') }
    const previewDir = join(jobDir, 'preview')
    const profile = join(jobDir, 'lo-profile')
    await mkdir(join(profile, 'user'), { recursive: true })
    await mkdir(previewDir, { recursive: true })
    // Highest macro security with an empty trusted-location profile. No user profile or templates are loaded.
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateLinksMode" oor:op="fuse"><value>0</value></prop></item></oor:items>', 'utf8')
    const sourceDirectory = join(jobDir, 'preview-source')
    await mkdir(sourceDirectory, { recursive: true })
    const snapshot = join(sourceDirectory, basename(path))
    await copyFile(path, snapshot)
    const release = this.options.components?.acquire?.('libreoffice')
    try { await this.run(executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nodefault', '--nofirststartwizard', '--convert-to', format === 'docx' ? 'pdf:writer_pdf_Export' : 'pdf:impress_pdf_Export', '--outdir', previewDir, snapshot], '', signal) } finally { release?.() }
    const output = join(previewDir, `${basename(path, extname(path))}.pdf`)
    try { await stat(output) } catch { throw new Error('LibreOffice 没有生成预览 PDF；转换未成功') }
    await this.worker({ action: 'inspect', path: output, format: 'pdf' }, signal)
    return output
  }

  private run(executable: string, args: string[], input: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
    checkAbort(signal)
    return new Promise((resolvePromise, reject) => {
      let stdout = '', stderr = '', failure: Error | undefined, stopped: Promise<void> | undefined
      const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
      delete environment.PYTHONPATH
      delete environment.PYTHONHOME
      delete environment.PYTHONUSERBASE
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment })
      const stop = (error: Error) => {
        if (failure) return
        failure = error
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { shell: false, windowsHide: true, stdio: 'ignore' })
          stopped = new Promise(resolveStopped => {
            killer.once('error', () => { child.kill(); resolveStopped() })
            killer.once('close', code => { if (code !== 0) child.kill(); resolveStopped() })
          })
        } else child.kill()
      }
      const abort = () => stop(abortError())
      signal.addEventListener('abort', abort, { once: true })
      const timeout = setTimeout(() => stop(new Error('文档处理超过时间限制')), this.options.timeoutMs ?? 120000)
      child.stdout.setEncoding('utf8').on('data', chunk => { if (failure) return; stdout += chunk; if (stdout.length > 16 * 1024 * 1024) stop(new Error('文档检查结果超过限制')) })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-20000) })
      child.once('error', error => { failure = new Error(`无法启动文档运行时：${error.message}`) })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
      child.once('close', async code => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        await stopped
        if (failure) return reject(failure)
        if (code !== 0) {
          try { const data = JSON.parse(stdout); if (data.error) return reject(new Error(data.error)) } catch { /* non-JSON runtime error */ }
          return reject(new Error(`文档进程退出 (${code})：${stderr || stdout}`))
        }
        resolvePromise({ stdout, stderr })
      })
    })
  }

  async shutdown(): Promise<void> {
    this.closing = true
    for (const task of this.active) task.abort()
    while (this.active.size) await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
}
