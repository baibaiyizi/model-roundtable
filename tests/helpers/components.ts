import { resolve } from 'node:path'
import { RuntimeManager } from '../../src/main/components'

export const componentCache = resolve(process.env.MODEL_ROUNDTABLE_COMPONENTS_DIR ?? '.cache/components-runtime')
export const componentTestEnv = { MODEL_ROUNDTABLE_COMPONENTS_DIR: componentCache }
export const testComponents = new RuntimeManager({ manifestPath: resolve('resources/components/manifest.json'), cacheDir: componentCache })
