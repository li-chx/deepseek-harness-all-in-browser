/** HTTPS GET compatibility for registry metadata, backed by browser Fetch and subject to CORS. */
import type { HttpFetch } from '../../../transport/http-transport.ts'
import { Buffer } from 'buffer'
import { EventEmitter } from './events.ts'
import { Readable } from './stream.ts'
import { notAvailableError } from '../../notImplementedFail.ts'

/** Options supported by the metadata GET adapter; sockets, proxies and TLS overrides are unavailable. */
export interface GetOptions {
  headers?: Record<string, string>
  timeout?: number
}

/** Readable metadata response with Node-style status and lower-case headers. */
export type GetResponse = InstanceType<typeof Readable> & { statusCode: number; headers: Record<string, string> }

/** One GET and its response body; destroy aborts Fetch and prevents further response delivery. */
export class GetRequest extends EventEmitter {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private response: GetResponse | undefined
  private settled = false

  constructor(url: URL, private readonly options: GetOptions, callback?: (response: GetResponse) => void,
    private readonly fetcher: HttpFetch = globalThis.fetch.bind(globalThis)) {
    super()
    if (callback !== undefined) this.once('response', (value) => { callback(value as GetResponse) })
    queueMicrotask(() => { void this.start(url) })
  }

  /** Abort the request and any unread response; emits error followed by close once.
   * @param error Failure to report, or a connection-reset error when omitted.
   * @returns This request.
   */
  destroy(error: Error = Object.assign(new Error('HTTPS request destroyed'), { code: 'ECONNRESET' })): this {
    if (this.settled) return this
    this.settled = true
    clearTimeout(this.timer)
    this.controller.abort(error)
    this.response?.destroy()
    this.emit('error', error)
    this.emit('close')
    return this
  }

  private activity(): void {
    clearTimeout(this.timer)
    if ((this.options.timeout ?? 0) > 0) this.timer = setTimeout(() => this.emit('timeout'), this.options.timeout)
  }

  private finish(): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.timer)
    this.controller.abort()
    this.emit('close')
  }

  private async start(url: URL): Promise<void> {
    if (this.settled) return
    this.activity()
    let result: Response
    try {
      result = await this.fetcher(url, { headers: this.options.headers ?? {}, signal: this.controller.signal, redirect: 'manual' })
    } catch (error) {
      this.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.controller.signal.aborted) { await result.body?.cancel(); return }
    this.activity()
    const activity = (): void => { this.activity() }
    const finish = (): void => { this.finish() }
    const reader = result.body?.getReader()
    const body = new Readable({
      read() {
        if (reader === undefined) { this.push(null); return }
        void reader.read().then((next) => {
          if (this.destroyed) return
          activity()
          this.push(next.done ? null : Buffer.from(next.value))
        }, (error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))))
      },
      destroy(error, done) {
        finish()
        if (reader === undefined) { done(error); return }
        void reader.cancel().then(() => { reader.releaseLock(); done(error) }, (cancelError: unknown) => {
          reader.releaseLock()
          done(error ?? (cancelError instanceof Error ? cancelError : new Error(String(cancelError))))
        })
      },
    })
    this.response = Object.assign(body, {
      statusCode: result.status, headers: Object.fromEntries(result.headers.entries()),
    })
    this.response.once('end', () => { this.finish() })
    this.response.once('close', () => { this.finish() })
    this.emit('response', this.response)
  }
}

/** Start a browser HTTPS GET; unknown options fail before any network activity.
 * @param input Absolute HTTPS URL.
 * @param options Headers and inactivity timeout, or the response callback.
 * @param callback Receives the response before body data events.
 * @returns Cancellable request emitting response, timeout, error and close.
 */
function request(fetcher: HttpFetch, input: string | URL, options: GetOptions | ((response: GetResponse) => void) = {},
  callback?: (response: GetResponse) => void): GetRequest {
  const url = new URL(input)
  if (url.protocol !== 'https:') throw new TypeError('node:https.get requires an HTTPS URL')
  const resolved = typeof options === 'function' ? {} : options
  for (const key of Object.keys(resolved)) {
    if (key !== 'headers' && key !== 'timeout') throw notAvailableError('node:https', `get option ${key}`)
  }
  if (resolved.timeout !== undefined && (!Number.isFinite(resolved.timeout) || resolved.timeout < 0)) throw new RangeError('HTTPS timeout must be a nonnegative number')
  return new GetRequest(url, resolved, typeof options === 'function' ? options : callback, fetcher)
}

type HttpsMethods = { get: typeof get; createServer: typeof createServer }

/** Create HTTPS compatibility methods bound to one host's HTTP provider.
 * @param fetcher Outbound Fetch adapter.
 * @returns CommonJS-compatible HTTPS exports.
 */
export function createHttpsModule(fetcher: HttpFetch): HttpsMethods & { __esModule: boolean; default: HttpsMethods } {
  const get = (input: string | URL, options?: GetOptions | ((response: GetResponse) => void),
    callback?: (response: GetResponse) => void): GetRequest => request(fetcher, input, options, callback)
  const methods = { get, createServer }
  return { ...methods, __esModule: true, default: methods }
}

/** Start HTTPS GET through the ambient platform Fetch.
 * @param input HTTPS URL.
 * @param options Headers, timeout, or response callback.
 * @param callback Response callback.
 * @returns Cancellable GET request.
 */
export function get(input: string | URL, options?: GetOptions | ((response: GetResponse) => void),
  callback?: (response: GetResponse) => void): GetRequest {
  return request((input, init) => fetch(input, init), input, options, callback)
}

/** Reject native TLS binding.
 * @returns Never; browsers cannot bind sockets.
 */
export function createServer(): never { throw notAvailableError('node:https', 'createServer') }

/** CommonJS interop marker. */
export const __esModule = true

/** CommonJS exports for the explicitly supported HTTPS operations. */
export default { get, createServer }
