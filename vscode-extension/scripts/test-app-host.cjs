const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { _electron } = require('../../node_modules/@playwright/test');
const { prepareInstalledExtension } = require('./test-runtime.cjs');

async function until(read, predicate, milliseconds = 45_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Timed out waiting for actual Electron / VS Code integration');
}

(async () => {
  const repository = path.resolve(__dirname, '../..');
  const extension = path.resolve(__dirname, '..');
  const root = await mkdtemp(path.join(tmpdir(), 'roundtable-app-vscode-'));
  const profile = path.join(root, 'app-profile'), workspace = path.join(root, '双向 中文项目');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, '资料.md'), '# 磁盘中的原始版本\n本文件不应被扩展保存。\n');
  await writeFile(path.join(workspace, '表格.csv'), 'item,value\n测试,42\n');
  const runtime = await prepareInstalledExtension(root, path.join(extension, 'out/test/app-host.test.js'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== 'ELECTRON_RUN_AS_NODE'));
  let desktop, hostRun;
  try {
    desktop = await _electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [repository], cwd: repository, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: profile, MODEL_ROUNDTABLE_TEST: '1' }, timeout: 30_000 });
    const page = await desktop.firstWindow(); await page.waitForFunction(() => !!window.roundtable?.editorState);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const fixture = { root: workspace };
    await page.evaluate(() => window.roundtable.editorEnable(true));
    await writeFile(path.join(root, 'fixture.json'), JSON.stringify(fixture), { mode: 0o600 });
    console.log(`Actual Electron / VS Code verification artifacts: ${root}`);
    hostRun = runTests({ vscodeExecutablePath: runtime.executable, extensionDevelopmentPath: runtime.driver, extensionTestsPath: runtime.runner,
      launchArgs: [ '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--user-data-dir', runtime.profile, '--extensions-dir', runtime.extensions],
      extensionTestsEnv: { ROUNDTABLE_TEST_ROOT: root, ROUNDTABLE_TEST_DISCOVERY: path.join(profile, 'editor-bridge.json') } });
    // Observe rejection immediately, while the coordinator also waits for received records.
    let hostFailure; hostRun.catch(error => { hostFailure = error; });
    const requestState = await until(async () => { if (hostFailure) throw hostFailure; return page.evaluate(() => window.roundtable.editorState()); }, state => state.connectionRequests.length === 1);
    await page.evaluate(requestId => window.roundtable.editorResolveConnection({ requestId, allow: true }), requestState.connectionRequests[0].id);
    const state = await until(async () => { if (hostFailure) throw hostFailure; return page.evaluate(() => window.roundtable.editorState()); }, state => state.transfers.length === 2 && state.windows.length === 1);
    const text = state.transfers.find(item => item.kind === 'text'), files = state.transfers.find(item => item.kind === 'files');
    assert.equal(text.status, 'pending'); assert.equal(text.text.content, '尚未保存的真实选区\n'); assert.equal(text.text.dirty, true);
    assert.equal(text.text.path, '资料.md'); assert.equal(text.text.startLine, 2); assert.equal(text.text.endLine, 2); assert.match(text.text.sha256, /^[a-f0-9]{64}$/);
    assert.equal(files.status, 'pending'); assert.deepEqual(files.files.map(file => file.toLowerCase()), [path.join(workspace, '表格.csv').toLowerCase()]);
    const before = await page.evaluate(() => window.roundtable.bootstrap());
    assert.equal(before.sessions.length, 0); assert.equal(before.executions.length, 0); assert.equal(before.sources.length, 0); assert.equal(before.providers.length, 0);
    const markdown = '# 来自真实模型圆桌的总结\n\n真实 Electron IPC → 回环桥接 → VS Code 未保存 Markdown。';
    await page.evaluate(input => window.roundtable.editorSend(input), { title: '真实双向验收', text: markdown, windowId: state.windows[0].id });
    await hostRun;
    const hostReport = JSON.parse(await readFile(path.join(root, 'host-result.json'), 'utf8'));
    assert.equal(hostReport.markdown, markdown); assert.equal(hostReport.untitled, true); assert.equal(hostReport.preview, true);
    const after = await page.evaluate(() => window.roundtable.bootstrap());
    assert.equal(after.sessions.length, 0); assert.equal(after.executions.length, 0); assert.equal(after.sources.length, 0);
    assert.match(await readFile(path.join(workspace, '资料.md'), 'utf8'), /磁盘中的原始版本/); assert.deepEqual(errors, []);
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: path.join(root, 'electron.png') });
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, appVersion: after.version, vscodeVersion: hostReport.version, noWorkspaceRequired: true, noAppProjectRequired: true, firstSendConsent: true, dirtyTextPersisted: true, sourceHashPersisted: true, csvImportPending: true, receivedUntitledMarkdown: true, builtInMarkdownPreview: true, createdSessions: 0, createdExecutions: 0, importedSources: 0, configuredProviders: 0, diskUnchanged: true, rendererErrors: errors }, null, 2));
    console.log('PASS: actual Electron IPC and actual VS Code extension host bidirectional integration');
  } finally { await desktop?.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
