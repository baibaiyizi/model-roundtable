export type StructuredMode = 'text' | 'json_object' | 'json_schema'
/** Saved only after an explicit successful probe against this exact service URL. */
export interface StructuredCapability { mode: Exclude<StructuredMode, 'text'>; testedAt: string; baseUrl: string }
export interface StructuredRequest { name: string; jsonSchema: Record<string, unknown> }
export type ResponseIssue = 'empty' | 'truncated' | 'refusal' | 'interrupted' | 'unexpected_finish' | 'invalid_json' | 'incomplete_reasoning' | 'invalid_schema' | 'transport'
export interface ResponseDiagnostic {
  code?: ResponseIssue; finishReason?: string; refusal?: string; responseId?: string
  rawChars: number; maxOutputTokens?: number; structuredMode?: StructuredMode
  normalizations?: Array<'think' | 'fence'>
}
