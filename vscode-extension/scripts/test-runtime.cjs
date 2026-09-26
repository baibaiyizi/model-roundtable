const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { access, mkdir, readFile, readdir, realpath, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const vscodeVersion = '1.138.0';

async function prepareInstalledExtension(root, tests) {
  assert.equal(process.platform, 'win32', 'The companion currently supports local Windows VS Code');
  const extensionRoot = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const vsix = path.join(extensionRoot, `${manifest.name}-${manifest.version}.vsix`);
  await access(vsix); // Run the package command first; never silently test a source-only extension.
  const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({ version: vscodeVersion, cachePath: path.resolve(extensionRoot, '../.cache/vscode-test') });
  const executableRoot = await realpath(path.dirname(executable));
  const [cliLauncher] = resolveCliArgsFromVSCodeExecutablePath(executable, { reuseMachineInstall: true });
  // Use the official CLI selected by code.cmd, including VS Code's versioned
  // installation layout, without putting fixture paths through a command shell.
  const launcher = await readFile(cliLauncher, 'utf8');
  const match = launcher.match(/"%~dp0\.\.\\([^"\r\n]*resources\\app\\out\\cli\.js)"/i);
  assert.ok(match, 'The selected VS Code must include its original Windows CLI');
  const cli = await realpath(path.join(executableRoot, match[1]));
  const relative = path.relative(executableRoot, cli);
  assert.ok(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'CLI must remain within the selected VS Code installation');
  const extensions = path.join(root, 'extensions'), profile = path.join(root, 'vscode-profile');
  await mkdir(extensions, { recursive: true });
  const runCli = args => new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const child = spawn(executable, [cli, '--user-data-dir', profile, '--extensions-dir', extensions, '--disable-telemetry', ...args], { windowsHide: true, shell: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated VS Code CLI timed out')); }, 120_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`VS Code CLI exited ${code}: ${stderr}\n${stdout}`)); });
  });
  const actualVersion = (await runCli(['--version'])).trim().split(/\r?\n/)[0];
  if (!process.env.VSCODE_EXECUTABLE_PATH) assert.equal(actualVersion, vscodeVersion);
  await runCli(['--install-extension', vsix, '--force']);
  const installed = await runCli(['--list-extensions', '--show-versions']);
  assert.ok(installed.split(/\r?\n/).includes(`${id}@${manifest.version}`), 'The official CLI must report the installed VSIX version');
  let installedPath;
  for (const entry of await readdir(extensions, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extensions, entry.name);
    const metadata = JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8'));
    if (`${metadata.publisher}.${metadata.name}` === id && metadata.version === manifest.version) installedPath = await realpath(candidate);
  }
  assert.ok(installedPath, 'The installed extension directory must exist');
  const runner = path.join(root, 'run-installed-tests.cjs');
  const evidence = { vscodeVersion: actualVersion, extensionId: id, extensionVersion: manifest.version, vsixSha256: createHash('sha256').update(await readFile(vsix)).digest('hex'), installedWithOfficialCLI: true, isolatedExtensions: true, loadedFromInstalledVSIX: true };
  await writeFile(runner, `const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
exports.run = async () => {
  const extension = require('vscode').extensions.getExtension(${JSON.stringify(id)});
  assert.ok(extension, 'Installed companion must be discoverable');
  assert.equal((await fs.realpath(extension.extensionPath)).toLowerCase(), ${JSON.stringify(installedPath.toLowerCase())}, 'Source development extension must not shadow the installed VSIX');
  assert.equal(extension.packageJSON.version, ${JSON.stringify(manifest.version)});
  await require(${JSON.stringify(tests)}).run();
  await fs.writeFile(${JSON.stringify(path.join(root, 'vsix-install-result.json'))}, ${JSON.stringify(JSON.stringify(evidence, null, 2))});
  console.log('PASS: official CLI VSIX installation and installed extension activation');
};
`);
  // Test mode enables the extension's existing isolated discovery hook. Point it
  // at the installed VSIX, never the source checkout, so missing packaged files fail.
  return { executable, driver: installedPath, runner, extensions, profile };
}

module.exports = { prepareInstalledExtension };
