import type { Session } from '../shared/types'
import { isTokenCount } from '../shared/usage'

const modes = { roundtable: '圆桌讨论', free: '自由群聊', debate: '正式辩论' }
export function exportMarkdown(session: Session): string {
  const lines = [
    `# ${session.title}`, '', `模式：${modes[session.mode]} · 创建：${session.createdAt}`, '',
    `## 讨论问题`, '', session.topic, '', '## 参会模型', '',
    ...session.participants.map(p => `- ${p.name}：${p.model.modelId}${p.team ? `（${p.team === 'pro' ? '正方' : '反方'}）` : ''} · ${p.role || '独立讨论者'}`),
    `- 主持 / 裁判：${session.moderator?.modelId ?? '无主持'}`, '', '## 讨论记录', ''
  ]
  for (const message of session.messages) {
    lines.push(`### ${message.speakerName} · ${message.phase}`, '', message.content || '（无正文）', '')
    if (message.status !== 'complete') lines.push(`> 状态：${message.status}${message.error ? ` · ${message.error}` : ''}`, '')
    if (isTokenCount(message.usage?.totalTokens)) {
      const input = isTokenCount(message.usage?.inputTokens) ? message.usage.inputTokens : '未报告'
      const output = isTokenCount(message.usage?.outputTokens) ? message.usage.outputTokens : '未报告'
      lines.push(`*用量：总计 ${message.usage!.totalTokens} / 输入 ${input} / 输出 ${output} tokens*`, '')
    }
  }
  if (session.evidence.length) {
    lines.push('## 证据快照', '')
    for (const source of session.evidence) {
      lines.push(`### [${source.id}] ${source.title}`, '', `位置：${source.locator}`, `类型：${source.kind} · 获取时间：${source.retrievedAt}`, '')
      if (source.url) lines.push(`来源：${source.url}`, '')
      if (source.query) lines.push(`检索问题：${source.query}`, '')
      lines.push(source.text, '')
    }
  }
  lines.push('---', '此文档记录模型讨论与当时使用的证据。共识和裁判意见不代表事实已被独立验证。', '')
  return lines.join('\n')
}
