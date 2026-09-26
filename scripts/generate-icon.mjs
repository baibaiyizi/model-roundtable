import { readFile, writeFile } from 'node:fs/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'

// Original vector artwork; keep the SVG as the source of all desktop sizes.
const source = new URL('../resources/icon.svg', import.meta.url)
const image = await loadImage(await readFile(source))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = []
for (const size of [...sizes, 512]) {
  const canvas = createCanvas(size, size)
  canvas.getContext('2d').drawImage(image, 0, 0, size, size)
  const png = await canvas.encode('png')
  if (size === 512) await writeFile(new URL('../resources/icon.png', import.meta.url), png)
  else frames.push(png)
}
// Windows supports PNG payloads in ICO entries. Each frame has its native size.
const directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16
  directory[entry] = size === 256 ? 0 : size
  directory[entry + 1] = size === 256 ? 0 : size
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(frames[index].length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += frames[index].length
}
await writeFile(new URL('../resources/icon.ico', import.meta.url), Buffer.concat([directory, ...frames]))
console.log('Generated icon.png (512px) and icon.ico (16/24/32/48/64/128/256px).')
