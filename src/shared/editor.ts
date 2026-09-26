export interface EditorTarget { kind: 'discussion-new' | 'execution-new' | 'discussion'; sessionId?: string; projectId?: string }
export interface EditorText { path: string; filePath?: string; resolvedFilePath?: string; untitled?: boolean; content: string; startLine: number; endLine: number; language: string; dirty: boolean; capturedAt: string; sha256: string }
export interface EditorTransfer {
  id: string; clientId: string; projectId?: string; kind: 'text' | 'files'; target?: EditorTarget
  text?: EditorText; files?: string[]; status: 'pending' | 'applied' | 'dismissed' | 'imported'; createdAt: string
  resolvedFiles?: string[]; sourceIds?: string[]; knowledgeBaseId?: string
}
export interface EditorClient { id: string; name: string; createdAt: string }
export interface EditorWindow { id: string; clientId: string; name: string; workspace?: string; lastSeen: number }
export interface EditorConnectionRequest { id: string; name: string; createdAt: string; expiresAt: string }
export interface EditorState { enabled: boolean; running: boolean; executable?: string; vsixPath: string; clients: EditorClient[]; windows: EditorWindow[]; transfers: EditorTransfer[]; connectionRequests: EditorConnectionRequest[] }
export interface EditorOutbound { id: string; windowId: string; kind: 'markdown'; title?: string; text?: string }
export const isEditorInboxTransfer = (transfer: EditorTransfer): boolean => transfer.status === 'pending' || transfer.status === 'imported'
export interface EditorAPI {
  editorState(): Promise<EditorState>
  editorEnable(enabled: boolean): Promise<EditorState>
  editorSelectExecutable(): Promise<EditorState>
  editorInstall(): Promise<void>
  editorResolveConnection(input: { requestId: string; allow: boolean }): Promise<EditorState>
  editorRevoke(clientId: string): Promise<EditorState>
  editorDismiss(transferId: string): Promise<void>
  editorApply(input: { transferId: string; target: EditorTarget; draftId: string; draft: string }): Promise<void>
  editorImport(input: { transferId: string; knowledgeBaseId: string }): Promise<void>
  editorOpen(input: { projectId: string; path?: string; line?: number }): Promise<void>
  editorOpenSource(transferId: string): Promise<void>
  editorSend(input: { title: string; text: string; windowId?: string }): Promise<void>
}
export function editorTransferBlock(transfer: EditorTransfer): string {
  if (!transfer.text) throw new Error('此资料不是文本快照。')
  const t = transfer.text
  const fence = '`'.repeat(Math.max(3, ...Array.from(t.content.matchAll(/`+/g), match => match[0].length + 1)))
  return `\n\n[VS Code 资料：${t.path} · 第 ${t.startLine}–${t.endLine} 行${t.dirty ? ' · 未保存的编辑器快照' : ''} · ${t.capturedAt} · SHA-256 ${t.sha256} · 资料 ID ${transfer.id}]\n${fence}\n${t.content}\n${fence}`
}

/** Resolve historical source headers against saved receipts, never the destination project. */
export function editorSourceTransfers(text: string, transfers: EditorTransfer[]): EditorTransfer[] {
  const ids = new Set([...text.matchAll(/\[VS Code 资料：[^\n]+ · 资料 ID ([0-9a-f-]{36})\]/gi)].map(match => match[1]))
  const lines = new Set(text.split(/\r?\n/))
  const candidates = transfers.filter(transfer => transfer.kind === 'text' && transfer.text && !transfer.text.untitled)
  const headers = new Map<string, EditorTransfer[]>()
  for (const transfer of candidates) {
    const t = transfer.text!
    const header = `[VS Code 资料：${t.path} · 第 ${t.startLine}–${t.endLine} 行${t.dirty ? ' · 未保存的编辑器快照' : ''} · ${t.capturedAt} · SHA-256 ${t.sha256}]`
    if (lines.has(header)) headers.set(header, [...(headers.get(header) ?? []), transfer])
  }
  for (const matches of headers.values()) if (matches.length === 1) ids.add(matches[0].id)
  return candidates.filter(transfer => ids.has(transfer.id))
}
