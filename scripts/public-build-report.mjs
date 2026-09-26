import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'

export function publicBuildReport(text, root) {
  let result = text.replace(/\r\n/g, '\n')
  const substitutions = [[tmpdir(), '<temporary-directory>'], [homedir(), '<user-profile>'], [resolve(root), '<project>']].sort((a, b) => b[0].length - a[0].length)
  for (const [path, label] of substitutions) {
    for (const variant of new Set([path, path.replaceAll('\\', '/'), path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)])) {
      result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), label)
    }
  }
  const heading = 'Public build record: local project/profile/temporary paths are redacted; version, flags and binary hashes are unchanged.\n'
  return result.startsWith(heading) ? result : heading + result
}
