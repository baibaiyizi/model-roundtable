import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { BridgeError } from '../src/client';

test('menu context follows public workspace trust and runtime rejects remote or untrusted sends', async () => {
  const contexts: [string, boolean][] = [], granted: (() => void)[] = [];
  const noopDisposable = { dispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 }, UIKind: { Desktop: 1 },
    env: { uiKind: 1, remoteName: undefined as string | undefined },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
    workspace: { isTrusted: false, onDidGrantWorkspaceTrust: (callback: () => void) => { granted.push(callback); return noopDisposable; } },
    commands: { executeCommand: async (_command: string, key: string, value: boolean) => { contexts.push([key, value]); } }
  };
  const source = join(__dirname, '../src/extension.js'), requireModule = createRequire(source), exports: Record<string, any> = {};
  const compiled = runInNewContext(`(function(require,exports){${await readFile(source, 'utf8')}\n})`, { process, setTimeout, clearTimeout, Buffer });
  compiled((id: string) => id === 'vscode' ? vscode : requireModule(id), exports);
  let storedCredential: string | undefined;
  const context = { subscriptions: [], secrets: { get: async () => storedCredential, onDidChange: () => noopDisposable }, workspaceState: { get: (_key: string, defaultValue: unknown) => defaultValue } };
  const companion = new exports.Companion(context);
  try {
    await companion.initialize(); assert.deepEqual(contexts.at(-1), ['modelRoundtable.canSend', false]);
    await assert.rejects(companion.sendText(false), /可信的 Windows/);
    vscode.workspace.isTrusted = true; granted[0]();
    assert.deepEqual(contexts.at(-1), ['modelRoundtable.canSend', process.platform === 'win32']);
    vscode.env.remoteName = 'ssh-remote';
    await companion.initialize(); assert.deepEqual(contexts.at(-1), ['modelRoundtable.canSend', false]);
    await assert.rejects(companion.connect(), /不支持 Remote/);
    vscode.env.remoteName = undefined; vscode.env.uiKind = 2;
    await assert.rejects(companion.connect(), /浏览器版/);
    vscode.env.uiKind = 1;
    storedCredential = JSON.stringify({ clientId: 'old', token: 'old-token' });
    companion.credential = JSON.parse(storedCredential);
    companion.client.setCredential(companion.credential);
    let rejectOld = true, requests = 0;
    companion.client.call = async (_method: string, route: string) => {
      if (route === '/connection' && rejectOld) { rejectOld = false; storedCredential = JSON.stringify({ clientId: 'new', token: 'new-token' }); throw new BridgeError('old revoked', 401); }
      if (route === '/windows') return { id: 'new:window' };
      if (route === '/outbox') return new Promise(() => {});
      if (route === '/connections') requests++;
      return {};
    };
    await companion.connect();
    assert.equal(requests, 0, 'late old-token rejection must reuse the new shared credential without another consent request');
  } finally { companion.dispose(); }
});
