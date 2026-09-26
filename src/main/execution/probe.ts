import type { Provider } from '../../shared/types'
import type { ProviderNetworkPort } from '../../shared/network'
export async function testToolCalling(provider: Provider, apiKey: string, modelId: string, fetcher: typeof fetch = fetch, signal?: AbortSignal, network?: ProviderNetworkPort): Promise<{ text: string }> {
  if (provider.network && provider.network.mode !== 'system' && !network) throw new Error('模型指定的网络线路尚未准备，未发送测试请求。')
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(provider.timeoutMs)])
  const lease = await network?.acquireForProviders([provider.id], deadline)
  try {
    deadline.throwIfAborted()
    return await probe(provider, apiKey, modelId, lease ? lease.fetchForProvider(provider.id) : fetcher, deadline)
  } finally { lease?.release() }
}
async function probe(provider: Provider, apiKey: string, modelId: string, fetcher: typeof fetch, signal: AbortSignal): Promise<{ text: string }> {
  const response = await fetcher(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(provider.timeoutMs)]), body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: '请调用 connection_probe 工具，传入 ok=true。这只是能力测试，不执行任何本机命令。' }], tools: [{ type: 'function', function: { name: 'connection_probe', description: '确认工具调用能力', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }], tool_choice: { type: 'function', function: { name: 'connection_probe' } }, [provider.tokenParameter]: 128, stream: false }) })
  if (!response.ok) throw new Error(`工具调用测试失败：HTTP ${response.status}。`)
  const body = await response.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }
  const call = body.choices?.[0]?.message?.tool_calls?.find(tool => tool.function?.name === 'connection_probe')
  if (!call || JSON.parse(call.function?.arguments ?? '{}').ok !== true) throw new Error('模型未返回有效工具调用；可以用于讨论，暂不能用于执行。')
  return { text: '工具调用测试成功（未执行本机工具）。' }
}
