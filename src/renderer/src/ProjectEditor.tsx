import { useState } from 'react'
import { FolderOpen, Save } from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import type { Project, ProjectInput } from '../../shared/workspace'
import { api } from './api'
import { FilterChoices } from './SelectionControls'
import { Modal, Spinner, useTask, type Notify } from './common'

export function ProjectEditor({ project, data, onClose, onSaved, notify }: {
  project?: Project; data: Bootstrap; onClose: () => void; onSaved: (p: Project) => void; notify: Notify
}) {
  const [form, setForm] = useState<ProjectInput>(project ? { id: project.id, name: project.name, directory: project.directory, instructions: project.instructions, knowledgeBaseIds: project.knowledgeBaseIds } : { name: '', directory: '', instructions: '', knowledgeBaseIds: [] })
  const { busy, run } = useTask(notify)
  return <Modal title={project ? '编辑项目' : '新建项目'} onClose={onClose} wide>
    <form onSubmit={e => { e.preventDefault(); void run(async () => { const saved = await api.saveProject(form); onSaved(saved); onClose(); notify('项目已保存') }) }}>
      <p className="modal-description">把同一件事的讨论、资料和执行成果放在一起。工作目录用于实际读取和修改文件。</p>
      <label className="field"><span>项目名称</span><input autoFocus required aria-label="项目名称" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="例如：产品网站 / 研究报告"/></label>
      <label className="field"><span>工作目录</span><div className="inline-input"><input required aria-label="工作目录" value={form.directory} onChange={e => setForm(f => ({ ...f, directory: e.target.value }))} placeholder="选择项目文件所在文件夹"/><button type="button" disabled={busy} onClick={() => void run(async () => { const directory = await api.selectDirectory(); if (directory) setForm(f => ({ ...f, directory, name: f.name || directory.split(/[\\/]/).filter(Boolean).at(-1) || '' })) })}><FolderOpen size={16}/>选择文件夹</button></div></label>
      <label className="field"><span>项目说明</span><textarea aria-label="项目说明" rows={4} value={form.instructions} onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))} placeholder="背景、目标和项目约定，新会话会继承这些说明。"/></label>
      <div className="section-heading"><h3>默认知识库</h3><span className="muted small">新讨论仍可单独调整</span></div>
      {data.knowledgeBases.length ? <FilterChoices label="默认知识库" options={data.knowledgeBases.map(k => ({ id: k.id, name: k.name }))} selected={form.knowledgeBaseIds} onChange={ids => setForm(f => ({ ...f, knowledgeBaseIds: ids }))}/> : <p className="muted small">尚无知识库，可稍后在项目设置中添加。</p>}
      <div className="modal-footer"><span/><button type="button" onClick={onClose}>取消</button><button type="submit" className="primary" disabled={busy || !form.name.trim() || !form.directory.trim()}>{busy ? <Spinner/> : <><Save size={16}/>保存项目</>}</button></div>
    </form>
  </Modal>
}
