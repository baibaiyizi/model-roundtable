import type { Evidence } from '../../shared/types'

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.pdf', '.docx', '.pptx', '.html', '.htm', '.xlsx', '.xls', '.xlsm', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.wav', '.mp3', '.m4a', '.flac', '.ogg', '.mp4', '.mkv', '.mov', '.webm', '.avi']

export interface ExtractedPart { text: string; locator: string; kind: Evidence['kind'] }
export interface ImportJob { originalPath: string; url?: string; mediaDir: string; scratchDir: string }
export type PptxExtractor = (originalPath: string, signal: AbortSignal, progress: (text: string) => void) => Promise<ExtractedPart[]>
export interface ParserServices {
  signal: AbortSignal
  progress(text: string): void
  vision(dataUrl: string): Promise<{ ocr: string; description: string }>
  transcribe(filePath: string): Promise<string>
  extractPptx?(filePath: string): Promise<ExtractedPart[]>
}
export type WorkerRequest = { type: 'job'; job: ImportJob } | { type: 'cancel' } | { type: 'rpc-result'; id: string; value?: unknown; error?: string }
export type WorkerEvent = { type: 'progress'; text: string } | { type: 'done'; parts: ExtractedPart[] } | { type: 'error'; error: string } | { type: 'rpc'; id: string; method: 'vision' | 'transcribe' | 'extract-pptx'; argument: string }

export function chunkParts(parts: ExtractedPart[], maxChars = 1600): ExtractedPart[] {
  if (!Number.isInteger(maxChars) || maxChars < 32) throw new Error('分块长度必须至少为 32 字符')
  return parts.flatMap(part => {
    const text = part.text.trim()
    if (!text) return []
    const result: ExtractedPart[] = []
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + maxChars, text.length)
      // Keep UTF-16 surrogate pairs intact, and never discard text at boundaries.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      result.push({ ...part, text: text.slice(start, end), locator: text.length > maxChars ? `${part.locator} · 字符 ${start + 1}–${end}` : part.locator })
      start = end
    }
    return result
  })
}

export function validateVectors(vectors: number[][], count: number, dimensions?: number): number {
  if (vectors.length !== count || !vectors.length) throw new Error('Embedding 返回条数与请求不一致')
  const actual = vectors[0]?.length
  if (!actual || (dimensions !== undefined && actual !== dimensions)) throw new Error(`Embedding 维度不一致：期望 ${dimensions ?? '非空向量'}，收到 ${actual ?? 0}；请明确重建知识库`)
  if (vectors.some(vector => vector.length !== actual || vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding 返回不一致或无效的向量')
  if (vectors.some(vector => vector.every(value => value === 0))) throw new Error('Embedding 返回零向量，无法进行余弦语义检索')
  return actual
}
