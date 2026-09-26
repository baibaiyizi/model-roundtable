import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Companion } from '../src/extension';

export async function run(): Promise<void> {
  const root = process.env.ROUNDTABLE_TEST_ROOT!, projectRoot = join(root, '中文 测试项目');
  const captures: any[] = [], receipts: string[] = [], requests: any[] = [];
  let revoked = false, outbound: any[] = [], rejectFirst = false, windowId = '', decision = 'approved', approvedId = '';
  const cancelled: string[] = [];
  const server = createServer(async (req, res) => {
    let data = ''; for await (const part of req) data += part;
    const body = data ? JSON.parse(data) : undefined;
    const url = new URL(req.url!, 'http://127.0.0.1'); res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/connections') { assert.ok(body.id); assert.match(body.claim, /^[\w-]{43}$/); requests.push(body); res.end('{"status":"pending"}'); return; }
    if (url.pathname.startsWith('/connections/')) {
      const id = url.pathname.split('/').at(-1); assert.equal(body.claim, requests.find(item => item.id === id).claim);
      if (req.method === 'DELETE') cancelled.push(id!);
      const status = req.method === 'DELETE' ? 'cancelled' : id === approvedId ? 'approved' : decision;
      res.end(JSON.stringify({ status, ...(status === 'approved' ? { clientId: 'client-1', token: 'test-private-token' } : {}) })); return;
    }
    assert.equal(req.headers.authorization, 'Bearer test-private-token');
    if (url.pathname === '/connection') res.end('{"clientId":"client-1"}');
    else if (url.pathname === '/windows') { windowId = req.headers['x-editor-window-id'] as string; res.end(JSON.stringify({ id: windowId })); }
    else if (url.pathname === '/transfers') {
      assert.equal(body.projectId, undefined); assert.equal(body.target, undefined); captures.push(body);
      if (rejectFirst) { rejectFirst = false; req.socket.destroy(); return; }
      res.end(JSON.stringify({ id: body.id, status: 'pending' }));
    } else if (url.pathname === '/outbox') {
      assert.equal(url.search, '');
      setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ items: outbound })); }, 100);
    } else if (url.pathname.endsWith('/ack')) { assert.deepEqual(body, {}); receipts.push(url.pathname); outbound = []; res.end('{"ok":true}'); }
    else if (url.pathname === '/revoke') { revoked = true; res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(process.env.ROUNDTABLE_TEST_DISCOVERY!, JSON.stringify({ protocol: 2, port: (server.address() as { port: number }).port }));
  let companion: Companion | undefined;
  try {
    const extension = vscode.extensions.getExtension<Companion>('model-roundtable.model-roundtable-companion');
    assert.ok(extension); companion = await extension.activate();
    assert.equal(requests.length, 0, 'startup does not create a connection request');
    assert.equal(vscode.workspace.workspaceFolders, undefined, 'this real host has no workspace folder');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(projectRoot, '资料.md')));
    const editor = await vscode.window.showTextDocument(document);
    await editor.edit(builder => builder.replace(new vscode.Range(0, 0, document.lineCount, 0), '# 未保存内容\n第二行\n第三行\n'));
    editor.selection = new vscode.Selection(1, 0, 2, 0);
    const transferId = await companion.sendText(true);
    assert.equal(requests.length, 1, 'first send obtains a connection without pairing or targets');
    assert.equal(captures[0].text.content, '第二行\n'); assert.equal(captures[0].text.dirty, true);
    assert.equal(captures[0].text.startLine, 2); assert.equal(captures[0].text.endLine, 2);
    assert.equal(captures[0].text.path, '资料.md'); assert.equal(captures[0].id, transferId);
    assert.equal(captures[0].text.filePath.toLowerCase(), join(projectRoot, '资料.md').toLowerCase());
    assert.match(await readFile(join(projectRoot, '资料.md'), 'utf8'), /原始磁盘内容/);
    await companion.sendText(false); assert.match(captures[1].text.content, /未保存内容/);
    await companion.importFiles(vscode.Uri.file(join(projectRoot, '资料.csv'))); assert.deepEqual(captures[2].files.map((file: string) => file.toLowerCase()), [join(projectRoot, '资料.csv').toLowerCase()]);
    rejectFirst = true;
    await assert.rejects(companion.sendText(true), /无法连接/);
    assert.equal(companion.getState().pending, 1);
    const pendingTransfer = captures[3]; await (companion as any).deliver(pendingTransfer);
    assert.equal(captures[4].id, pendingTransfer.id); assert.equal(companion.getState().pending, 0);
    await assert.rejects((companion as any).deliver({ id: 'old', projectId: 'old-project', kind: 'text', text: { path: 'old.md', content: 'old' } }), /来自旧版/);
    const untitled = await vscode.workspace.openTextDocument({ content: '无需保存的未命名文本', language: 'markdown' });
    await vscode.window.showTextDocument(untitled); await companion.sendText(false);
    assert.equal(captures[5].text.untitled, true); assert.equal(captures[5].text.filePath, undefined);
    const huge = await vscode.workspace.openTextDocument({ content: '字'.repeat(20_001) });
    await vscode.window.showTextDocument(huge); await assert.rejects(companion.sendText(false), /20,000/); assert.equal(captures.length, 6);
    assert.equal(requests.length, 1, 'later sends reuse authorization');
    assert.ok(!cancelled.includes(requests[0].id), 'successful claim is never cancelled or revoked by SecretStorage change');
    outbound = [{ id: 'markdown-1', windowId, kind: 'markdown', text: '# 圆桌总结\n\n实际 Markdown 预览验证。' }];
    await until(() => receipts.length === 1);
    const received = vscode.workspace.textDocuments.find(item => item.isUntitled && item.getText().includes('实际 Markdown 预览验证'));
    assert.ok(received); assert.equal(received.languageId, 'markdown');
    assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview));
    outbound = [{ id: 'markdown-1', windowId, kind: 'markdown', text: '# 圆桌总结\n\n实际 Markdown 预览验证。' }];
    await until(() => receipts.length === 2);
    assert.equal(vscode.workspace.textDocuments.filter(item => item.isUntitled && item.getText().includes('实际 Markdown 预览验证')).length, 1);
    await companion.disconnect(); assert.equal(revoked, true); assert.equal(companion.getState().connected, false);
    decision = 'rejected'; await assert.rejects(companion.connect(), /已拒绝/);
    await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(requests.length, 2, 'refusal never loops into another request');
    decision = 'expired'; await assert.rejects(companion.connect(), /已过期/);
    decision = 'pending';
    const InstalledCompanion = companion.constructor as typeof Companion;
    const second = new InstalledCompanion((companion as any).context, process.env.ROUNDTABLE_TEST_DISCOVERY);
    try {
      await second.initialize();
      const count = requests.length, firstConnection = companion.connect(), otherConnection = second.connect();
      await until(() => requests.length === count + 2); approvedId = requests[count].id;
      await Promise.all([firstConnection, otherConnection]);
      assert.equal(companion.getState().connected, true); assert.equal(second.getState().connected, true);
      assert.ok(cancelled.includes(requests[count + 1].id), 'shared SecretStorage credential cancels only the other pending request');
      assert.ok(!cancelled.includes(approvedId), 'approved request is not cancelled');
      await companion.disconnect(); await until(() => !second.getState().connected);
      const cancelledConnection = companion.connect();
      await until(() => requests.length === count + 3);
      await (companion as any).cancelConnectionRequest();
      await assert.rejects(cancelledConnection, /取消/);
    } finally { second.dispose(); }
    await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, version: vscode.version, cases: ['no workspace required', 'first-send consent and connection reuse', 'dirty selection snapshot and whole file', 'absolute CSV import request', 'retained transfer retry ID and old payload rejection', 'untitled source and text length', 'untitled Markdown and real built-in preview', 'duplicate ACK idempotency', 'revocation/rejection/expiry/cancellation without automatic re-request', 'shared SecretStorage event reuses credential and cancels competing request'], modelRequests: 0 }, null, 2));
    console.log('PASS: real VS Code extension-host protocol 2 integration');
  } finally { companion?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function until(predicate: () => boolean): Promise<void> { const end = Date.now() + 10_000; while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for editor receipt'); await new Promise(resolve => setTimeout(resolve, 50)); } }
