import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionManager } from '../src/main/execution/manager'
import type { ExecutionStore } from '../src/main/execution/ports'
import type { Execution } from '../src/shared/execution'
import type { GatewayPort } from '../src/shared/ports'

describe('execution review structured result persistence', () => {
  it.each([
    { text: '<think>核对变更。</think>```json\n{"verdict":"pass","findings":"文件已修改"}\n```', finishReason: 'stop', status: 'complete', verdict: 'pass', code: undefined },
    { text: '正文不是 JSON', finishReason: 'stop', status: 'failed', verdict: 'failed', code: 'invalid_json' },
    { text: '{"verdict":"pass","findings":"文件已修改"}', finishReason: 'length', status: 'failed', verdict: 'failed', code: 'truncated' },
  ])('keeps the actual review response and diagnosis: $status/$code', async sample => {
    const directory = await mkdtemp(join(tmpdir(), 'review-json-')), stateDir = await mkdtemp(join(tmpdir(), 'review-state-'))
    const executions = new Map<string, Execution>()
    const store: ExecutionStore = {
      getProject: () => ({ id: 'project', name: '项目', directory, instructions: '', knowledgeBaseIds: [], createdAt: '', updatedAt: '' }),
      getProvider: () => ({ id: 'p', name: 'test', baseUrl: 'https://example.invalid/v1', modelIds: ['test'], hasKey: false, tokenParameter: 'max_tokens', streamUsage: true, timeoutMs: 1000 }),
      getSecret: async () => '', getSession: () => undefined,
      getExecution: id => structuredClone(executions.get(id)), saveExecution: value => { executions.set(value.id, structuredClone(value)) }, listExecutions: () => [...executions.values()],
    }
    const gateway: GatewayPort = { embed: async () => [], transcribe: async () => '', chat: vi.fn(async request => {
      expect(request.structured?.name).toBe('execution_review'); expect(request.prompt).toContain('proof.txt')
      return { text: sample.text, finishReason: sample.finishReason, responseId: 'review-response', usage: { totalTokens: 22 } }
    }) }
    const manager = new ExecutionManager(store, gateway, { stateDir, runtimeDir: '', backendFactory: () => ({ run: async context => { context.reserveCall(); await writeFile(join(directory, 'proof.txt'), '已修改'); return '已写文件' } }) }, () => {})
    try {
      const model = { providerId: 'p', modelId: 'test' }
      const execution = manager.create({ projectId: 'project', task: '写文件', acceptance: '文件已修改', executor: model, reviewers: [model], maxCalls: 2, maxOutputTokens: 1500, timeoutMs: 10000, maxRepairRounds: 0 })
      await manager.start(execution.id)
      await vi.waitFor(() => expect(store.getExecution(execution.id)?.status).toBe(sample.status))
      const result = store.getExecution(execution.id)!
      expect(result.calls).toBe(2); expect(gateway.chat).toHaveBeenCalledTimes(1)
      expect(result.reviews[0]).toMatchObject({ verdict: sample.verdict, rawResponse: sample.text, usage: { totalTokens: 22 }, diagnostic: { responseId: 'review-response', finishReason: sample.finishReason, maxOutputTokens: 1500 } })
      expect(result.reviews[0].diagnostic?.code).toBe(sample.code)
    } finally { await manager.shutdown() }
  })
})
