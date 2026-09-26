import { request } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export interface Credential { clientId: string; token: string }
export interface Transfer {
  id: string; kind: 'text' | 'files';
  text?: { path: string; filePath?: string; untitled?: boolean; content: string; startLine: number; endLine: number; language: string; dirty: boolean; capturedAt: string };
  files?: string[];
}
export interface OutboxItem { id: string; windowId: string; kind: 'markdown'; title?: string; text?: string }
export interface ConnectionResult { status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'; clientId?: string; token?: string }
export class BridgeError extends Error { constructor(message: string, readonly status?: number) { super(message); } }

/** Never uses proxy variables, browser networking, redirects or non-loopback hosts. */
export class BridgeClient {
  private pending = new Set<ReturnType<typeof request>>();
  constructor(readonly discoveryPath: string, readonly windowId: string, private credential?: Credential) {}
  setCredential(value?: Credential): void { this.credential = value; }
  cancel(): void { for (const pending of this.pending) pending.destroy(new BridgeError('连接已取消。')); this.pending.clear(); }
  async call<T>(method: string, route: string, body?: unknown, timeout = 12_000): Promise<T> {
    let discovery: { protocol: number; port: number };
    try { discovery = JSON.parse(await readFile(this.discoveryPath, 'utf8')); }
    catch { throw new BridgeError('模型圆桌尚未启动，或编辑器协同未启用。'); }
    if (discovery.protocol !== 2 || !Number.isInteger(discovery.port) || discovery.port < 1 || discovery.port > 65535) throw new BridgeError('编辑器桥接版本或端口无效，请更新应用和扩展。');
    if (!route.startsWith('/') || route.startsWith('//') || /[\r\n]/.test(route)) throw new BridgeError('无效的桥接请求。');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload) > 256 * 1024) throw new BridgeError('资料过大，请缩小选区或改为导入知识库。');
    return new Promise<T>((accept, reject) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Editor-Window-Id': this.windowId };
      if (this.credential) headers.Authorization = `Bearer ${this.credential.token}`;
      if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));
      const req = request({ hostname: '127.0.0.1', port: discovery.port, path: route, method, headers, agent: false }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) req.destroy(new BridgeError('应用响应超出安全大小限制。'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          let result: unknown;
          try { result = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
          catch { reject(new BridgeError('应用返回了无法解析的桥接响应。')); return; }
          const status = response.statusCode || 500;
          if (status < 200 || status >= 300) {
            const detail = result && typeof result === 'object' && 'error' in result ? String(result.error) : `连接失败（${status}）`;
            reject(new BridgeError(detail, status)); return;
          }
          accept(result as T);
        });
      });
      this.pending.add(req);
      const timer = setTimeout(() => req.destroy(new BridgeError('模型圆桌连接超时。')), timeout);
      req.on('close', () => { clearTimeout(timer); this.pending.delete(req); });
      req.on('error', error => reject(error instanceof BridgeError ? error : new BridgeError('无法连接模型圆桌，请确认应用正在运行。')));
      req.end(payload);
    });
  }
}

export function isLocalFilePath(path: string): boolean {
  return !!path && isAbsolute(path) && !path.includes('\0') && !/^[/\\]{2}/.test(path) && (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path) && !path.slice(2).includes(':'));
}
export async function localFile(path: string): Promise<string> {
  if (!isLocalFilePath(path)) throw new BridgeError('只支持本机磁盘上的普通文件，不支持网络共享或设备路径。');
  const normalized = resolve(path), actual = await realpath(normalized);
  if (!isLocalFilePath(actual) || !(await stat(actual)).isFile()) throw new BridgeError('请选择本机磁盘上的普通文件。');
  return normalized;
}
