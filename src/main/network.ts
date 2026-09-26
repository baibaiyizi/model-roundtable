import { net, session as electronSession, type Session } from 'electron'

// Electron fetch rejects a manual redirect instead of returning its 3xx response.
// Web imports need each redirect visible so every destination can be validated.
export const fetchWithSession = (session: Session): typeof fetch => async (input, init) => {
  if (init?.redirect !== 'manual') return session.fetch(input instanceof URL ? input.toString() : input, init)
  if (input instanceof Request || (init.method && init.method !== 'GET') || init.body) throw new Error('网页下载只支持 GET。')
  init.signal?.throwIfAborted()
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({ session, url: String(input), method: 'GET', redirect: 'manual', credentials: 'omit', headers: Object.fromEntries(new Headers(init.headers)) })
    let body: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    const fail = (error: unknown): void => {
      if (ended) return
      ended = true
      body?.error(error)
      reject(error)
    }
    const abort = (): void => { fail(init.signal?.reason ?? new Error('网页下载已取消')); request.abort() }
    init.signal?.addEventListener('abort', abort, { once: true })
    request.on('close', () => init.signal?.removeEventListener('abort', abort))
    request.on('error', fail)
    request.on('redirect', (status, _method, destination) => {
      ended = true
      resolve(new Response(null, { status, headers: { location: destination } }))
      request.abort()
    })
    request.on('response', response => {
      const headers = new Headers()
      for (const [key, values] of Object.entries(response.headers)) for (const value of Array.isArray(values) ? values : [values]) headers.append(key, value)
      if ([204, 205, 304].includes(response.statusCode)) {
        ended = true; resolve(new Response(null, { status: response.statusCode, headers })); request.abort(); return
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { body = controller },
        cancel() { ended = true; request.abort() },
      })
      response.on('end', () => { if (!ended) { ended = true; body?.close() } })
      response.on('error', fail)
      response.on('aborted', () => fail(new Error('网页下载已中断')))
      response.on('data', chunk => { if (!ended) body?.enqueue(chunk) })
      resolve(new Response(stream, { status: response.statusCode, headers }))
    })
    if (init.signal?.aborted) { abort(); return }
    request.end()
  })
}
export const desktopFetch: typeof fetch = (input, init) => fetchWithSession(electronSession.defaultSession)(input, init)
