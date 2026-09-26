import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, access, symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DocumentService } from '../src/main/documents/service'
import { DOCUMENT_TOOLS } from '../src/main/documents/tools'
import { testComponents } from './helpers/components'

const runtimeDir = (await testComponents.resolve('documents')).directory
const cleanup: Array<{ directory: string; service: DocumentService }> = []
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), '圆桌文档-'))
  const project = join(directory, '中文项目')
  await mkdir(project)
  const service = new DocumentService({ runtimeDir, stateDir: join(directory, 'history'), components: testComponents })
  cleanup.push({ directory, service })
  return { directory, project, service }
}
afterEach(async () => {
  for (const { directory, service } of cleanup.splice(0)) { await service.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
const python = (code: string, args: string[]) => {
  const result = spawnSync(join(runtimeDir, 'python/python.exe'), ['-I', '-B', '-X', 'utf8', '-c', code, ...args], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}

describe('真实随包文档运行时', () => {
  test('立即退出会取消仍在检查路径的文档任务，关闭返回后不启动进程或写入记录', async () => {
    const { service, project, directory } = await setup()
    await writeFile(join(project, '检查.json'), '{"状态":"原件"}', 'utf8')
    const pending = service.execute(project, { action: 'inspect', path: '检查.json' })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await service.shutdown()
    await rejected
    expect(await readdir(directory)).toEqual(['中文项目'])
    expect(await readFile(join(project, '检查.json'), 'utf8')).toBe('{"状态":"原件"}')
    await expect(service.execute(project, { action: 'inspect', path: '检查.json' })).rejects.toThrow('应用正在退出')
  })

  test('MCP 调用新建 Word，修改外来文档跨 run 原文，备份并生成真实 PDF 预览', async () => {
    const { service, project } = await setup()
    expect(DOCUMENT_TOOLS.map(tool => tool.name)).toEqual(['document_inspect', 'document_create', 'document_edit', 'document_preview'])
    const created = await service.callTool(project, 'document_create', { path: '报告.docx', content: { title: '讨论结果', blocks: [{ type: 'paragraph', text: '原始观点' }, { type: 'table', rows: [['项目', '值'], ['A', '旧值']] }] } })
    expect(created.status).toBe('complete')
    expect(created.previewPath).toMatch(/\.pdf$/)
    expect((await readFile(created.previewPath!)).subarray(0, 5).toString()).toBe('%PDF-')
    // A genuinely external document with mixed run formatting, not just our generated template.
    python("from docx import Document; import sys; d=Document(); p=d.add_paragraph(); p.add_run('前缀'); r=p.add_run('需要修改'); r.bold=True; p.add_run('后缀'); d.save(sys.argv[1])", [join(project, '外来.docx')])
    const inspected = await service.execute(project, { action: 'inspect', path: '外来.docx' })
    const edited = await service.execute(project, { action: 'edit', path: '外来.docx', expectedHash: inspected.sha256, edits: [{ kind: 'word.replace', paragraph: 0, oldText: '需要修改', newText: '已经更新' }] })
    expect(edited.status).toBe('complete')
    expect(edited.inspection.units[0].text).toBe('前缀已经更新后缀')
    expect(edited.changes[0].before).toBe('前缀需要修改后缀')
    expect(edited.backupPath).toBeTruthy()
    expect(python("from docx import Document; import sys; d=Document(sys.argv[1]); print(d.paragraphs[0].runs[1].bold)", [join(project, '外来.docx')]).trim()).toBe('True')
    expect(python("from docx import Document; import sys; print(Document(sys.argv[1]).paragraphs[0].text)", [edited.backupPath!]).trim()).toBe('前缀需要修改后缀')
  }, 120000)

  test('Excel 修改单元格保留公式，缺失缓存明确为 null，不启动 Calc', async () => {
    const { service, project } = await setup()
    const created = await service.execute(project, { action: 'create', path: '数据.xlsx', content: { sheets: [{ name: '中文表', rows: [['数量', '公式'], [2, '=A2*3']] }] } })
    const edited = await service.execute(project, { action: 'edit', path: '数据.xlsx', expectedHash: created.sha256, edits: [{ kind: 'sheet.cell', sheet: '中文表', address: 'A2', value: 7 }] })
    expect(edited.inspection.units.find(unit => unit.address === 'A2')?.rows).toEqual([[7]])
    expect(edited.inspection.units.find(unit => unit.address === 'B2')).toMatchObject({ formula: '=A2*3', cached: null })
    const preview = await service.execute(project, { action: 'preview', path: '数据.xlsx' })
    expect(await realpath(preview.previewPath!)).toBe(await realpath(join(project, '数据.xlsx')))
    expect(python("from openpyxl import load_workbook; import sys; w=load_workbook(sys.argv[1]); print(w.calculation.calcMode, w.calculation.fullCalcOnLoad)", [join(project, '数据.xlsx')]).trim()).toBe('manual False')
  }, 30000)

  test('PPT 外来普通文本和表格可定点修改，中文 PDF 可生成并加水印', async () => {
    const { service, project } = await setup()
    const ppt = await service.execute(project, { action: 'create', path: '演示.pptx', content: { slides: [{ title: '原题', body: '中文正文', table: [['项目', '旧值']] }] } })
    const title = ppt.inspection.units.find(unit => unit.shape !== undefined && unit.text === '原题')!
    const table = ppt.inspection.units.find(unit => unit.type === 'table')!
    const changed = await service.execute(project, { action: 'edit', path: '演示.pptx', expectedHash: ppt.sha256, edits: [
      { kind: 'slide.text', slide: 0, shape: title.shape!, oldText: '原题', newText: '新题' },
      { kind: 'slide.cell', slide: 0, shape: table.shape!, row: 0, column: 1, oldText: '旧值', value: '新值' },
    ] })
    expect(changed.status).toBe('complete')
    expect(changed.inspection.units.find(unit => unit.type === 'table')?.rows).toEqual([['项目', '新值']])
    const pdf = await service.execute(project, { action: 'create', path: '报告.pdf', content: { title: '中文报告', blocks: [{ type: 'paragraph', text: '正式结论与少数意见' }] } })
    expect(pdf.inspection.units[0].text).toContain('中文报告')
    const stamped = await service.execute(project, { action: 'edit', path: '报告.pdf', expectedHash: pdf.sha256, edits: [{ kind: 'pdf.stamp', text: '已复核' }, { kind: 'pdf.rotate', page: 0, degrees: 90 }] })
    expect(stamped.inspection.units[0].text).toContain('已复核')
    expect(python("from pypdf import PdfReader; import sys; print(PdfReader(sys.argv[1]).pages[0].rotation)", [join(project, '报告.pdf')]).trim()).toBe('90')
  }, 120000)

  test('冲突、路径越界与错误操作不会覆盖用户原件，取消不会发布临时文件', async () => {
    const { service, project } = await setup()
    const original = await service.execute(project, { action: 'create', path: '计划.md', content: { text: '# 计划\n第一版' } })
    await writeFile(join(project, '计划.md'), '# 计划\n外部更新', 'utf8')
    await expect(service.execute(project, { action: 'edit', path: '计划.md', expectedHash: original.sha256, edits: [{ kind: 'text.replace', oldText: '第一版', newText: '第二版' }] })).rejects.toThrow('文件已被其他操作修改')
    await expect(service.execute(project, { action: 'create', path: '../逃出.txt', content: { text: 'x' } })).rejects.toThrow('超出项目目录')
    const latest = await service.execute(project, { action: 'inspect', path: '计划.md' })
    await expect(service.execute(project, { action: 'edit', path: '计划.md', expectedHash: latest.sha256, edits: [{ kind: 'text.replace', oldText: '不存在', newText: '覆盖' }] })).rejects.toThrow('唯一匹配')
    expect(await readFile(join(project, '计划.md'), 'utf8')).toBe('# 计划\n外部更新')
    const controller = new AbortController()
    const pending = service.execute(project, { action: 'create', path: '取消.docx', content: { blocks: Array.from({ length: 10000 }, () => ({ type: 'paragraph' as const, text: '等待处理的内容'.repeat(10) })) } }, controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow('取消')
    await expect(access(join(project, '取消.docx'))).rejects.toThrow()
    expect((await readdir(project)).filter(name => name.startsWith('.roundtable-'))).toEqual([])
  }, 30000)

  test('普通 Word 表格修改与 PDF 表单/页面操作都实际回读；复杂文件明确拒绝', async () => {
    const { service, project } = await setup()
    const word = await service.execute(project, { action: 'create', path: '表格.docx', content: { blocks: [{ type: 'table', rows: [['旧', '值']] }] } })
    const edited = await service.execute(project, { action: 'edit', path: '表格.docx', expectedHash: word.sha256, edits: [{ kind: 'word.cell', table: 0, row: 0, column: 1, oldText: '值', value: '新值' }] })
    expect(edited.inspection.units.find(unit => unit.table === 0)?.rows).toEqual([['旧', '新值']])
    python("from reportlab.pdfgen import canvas; import sys; c=canvas.Canvas(sys.argv[1]); c.acroForm.textfield(name='answer', x=30, y=500, width=200, height=20); c.drawString(30,550,'Form'); c.showPage(); c.drawString(30,550,'Second'); c.save()", [join(project, 'form.pdf')])
    const form = await service.execute(project, { action: 'inspect', path: 'form.pdf' })
    const filled = await service.execute(project, { action: 'edit', path: 'form.pdf', expectedHash: form.sha256, edits: [{ kind: 'pdf.form', values: { answer: 'verified' } }] })
    expect(filled.inspection.units.find(unit => unit.id === 'field:answer')?.text).toBe('verified')
    const pages = await service.execute(project, { action: 'edit', path: 'form.pdf', expectedHash: filled.sha256, edits: [{ kind: 'pdf.pages', pages: [1] }] })
    expect(pages.inspection.units.filter(unit => unit.type === 'page')).toHaveLength(1)
    python("from openpyxl import Workbook; from openpyxl.chart import BarChart,Reference; import sys; w=Workbook(); s=w.active; s.append([1]); c=BarChart(); c.add_data(Reference(s,min_col=1,min_row=1,max_row=1)); s.add_chart(c,'C1'); w.save(sys.argv[1])", [join(project, '复杂.xlsx')])
    const complex = await service.execute(project, { action: 'inspect', path: '复杂.xlsx' })
    expect(complex.inspection.editable).toBe(false)
    await expect(service.execute(project, { action: 'edit', path: '复杂.xlsx', expectedHash: complex.sha256, edits: [{ kind: 'sheet.cell', sheet: 'Sheet', address: 'A1', value: 3 }] })).rejects.toThrow('绘图对象')
  }, 120000)

  test('图片、Word样式、Excel工作表样式、PPT图表和多来源PDF合并实际可用', async () => {
    const { service, project } = await setup()
    python("from PIL import Image; import sys; Image.new('RGB',(240,120),(30,100,200)).save(sys.argv[1])", [join(project, '图.png')])
    const word = await service.execute(project, { action: 'create', path: 'before.docx', content: { blocks: [{ type: 'paragraph', text: '可设置样式' }] } })
    const wordEdited = await service.execute(project, { action: 'edit', path: 'before.docx', expectedHash: word.sha256, edits: [
      { kind: 'word.style', paragraph: 0, run: 0, style: { bold: true, fontSize: 16, color: '245ABC', alignment: 'center' } },
      { kind: 'word.image', path: '图.png', widthCm: 4 },
    ] })
    expect(wordEdited.status).toBe('complete')
    expect(wordEdited.inspection.units[0].runs?.[0]).toMatchObject({ bold: true, fontSize: 16 })
    expect(wordEdited.inspection.units.some(unit => unit.type === 'image')).toBe(true)
    // A source called before.docx must never collide with the private pre-edit backup.
    expect(python("from docx import Document; import sys; print(len(Document(sys.argv[1]).inline_shapes))", [wordEdited.backupPath!]).trim()).toBe('0')
    const workbook = await service.execute(project, { action: 'create', path: '样式.xlsx', content: { sheets: [{ name: '数据', rows: [['标题'], [123]] }] } })
    await service.execute(project, { action: 'edit', path: '样式.xlsx', expectedHash: workbook.sha256, edits: [
      { kind: 'sheet.create', name: '汇总', rows: [['完成']] },
      { kind: 'sheet.style', sheet: '数据', range: 'A1:A2', style: { bold: true, fillColor: 'E1EFFF', numberFormat: '0.00', alignment: 'center' } },
    ] })
    expect(python("from openpyxl import load_workbook; import sys; w=load_workbook(sys.argv[1]); c=w['数据']['A2']; print('汇总' in w.sheetnames,c.font.bold,c.fill.fgColor.rgb,c.number_format)", [join(project, '样式.xlsx')]).trim()).toBe('True True 00E1EFFF 0.00')
    const presentation = await service.execute(project, { action: 'create', path: '图表.pptx', content: { slides: [{ title: '趋势', chart: { type: 'column', categories: ['甲', '乙'], series: [{ name: '销量', values: [1, 2] }] } }] } })
    expect(presentation.inspection.editable).toBe(true)
    const chart = presentation.inspection.units.find(unit => unit.type === 'chart')!
    const updated = await service.execute(project, { action: 'edit', path: '图表.pptx', expectedHash: presentation.sha256, edits: [
      { kind: 'slide.chart', slide: 0, shape: chart.shape!, categories: ['甲', '乙'], series: [{ name: '销量', values: [3, 4] }] },
      { kind: 'slide.image', slide: 0, image: { path: '图.png', xCm: 20, yCm: 0, widthCm: 3 } },
    ] })
    expect(updated.status).toBe('complete')
    expect(updated.inspection.units.find(unit => unit.type === 'chart')?.chart?.series[0].values).toEqual([3, 4])
    const one = await service.execute(project, { action: 'create', path: '一.pdf', content: { blocks: [{ type: 'paragraph', text: '第一页' }] } })
    await service.execute(project, { action: 'create', path: '二.pdf', content: { blocks: [{ type: 'paragraph', text: '另一来源' }, { type: 'image', path: '图.png', widthCm: 4 }] } })
    const merged = await service.execute(project, { action: 'edit', path: '一.pdf', expectedHash: one.sha256, edits: [{ kind: 'pdf.merge', paths: ['二.pdf'], position: 0 }] })
    expect(merged.inspection.units.filter(unit => unit.type === 'page')).toHaveLength(2)
    expect(merged.inspection.units[0].text).toContain('另一来源')
    await expect(service.execute(project, { action: 'edit', path: '一.pdf', expectedHash: merged.sha256, edits: [{ kind: 'pdf.merge', paths: ['../越界.pdf'] }] })).rejects.toThrow('超出项目目录')
    await expect(service.execute(project, { action: 'create', path: '字段不符.docx', content: { text: '不能静默忽略' } })).rejects.toThrow('内容字段不匹配')
  }, 120000)

  test('真实目录联接不能越界；外部加载资源阻止转换；长预览明确截断', async () => {
    const { service, project, directory } = await setup()
    const outside = join(directory, '项目外')
    await mkdir(outside)
    await writeFile(join(outside, '内容.txt'), '不可读', 'utf8')
    await symlink(outside, join(project, '联接'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.execute(project, { action: 'inspect', path: '联接/内容.txt' })).rejects.toThrow('项目外部')
    await expect(service.execute(project, { action: 'create', path: '联接/新建.txt', content: { text: '不可写' } })).rejects.toThrow('项目外部')
    expect(await readdir(outside)).toEqual(['内容.txt'])
    python("from docx import Document; import sys; from docx.opc.constants import RELATIONSHIP_TYPE as RT; d=Document(); d.add_paragraph('外部图片'); d.part.relate_to('https://example.invalid/picture.png',RT.IMAGE,is_external=True); d.save(sys.argv[1])", [join(project, '外部资源.docx')])
    const document = await service.execute(project, { action: 'inspect', path: '外部资源.docx' })
    expect(document.inspection.editable).toBe(false)
    await expect(service.execute(project, { action: 'preview', path: '外部资源.docx' })).rejects.toThrow('外部加载资源')
    await writeFile(join(project, '长文本.txt'), '长'.repeat(20001), 'utf8')
    const text = await service.execute(project, { action: 'inspect', path: '长文本.txt' })
    expect(text.inspection.truncated).toBe(true)
    expect(text.inspection.units[0].text).toHaveLength(20000)
  }, 30000)
})
