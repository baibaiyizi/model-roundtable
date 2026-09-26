import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient, BridgeError, localFile, isLocalFilePath } from '../src/client';

test('transport stays on loopback, supplies credentials, and rejects redirects without following them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-ext-'));
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.url!);
    assert.equal(req.headers.authorization, 'Bearer private-token');
    assert.equal(req.headers['x-editor-window-id'], 'window-one');
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://example.com/' }); res.end('{}'); }
    else if (req.url === '/broken') res.end('not json');
    else if (req.url === '/unauthorized') { res.writeHead(401); res.end('{"error":"revoked"}'); }
    else res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const discovery = join(root, 'editor-bridge.json');
    await writeFile(discovery, JSON.stringify({ protocol: 2, port: (server.address() as { port: number }).port }));
    const client = new BridgeClient(discovery, 'window-one', { clientId: 'a', token: 'private-token' });
    assert.deepEqual(await client.call('POST', '/test', { test: true }), { ok: true });
    await assert.rejects(client.call('GET', '/redirect'), error => error instanceof BridgeError && error.status === 302);
    await assert.rejects(client.call('GET', '/broken'), /无法解析/);
    await assert.rejects(client.call('GET', '/unauthorized'), error => error instanceof BridgeError && error.status === 401);
    await assert.rejects(client.call('GET', '//example.com'), /无效/);
    assert.deepEqual(received, ['/test', '/redirect', '/broken', '/unauthorized']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('cancel and timeout reject in-flight calls; invalid discovery never sends a request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-ext-'));
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const discovery = join(root, 'editor-bridge.json');
    await writeFile(discovery, JSON.stringify({ protocol: 2, port: (server.address() as { port: number }).port }));
    const client = new BridgeClient(discovery, 'one');
    await assert.rejects(client.call('GET', '/wait', undefined, 20), /超时/);
    const pending = client.call('GET', '/wait');
    setTimeout(() => client.cancel(), 20);
    await assert.rejects(pending, /取消/);
    await writeFile(discovery, '{"protocol":1,"port":5}');
    await assert.rejects(client.call('GET', '/test'), /版本或端口无效/);
    await assert.rejects(new BridgeClient(join(root, 'missing'), 'one').call('GET', '/test'), /尚未启动/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('local paths accept files outside a workspace and reject non-local or non-file sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-ext-'));
  const project = join(root, '中文 项目'); const outside = join(root, 'outside');
  await mkdir(project); await mkdir(outside); await writeFile(join(project, '资料.md'), 'hello'); await writeFile(join(outside, '资料.txt'), 'other');
  try {
    assert.equal(await localFile(join(project, '资料.md')), join(project, '资料.md'));
    assert.equal(await localFile(join(outside, '资料.txt')), join(outside, '资料.txt'));
    await symlink(outside, join(project, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(await localFile(join(project, 'link', '资料.txt')), join(project, 'link', '资料.txt'), 'preserve source link path for the application to detect changed targets');
    await assert.rejects(localFile(project), /普通文件/);
    assert.equal(isLocalFilePath('relative.md'), false);
    assert.equal(isLocalFilePath('//server/share/file.md'), false);
    await assert.rejects(localFile('//server/share/file.md'), /网络共享/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
