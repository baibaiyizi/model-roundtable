import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Project, ProjectFile, ProjectFileContent, ProjectInput } from '../shared/types'
import type { Store } from './store'

export async function resolveProjectPath(root: string, requested = ''): Promise<string> {
  if (isAbsolute(requested)) throw new Error('只接受项目内相对路径。')
  const base = await realpath(root)
  const target = await realpath(join(base, requested))
  const rel = relative(base, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('目标不在项目目录内。')
  return target
}

export class Projects {
  constructor(private store: Store) {}
  async save(input: ProjectInput): Promise<Project> {
    const directory = await realpath(input.directory)
    if (!(await stat(directory)).isDirectory()) throw new Error('请选择一个本机项目目录。')
    const old = input.id ? this.store.getProject(input.id) : undefined
    if (input.id && !old) throw new Error('项目不存在。')
    if (old && old.directory !== directory && (this.store.listSessions().some(s => s.projectId === old.id) || this.store.listExecutions().some(e => e.projectId === old.id))) throw new Error('已有聊天的项目不能更换工作目录，请新建项目。')
    if (input.knowledgeBaseIds.some(id => !this.store.getKnowledgeBase(id))) throw new Error('选定的知识库已删除，请重新选择。')
    const now = new Date().toISOString()
    const project: Project = { ...input, directory, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, updatedAt: now }
    this.store.saveProject(project)
    return project
  }
  private root(id: string): string {
    const project = this.store.getProject(id)
    if (!project) throw new Error('项目不存在。')
    return project.directory
  }
  path(id: string, path?: string): Promise<string> { return resolveProjectPath(this.root(id), path) }
  async files(id: string, path = ''): Promise<ProjectFile[]> {
    const root = this.root(id)
    const target = await resolveProjectPath(root, path)
    const entries = await readdir(target, { withFileTypes: true })
    if (entries.length > 10000) throw new Error('该目录条目超过 10000，请选择更小的子目录。')
    const files = await Promise.all(entries.filter(e => !e.isSymbolicLink()).map(async entry => {
      const info = await stat(join(target, entry.name))
      return { path: relative(root, join(target, entry.name)).replaceAll('\\','/'), name: entry.name, directory: info.isDirectory(), size: info.size }
    }))
    return files.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN'))
  }
  async file(id: string, path: string): Promise<ProjectFileContent> {
    const target = await this.path(id, path)
    const info = await stat(target)
    if (!info.isFile()) throw new Error('请选择文件。')
    if (info.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB，请使用文件预览或外部应用打开。')
    const bytes = await readFile(target)
    let text: string | undefined
    try { if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* Non UTF-8 files need a document viewer. */ }
    return { path, text, binary: text === undefined, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }
}
