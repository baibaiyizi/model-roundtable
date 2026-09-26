import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, extname, basename } from 'node:path';
import { BridgeClient, BridgeError, isLocalFilePath, localFile, type Credential, type Transfer, type OutboxItem, type ConnectionResult } from './client';

const SECRET = 'model-roundtable.credential';
const MAX_TEXT = 20_000;
const supportedOffice = /\.(pdf|docx|xlsx|xls|xlsm|csv|pptx)$/i;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function parseCredential(stored?: string): Credential | undefined {
  if (!stored) return;
  try { const value = JSON.parse(stored); if (typeof value.clientId === 'string' && typeof value.token === 'string' && value.clientId && value.token) return { clientId: value.clientId, token: value.token }; } catch {}
}

export class Companion implements vscode.Disposable {
  readonly windowId = randomUUID();
  readonly client: BridgeClient;
  private credential?: Credential;
  private registeredWindowId?: string;
  private disposed = false;
  private generation = 0;
  private polling = false;
  private wake?: () => void;
  private connecting?: Promise<void>;
  private connectionRequest?: { id: string; claim: string; cancelled: boolean };
  private statusText = '未连接';
  private pending: Transfer[] = [];
  private received = new Set<string>();
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  constructor(private context: vscode.ExtensionContext, discoveryPath?: string) {
    this.client = new BridgeClient(discoveryPath ?? join(process.env.APPDATA ?? '', 'model-roundtable', 'v2', 'editor-bridge.json'), this.windowId);
    this.status.command = 'modelRoundtable.status'; this.status.show(); this.updateStatus('未连接');
  }
  async initialize(): Promise<void> {
    // The built-in trust context key is absent in some empty windows; use the public trust API.
    await vscode.commands.executeCommand('setContext', 'modelRoundtable.canSend', this.localSupported());
    const stored = await this.context.secrets.get(SECRET);
    this.credential = parseCredential(stored);
    if (stored && !this.credential) await this.context.secrets.delete(SECRET);
    this.client.setCredential(this.credential);
    this.pending = this.context.workspaceState.get<Transfer[]>('pending', []);
    this.received = new Set(this.context.workspaceState.get<string[]>('received', []));
    this.context.subscriptions.push(this.context.secrets.onDidChange(event => { if (event.key === SECRET) void this.refreshCredential().catch(error => this.updateStatus(message(error))); }));
    this.context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void vscode.commands.executeCommand('setContext', 'modelRoundtable.canSend', this.localSupported());
      if (this.credential && this.localSupported()) this.startPolling();
    }));
    if (this.credential && this.localSupported()) this.startPolling();
    else this.updateStatus('未连接，发送时自动申请');
  }
  private async refreshCredential(): Promise<void> {
    const next = parseCredential(await this.context.secrets.get(SECRET));
    if (next?.token === this.credential?.token) return;
    this.stopPolling(); this.credential = next; this.client.setCredential(next);
    this.updateStatus(next ? '已连接，正在同步窗口' : '连接已在其它窗口撤销');
    if (next) { await this.cancelConnectionRequest(); if (this.localSupported()) this.startPolling(); }
  }
  private localSupported(): boolean { return process.platform === 'win32' && vscode.env.uiKind === vscode.UIKind.Desktop && !vscode.env.remoteName && vscode.workspace.isTrusted; }
  private assertLocal(): void {
    if (!this.localSupported()) throw new BridgeError('只支持可信的 Windows 本机 VS Code，不支持 Remote、SSH、WSL 或浏览器版。无需打开项目文件夹。');
  }
  private updateStatus(text: string): void {
    this.statusText = text;
    this.status.text = `$(comment-discussion) 圆桌 · ${text}`;
    this.status.tooltip = `${text}\n资料发送至统一收件箱，无需绑定项目。\n${this.pending.length} 条待确认传输。点击查看连接和操作。`;
  }
  getState() { return { connected: !!this.credential, status: this.statusText, pending: this.pending.length, windowId: this.windowId }; }
  async showStatus(): Promise<void> {
    const choices = [{ label: this.credential ? '重新连接模型圆桌' : '连接模型圆桌', id: 'connect' }];
    if (this.pending.length) choices.push({ label: `重试未确认传输（${this.pending.length}）`, id: 'retry' });
    if (this.credential) choices.push({ label: '撤销连接', id: 'disconnect' });
    const option = await vscode.window.showQuickPick(choices, { title: `模型圆桌：${this.statusText}`, placeHolder: '打开模型圆桌，首次发送时在圆桌确认连接即可' });
    if (option) await vscode.commands.executeCommand(`modelRoundtable.${option.id}`);
  }
  async connect(): Promise<void> {
    this.assertLocal();
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async connectOnce(): Promise<void> {
    await this.refreshCredential();
    if (this.credential) {
      try { await this.client.call('GET', '/connection'); await this.registerWindow(); this.startPolling(); return; }
      catch (error) {
        if (!(error instanceof BridgeError) || error.status !== 401) throw error;
        await this.clearCredential();
        if (this.credential) {
          await this.client.call('GET', '/connection'); await this.registerWindow(); this.startPolling(); return;
        }
      }
    }
    const request = { id: randomUUID(), claim: randomBytes(32).toString('base64url'), cancelled: false };
    this.connectionRequest = request;
    try {
      await this.client.call('POST', '/connections', { id: request.id, claim: request.claim, name: `VS Code · ${hostname()}`.slice(0, 100) });
      this.updateStatus('等待圆桌确认连接');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '请在模型圆桌确认连接请求', cancellable: true }, async (_progress, cancellation) => {
        const onCancel = cancellation.onCancellationRequested(() => { request.cancelled = true; void this.cancelConnectionRequest(); });
        try {
          const expires = Date.now() + 5 * 60_000;
          while (!this.disposed && !request.cancelled && Date.now() < expires) {
            if (this.credential) return;
            const result = await this.client.call<ConnectionResult>('POST', `/connections/${request.id}`, { claim: request.claim });
            if (this.credential) return;
            if (request.cancelled || this.disposed) break;
            if (result.status === 'approved') {
              const credential = parseCredential(JSON.stringify(result));
              if (!credential) throw new BridgeError('连接响应无效，请重新连接。');
              // DELETE cancels authorization even after approval. Once claimed, only revoke can remove it.
              if (this.connectionRequest === request) this.connectionRequest = undefined;
              this.credential = credential; this.client.setCredential(credential);
              await this.context.secrets.store(SECRET, JSON.stringify(credential));
              return;
            }
            if (result.status !== 'pending') {
              const reason = { rejected: '圆桌已拒绝连接。需要时可再次手动发送或重新连接。', cancelled: '连接申请已取消。', expired: '连接申请已过期，请重新发送。' }[result.status];
              throw new BridgeError(reason ?? '连接响应无效。');
            }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!this.credential) throw new BridgeError(request.cancelled || this.disposed ? '连接申请已取消。' : '连接申请已过期，请重新发送。');
        } finally { onCancel.dispose(); }
      });
      if (!this.credential || this.disposed) throw new BridgeError('连接申请已取消。');
      await this.registerWindow(); this.startPolling();
      void vscode.window.showInformationMessage('已连接模型圆桌。以后可直接右键发送资料，无需绑定项目。');
    } catch (error) { this.updateStatus(message(error)); throw error; }
    finally { await this.cancelConnectionRequest(); }
  }
  private async cancelConnectionRequest(): Promise<void> {
    const request = this.connectionRequest; if (!request) return;
    this.connectionRequest = undefined; request.cancelled = true;
    try { await this.client.call('DELETE', `/connections/${request.id}`, { claim: request.claim }); } catch {}
  }
  private async clearCredential(): Promise<void> {
    const rejectedToken = this.credential?.token;
    const stored = parseCredential(await this.context.secrets.get(SECRET));
    if (stored && stored.token !== rejectedToken) { await this.refreshCredential(); return; }
    this.stopPolling(); this.credential = undefined; this.client.setCredential(undefined);
    await this.context.secrets.delete(SECRET);
  }
  async disconnect(): Promise<void> {
    await this.cancelConnectionRequest();
    if (!this.credential) return;
    await this.client.call('POST', '/revoke', {});
    await this.clearCredential(); this.updateStatus('已撤销连接');
  }
  private async registerWindow(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath)[0];
    const registered = await this.client.call<{ id: string }>('POST', '/windows', { name: vscode.workspace.name ?? '未打开文件夹的 VS Code 窗口', ...(workspace ? { workspace } : {}) });
    if (typeof registered.id !== 'string') throw new BridgeError('窗口登记响应无效。');
    this.registeredWindowId = registered.id;
    this.updateStatus('已连接');
  }
  async sendText(selectionOnly: boolean): Promise<string> {
    this.assertLocal();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['file', 'untitled'].includes(editor.document.uri.scheme)) throw new BridgeError('请打开本机文本文件或未命名文本。');
    const document = editor.document;
    const range = selectionOnly ? editor.selection : new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length);
    if (selectionOnly && range.isEmpty) throw new BridgeError('请先选择要发送的文本。');
    // Capture the buffer before permission prompts; later edits must not alter this snapshot.
    const content = document.getText(range), dirty = document.isDirty, capturedAt = new Date().toISOString();
    const language = document.languageId, uri = document.uri;
    if (!content.trim()) throw new BridgeError('选中的文本或文件为空。');
    if (content.length > MAX_TEXT) throw new BridgeError('文本超过 20,000 字符，请缩小选区或改为导入知识库。');
    const source = uri.scheme === 'untitled' ? { path: basename(uri.path), untitled: true } : { path: vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri, false) : basename(uri.fsPath), filePath: await localFile(uri.fsPath) };
    const transfer: Transfer = { id: randomUUID(), kind: 'text', text: { ...source, content, startLine: range.start.line + 1, endLine: range.end.line + (range.end.character === 0 && range.end.line > range.start.line ? 0 : 1), language, dirty, capturedAt } };
    await this.deliver(transfer); return transfer.id;
  }
  async importFiles(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<string | undefined> {
    this.assertLocal();
    let files = selected?.length ? selected : uri ? [uri] : undefined;
    if (!files) files = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, openLabel: '送到圆桌确认导入', filters: { '资料文件': ['pdf', 'docx', 'xlsx', 'xls', 'xlsm', 'csv', 'pptx'] } });
    if (!files?.length) return;
    if (files.length > 100) throw new BridgeError('一次最多选择 100 个资料文件。');
    const paths: string[] = [];
    for (const file of files) {
      if (file.scheme !== 'file' || !supportedOffice.test(extname(file.fsPath))) throw new BridgeError('支持 PDF、DOCX、Excel、CSV 和 PPTX；文本文件请使用发送当前文件。');
      paths.push(await localFile(file.fsPath));
    }
    const transfer: Transfer = { id: randomUUID(), kind: 'files', files: [...new Set(paths)] };
    await this.deliver(transfer); return transfer.id;
  }
  private async deliver(transfer: Transfer): Promise<void> {
    // Old unsent project-relative payloads remain visible but cannot be replayed through protocol 2.
    if ('projectId' in transfer || 'target' in transfer || transfer.kind === 'text' && (!transfer.text || !transfer.text.untitled && !transfer.text.filePath) || transfer.kind === 'files' && !transfer.files?.every(isLocalFilePath)) throw new BridgeError('此待传输记录来自旧版，缺少完整来源。请重新发送原资料；也可移除本机旧记录。');
    if (!this.pending.some(item => item.id === transfer.id)) {
      if (this.pending.length >= 20) throw new BridgeError('待确认传输已达 20 条，请先重试或清理待传输资料。');
      this.pending.push(transfer); await this.context.workspaceState.update('pending', this.pending);
    }
    await this.connect();
    const response = await this.client.call<{ id: string; status: string }>('POST', '/transfers', transfer);
    if (response.id !== transfer.id || !response.status) throw new BridgeError('应用未确认资料已持久化，保留同一传输 ID 供手动重试。');
    this.pending = this.pending.filter(item => item.id !== transfer.id); await this.context.workspaceState.update('pending', this.pending);
    this.updateStatus('已连接');
    void vscode.window.showInformationMessage('已送到圆桌收件箱。回到圆桌确认接收，不会自动调用模型。');
  }
  async retry(): Promise<void> {
    this.assertLocal();
    if (!this.pending.length) { void vscode.window.showInformationMessage('没有未确认的传输。'); return; }
    const picked = await vscode.window.showQuickPick(this.pending.map(item => ({ label: item.text?.path ?? item.files?.join('、') ?? item.id, description: item.id, item })), { title: '选择待确认资料', ignoreFocusOut: true });
    if (!picked) return;
    const action = await vscode.window.showQuickPick(['重试发送（保留原传输 ID）', '移除本机待传输记录'], { title: picked.label });
    if (action?.startsWith('重试')) await this.deliver(picked.item);
    else if (action?.startsWith('移除')) { this.pending = this.pending.filter(item => item.id !== picked.item.id); await this.context.workspaceState.update('pending', this.pending); this.updateStatus(this.statusText); }
  }
  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    const generation = ++this.generation;
    this.wake?.(); void this.pollLoop(generation).finally(() => { if (generation === this.generation) this.polling = false; });
  }
  private stopPolling(): void { this.generation++; this.polling = false; this.wake?.(); }
  private async pollLoop(generation: number): Promise<void> {
    let delay = 1000;
    while (!this.disposed && generation === this.generation && this.credential && this.localSupported()) {
      const credential = this.credential;
      try { await this.client.call('GET', '/connection'); await this.registerWindow(); await this.pollOnce(generation); delay = 1000; }
      catch (error) {
        if (generation !== this.generation || this.disposed) return;
        this.updateStatus(message(error));
        if (error instanceof BridgeError && error.status === 401) { if (this.credential === credential) await this.clearCredential(); return; }
        if (error instanceof BridgeError && error.status === 400) return;
        await new Promise<void>(resolve => { const timer = setTimeout(() => { this.wake = undefined; resolve(); }, delay); this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); }; });
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }
  async pollOnce(generation = this.generation): Promise<void> {
    this.assertLocal(); if (!this.credential) throw new BridgeError('尚未连接模型圆桌。');
    const result = await this.client.call<{ items: OutboxItem[] }>('GET', '/outbox', undefined, 35_000);
    if (!Array.isArray(result.items)) throw new BridgeError('收到无效的资料列表。');
    if (this.disposed || generation !== this.generation || !this.credential) return;
    this.updateStatus('已连接');
    for (const item of result.items) {
      if (this.disposed || generation !== this.generation || !this.credential) return;
      if (item.windowId !== this.registeredWindowId || typeof item.id !== 'string') throw new BridgeError('收到不属于当前窗口的资料。');
      if (!this.received.has(item.id)) {
        await this.receive(item);
        this.received.add(item.id); this.received = new Set([...this.received].slice(-500));
        await this.context.workspaceState.update('received', [...this.received]);
      }
      await this.client.call('POST', `/outbox/${encodeURIComponent(item.id)}/ack`, {});
    }
  }
  private async receive(item: OutboxItem): Promise<void> {
    this.assertLocal();
    if (item.kind !== 'markdown' || typeof item.text !== 'string') throw new BridgeError('不支持的编辑器资料类型。');
    if (Buffer.byteLength(item.text) > 1024 * 1024) throw new BridgeError('收到的 Markdown 超过 1 MiB。');
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: item.text });
    await vscode.window.showTextDocument(document, { preview: false });
    try { await vscode.commands.executeCommand('markdown.showPreviewToSide', document.uri); }
    catch { void vscode.window.showWarningMessage('Markdown 已在未保存文档中打开；当前编辑器未启用 Markdown 预览。'); }
  }
  dispose(): void { this.disposed = true; this.stopPolling(); this.client.cancel(); void this.cancelConnectionRequest(); this.status.dispose(); }
}

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const testDiscovery = context.extensionMode === vscode.ExtensionMode.Test ? process.env.ROUNDTABLE_TEST_DISCOVERY : undefined;
  const companion = new Companion(context, testDiscovery); context.subscriptions.push(companion);
  await companion.initialize();
  const register = (name: string, action: (...args: any[]) => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand(`modelRoundtable.${name}`, async (...args: any[]) => {
    try { return await action(...args); } catch (error) { void vscode.window.showErrorMessage(`模型圆桌：${message(error)}`); return undefined; }
  }));
  register('connect', () => companion.connect());
  register('sendSelection', () => companion.sendText(true)); register('sendFile', () => companion.sendText(false));
  register('importFiles', (uri?: vscode.Uri, selection?: vscode.Uri[]) => companion.importFiles(uri, selection));
  register('retry', () => companion.retry()); register('status', () => companion.showStatus()); register('disconnect', () => companion.disconnect());
  return context.extensionMode === vscode.ExtensionMode.Test ? companion : undefined;
}
