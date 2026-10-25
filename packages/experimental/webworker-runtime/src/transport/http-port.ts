/** Dedicated MessagePort HTTP carrier. Bodies transfer as streams; unsupported transfer fails without buffering. */
import { WorkerHttpTransport, type HttpTransport } from './http-transport.ts'

interface Fields {
  url: string
  method: string
  headers: [string, string][]
  body: ReadableStream<Uint8Array> | null
  redirect: RequestRedirect
  credentials: RequestCredentials
  mode: RequestMode
  cache: RequestCache
  referrer: string
  referrerPolicy: ReferrerPolicy
  integrity: string
  keepalive: boolean
}
interface Reply {
  id: number
  status: number
  statusText: string
  headers: [string, string][]
  body: ReadableStream<Uint8Array> | null
  url: string
  redirected: boolean
  type: ResponseType
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' }
function identified(value: unknown): value is Record<string, unknown> & { id: number } {
  return object(value) && Number.isSafeInteger(value.id) && typeof value.id === 'number' && value.id > 0
}
function headers(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === 2 && row.every(item => typeof item === 'string'))
}
function stream(value: unknown): value is ReadableStream<Uint8Array> | null { return value === null || value instanceof ReadableStream }
function fields(value: unknown): value is Fields {
  return object(value) && typeof value.url === 'string' && typeof value.method === 'string' && headers(value.headers)
    && stream(value.body) && ['follow', 'error', 'manual'].includes(String(value.redirect))
    && ['omit', 'same-origin', 'include'].includes(String(value.credentials))
    && ['cors', 'no-cors', 'same-origin', 'navigate'].includes(String(value.mode))
    && ['default', 'no-store', 'reload', 'no-cache', 'force-cache', 'only-if-cached'].includes(String(value.cache))
    && typeof value.referrer === 'string' && typeof value.referrerPolicy === 'string'
    && typeof value.integrity === 'string' && typeof value.keepalive === 'boolean'
}
function reply(value: unknown): value is Reply {
  return identified(value) && typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 200 && value.status <= 599
    && typeof value.statusText === 'string' && headers(value.headers) && stream(value.body)
    && typeof value.url === 'string' && typeof value.redirected === 'boolean'
    && ['basic', 'cors', 'default', 'error', 'opaque', 'opaqueredirect'].includes(String(value.type))
}
function failure(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Restore Fetch response metadata not accepted by the Response constructor.
 * @param value Validated HTTP reply.
 * @returns Streaming Fetch response.
 */
function response(value: Reply): Response {
  const result = new Response(value.body, value)
  Object.defineProperties(result, { url: { value: value.url }, redirected: { value: value.redirected }, type: { value: value.type } })
  return result
}

/** Worker-side HTTP provider; caller closes it when the worker host is disposed. */
export class PortHttpTransport implements HttpTransport {
  private next = 0
  private closed = false
  private readonly pending = new Map<number, {
    resolve(value: Response): void
    reject(error: Error): void
    remove(): void
    responded: boolean
  }>()
  constructor(private readonly port: MessagePort) { port.addEventListener('message', this.message); port.start() }

  private readonly message = (event: MessageEvent<unknown>): void => {
    const value = event.data
    if (object(value) && value.t === 'close') { this.close(); return }
    if (!identified(value)) { this.close(); return }
    const pending = this.pending.get(value.id)
    if (pending === undefined) {
      if (reply(value)) void value.body?.cancel().catch((error: unknown) =>{  console.error('HTTP discarded response cancellation failed', error) })
      return
    }
    if (value.t === 'end') { if (!pending.responded) pending.reject(new Error('HTTP body ended before response')); pending.remove(); return }
    if (value.t === 'error' && typeof value.message === 'string') {
      pending.remove(); pending.reject(new Error(value.message)); return
    }
    if (value.t !== 'response' || !reply(value)) { this.close(); return }
    // Abort remains connected after headers; the provider retires it when the transferred body ends.
    if (pending.responded) { this.close(); return }
    try { pending.resolve(response(value)); pending.responded = true }
    catch (error) {
      pending.remove(); pending.reject(new Error('Invalid HTTP response', { cause: error }))
      this.port.postMessage({ t: 'abort', id: value.id })
      void value.body?.cancel().catch((error: unknown) =>{  console.error('HTTP invalid response cancellation failed', error) })
      return
    }
    if (value.body === null) pending.remove()
  }

  /** Send Fetch fields and transferable body over the owned port.
   * @param request Outbound request with caller cancellation.
   * @returns Streaming response, or a rejection when transport/transfer fails.
   */
  async fetch(request: Request): Promise<Response> {
    if (this.closed) return Promise.reject(new Error('HTTP port is closed'))
    request.signal.throwIfAborted()
    const id = ++this.next
    return new Promise<Response>((resolve, reject) => {
      const remove = (): void => { this.pending.delete(id); request.signal.removeEventListener('abort', abort) }
      const abort = (): void => { this.port.postMessage({ t: 'abort', id }); remove(); reject(request.signal.reason instanceof Error ? request.signal.reason : new DOMException('Request aborted', 'AbortError')) }
      this.pending.set(id, { resolve, reject, remove, responded: false })
      request.signal.addEventListener('abort', abort, { once: true })
      const data: Fields = { url: request.url, method: request.method, headers: [...request.headers], body: request.body,
        redirect: request.redirect, credentials: request.credentials, mode: request.mode, cache: request.cache,
        referrer: request.referrer, referrerPolicy: request.referrerPolicy, integrity: request.integrity, keepalive: request.keepalive }
      try { this.port.postMessage({ t: 'request', id, request: data }, request.body === null ? [] : [request.body]) }
      catch (error) { remove(); reject(new Error('HTTP request stream transfer failed', { cause: error })) }
    })
  }

  /** Abort provider work, reject pending calls, detach listeners and close the port. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.port.postMessage({ t: 'close' })
    for (const pending of this.pending.values()) { pending.remove(); pending.reject(new Error('HTTP port closed')) }
    this.port.removeEventListener('message', this.message)
    this.port.close()
  }
}

/** Serve HTTP from the page (for example through native RPC); function values never cross threads.
 * @param port Dedicated port transferred alongside Worker init.
 * @param transport Provider honoring request cancellation through response body consumption.
 * @returns Disposer aborting outstanding requests and closing the port.
 */
export function serveHttpTransport(port: MessagePort, transport: HttpTransport): () => void {
  const http = new WorkerHttpTransport(transport)
  const controllers = new Map<number, AbortController>()
  let closed = false
  const dispose = (): void => {
    if (closed) return
    closed = true
    http.close()
    port.postMessage({ t: 'close' })
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    port.removeEventListener('message', receive)
    port.close()
  }
  const run = async (id: number, value: Fields): Promise<void> => {
    const controller = new AbortController()
    controllers.set(id, controller)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      // Node test hosts require duplex for stream uploads; browsers ignore this extra init member.
      const init = { ...value, signal: controller.signal, duplex: 'half' }
      const result = await http.fetch(new Request(value.url, init))
      if (controller.signal.aborted || closed) { await result.body?.cancel(); return }
      if (result.status === 0) throw new Error('HTTP port cannot expose an opaque response; provider must return readable HTTP results')
      reader = result.body?.getReader()
      const responseReader = reader
      const release = (): void => { controllers.delete(id); port.postMessage({ t: 'end', id }) }
      const body = responseReader === undefined ? null : new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const next = await responseReader.read()
            if (next.done) { output.close(); release(); responseReader.releaseLock() }
            else output.enqueue(next.value)
          } catch (error) { output.error(error); release(); responseReader.releaseLock() }
        },
        async cancel(reason) {
          controller.abort(reason)
          try { await responseReader.cancel(reason) } finally { release(); responseReader.releaseLock() }
        },
      })
      port.postMessage({ t: 'response', id, status: result.status, statusText: result.statusText, headers: [...result.headers],
        body, url: result.url, redirected: result.redirected, type: result.type }, body === null ? [] : [body])
      if (body === null) controllers.delete(id)
    } catch (error) {
      controllers.delete(id)
      controller.abort(error)
      if (reader !== undefined) {
        try { await reader.cancel(error) } catch (cancelError) { console.error('HTTP transfer cleanup failed', cancelError) }
        reader.releaseLock()
      }
      if (!closed) port.postMessage({ t: 'error', id, message: failure(error) })
    }
  }
  const receive = (event: MessageEvent<unknown>): void => {
    const value = event.data
    if (object(value) && value.t === 'close') { dispose(); return }
    if (!identified(value)) { dispose(); return }
    if (value.t === 'abort') { controllers.get(value.id)?.abort(); return }
    if (value.t !== 'request' || !fields(value.request) || controllers.has(value.id)) { dispose(); return }
    void run(value.id, value.request)
  }
  port.addEventListener('message', receive)
  port.start()
  return dispose
}
