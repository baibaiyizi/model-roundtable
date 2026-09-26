import type { Connection } from '@lancedb/lancedb'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ComponentRuntimePort } from '../../shared/components'
import { MissingComponentError } from '../components'

export type VectorRow = { id: string; sourceId: string; vector: number[] }
export class VectorStore {
  private connection?: Promise<Connection>
  constructor(private readonly directory: string, private readonly components?: ComponentRuntimePort) {}
  async ready(): Promise<void> { await this.db() }
  private async db(): Promise<Connection> {
    if (!this.connection) this.connection = this.open().catch(error => { this.connection = undefined; throw error })
    return this.connection
  }
  private async open(): Promise<Connection> {
    if (!this.components) throw new MissingComponentError('lancedb', '长期知识库向量索引')
    const component = await this.components.resolve('lancedb')
    // Both the wrapper and native addon resolve inside the immutable component tree.
    // A global NAPI_RS_NATIVE_LIBRARY_PATH would also redirect Canvas and must never be used.
    const isolatedRequire = createRequire(join(component.directory, 'component-loader.cjs'))
    const lance = isolatedRequire('@lancedb/lancedb') as typeof import('@lancedb/lancedb')
    this.components.markLoaded?.('lancedb')
    return lance.connect(this.directory)
  }
  private tableName(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('无效的知识库 ID')
    return `kb_${id.replaceAll('-', '_')}`
  }
  async add(kbId: string, rows: VectorRow[]): Promise<void> {
    if (!rows.length) return
    const db = await this.db(), name = this.tableName(kbId)
    if ((await db.tableNames()).includes(name)) {
      const table = await db.openTable(name)
      try { await table.add(rows) } finally { table.close() }
    } else (await db.createTable(name, rows)).close()
  }
  async removeSource(kbId: string, sourceId: string): Promise<void> {
    const db = await this.db(), name = this.tableName(kbId)
    if ((await db.tableNames()).includes(name)) {
      const table = await db.openTable(name)
      try { await table.delete(`sourceId = '${sourceId.replaceAll("'", "''")}'`) } finally { table.close() }
    }
  }
  async drop(kbId: string): Promise<void> {
    const db = await this.db(), name = this.tableName(kbId)
    if ((await db.tableNames()).includes(name)) await db.dropTable(name)
  }
  async nearest(kbId: string, vector: number[], readyIds: string[], limit = 8): Promise<string[]> {
    if (!readyIds.length) return []
    const db = await this.db(), name = this.tableName(kbId)
    if (!(await db.tableNames()).includes(name)) throw new Error('知识库索引不存在，请重建索引')
    const filter = `sourceId IN (${readyIds.map(id => `'${id.replaceAll("'", "''")}'`).join(',')})`
    const table = await db.openTable(name)
    try {
      const rows = await table.vectorSearch(vector).distanceType('cosine').where(filter).select(['id', '_distance']).limit(limit).toArray()
      return rows.map(row => String(row.id))
    } finally { table.close() }
  }
  async close(): Promise<void> { if (this.connection) { try { (await this.connection).close() } finally { this.connection = undefined } } }
}
