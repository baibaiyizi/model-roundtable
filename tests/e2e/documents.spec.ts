import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { AppAPI } from '../../src/shared/types'
import { componentTestEnv, testComponents } from '../helpers/components'

declare global { interface Window { roundtable: AppAPI } }

test('project document inspection opens a restricted PDF preview and shows spreadsheet formulas without recalculation', async () => {
  const root = resolve('.')
  const directory = join(root, '.test-data', `documents-ui-${Date.now()}`)
  const project = join(directory, '中文成果')
  await mkdir(project, { recursive: true })
  const result = spawnSync((await testComponents.resolve('documents')).executable, ['-I', '-B', '-X', 'utf8', '-c', "from docx import Document; from openpyxl import Workbook; import sys,os; d=Document(); d.add_heading('桌面成果预览',0); d.add_paragraph('保留共识与少数意见。'); d.save(os.path.join(sys.argv[1],'报告.docx')); w=Workbook(); w.active.title='结果'; w.active.append(['数量','公式']); w.active.append([7,'=A2*3']); w.save(os.path.join(sys.argv[1],'数据.xlsx'))", project], { windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.error?.message ?? `Python exited ${result.status}: ${result.stderr}`)
  let desktop: ElectronApplication | undefined
  const errors: string[] = []
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE'))
    desktop = await electron.launch({ executablePath: process.env.ROUNDTABLE_EXECUTABLE, args: process.env.ROUNDTABLE_EXECUTABLE ? [] : [root], cwd: process.env.ROUNDTABLE_EXECUTABLE ? dirname(process.env.ROUNDTABLE_EXECUTABLE) : root, env: { ...env, ...componentTestEnv, MODEL_ROUNDTABLE_DATA_DIR: join(directory, 'profile'), MODEL_ROUNDTABLE_TEST: '1' }, timeout: 20000 })
    const page = await desktop.firstWindow()
    page.setDefaultTimeout(15000)
    page.on('pageerror', e => errors.push(e.message))
    await expect(page.locator('.welcome-page')).toBeVisible()
    await page.evaluate(async directory => window.roundtable.saveProject({ name: '文档成果', directory, instructions: '', knowledgeBaseIds: [] }), project)
    await page.reload()
    await page.getByRole('button', { name: '项目 文档成果', exact: true }).click()
    await page.getByRole('button', { name: '浏览项目文件', exact: true }).click()
    await page.locator('.file-row').filter({ hasText: '报告.docx' }).click()
    await page.getByRole('button', { name: '查看文档内容', exact: true }).click()
    await expect(page.locator('.document-unit')).toContainText(['桌面成果预览', '保留共识与少数意见。'])
    const viewerPromise = desktop.waitForEvent('window')
    await page.getByRole('button', { name: '预览文档', exact: true }).click()
    const viewer = await viewerPromise
    await expect.poll(async () => viewer.url(), { timeout: 60000 }).toMatch(/^file:.*\.pdf$/i)
    expect(await viewer.evaluate(() => ({ api: typeof window.roundtable, node: typeof (globalThis as Record<string, unknown>).require }))).toEqual({ api: 'undefined', node: 'undefined' })
    await viewer.waitForLoadState('load')
    let previewCapture: Buffer | undefined
    await expect.poll(async () => {
      previewCapture = await viewer.screenshot()
      const rendered = await loadImage(previewCapture)
      const canvas = createCanvas(rendered.width, rendered.height), context = canvas.getContext('2d')
      context.drawImage(rendered, 0, 0)
      const pixels = context.getImageData(0, 0, rendered.width, rendered.height).data
      let light = 0, count = 0
      for (let i = 0; i < pixels.length; i += 64) { count++; if (pixels[i] > 235 && pixels[i + 1] > 235 && pixels[i + 2] > 235) light++ }
      return light / count
    }, { timeout: 20000 }).toBeGreaterThan(0.15)
    await writeFile(join(directory, '09-document-preview.png'), previewCapture!)
    await viewer.close()
    await page.locator('.file-row').filter({ hasText: '数据.xlsx' }).click()
    await page.getByRole('button', { name: '预览文档', exact: true }).click()
    await expect(page.locator('.document-inspection')).toContainText('=A2*3')
    await expect(page.locator('.document-inspection')).toContainText('未提供')
    await expect(page.locator('.document-table')).toContainText('数量')
    await expect(page.locator('.document-table')).toContainText('公式')
    await expect(page.locator('.document-table')).toContainText('7')
    expect(desktop.windows()).toHaveLength(1)
    if (!process.env.ROUNDTABLE_EXECUTABLE) await page.screenshot({ path: join(directory, '10-spreadsheet-preview.png') })
    expect(errors).toEqual([])
  } finally { await desktop?.close() }
})
