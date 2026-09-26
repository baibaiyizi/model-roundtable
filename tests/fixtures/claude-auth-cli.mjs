// Controlled child process only: no account login, model call or external network.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
if (argv.includes('--version')) console.log('2.1.280 (Claude Code QA peer)')
else if (argv[0] === 'auth' && argv[1] === 'status') {
  send({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
  process.exitCode = 1
} else if (argv[0] === 'auth' && argv[1] === 'login') {
  await writeFile(join(process.cwd(), 'qa-login.json'), JSON.stringify({ argv, profile: process.env.CLAUDE_CONFIG_DIR, credentialNames: Object.keys(process.env).filter(name => /^(ANTHROPIC_|OPENAI_)/.test(name)) }))
  console.log(`https://claude.ai/qa-auth/${argv.includes('--console') ? 'console' : 'subscription'}`)
} else if (argv.includes('--help')) console.log('Models: "sonnet", "opus", "haiku"')
else {
  let prompt = ''; for await (const part of process.stdin) prompt += part
  const key = process.env.ANTHROPIC_API_KEY
  if (key && (prompt.includes(key) || argv.some(value => value.includes(key)))) throw new Error('Credential escaped the child environment')
  const profile = process.env.CLAUDE_CONFIG_DIR
  await mkdir(profile, { recursive: true })
  await writeFile(join(process.cwd(), 'qa-auth.json'), JSON.stringify({ argv, profile, credentialNames: Object.keys(process.env).filter(name => /^(ANTHROPIC_|OPENAI_)/.test(name)), keyHash: key ? createHash('sha256').update(key).digest('hex') : null, proxy: process.env.HTTPS_PROXY ?? null }))
  if (prompt.includes('FAIL')) { process.stderr.write(`Rejected key ${key}`); process.exitCode = 1 }
  else {
    const text = key ? `Key access: ${key}` : 'Official profile access'
    if (prompt.includes('STREAM') && key) {
      send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'qa-auth-answer' } } })
      for (const chunk of ['Key access: ', key.slice(0, 8), key.slice(8)]) send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } })
    }
    send({ type: 'assistant', message: { id: 'qa-auth-answer', content: [{ type: 'text', text }] } })
    send({ type: 'result', is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 2 } })
  }
}
