/** All paths are relative to the execution's selected project directory. */
export type DocumentFormat = 'txt' | 'md' | 'json' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf'
export type CellValue = string | number | boolean | null
export interface DocumentBlock { type: 'paragraph' | 'heading' | 'table' | 'image'; text?: string; level?: number; rows?: string[][]; path?: string; widthCm?: number }
export interface DocumentStyle { bold?: boolean; italic?: boolean; fontName?: string; fontSize?: number; color?: string; alignment?: 'left' | 'center' | 'right' | 'justify'; styleName?: string }
export interface SheetStyle { bold?: boolean; italic?: boolean; fontName?: string; fontSize?: number; color?: string; fillColor?: string; numberFormat?: string; alignment?: 'left' | 'center' | 'right' }
export interface SlideImage { path: string; xCm: number; yCm: number; widthCm: number }
export interface ChartContent { type: 'column' | 'bar' | 'line' | 'pie'; categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
export interface SlideContent { title: string; body?: string; table?: string[][]; images?: SlideImage[]; chart?: ChartContent }
export interface SheetContent { name: string; rows: CellValue[][] }
export interface DocumentContent { text?: string; title?: string; blocks?: DocumentBlock[]; sheets?: SheetContent[]; slides?: SlideContent[] }
export type DocumentEdit =
  | { kind: 'text.replace'; oldText: string; newText: string }
  | { kind: 'word.replace'; paragraph: number; oldText: string; newText: string }
  | { kind: 'word.cell'; table: number; row: number; column: number; oldText: string; value: string }
  | { kind: 'word.append'; block: DocumentBlock }
  | { kind: 'word.style'; paragraph: number; run?: number; style: DocumentStyle }
  | { kind: 'word.image'; path: string; paragraph?: number; widthCm?: number }
  | { kind: 'sheet.cell'; sheet: string; address: string; value: CellValue; formula?: string; numberFormat?: string }
  | { kind: 'sheet.create'; name: string; rows?: CellValue[][] }
  | { kind: 'sheet.style'; sheet: string; range: string; style: SheetStyle }
  | { kind: 'slide.text'; slide: number; shape: number; oldText: string; newText: string }
  | { kind: 'slide.cell'; slide: number; shape: number; row: number; column: number; oldText: string; value: string }
  | { kind: 'slide.add'; slide: SlideContent }
  | { kind: 'slide.image'; slide: number; image: SlideImage }
  | { kind: 'slide.chart'; slide: number; shape: number; categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
  | { kind: 'pdf.pages'; pages: number[] }
  | { kind: 'pdf.merge'; paths: string[]; position?: number }
  | { kind: 'pdf.rotate'; page: number; degrees: 90 | 180 | 270 }
  | { kind: 'pdf.form'; values: Record<string, string | boolean> }
  | { kind: 'pdf.stamp'; text: string; pages?: number[] }
export type DocumentRequest =
  | { action: 'inspect'; path: string }
  | { action: 'create'; path: string; content: DocumentContent }
  | { action: 'edit'; path: string; expectedHash: string; edits: DocumentEdit[] }
  | { action: 'preview'; path: string; expectedHash?: string }
export interface DocumentUnit {
  id: string; type: string; text?: string; rows?: CellValue[][]; formula?: string; cached?: CellValue
  paragraph?: number; table?: number; slide?: number; shape?: number; sheet?: string; address?: string; page?: number
  runs?: Array<{ text: string; bold?: boolean | null; italic?: boolean | null; fontName?: string | null; fontSize?: number | null }>
  chart?: { categories: string[]; series: Array<{ name: string; values: Array<number | null> }> }
}
export interface DocumentInspection {
  format: DocumentFormat; units: DocumentUnit[]; warnings: string[]; editable: boolean; blockedReasons: string[]
  totalUnits: number; truncated: boolean
}
export interface DocumentChange { location: string; before: string; after: string }
export interface DocumentResult {
  jobId: string; action: DocumentRequest['action']; path: string; sha256: string
  status: 'complete' | 'preview-failed'; inspection: DocumentInspection; changes: DocumentChange[]
  backupPath?: string; previewPath?: string; previewError?: string; journalPath?: string
}
