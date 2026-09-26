import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractSource, runMedia } from '../src/main/knowledge/parsers'

const mediaDir = resolve(process.env.ROUNDTABLE_MEDIA_DIR ?? 'resources/media'), ffmpeg = join(mediaDir, 'bin', 'ffmpeg.exe')
const hasMedia = existsSync(ffmpeg) && existsSync(join(mediaDir, 'bin', 'ffprobe.exe'))
const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'roundtable-media-')); directories.push(dir); return dir
}

describe.runIf(hasMedia)('真实 FFmpeg 媒体处理（npm run media:setup 后运行）', () => {
  it('长音轨分为五分钟与尾片段，引用实际分片区间', async () => {
    const dir = await fixtureDir(), path = join(dir, '中文长音频.wav'), signal = new AbortController().signal
    await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '301', '-c:a', 'pcm_s16le', path], signal)
    const transcribe = vi.fn(async () => '测试转录文本')
    const parts = await extractSource({ originalPath: path, mediaDir, scratchDir: join(dir, 'scratch') }, { signal, progress: vi.fn(), vision: vi.fn(), transcribe })
    expect(transcribe).toHaveBeenCalledTimes(2)
    expect(parts[0].locator).toContain('00:00:00–00:05:00')
    expect(parts[1].locator).toContain('00:05:00–00:05:01')
    expect(parts.every(part => part.kind === 'transcript' && part.locator.includes('非逐字时间戳'))).toBe(true)
  })

  it('没有音轨的视频通过抽样画面导入，不调用转录', async () => {
    const dir = await fixtureDir(), path = join(dir, '无音轨视频.mp4'), signal = new AbortController().signal
    await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1', '-t', '2', '-an', '-c:v', 'mpeg4', path], signal)
    const transcribe = vi.fn(), vision = vi.fn(async () => ({ ocr: '', description: '蓝色画面' }))
    const parts = await extractSource({ originalPath: path, mediaDir, scratchDir: join(dir, 'scratch') }, { signal, progress: vi.fn(), vision, transcribe })
    expect(transcribe).not.toHaveBeenCalled()
    expect(vision).toHaveBeenCalledTimes(1)
    expect(parts[0].kind).toBe('vision')
    expect(parts[0].locator).toContain('00:00:00 视频抽样帧（间隔 30 秒，无音轨）')
  })

  it('带音轨的视频同时完成 AAC 解码转录与 JPEG 抽帧', async () => {
    const dir = await fixtureDir(), path = join(dir, '带音轨视频.mp4'), signal = new AbortController().signal
    await runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=1', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', path], signal)
    const transcribe = vi.fn(async () => '带音轨的视频转录'), vision = vi.fn(async () => ({ ocr: '', description: '绿色画面' }))
    const parts = await extractSource({ originalPath: path, mediaDir, scratchDir: join(dir, 'scratch') }, { signal, progress: vi.fn(), vision, transcribe })
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(vision).toHaveBeenCalledTimes(1)
    expect(parts.map(part => part.kind)).toEqual(['transcript', 'vision'])
    expect(parts.find(part => part.kind === 'vision')?.locator).toContain('00:00:00 视频抽样帧')
  })

  it('取消等待 FFmpeg 退出，临时文件可以立即删除', async () => {
    const dir = await fixtureDir(), path = join(dir, '取消.wav')
    const controller = new AbortController()
    const process = runMedia(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-re', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '60', path], controller.signal)
    setTimeout(() => controller.abort(), 200)
    await expect(process).rejects.toThrow('取消')
    await rm(path, { force: true })
  })
})
