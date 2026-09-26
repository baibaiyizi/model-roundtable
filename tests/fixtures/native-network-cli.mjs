// Controlled stdio peer: validates environment transfer, never calls a cloud account.
import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
const kind = process.argv[2], args = process.argv.slice(3)
const audit = { kind, pid: process.pid, proxy: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].map(key => [key, process.env[key] ?? null])) }
const profile = process.env.CODEX_HOME ?? process.env.CLAUDE_CONFIG_DIR
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'qa-network.json'), JSON.stringify(audit))
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
async function callWeb(config) {
  const client = new Client({ name: 'controlled-native-web', version: '1' })
  const authorization = config.headers?.Authorization ?? `Bearer ${process.env[config.bearer_token_env_var]}`
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: authorization } } }))
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name)
    const searched = await client.callTool({ name: 'web_search', arguments: { query: '原生后台联网验收' } })
    const read = await client.callTool({ name: 'web_read', arguments: { url: 'https://example.org' } })
    return { names, searched, read }
  } finally { await client.close() }
}
if (args.includes('--version')) { process.stdout.write('qa-network\n'); process.exit(0) }
if (args.includes('status')) { process.stdout.write(JSON.stringify({ loggedIn: false })); process.exit(0) }
if (args.includes('--help')) { process.stdout.write('Use "sonnet"'); process.exit(0) }
if (kind === 'claude') {
  let prompt = ''; for await (const part of process.stdin) prompt += part
  if (prompt.includes('WAIT_UNTIL_CANCELLED')) await new Promise(() => { setInterval(() => {}, 1000) })
  if (prompt.includes('CALL_WEB_TOOLS')) {
    if (args[args.indexOf('--tools') + 1].split(',').some(tool => ['WebSearch', 'WebFetch'].includes(tool))) throw new Error('原生联网工具未关闭')
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'))
    audit.web = await callWeb(config.mcpServers.documents)
  }
  const text = JSON.stringify(audit)
  send({ type: 'assistant', message: { id: 'network-reply', content: [{ type: 'text', text }] } })
  send({ type: 'result', is_error: false, result: text })
} else {
  let model, config
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const request = JSON.parse(line)
    if (!request.id) continue
    if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'QA network peer' } })
    else if (request.method === 'model/list') send({ id: request.id, result: { data: [{ model: 'qa-model' }] } })
    else if (request.method === 'thread/start') { model = request.params.model; config = request.params.config; send({ id: request.id, result: { thread: { id: 'qa-thread' }, model, modelProvider: 'openai' } }) }
    else if (request.method === 'turn/start') {
      send({ id: request.id, result: { turn: { id: 'qa-turn' } } })
      send({ method: 'turn/started', params: { threadId: 'qa-thread', turn: { id: 'qa-turn' } } })
      if (request.params.input[0].text.includes('WAIT_UNTIL_CANCELLED')) continue
      if (request.params.input[0].text.includes('CALL_WEB_TOOLS')) {
        if (config.web_search !== 'disabled') throw new Error('原生联网工具未关闭')
        audit.web = await callWeb(config.mcp_servers.documents)
      }
      send({ method: 'item/completed', params: { threadId: 'qa-thread', item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(audit) } } })
      send({ method: 'turn/completed', params: { threadId: 'qa-thread', turn: { id: 'qa-turn', status: 'completed' } } })
    } else send({ id: request.id, result: {} })
  }
}
