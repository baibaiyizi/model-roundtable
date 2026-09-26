import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createServer, request as requestHttp, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { once } from 'node:events'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import type { AppAPI } from '../../src/shared/types'

declare global { interface Window { roundtable: AppAPI } }

type ObservedRequest = { route: string; model: string; authorization?: string }

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as { port: number }).port
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
}

/** Real HTTP proxy, including CONNECT as used by Mihomo's HTTP outbound. */
async function taggedProxy(route: string, upstreamPort: number) {
  const seen: ObservedRequest[] = []
  const sockets = new Set<Socket>()
  const forward = async (incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const payload = JSON.parse(body.toString()) as { model: string }
    seen.push({ route, model: payload.model, authorization: incoming.headers.authorization })
    const outgoing = requestHttp({ hostname: '127.0.0.1', port: upstreamPort, path: '/v1/chat/completions', method: 'POST', headers: { ...incoming.headers, 'x-fixture-route': route, host: `127.0.0.1:${upstreamPort}`, connection: 'close' } }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers)
      result.pipe(response)
    })
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    outgoing.end(body)
  }
  const handler = (incoming: IncomingMessage, response: ServerResponse) => { void forward(incoming, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) }
  const relay = createServer(handler)
  const relayPort = await listen(relay)
  const proxy = createServer(handler)
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  proxy.on('connect', (incoming, client, head) => {
    if (incoming.url !== `127.0.0.1:${upstreamPort}`) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const target = connect(relayPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      client.pipe(target); target.pipe(client)
    })
    sockets.add(target); target.on('close', () => sockets.delete(target))
    target.on('error', () => client.destroy()); client.on('error', () => target.destroy())
    client.on('close', () => target.destroy())
  })
  const port = await listen(proxy)
  return { port, seen, close: async () => { for (const socket of sockets) socket.destroy(); await close(proxy); await close(relay) } }
}

