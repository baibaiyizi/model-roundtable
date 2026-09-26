import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { DocumentTools } from './ports'
import { APP_VERSION } from '../../shared/build'

export class DocumentsMcp {
  readonly token = randomBytes(32).toString('hex')
  url = ''
  private calls = new Set<Promise<unknown>>()
  private handler = createMcpHandler(() => {
    const mcp = new Server({ name: 'model-roundtable-documents', version: APP_VERSION }, { capabilities: { tools: {} } })
    mcp.setRequestHandler('tools/list', () => ({ tools: this.tools.tools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema, type: 'object' as const } })) }))
    mcp.setRequestHandler('tools/call', async request => {
      this.signal.throwIfAborted()
      if (!this.tools.tools.some(tool => tool.name === request.params.name)) throw new Error('不支持的工具。')
      const pending = this.tools.call(this.directory, request.params.name, request.params.arguments ?? {}, this.signal)
      this.calls.add(pending)
      try {
        const output = await pending
        this.signal.throwIfAborted()
        return { content: [{ type: 'text', text: JSON.stringify(output) }] }
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '文档工具失败。' }] } }
      finally { this.calls.delete(pending) }
    })
    return mcp
  })
  private nodeHandler = toNodeHandler(this.handler)
  private server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${this.token}` || this.signal.aborted) { res.writeHead(403); res.end(); return }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    void this.nodeHandler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
  })
  constructor(private tools: DocumentTools, private directory: string, private signal: AbortSignal) {}
  async start(): Promise<void> {
    this.signal.throwIfAborted()
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('文档工具服务启动失败。')
    this.url = `http://127.0.0.1:${address.port}/mcp`
  }
  async close(): Promise<void> {
    await this.handler.close()
    this.server.closeAllConnections()
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
    // Keep the project write lease until cancelled document workers really exit.
    await Promise.allSettled([...this.calls])
  }
}
