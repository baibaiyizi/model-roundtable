import { z } from 'zod'

const text = z.string().max(2_000_000)
const index = z.number().int().min(0).max(100000)
const value = z.union([text, z.number().finite(), z.boolean(), z.null()])
const rows = z.array(z.array(text).max(1000)).max(10000)
const cm = z.number().positive().max(60)
const relativePath = z.string().min(1).max(1000)
const block = z.object({ type: z.enum(['paragraph', 'heading', 'table', 'image']), text: text.optional(), level: z.number().int().min(0).max(9).optional(), rows: rows.optional(), path: relativePath.optional(), widthCm: cm.optional() }).strict()
const image = z.object({ path: relativePath, xCm: z.number().min(0).max(60), yCm: z.number().min(0).max(60), widthCm: cm }).strict()
const series = z.array(z.object({ name: text.max(300), values: z.array(z.number().finite().nullable()).max(1000) }).strict()).min(1).max(30)
const categories = z.array(text.max(300)).min(1).max(1000)
const chart = z.object({ type: z.enum(['column', 'bar', 'line', 'pie']), categories, series }).strict()
const slide = z.object({ title: text, body: text.optional(), table: rows.optional(), images: z.array(image).max(100).optional(), chart: chart.optional() }).strict()
const style = { bold: z.boolean().optional(), italic: z.boolean().optional(), fontName: z.string().min(1).max(200).optional(), fontSize: z.number().positive().max(200).optional(), color: z.string().regex(/^[a-fA-F0-9]{6}$/).optional() }
const content = z.object({
  text: text.optional(), title: text.optional(), blocks: z.array(block).max(10000).optional(),
  sheets: z.array(z.object({ name: z.string().min(1).max(31), rows: z.array(z.array(value).max(16384)).max(100000) }).strict()).max(100).optional(),
  slides: z.array(slide).max(500).optional(),
}).strict()
const edit = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text.replace'), oldText: text.min(1), newText: text }).strict(),
  z.object({ kind: z.literal('word.replace'), paragraph: index, oldText: text.min(1), newText: text }).strict(),
  z.object({ kind: z.literal('word.cell'), table: index, row: index, column: index, oldText: text, value: text }).strict(),
  z.object({ kind: z.literal('word.append'), block }).strict(),
  z.object({ kind: z.literal('word.style'), paragraph: index, run: index.optional(), style: z.object({ ...style, alignment: z.enum(['left', 'center', 'right', 'justify']).optional(), styleName: z.string().min(1).max(200).optional() }).strict() }).strict(),
  z.object({ kind: z.literal('word.image'), path: relativePath, paragraph: index.optional(), widthCm: cm.optional() }).strict(),
  z.object({ kind: z.literal('sheet.cell'), sheet: z.string().min(1).max(31), address: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/), value, formula: text.optional(), numberFormat: z.string().max(300).optional() }).strict(),
  z.object({ kind: z.literal('sheet.create'), name: z.string().min(1).max(31), rows: z.array(z.array(value).max(16384)).max(100000).optional() }).strict(),
  z.object({ kind: z.literal('sheet.style'), sheet: z.string().min(1).max(31), range: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}(:[A-Z]{1,3}[1-9][0-9]{0,6})?$/), style: z.object({ ...style, fillColor: z.string().regex(/^[a-fA-F0-9]{6}$/).optional(), numberFormat: z.string().max(300).optional(), alignment: z.enum(['left', 'center', 'right']).optional() }).strict() }).strict(),
  z.object({ kind: z.literal('slide.text'), slide: index, shape: index, oldText: text, newText: text }).strict(),
  z.object({ kind: z.literal('slide.cell'), slide: index, shape: index, row: index, column: index, oldText: text, value: text }).strict(),
  z.object({ kind: z.literal('slide.add'), slide }).strict(),
  z.object({ kind: z.literal('slide.image'), slide: index, image }).strict(),
  z.object({ kind: z.literal('slide.chart'), slide: index, shape: index, categories, series }).strict(),
  z.object({ kind: z.literal('pdf.pages'), pages: z.array(index).min(1).max(500) }).strict(),
  z.object({ kind: z.literal('pdf.merge'), paths: z.array(relativePath).min(1).max(30), position: index.optional() }).strict(),
  z.object({ kind: z.literal('pdf.rotate'), page: index, degrees: z.union([z.literal(90), z.literal(180), z.literal(270)]) }).strict(),
  z.object({ kind: z.literal('pdf.form'), values: z.record(z.string().min(1).max(500), z.union([text, z.boolean()])) }).strict(),
  z.object({ kind: z.literal('pdf.stamp'), text: text.max(1000), pages: z.array(index).max(500).optional() }).strict(),
])
const path = z.string().min(1).max(1000)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const DOCUMENT_SCHEMAS = {
  document_inspect: z.object({ path }).strict(),
  document_create: z.object({ path, content }).strict(),
  document_edit: z.object({ path, expectedHash: hash, edits: z.array(edit).min(1).max(1000) }).strict(),
  document_preview: z.object({ path, expectedHash: hash.optional() }).strict(),
}
const descriptions = {
  document_inspect: '读取项目目录内文档，返回 SHA256、可编辑对象索引和限制。支持 txt/md/json/csv/docx/xlsx/pptx/pdf。索引从0开始，PPT shape是对象ID。编辑前必须调用。',
  document_create: '在项目中新建文档，拒绝覆盖现有文件。Word/PDF使用title/blocks，Excel使用sheets，PPT使用slides，文本格式使用text。验证后保存并记录差异。',
  document_edit: '直接修改项目中的普通文档；必须传检查得到的expectedHash，先保留前版本、验证临时输出再替换。文本原文必须匹配。Excel不重算公式、不执行宏；复杂对象或旧格式明确拒绝。',
  document_preview: '生成可查看的文档结果。DOCX/PPTX通过随包LibreOffice生成PDF副本，XLSX返回网格与已有缓存不重算，PDF和文本返回原件路径。转换失败明确报错。',
}
export const DOCUMENT_TOOLS = Object.entries(DOCUMENT_SCHEMAS).map(([name, schema]) => ({
  name, description: descriptions[name as keyof typeof descriptions], inputSchema: z.toJSONSchema(schema),
}))
