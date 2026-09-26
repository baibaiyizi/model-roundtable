// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { clearLocalDrafts, receiveEditorDraft, useDraft } from '../src/renderer/src/useDraft'
import { editorSourceTransfers, editorTransferBlock, type EditorTransfer } from '../src/shared/editor'

const mocks = vi.hoisted(() => ({ getDraft: vi.fn(), saveDraft: vi.fn(), editorApply: vi.fn() }))
vi.mock('../src/renderer/src/api', () => ({ api: mocks }))
type Draft = { topic: string; participants: string[]; projectId?: string; task?: string; _editorTransfers?: string[] }
let current: { value: Draft; update: Dispatch<SetStateAction<Draft>> }
const roots: Root[] = []
const saved = new Map<string, string>()
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
function Composer({ draftKey }: { draftKey: string }) {
  const [value, update] = useDraft<Draft>(draftKey, { topic: '', participants: ['initial'] })
  current = { value, update }; return createElement('div', null, value.topic)
}
async function mount(key: string) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => { root.render(createElement(Composer, { draftKey: key })); await tick() })
  return root
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear(); saved.clear(); vi.clearAllMocks()
  mocks.getDraft.mockImplementation(async key => saved.get(key) ?? '')
  mocks.saveDraft.mockImplementation(async ({ id, text }: { id: string; text: string }) => { saved.set(id, text) })
  mocks.editorApply.mockImplementation(async ({ draftId, draft }: { draftId: string; draft: string }) => { saved.set(draftId, draft) })
})
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); await tick() }); document.body.innerHTML = '' })

describe('editor draft delayed persistence', () => {
  it('waits for an old composer save before loading and appending into its remounted draft', async () => {
    const key = `discussion-new.${crypto.randomUUID()}`, gate = deferred()
    saved.set(key, JSON.stringify({ topic: '旧草稿', participants: ['preserve'] }))
    const root = await mount(key)
    await act(async () => current.update(value => ({ ...value, topic: '最新尚在保存的原草稿' })))
    mocks.saveDraft.mockImplementationOnce(async ({ id, text }: { id: string; text: string }) => { await gate.promise; saved.set(id, text) })
    await act(async () => { root.unmount(); await tick() })
    const transfer: EditorTransfer = { id: crypto.randomUUID(), clientId: 'client', projectId: key.slice('discussion-new.'.length), kind: 'text', target: { kind: 'discussion-new' }, status: 'pending', createdAt: new Date().toISOString(), text: { path: 'source.md', content: 'VS Code 内容', startLine: 1, endLine: 1, language: 'markdown', dirty: false, capturedAt: new Date().toISOString(), sha256: 'hash' } }
    try {
      await mount(key)
      let accepted!: Promise<void>
      await act(async () => { accepted = receiveEditorDraft(key, { transfer, target: { kind: 'discussion-new', projectId: key.slice('discussion-new.'.length) } }); await tick() })
      gate.resolve()
      await act(async () => { await accepted; await tick() })
      expect(current.value.topic).toContain('最新尚在保存的原草稿')
      expect(current.value.topic).toContain('VS Code 内容')
      expect(current.value.participants).toEqual(['preserve'])
    } finally { gate.resolve() }
  })

  it('does not recreate a deleted project draft from an already queued second save', async () => {
    const pid = crypto.randomUUID(), key = `discussion-new.${pid}`, gate = deferred()
    const root = await mount(key)
    mocks.saveDraft.mockImplementationOnce(async ({ id, text }: { id: string; text: string }) => { await gate.promise; saved.set(id, text) })
    await act(async () => { current.update(value => ({ ...value, topic: 'first' })); await tick() })
    // The ordinary debounce starts one slow save; unmount then queues a second.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)) })
    await act(async () => { current.update(value => ({ ...value, topic: 'second' })); root.unmount(); await tick() })
    clearLocalDrafts({ projectId: pid })
    gate.resolve(); await act(async () => { await tick() })
    // An already-started call cannot be unsent; the second, queued call must be discarded.
    expect(mocks.saveDraft).toHaveBeenCalledTimes(1)
  })

  it('sends an unbound untitled receipt to an independent draft without changing member choices', async () => {
    const key = 'discussion-new.independent'
    saved.set(key, JSON.stringify({ topic: '保留问题', participants: ['chosen-model'] }))
    await mount(key)
    const transfer = receipt({ untitled: true, path: 'Untitled-1' })
    await act(async () => { await receiveEditorDraft(key, { transfer, target: { kind: 'discussion-new' } }) })
    expect(current.value.topic).toContain('保留问题')
    expect(current.value.topic).toContain('来自任意目录的资料')
    expect(current.value.participants).toEqual(['chosen-model'])
    expect(mocks.editorApply).toHaveBeenCalledWith(expect.objectContaining({ transferId: transfer.id, target: { kind: 'discussion-new' }, draftId: key }))
  })

  it('keeps the original UI, local cache and stored draft when acceptance fails', async () => {
    const key = `discussion-new.${crypto.randomUUID()}`
    const original = { topic: '原来的内容', participants: ['retain'] }
    saved.set(key, JSON.stringify(original)); localStorage.setItem(`roundtable.draft.${key}`, JSON.stringify(original))
    await mount(key)
    mocks.editorApply.mockRejectedValueOnce(new Error('目标已删除'))
    await act(async () => { await expect(receiveEditorDraft(key, { transfer: receipt(), target: { kind: 'discussion-new' } })).rejects.toThrow('目标已删除') })
    expect(current.value).toEqual(original)
    expect(JSON.parse(localStorage.getItem(`roundtable.draft.${key}`)!)).toEqual(original)
    expect(JSON.parse(saved.get(key)!)).toEqual(original)
  })

  it('preserves edits made while acceptance is saving, after the appended snapshot', async () => {
    const key = `discussion-new.${crypto.randomUUID()}`, gate = deferred()
    await mount(key)
    mocks.editorApply.mockImplementationOnce(async ({ draftId, draft }) => { await gate.promise; saved.set(draftId, draft) })
    let accepted!: Promise<void>
    await act(async () => { accepted = receiveEditorDraft(key, { transfer: receipt(), target: { kind: 'discussion-new' } }); await tick() })
    await act(async () => { current.update(value => ({ ...value, participants: ['changed-during-save'], topic: `${value.topic}\n追加自己的话` })) })
    gate.resolve()
    await act(async () => { await accepted; await tick() })
    expect(current.value.topic).toContain('来自任意目录的资料')
    expect(current.value.topic).toContain('追加自己的话')
    expect(current.value.participants).toEqual(['changed-during-save'])
    expect(JSON.parse(saved.get(key)!)).toEqual(current.value)
  })

  it('accepts source project A into an execution draft for selected target project B', async () => {
    const pid = crypto.randomUUID(), key = `execution-new.${pid}.new`
    saved.set(key, JSON.stringify({ topic: '', task: '保留执行任务', projectId: pid, participants: ['executor'] }))
    await mount(key)
    const transfer = { ...receipt(), projectId: crypto.randomUUID() }
    await act(async () => { await receiveEditorDraft(key, { transfer, target: { kind: 'execution-new', projectId: pid } }) })
    expect(current.value.task).toContain('保留执行任务')
    expect(current.value.task).toContain('来自任意目录的资料')
    expect(current.value.projectId).toBe(pid)
  })

  it('leaves the draft untouched when its execution project no longer matches the selected target', async () => {
    const pid = crypto.randomUUID(), key = `execution-new.${pid}.new`
    saved.set(key, JSON.stringify({ topic: '', task: '原执行任务', projectId: 'switched', participants: ['executor'] }))
    await mount(key)
    await act(async () => { await expect(receiveEditorDraft(key, { transfer: receipt(), target: { kind: 'execution-new', projectId: pid } })).rejects.toThrow('执行草稿已切换项目') })
    expect(current.value.task).toBe('原执行任务')
    expect(mocks.editorApply).not.toHaveBeenCalled()
  })

  it('rejects an oversized append without accepting the receipt or changing the draft', async () => {
    const key = `discussion-new.${crypto.randomUUID()}`
    saved.set(key, JSON.stringify({ topic: '字'.repeat(19980), participants: ['retain'] }))
    await mount(key)
    await act(async () => { await expect(receiveEditorDraft(key, { transfer: receipt(), target: { kind: 'discussion-new' } })).rejects.toThrow('20,000') })
    expect(current.value.topic.length).toBe(19980)
    expect(mocks.editorApply).not.toHaveBeenCalled()
  })
})

