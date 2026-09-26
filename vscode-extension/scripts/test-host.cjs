const { runTests } = require('@vscode/test-electron');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { prepareInstalledExtension } = require('./test-runtime.cjs');

(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'roundtable-vscode-host-'));
  const workspace = path.join(root, '中文 测试项目');
  await mkdir(workspace);
  await writeFile(path.join(workspace, '资料.md'), '# 原始磁盘内容\n不会保存覆盖\n');
  await writeFile(path.join(workspace, '资料.csv'), 'name,value\nhello,1\n');
  const runtime = await prepareInstalledExtension(root, path.resolve(__dirname, '..', 'out', 'test', 'host.test.js'));
  const launchArgs = [ '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--user-data-dir', runtime.profile, '--extensions-dir', runtime.extensions];
  if (process.env.ROUNDTABLE_TEST_DEBUG_PORT) launchArgs.push(`--remote-debugging-port=${process.env.ROUNDTABLE_TEST_DEBUG_PORT}`);
  console.log(`VS Code test workspace: ${root}`);
  await runTests({ vscodeExecutablePath: runtime.executable, extensionDevelopmentPath: runtime.driver, extensionTestsPath: runtime.runner, launchArgs, extensionTestsEnv: { ROUNDTABLE_TEST_ROOT: root, ROUNDTABLE_TEST_DISCOVERY: path.join(root, 'editor-bridge.json') } });
  console.log(`VS Code extension-host verification artifacts: ${root}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
