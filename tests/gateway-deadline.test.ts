import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/main/gateway'
import type { Provider } from '../src/shared/types'

describe('provider deadlines cover stalled JSON response bodies', () => {
  let server: Server
  let gateway: Gateway
  let calls: string[]
  let fixtureDir: string
  beforeEach(async () => {
    calls = []
    fixtureDir = await mkdtemp(join(tmpdir(), 'roundtable-deadline-'))
    await writeFile(join(fixtureDir, 'sample.wav'), Buffer.alloc(44))
    server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        calls.push(request.url ?? '')
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.write('{') // Headers and body begin; the service never finishes JSON.
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const provider: Provider = { id: 'p', name: 'deadline', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, modelIds: [], hasKey: true, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 250 }
    gateway = new Gateway({ getProvider: () => provider, getSecret: async () => 'test-deadline-key' })
  })
  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    // This directory comes directly from mkdtemp, under the explicit test prefix.
    if (!fixtureDir.startsWith(join(tmpdir(), 'roundtable-deadline-'))) throw new Error('Unexpected test directory')
    await rm(fixtureDir, { recursive: true, force: true })
  })
  it.each(['chat', 'embed', 'transcribe', 'discover'] as const)('%s times out after headers without a retry', async operation => {
    const controller = new AbortController()
    let watchdogFired = false
    const watchdog = setTimeout(() => { watchdogFired = true; controller.abort(new Error('test watchdog')); server.closeAllConnections() }, 2000)
    const model = { providerId: 'p', modelId: 'test' }
    try {
      const call = operation === 'chat' ? gateway.chat({ model, system: '', prompt: 'test', maxOutputTokens: 64, signal: controller.signal })
        : operation === 'embed' ? gateway.embed(model, ['test'], controller.signal)
        : operation === 'transcribe' ? gateway.transcribe(model, join(fixtureDir, 'sample.wav'), controller.signal)
        : gateway.discover('p')
      await expect(call).rejects.toThrow('模型服务超时')
      expect(watchdogFired).toBe(false)
      expect(controller.signal.aborted).toBe(false)
      expect(calls).toHaveLength(1)
    } finally { clearTimeout(watchdog); controller.abort() }
  })
})