function receipt(text: Partial<NonNullable<EditorTransfer['text']>> = {}): EditorTransfer {
  return { id: crypto.randomUUID(), clientId: 'client', kind: 'text', status: 'pending', createdAt: new Date().toISOString(), text: { path: '其他目录/source.md', filePath: 'C:/其他目录/source.md', content: '来自任意目录的资料', startLine: 1, endLine: 1, language: 'markdown', dirty: true, capturedAt: new Date().toISOString(), sha256: 'hash', ...text } }
}

describe('saved editor source references', () => {
  it('resolves a complete 0.6.1 header to its saved source record, including after cross-project receipt', () => {
    const transfer = { ...receipt(), projectId: 'original-project', target: { kind: 'discussion-new' as const, projectId: 'receiving-project' } }
    const oldBlock = editorTransferBlock(transfer).replace(` · 资料 ID ${transfer.id}]`, ']')
    expect(editorSourceTransfers(`先前的讨论\n${oldBlock}`, [transfer])).toEqual([transfer])
    expect(editorSourceTransfers(editorTransferBlock(transfer), [transfer])).toEqual([transfer])
  })

  it('does not guess from a same-named file, incorrect hash, or an ambiguous complete old header', () => {
    const transfer = receipt({ path: '同名.md', sha256: 'original-hash' })
    const oldBlock = editorTransferBlock(transfer).replace(` · 资料 ID ${transfer.id}]`, ']')
    const duplicate = { ...transfer, id: crypto.randomUUID(), projectId: 'another-project' }
    expect(editorSourceTransfers(oldBlock, [transfer, duplicate])).toEqual([])
    expect(editorSourceTransfers(oldBlock.replace('original-hash', 'different-hash'), [transfer])).toEqual([])
    expect(editorSourceTransfers('[VS Code 资料：同名.md · 第 1–1 行]', [transfer])).toEqual([])
    expect(editorSourceTransfers(editorTransferBlock(transfer), [transfer, duplicate])).toEqual([transfer])
  })
})
