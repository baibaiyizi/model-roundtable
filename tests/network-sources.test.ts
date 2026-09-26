import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const { buildDependencies, verifyNetworkSources } = createRequire(import.meta.url)('../scripts/network-sources.mjs')
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'roundtable-network-source-test-')); roots.push(root)
  const original = resolve('resources/network')
  await cp(original, root, { recursive: true, filter: path => !path.startsWith(join(original, 'sources') + sep) && path !== join(original, 'sources') && !path.endsWith('.zip') })
  return { root, manifest: JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'roundtable-network-source-test-'))) throw new Error('Unexpected test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('Mihomo corresponding source gate', () => {
  it('retains every actual binary dependency and the 121-certificate build snapshot', async () => {
    const directory = resolve('resources/network')
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    const result = await verifyNetworkSources(directory, manifest)
    expect(result.modules).toBe(176)
    expect(result.dependencies).toBeGreaterThan(100)
    expect(manifest.omittedNonRuntimeModules[0].path).toBe('github.com/RyuaNerin/testingutil')
  })
  it('checks a replacement module instead of pretending the original protobuf source was linked', () => {
    const result = buildDependencies('\tdep\tgoogle.golang.org/protobuf\tv1.34.2\n\t=>\tgithub.com/metacubex/protobuf-go\tv0.0.0-test\th1:exact\n')
    expect(result[0].replacement).toEqual({ path: 'github.com/metacubex/protobuf-go', version: 'v0.0.0-test', sum: 'h1:exact' })
  })
  it('blocks modified original license text', async () => {
    const { root, manifest } = await fixture()
    await writeFile(join(root, 'licenses/toolchain/go/LICENSE'), 'changed license')
    await expect(verifyNetworkSources(root, manifest)).rejects.toThrow('checksum mismatch')
  })
  it('blocks missing source archives even when license texts remain', async () => {
    const { root, manifest } = await fixture()
    manifest.artifacts = manifest.artifacts.filter((item: { file: string }) => item.file !== manifest.modules[0].archive)
    await expect(verifyNetworkSources(root, manifest)).rejects.toThrow('Go source missing')
  })
  it('blocks incorrect module sums', async () => {
    const { root, manifest } = await fixture()
    manifest.modules[0].sum = 'h1:incorrect'
    await expect(verifyNetworkSources(root, manifest)).rejects.toThrow('Go sum mismatch')
  })
  it('blocks a deleted actual CA source snapshot', async () => {
    const { root, manifest } = await fixture()
    manifest.materials = manifest.materials.filter((item: { file: string }) => item.file !== 'build-info/ca-certificates.crt')
    await expect(verifyNetworkSources(root, manifest)).rejects.toThrow('Missing Mihomo source material')
  })
})
