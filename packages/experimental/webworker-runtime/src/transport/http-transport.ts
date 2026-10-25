/** Instance-owned outbound HTTP; providers preserve streaming bodies and honor Request.signal. */
export interface HttpTransport {
  /** Send one request without buffering its body or response.
   * @param request Request including cancellation, headers and Fetch policies.
   * @returns Response whose body remains readable until cancellation or completion.
   */
  fetch(request: Request): Promise<Response>
}

/** Fetch call signature used by browser and Node compatibility consumers. */
export type HttpFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Own request cancellation for one Worker, including responses still being consumed. */
export class WorkerHttpTransport implements HttpTransport {
  private readonly controller = new AbortController()
  private readonly provider: HttpTransport

  constructor(provider?: HttpTransport) {
    const nativeFetch = globalThis.fetch.bind(globalThis)
    this.provider = provider ?? { fetch: request => nativeFetch(request) }
  }

  /** Fetch-compatible adapter; all consumers share this instance's lifetime. */
  readonly request: HttpFetch = async (input, init) => this.fetch(new Request(input, init))

  /** Send through the configured provider with Worker shutdown cancellation.
   * @param request Caller-owned request.
   * @returns Provider response; streaming and headers are unchanged.
   */
  async fetch(request: Request): Promise<Response> {
    const signal = AbortSignal.any([request.signal, this.controller.signal])
    signal.throwIfAborted()
    const response = await this.provider.fetch(new Request(request, { signal }))
    if (signal.aborted) { await response.body?.cancel(signal.reason); signal.throwIfAborted() }
    if (response.body === null) return response
    const reader = response.body.getReader()
    let output: ReadableStreamDefaultController<Uint8Array>
    let ended = false
    const finish = (): void => { ended = true; signal.removeEventListener('abort', abort); reader.releaseLock() }
    const abort = (): void => {
      if (ended) return
      output.error(signal.reason)
      void reader.cancel(signal.reason).then(finish, (error: unknown) => { finish(); console.error('HTTP response cancellation failed', error) })
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() },
      async pull(controller) {
        try {
          const next = await reader.read()
          if (ended || signal.aborted) return
          if (next.done) { controller.close(); finish() } else controller.enqueue(next.value)
        } catch (error) { if (!ended && !signal.aborted) { controller.error(error); finish() } }
      },
      async cancel(reason) { if (!ended) { try { await reader.cancel(reason) } finally { finish() } } },
    })
    const wrapped = new Response(body, response)
    Object.defineProperties(wrapped, {
      url: { value: response.url }, type: { value: response.type }, redirected: { value: response.redirected },
    })
    return wrapped
  }

  /** Abort outstanding requests and reject future requests. */
  close(): void { this.controller.abort(new DOMException('Worker HTTP transport disposed', 'AbortError')) }
}

/** Give VFS modules instance-local fetch without mutating the real Worker global.
 * @param fetch Outbound HTTP adapter.
 * @returns Global proxy preserving global aliases and platform receiver identity.
 */
export function httpModuleGlobal(fetch: HttpFetch): typeof globalThis {
  const bound = new Map<object, (...args: unknown[]) => unknown>()
  const proxy = new Proxy(globalThis, {
    get(target, key) {
      if (key === 'fetch') return fetch
      if (key === 'globalThis' || key === 'self' || key === 'global') return proxy
      const value: unknown = Reflect.get(target, key, target)
      // Constructors retain identity/prototype. Native global methods need the real global receiver.
      if (typeof value !== 'function' || Object.hasOwn(value, 'prototype')) return value
      const method = bound.get(value)
      if (method === undefined) {
        const callable = value as (...args: unknown[]) => unknown
        const receiverBound = callable.bind(target)
        bound.set(value, receiverBound)
        return receiverBound
      }
      return method
    },
  })
  return proxy
}
