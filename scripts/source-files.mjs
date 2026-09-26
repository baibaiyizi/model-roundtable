import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { sourceFiles } from './release-files.mjs'
console.log(JSON.stringify(await sourceFiles(resolve(fileURLToPath(new URL('..', import.meta.url))))))
