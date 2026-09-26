import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Companion } from '../src/extension';

export async function run(): Promise<void> {
  const root = process.env.ROUNDTABLE_TEST_ROOT!;
  const fixture = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8')) as { root: string };
  const extension = vscode.extensions.getExtension<Companion>('model-roundtable.model-roundtable-companion'); assert.ok(extension);
  const companion = await extension.activate();
  try {
    assert.equal(vscode.workspace.workspaceFolders, undefined);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixture.root, '资料.md')));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(builder => builder.replace(new vscode.Range(0, 0, doc.lineCount, 0), '# 本地缓冲区内容\n尚未保存的真实选区\n保留第三行\n'));
    editor.selection = new vscode.Selection(1, 0, 2, 0);
    await companion.sendText(true);
    await companion.importFiles(vscode.Uri.file(join(fixture.root, '表格.csv')));
    const deadline = Date.now() + 45_000;
    let received: vscode.TextDocument | undefined;
    while (!received && Date.now() < deadline) {
      received = vscode.workspace.textDocuments.find(item => item.isUntitled && item.getText().startsWith('# 来自真实模型圆桌的总结'));
      if (!received) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(received, 'actual app sent a Markdown document through its real bridge');
    let preview = false;
    while (!preview && Date.now() < deadline) {
      preview = vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputWebview);
      if (!preview) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(preview, 'actual Markdown preview opened');
    await writeFile(join(root, 'host-result.json'), JSON.stringify({ version: vscode.version, markdown: received.getText(), untitled: received.isUntitled, preview }, null, 2));
    console.log('PASS: actual Electron bridge received dirty text and returned Markdown');
  } finally { companion.dispose(); }
}
