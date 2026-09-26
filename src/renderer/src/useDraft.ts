import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { api } from './api'
import { editorTransferBlock, type EditorTarget, type EditorTransfer } from '../../shared/editor'

type DraftPayload = { transfer?: EditorTransfer; target?: EditorTarget; knowledgeBaseId?: string }
type Incoming = DraftPayload & { resolve(): void; reject(error: unknown): void }
const incoming = new Map<string, Incoming[]>()
const receivers = new Map<string, () => void>()
const writes = new Map<string, Promise<unknown>>()
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(work)
  writes.set(key, next); void next.finally(() => { if (writes.get(key) === next) writes.delete(key) }).catch(() => {})
  return next
}
export function receiveEditorDraft(key: string, payload: DraftPayload): Promise<void> {
  return new Promise((resolve, reject) => { incoming.set(key, [...(incoming.get(key) ?? []), { ...payload, resolve, reject }]); receivers.get(key)?.() })
}

const discarded = new Set<string>()
const activeKeys = new Set<string>()
export function clearLocalDrafts({ projectId, sessionIds = [] }: { projectId?: string; sessionIds?: string[] }) {
  const matches = (key: string) => sessionIds.some(id => key === `message.${id}` || (key.startsWith('execution-new.') && key.endsWith(`.${id}`))) || !!projectId && (key === `discussion-new.${projectId}` || key.startsWith(`execution-new.${projectId}.`))
  // Mark active composers first so their unmount cleanup cannot recreate a deleted draft.
  for (const key of activeKeys) if (matches(key)) discarded.add(key)
  for (const id of sessionIds) discarded.add(`message.${id}`)
  if (projectId) discarded.add(`discussion-new.${projectId}`)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('roundtable.draft.') && matches(key.slice('roundtable.draft.'.length))) {
        discarded.add(key.slice('roundtable.draft.'.length)); localStorage.removeItem(key)
      }
    }
  } catch { /* Deletion of the primary stored records has already succeeded. */ }
}

/** Drafts are local UI state. Switching views never sends or cancels a request. */
export function useDraft<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const storageKey = `roundtable.draft.${key}`
  const [value, setValue] = useState<T>(() => {
    try { const saved = localStorage.getItem(storageKey); return saved ? JSON.parse(saved) as T : initial } catch { return initial }
  })
  const edited = useRef(false)
  const ready = useRef(false)
  const mounted = useRef(true)
  const applying = useRef(false)
  const pendingUpdates = useRef<SetStateAction<T>[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(value)
  latest.current = value
  const cache = (next: T) => { try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch {} }
  const persist = () => serialize(key, () => discarded.has(key) ? Promise.resolve() : api.saveDraft({ id: key, text: JSON.stringify(latest.current) }))
  useEffect(() => {
    mounted.current = true; activeKeys.add(key)
    const receive = async () => {
      if (!ready.current || applying.current) return
      applying.current = true; clearTimeout(timer.current)
      try {
        while (mounted.current && incoming.get(key)?.length) {
          const item = incoming.get(key)!.shift()!
          try {
            await serialize(key, async () => {
              if (discarded.has(key) || !mounted.current) throw new Error('目标草稿已关闭或删除，资料仍保留在收件箱。')
              const next = { ...latest.current } as Record<string, unknown>
              if (item.transfer) {
                if (!item.target) throw new Error('请选择资料的接收目标。')
                if (key.startsWith('execution-new.') && next.projectId !== item.target.projectId) throw new Error('执行草稿已切换项目，请先为所选项目打开新执行草稿。原草稿保持不变。')
                const field = key.startsWith('discussion-new.') ? 'topic' : key.startsWith('execution-new.') ? 'task' : 'text'
                const ids = Array.isArray(next._editorTransfers) ? next._editorTransfers as string[] : []
                if (!ids.includes(item.transfer.id)) {
                  const text = String(next[field] ?? '') + editorTransferBlock(item.transfer)
                  if (text.length > 20000) throw new Error('追加后超过 20,000 字符，请缩小 VS Code 选区或改用知识库。原草稿保持不变。')
                  next[field] = text; next._editorTransfers = [...ids, item.transfer.id]
                }
              }
              if (item.knowledgeBaseId) next.knowledgeBaseIds = [...new Set([...(Array.isArray(next.knowledgeBaseIds) ? next.knowledgeBaseIds : []), item.knowledgeBaseId])]
              // Commit the receipt and draft together before changing the visible/local draft.
              if (item.transfer) await api.editorApply({ transferId: item.transfer.id, target: item.target!, draftId: key, draft: JSON.stringify(next) })
              else await api.saveDraft({id:key,text:JSON.stringify(next)})
              if (!discarded.has(key)) {
                edited.current = true; latest.current = next as T; cache(next as T)
                if (mounted.current) setValue(next as T)
              }
            })
            item.resolve()
          } catch (error) { item.reject(error) }
          finally {
            // Preserve any user edits queued while the atomic receipt save was in flight.
            for (const update of pendingUpdates.current.splice(0)) latest.current = typeof update === 'function' ? (update as (value: T) => T)(latest.current) : update
            if (edited.current && mounted.current && !discarded.has(key)) { cache(latest.current); setValue(latest.current) }
          }
        }
      } finally { applying.current = false; if (edited.current) void persist().catch(() => {}) }
    }
    receivers.set(key, () => { void receive() })
    return () => { mounted.current = false; activeKeys.delete(key); receivers.delete(key); clearTimeout(timer.current); if (edited.current && !applying.current) void persist().catch(() => {}) }
  }, [key])
  useEffect(() => {
    let active = true
    void serialize(key, () => api.getDraft(key)).then(saved => {
      if (active && saved && !edited.current) { try { const loaded = JSON.parse(saved) as T; latest.current = loaded; setValue(loaded) } catch { /* Ignore invalid UI drafts. */ } }
    }).catch(() => { /* The local copy remains available if loading the stored draft fails. */ }).finally(() => { if (active) { ready.current = true; receivers.get(key)?.() } })
    return () => { active = false }
  }, [key])
  useEffect(() => {
    if (!edited.current) return
    try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* Full storage must not break the conversation. */ }
    clearTimeout(timer.current)
    if (!applying.current) timer.current = setTimeout(() => { void persist().catch(() => {}) }, 250)
    return () => { clearTimeout(timer.current) }
  }, [key, storageKey, value])
  const update: Dispatch<SetStateAction<T>> = next => { edited.current = true; if (applying.current) { pendingUpdates.current.push(next); return }; const updated = typeof next === 'function' ? (next as (value: T) => T)(latest.current) : next; latest.current = updated; setValue(updated) }
  const clear = () => { edited.current = true; clearTimeout(timer.current); latest.current = initial; setValue(initial); try { localStorage.removeItem(storageKey) } catch { /* Keep the in-memory draft usable. */ } void persist().catch(() => {}) }
  return [value, update, clear]
}
