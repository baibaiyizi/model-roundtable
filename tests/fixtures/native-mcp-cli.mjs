// QA-only child process: exercises the application's real native protocol readers.
// This is not an official CLI and never connects to a model or an account.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const kind = process.argv[2]
const argv = process.argv.slice(3)
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const audit = async value => writeFile(join(process.cwd(), 'qa-native.json'), JSON.stringify({
  kind, argv, pid: process.pid,
  inheritedCredentialNames: Object.keys(process.env).filter(name => /^(OPENAI_|ANTHROPIC_|CODEX_API|CLAUDE_API|OPENCODE_)/i.test(name)),
  anthropicKeyHash: process.env.ANTHROPIC_API_KEY ? createHash('sha256').update(process.env.ANTHROPIC_API_KEY).digest('hex') : null,
  ...value,
}))
async function toolCall(url, token, prompt, started) {
  if (prompt.includes(token)) throw new Error('MCP credential was included in model prompt')
  if (JSON.stringify(argv).includes(token)) throw new Error('MCP credential was included in argv')
  const client = new Client({ name: 'native-protocol-qa', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const tools = (await client.listTools()).tools
    const tool = tools.find(item => item.name === 'ext_qa_read')
    if (!tool || tools.some(item => item.name === 'unauthorized_tool')) throw new Error('Incorrect project tool set')
    started(tool.name)
    const output = await client.callTool({ name: tool.name, arguments: { query: '中文材料' } })
    if (output.isError) throw new Error('QA tool returned an error')
    return JSON.stringify(output)
  } finally { await client.close() }
}

if (kind === 'claude') {
  let prompt = ''; for await (const part of process.stdin) prompt += part
  const config = JSON.parse(await readFile(argv[argv.indexOf('--mcp-config') + 1], 'utf8'))
  const server = config.mcpServers.documents
  const token = server.headers.Authorization.replace(/^Bearer /, '')
  await audit({ names: Object.keys(config.mcpServers), transport: server.type, hasAuthorization: true, maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, profile: process.env.CLAUDE_CONFIG_DIR })
  send({ type: 'system', session_id: 'qa-claude-session' })
  const output = await toolCall(server.url, token, prompt, () => send({ type: 'assistant', message: { id: 'qa-tool', content: [{ type: 'tool_use', id: 'qa-call', name: 'mcp__documents__ext_qa_read', input: { query: '中文材料' } }] } }))
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'qa-call', content: output }] } })
  send({ type: 'assistant', message: { id: 'qa-answer', content: [{ type: 'text', text: '真实 MCP 材料已读取' }] } })
  send({ type: 'result', is_error: false, result: '真实 MCP 材料已读取', usage: { input_tokens: 7, output_tokens: 9 } })
} else {
  let configuration
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const request = JSON.parse(line)
    if (!request.id) continue
    if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'QA protocol peer' } })
    else if (request.method === 'thread/start') {
      configuration = request.params
      const servers = configuration.config.mcp_servers
      await audit({ names: Object.keys(servers), config: configuration.config, model: configuration.model, profile: process.env.CODEX_HOME })
      send({ id: request.id, result: { thread: { id: 'qa-codex-thread' }, model: configuration.model, modelProvider: 'openai' } })
    } else if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'qa-turn' } } })
      send({ method: 'turn/started', params: { threadId: 'qa-codex-thread', turn: { id: 'qa-turn' } } })
      const server = configuration.config.mcp_servers.documents
      void toolCall(server.url, process.env[server.bearer_token_env_var], request.params.input[0].text, () => send({ method: 'item/started', params: { threadId: 'qa-codex-thread', item: { id: 'qa-call', type: 'mcpToolCall', server: 'documents', tool: 'ext_qa_read' } } })).then(output => {
        send({ method: 'item/completed', params: { threadId: 'qa-codex-thread', item: { id: 'qa-call', type: 'mcpToolCall', status: 'completed', result: output } } })
        send({ method: 'item/completed', params: { threadId: 'qa-codex-thread', item: { id: 'qa-answer', type: 'agentMessage', phase: 'final_answer', text: '真实 MCP 材料已读取' } } })
        send({ method: 'thread/tokenUsage/updated', params: { threadId: 'qa-codex-thread', tokenUsage: { total: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } } } })
        send({ method: 'turn/completed', params: { threadId: 'qa-codex-thread', turn: { id: 'qa-turn', status: 'completed' } } })
      }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; lines.close(); process.stdin.destroy() })
    } else if (request.method === 'turn/interrupt') {
      await writeFile(join(process.cwd(), 'qa-interrupted'), 'interrupt received')
      send({ id: request.id, result: {} })
    } else send({ id: request.id, error: { code: -32601, message: 'Unexpected QA RPC method' } })
  }
}
