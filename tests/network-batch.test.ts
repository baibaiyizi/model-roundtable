import { describe, expect, it, vi } from 'vitest'
import { runNodeTests } from '../src/main/networking/node-tests'
import type { NetworkTestJob } from '../src/shared/network'

const job = (count: number): NetworkTestJob => ({ id: 'batch', status: 'running', items: Array.from({ length: count }, (_, i) => ({ subscriptionId: 's', nodeId: String(i), status: 'waiting' })) })
describe('批量节点检测', () => {
  it('最多同时检测三个节点，逐项记录失败并完成余下检测', async () => {
    const batch = job(9), changed = vi.fn()
    let active = 0, peak = 0
    await runNodeTests(batch, new AbortController().signal, async node => {
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2)); active--
      if (node.nodeId === '2') throw new Error('节点超时')
      return { id: node.nodeId, name: node.nodeId, type: 'http', delayMs: 10 }
    }, changed)
    expect(peak).toBe(3); expect(batch.status).toBe('complete')
    expect(batch.items.filter(item => item.status === 'complete')).toHaveLength(8)
    expect(batch.items[2]).toMatchObject({ status: 'failed', error: '节点超时' }); expect(changed).toHaveBeenCalled()
  })
  it('取消保留已经完成的结果，不启动等待项或接纳迟到结果', async () => {
    const batch = job(7), controller = new AbortController(), started: string[] = []
    const release: Array<() => void> = []
    const running = runNodeTests(batch, controller.signal, async node => {
      started.push(node.nodeId)
      if (node.nodeId !== '0') await new Promise<void>(resolve => release.push(resolve))
      return { id: node.nodeId, name: node.nodeId, type: 'http', delayMs: 12 }
    }, () => {})
    await vi.waitFor(() => expect(batch.items[0].status).toBe('complete'))
    controller.abort(); release.forEach(resolve => resolve()); await running
    expect(started.length).toBeLessThanOrEqual(4); expect(batch.status).toBe('cancelled')
    expect(batch.items[0].result?.delayMs).toBe(12)
    expect(batch.items.slice(1).every(item => item.status === 'cancelled' && !item.result)).toBe(true)
  })
  it('开始前取消不会进行任何节点请求', async () => {
    const batch = job(4), controller = new AbortController(), test = vi.fn()
    controller.abort(); await runNodeTests(batch, controller.signal, test, () => {})
    expect(test).not.toHaveBeenCalled(); expect(batch.items.every(item => item.status === 'cancelled')).toBe(true)
  })
})
