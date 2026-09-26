import type { NetworkNode, NetworkNodeRef, NetworkTestJob } from '../../shared/network'

/** One explicitly requested batch. Results remain visible; cancellation never starts queued tests. */
export async function runNodeTests(job: NetworkTestJob, signal: AbortSignal, test: (node: NetworkNodeRef, signal: AbortSignal) => Promise<NetworkNode>, changed: () => void): Promise<void> {
  let cursor = 0
  const worker = async () => {
    while (!signal.aborted && cursor < job.items.length) {
      const item = job.items[cursor++]
      item.status = 'running'; changed()
      try {
        const result = await test(item, signal)
        if (signal.aborted) item.status = 'cancelled'
        else { item.result = result; item.error = result.error; item.status = result.error ? 'failed' : 'complete' }
      } catch (error) {
        item.status = signal.aborted ? 'cancelled' : 'failed'
        if (!signal.aborted) item.error = error instanceof Error ? error.message : '节点检测失败'
      }
      changed()
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, job.items.length) }, worker))
  for (const item of job.items) if (item.status === 'waiting') item.status = 'cancelled'
  job.status = signal.aborted ? 'cancelled' : 'complete'; changed()
}
