import { z } from 'zod'

export const idSchema = z.string().min(1).max(200)
export const networkSelectionSchema = z.discriminatedUnion('mode', [z.object({ mode: z.literal('system') }).strict(), z.object({ mode: z.literal('direct') }).strict(), z.object({ mode: z.literal('subscription'), subscriptionId: idSchema, nodeId: idSchema }).strict()])
export const modelSchema = z.object({ providerId: idSchema, modelId: z.string().trim().min(1).max(300) }).strict()
const optionalModel = modelSchema.optional()
export const providerSchema = z.object({
  network: networkSelectionSchema.optional(),
  kind: z.enum(['api', 'codex', 'claude']).optional(),
  claudeAuth: z.enum(['official', 'apiKey']).optional(),
  id: idSchema.optional(), name: z.string().trim().min(1).max(100),
  baseUrl: z.string().trim().max(2000).transform(value => value.replace(/\/+$/, '')).refine(value => {
    if (!value) return true
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash } catch { return false }
  }, '请输入完整 http(s) API 基础地址，不含查询参数、账号或密码。'),
  apiKey: z.string().max(10000).optional(), modelIds: z.array(z.string().trim().min(1).max(300)).max(5000).transform(ids => [...new Set(ids)]),
  tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']), streamUsage: z.boolean(), timeoutMs: z.number().int().min(1000).max(900000)
}).strict().superRefine((value, ctx) => {
  if ((!value.kind || value.kind === 'api') && !value.baseUrl) ctx.addIssue({ code: 'custom', message: 'API 服务需要填写地址。', path: ['baseUrl'] })
  if (value.claudeAuth && value.kind !== 'claude') ctx.addIssue({ code: 'custom', message: '只有 Claude Code 服务可以设置 Claude 认证方式。', path: ['claudeAuth'] })
  if (value.kind && value.kind !== 'api' && !(value.kind === 'claude' && value.claudeAuth === 'apiKey') && value.apiKey) ctx.addIssue({ code: 'custom', message: '官方登录连接不填写 API Key；Claude Code 可切换为自有 API Key。', path: ['apiKey'] })
  if (value.kind === 'claude' && value.claudeAuth === 'apiKey' && value.apiKey && /\s/.test(value.apiKey)) ctx.addIssue({ code: 'custom', message: 'Anthropic API Key 不能包含空白字符。', path: ['apiKey'] })
})
export const agentLoginSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('codex') }).strict(), z.object({ kind: z.literal('claude'), method: z.enum(['subscription', 'console']) }).strict()])
export const searchConfigSchema = z.object({ provider: z.enum(['browser','tavily','searxng']), engine: z.enum(['bing','baidu','google']), searxngUrl: z.url().max(4000).refine(url => /^https?:\/\//i.test(url), '请输入 http(s) 地址。').optional() }).strict()
export const settingsSchema = z.object({ moderator: optionalModel, vision: optionalModel, transcription: optionalModel, tavilyKey: z.string().max(10000).optional(), search: searchConfigSchema.optional() }).strict()
export const sessionSchema = z.object({
  projectId: idSchema.optional(),
  title: z.string().trim().max(150).optional(), topic: z.string().trim().min(1).max(20000), mode: z.enum(['roundtable', 'free', 'debate']),
  participants: z.array(z.object({ id: idSchema, name: z.string().trim().min(1).max(100), model: modelSchema, role: z.string().max(4000), team: z.enum(['pro','con']).optional(), muted: z.boolean().optional() }).strict()).min(2).max(30),
  moderator: optionalModel, knowledgeBaseIds: z.array(idSchema).max(30), searchEnabled: z.boolean(),
  limits: z.object({ autoTurns: z.number().int().min(1).max(100), maxCalls: z.number().int().min(1).max(1000), maxOutputTokens: z.number().int().min(64).max(32000), maxSearches: z.number().int().min(0).max(1000).nullable(), contextChars: z.number().int().min(4000).max(500000) }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'debate' && !value.moderator) ctx.addIssue({ code: 'custom', message: '正式辩论必须指定裁判。', path: ['moderator'] })
  if (new Set(value.participants.map(p => p.id)).size !== value.participants.length) ctx.addIssue({ code: 'custom', message: '参会席位 ID 不能重复。', path: ['participants'] })
  if (value.participants.some(p => ['moderator','user','system'].includes(p.id))) ctx.addIssue({ code: 'custom', message: '参会席位 ID 使用了保留名称。', path: ['participants'] })
  if (value.mode === 'debate' && (!value.participants.some(p => p.team === 'pro') || !value.participants.some(p => p.team === 'con') || value.participants.some(p => !p.team))) ctx.addIssue({ code: 'custom', message: '正式辩论需要正反双方，且每个参会模型必须分配队伍。', path: ['participants'] })
})
export const actionSchema = z.object({ sessionId: idSchema, action: z.enum(['pause','resume','stop','retry','skip','review','one-turn']) }).strict()
export const interjectSchema = z.object({ sessionId: idSchema, text: z.string().trim().min(1).max(20000), participantId: idSchema.optional() }).strict()
export const kbSchema = z.object({ name: z.string().trim().min(1).max(100), embedding: modelSchema }).strict()
export const importSchema = z.object({ knowledgeBaseId: idSchema, filePaths: z.array(z.string().min(1).max(32000)).min(1).max(100).optional(), url: z.url().max(4000).optional() }).strict().refine(x => Boolean(x.filePaths?.length) !== Boolean(x.url), '请选择文件或输入一个网页链接。')
export const httpUrlSchema = z.url().max(4000).refine(value => /^https?:\/\//i.test(value), '仅支持 http(s) 链接。')
export const projectSchema = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(100), directory: z.string().min(1).max(32000), instructions: z.string().max(20000), knowledgeBaseIds: z.array(idSchema).max(30) }).strict()
export const projectPathSchema = z.object({ projectId: idSchema, path: z.string().max(32000).optional() }).strict()