test('packaged Electron and bundled Mihomo isolate concurrent provider routes and fail closed when a node disappears', async () => {
  const root = resolve('.')
  const directory = join(root, '.test-data', `network-routing-${Date.now()}`)
  await mkdir(directory, { recursive: true })
  const received: ObservedRequest[] = []
  let holdNextStream = false
  let releaseStream: (() => void) | undefined
  const upstream = createServer((incoming, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; stream?: boolean }
      const route = String(incoming.headers['x-fixture-route'] ?? 'direct')
      received.push({ route, model: payload.model, authorization: incoming.headers.authorization })
      if (payload.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: `fixture-${payload.model}`, choices: [{ index: 0, delta: { content: `${route}:${payload.model}` }, finish_reason: null }] })}\n\n`)
        const finish = () => response.end(`data: ${JSON.stringify({ id: `fixture-${payload.model}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`)
        if (holdNextStream) { holdNextStream = false; releaseStream = finish }
        else finish()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `fixture-${payload.model}`, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: `${route}:${payload.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }))
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  const upstreamPort = await listen(upstream)
  const proxyA = await taggedProxy('A', upstreamPort)
  const proxyB = await taggedProxy('B', upstreamPort)
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message))
    await expect(page.locator('.welcome-page')).toBeVisible()
    const models = await page.evaluate(async ({ proxyPorts, upstreamPort }) => {
      // This goes through the shipped IPC, encrypted store, component unpacking and actual core validation.
      const state = await window.roundtable.importNetworkSubscription({ name: '并发出口验收', content: `proxies:\n  - name: 线路 A\n    type: http\n    server: 127.0.0.1\n    port: ${proxyPorts[0]}\n  - name: 线路 B\n    type: http\n    server: 127.0.0.1\n    port: ${proxyPorts[1]}\n` })
      const subscription = state.subscriptions[0]
      const models = []
      for (const label of ['A', 'B', 'direct']) {
        const modelId = `model-${label}`
        const provider = await window.roundtable.saveProvider({ name: `出口 ${label}`, apiKey: `synthetic-key-${label}`, baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, modelIds: [modelId], tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 15000, network: label === 'direct' ? { mode: 'direct' } : { mode: 'subscription', subscriptionId: subscription.id, nodeId: subscription.nodes.find(node => node.name === `线路 ${label}`)!.id } })
        models.push({ providerId: provider.id, modelId })
      }
      return models
    }, { proxyPorts: [proxyA.port, proxyB.port], upstreamPort })
    for (let round = 0; round < 3; round++) {
      const replies = await page.evaluate(models => Promise.all(models.map(model => window.roundtable.testModel(model))), models)
      expect(replies.map(reply => reply.text)).toEqual(['A:model-A', 'B:model-B', 'direct:model-direct'])
    }
    expect(received).toHaveLength(9)
    expect(proxyA.seen).toEqual(Array.from({ length: 3 }, () => ({ route: 'A', model: 'model-A', authorization: 'Bearer synthetic-key-A' })))
    expect(proxyB.seen).toEqual(Array.from({ length: 3 }, () => ({ route: 'B', model: 'model-B', authorization: 'Bearer synthetic-key-B' })))
    expect(received.filter(item => item.route === 'direct')).toEqual(Array.from({ length: 3 }, () => ({ route: 'direct', model: 'model-direct', authorization: 'Bearer synthetic-key-direct' })))
    expect((await page.evaluate(() => window.roundtable.getNetworkState())).core.phase).toBe('running')

    holdNextStream = true
    const discussion = await page.evaluate(models => window.roundtable.createSession({ title: '活动线路快照验收', topic: '固定当前发言使用的网络线路。', mode: 'roundtable', participants: [{ id: 'a', name: '成员 A', role: '', model: models[0] }, { id: 'direct', name: '直连成员', role: '', model: models[2] }], knowledgeBaseIds: [], searchEnabled: false, limits: { autoTurns: 12, maxCalls: 10, maxOutputTokens: 100, maxSearches: 0, contextChars: 8000 } }), models)
    await expect.poll(() => !!releaseStream).toBe(true)
    expect(received.at(-1)).toEqual({ route: 'A', model: 'model-A', authorization: 'Bearer synthetic-key-A' })
    const originalSelection = await page.evaluate(async models => {
      const providers = (await window.roundtable.bootstrap()).providers
      const current = providers.find(provider => provider.id === models[0].providerId)!
      const target = providers.find(provider => provider.id === models[1].providerId)!
      const { hasKey: _hasKey, structuredOutputs: _structuredOutputs, ...input } = current
      await window.roundtable.saveProvider({ ...input, network: target.network })
      return current.network!
    }, models)
    expect((await page.evaluate(() => window.roundtable.getNetworkState())).pending).toBe(true)
    await page.evaluate(id => window.roundtable.sessionAction({ sessionId: id, action: 'pause' }), discussion.id)
    releaseStream!(); releaseStream = undefined
    await expect.poll(async () => page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(item => item.id === id)?.status, discussion.id)).toBe('paused')
    const paused = await page.evaluate(async id => (await window.roundtable.bootstrap()).sessions.find(item => item.id === id)!, discussion.id)
    expect(paused.messages.filter(message => message.kind === 'assistant')).toHaveLength(1)
    expect(paused.messages.at(-1)).toMatchObject({ status: 'complete', content: 'A:model-A', network: { selection: originalSelection } })
    await expect.poll(async () => (await page.evaluate(() => window.roundtable.getNetworkState())).pending).toBe(false)
    expect((await page.evaluate(model => window.roundtable.testModel(model), models[0])).text).toBe('B:model-A')
    expect(proxyB.seen.at(-1)).toEqual({ route: 'B', model: 'model-A', authorization: 'Bearer synthetic-key-A' })
    await page.evaluate(async ({ model, network }) => {
      const { hasKey: _hasKey, structuredOutputs: _structuredOutputs, ...input } = (await window.roundtable.bootstrap()).providers.find(provider => provider.id === model.providerId)!
      await window.roundtable.saveProvider({ ...input, network })
    }, { model: models[0], network: originalSelection })
    await expect.poll(async () => (await page.evaluate(() => window.roundtable.getNetworkState())).pending).toBe(false)

    await proxyA.close()
    const countBeforeNodeFailure = received.length
    const modelACount = received.filter(item => item.model === 'model-A').length
    const afterFailure = await page.evaluate(models => Promise.all(models.map(async model => {
      try { return { ok: true, text: (await window.roundtable.testModel(model)).text } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    })), models)
    expect(afterFailure[0].ok).toBe(false)
    expect(afterFailure[0].error).toBeTruthy()
    expect(afterFailure.slice(1)).toEqual([{ ok: true, text: 'B:model-B' }, { ok: true, text: 'direct:model-direct' }])
    // A's failed call must not reach the still-available upstream through a direct fallback or another node.
    expect(received).toHaveLength(countBeforeNodeFailure + 2)
    expect(received.filter(item => item.model === 'model-A')).toHaveLength(modelACount)
    expect(received.slice(countBeforeNodeFailure).every(item => item.route === item.model.slice('model-'.length))).toBe(true)

    if (process.platform === 'win32') {
      const runtimeRoot = join(directory, 'profile', 'network', 'runtime')
      const owners = await Promise.all((await readdir(runtimeRoot)).filter(name => name.startsWith('core-')).map(async name => {
        const child = join(runtimeRoot, name)
        const owner = JSON.parse(await readFile(join(child, 'owner.json'), 'utf8')) as { pid: number; executable: string; directory: string; created: string }
        expect(owner.directory).toBe(child)
        return owner
      }))
      expect(owners).toHaveLength(1)
      // Verify PID, executable, start time and private directory before terminating only this fixture's child.
      const encoded = Buffer.from(JSON.stringify(owners[0])).toString('base64')
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$ErrorActionPreference='Stop'; $expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $ownedCore=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$expected.pid); if (-not $ownedCore -or $ownedCore.ExecutablePath -ine $expected.executable -or $ownedCore.CreationDate.ToUniversalTime().ToString('o') -ne $expected.created -or -not $ownedCore.CommandLine.Contains($expected.directory)) { throw 'Fixture core identity did not match' }; Stop-Process -Id $ownedCore.ProcessId -Force; 'stopped'`], { windowsHide: true, timeout: 15000 })
      expect(result.stdout.trim()).toBe('stopped')
      await expect.poll(async () => (await page.evaluate(() => window.roundtable.getNetworkState())).core.phase).toBe('failed')
      const countBeforeCoreFailure = received.length
      const afterCrash = await page.evaluate(models => Promise.all(models.map(async model => {
        try { return { ok: true, text: (await window.roundtable.testModel(model)).text } }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      })), models)
      expect(afterCrash.slice(0, 2).map(result => result.ok)).toEqual([false, false])
      expect(afterCrash[2]).toEqual({ ok: true, text: 'direct:model-direct' })
      expect(received.slice(countBeforeCoreFailure)).toEqual([{ route: 'direct', model: 'model-direct', authorization: 'Bearer synthetic-key-direct' }])
    }
    expect(errors).toEqual([])
  } finally {
    releaseStream?.()
    await desktop?.close()
    await proxyA.close(); await proxyB.close(); await close(upstream)
  }
})
