/**
 * Tunnel frame protocol between the page and the worker host. Frames cross
 * `postMessage`, so inbound frames are validated before use.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/transport/frames
 */

import type { VfsPersistenceStatus } from '../storage/persistence-types.ts'

/** Request identifier minted by the page. */
export type TunnelRequestId = string | number

/** One request; `body` carries cloneable or transferable raw bytes. */
export interface TunnelRequestFrame {
  readonly t: 'req'
  readonly id: TunnelRequestId
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: ArrayBuffer | Blob | ReadableStream<Uint8Array> | undefined
}

/** Open one Gateway Remote stream over the worker-local carrier. */
export interface TunnelStreamOpenFrame {
  readonly t: 'stream-open'
  readonly id: TunnelRequestId
  readonly endpoint: string
  readonly payload: unknown
}

/** One uplink item for an open Remote stream; `value` absent and `undefined` are equivalent. */
export interface TunnelStreamUplinkItemFrame {
  readonly t: 'stream-uplink-item'
  readonly id: TunnelRequestId
  readonly value?: unknown
}

/** Page-side half-close of a Remote stream's uplink. */
export interface TunnelStreamUplinkEndFrame {
  readonly t: 'stream-uplink-end'
  readonly id: TunnelRequestId
}

/** Page-side cancellation of an in-flight request or stream. */
export interface TunnelAbortFrame {
  readonly t: 'abort'
  readonly id: TunnelRequestId
}

/** Frames the worker accepts. */
/**
 * First inbound frame: the base image URL and ordered data overlays selected
 * before the worker assembly starts.
 */
export interface TunnelInitFrame {
  readonly t: 'init'
  readonly image: string
  readonly overlays: readonly string[]
  readonly httpPort?: MessagePort
  readonly storage?: TunnelStorageInit
}

/** Serializable browser storage selection; the Worker supplies its own build generation. */
export interface TunnelStorageInit {
  readonly kind: 'indexeddb'
  readonly source: string
  readonly deployment: string
}

/** Every frame the page sends the worker. */
export type TunnelInboundFrame =
  | TunnelInitFrame
  | TunnelRequestFrame
  | TunnelStreamOpenFrame
  | TunnelStreamUplinkItemFrame
  | TunnelStreamUplinkEndFrame
  | TunnelAbortFrame

/** Complete response for unary requests and static files. */
export interface TunnelResponseFrame {
  readonly t: 'res'
  readonly id: TunnelRequestId
  readonly status: number
  readonly headers: Record<string, string>
  readonly body?: ArrayBuffer | undefined
  /** Present when the worker itself refused the request, so the page can surface the reason. */
  readonly message?: string | undefined
}

/** Head of a streamed response, followed by chunks and one terminator. */
export interface TunnelResponseHeadFrame {
  readonly t: 'res-head'
  readonly id: TunnelRequestId
  readonly status: number
  readonly headers: Record<string, string>
}

/** One body chunk of a streamed response. */
export interface TunnelResponseChunkFrame {
  readonly t: 'res-chunk'
  readonly id: TunnelRequestId
  readonly chunk: ArrayBuffer
}

/** Normal end of a streamed response. */
export interface TunnelResponseEndFrame {
  readonly t: 'res-end'
  readonly id: TunnelRequestId
}

/** Failure of a streamed response after its head was sent. */
export interface TunnelResponseErrorFrame {
  readonly t: 'res-err'
  readonly id: TunnelRequestId
  readonly message: string
}

/** One decoded value from a worker-local Gateway Remote stream. */
export interface TunnelStreamItemFrame {
  readonly t: 'stream-item'
  readonly id: TunnelRequestId
  readonly value?: unknown
}

/** Normal completion of a worker-local Gateway Remote stream. */
export interface TunnelStreamEndFrame {
  readonly t: 'stream-end'
  readonly id: TunnelRequestId
}

/** Stable Host failure or worker-carrier failure for one logical stream. */
export interface TunnelStreamErrorFrame {
  readonly t: 'stream-error'
  readonly id: TunnelRequestId
  readonly failure:
    | {
      readonly kind: 'remote'
      readonly code: string
      readonly message: string
      readonly details: object
    }
    | {
      readonly kind: 'carrier'
      readonly message: string
    }
}

/** Worker request to show one VFS text file in the page's read-only viewer; no reply follows. */
export interface TunnelViewTextFrame {
  readonly t: 'view-text'
  /** Absolute VFS path, shown as the viewer title. */
  readonly path: string
  readonly text: string
}

/** Commit status emitted independently of HTTP responses. */
export interface TunnelStorageStatusFrame {
  readonly t: 'storage-status'
  readonly status: VfsPersistenceStatus
}

/** Frames the worker emits. */
export type TunnelOutboundFrame =
  | TunnelStorageStatusFrame
  | TunnelViewTextFrame
  | TunnelResponseFrame
  | TunnelResponseHeadFrame
  | TunnelResponseChunkFrame
  | TunnelResponseEndFrame
  | TunnelResponseErrorFrame
  | TunnelStreamItemFrame
  | TunnelStreamEndFrame
  | TunnelStreamErrorFrame

/**
 * Validate a `postMessage` payload as a tunnel frame.
 * @param data - Message data received by the worker.
 * @returns The frame.
 */
export function parseInboundFrame(data: unknown): TunnelInboundFrame {
  if (typeof data !== 'object' || data === null) {
    throw new Error(`webworker tunnel: message is not a frame: ${String(data)}`)
  }
  const frame = data as Record<string, unknown>
  if (frame.t === 'init') {
    if (typeof frame.image !== 'string') {
      throw new Error('webworker tunnel: init frame needs a string image url')
    }
    if (!Array.isArray(frame.overlays) || frame.overlays.some(overlay => typeof overlay !== 'string')) {
      throw new Error('webworker tunnel: init frame needs an array of string overlay urls')
    }
    if (frame.httpPort !== undefined && !(frame.httpPort instanceof MessagePort)) throw new Error('webworker tunnel: invalid HTTP provider port')
    let storage: TunnelStorageInit | undefined
    if (frame.storage !== undefined) {
      if (typeof frame.storage !== 'object' || frame.storage === null) throw new Error('webworker tunnel: invalid storage configuration')
      const value = frame.storage as Record<string, unknown>
      if (value.kind !== 'indexeddb' || typeof value.source !== 'string' || !value.source || typeof value.deployment !== 'string' || !value.deployment) {
        throw new Error('webworker tunnel: invalid storage configuration')
      }
      storage = { kind: 'indexeddb', source: value.source, deployment: value.deployment }
    }
    return { t: 'init', image: frame.image, overlays: frame.overlays as string[],
      ...frame.httpPort === undefined ? {} : { httpPort: frame.httpPort }, ...storage === undefined ? {} : { storage } }
  }
  const id = frame.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new Error(`webworker tunnel: frame has no usable id: ${JSON.stringify(frame.id)}`)
  }
  if (frame.t === 'abort') return { t: 'abort', id }
  if (frame.t === 'stream-uplink-end') return { t: 'stream-uplink-end', id }
  if (frame.t === 'stream-uplink-item') return { t: 'stream-uplink-item', id, value: frame.value }
  if (frame.t === 'stream-open') {
    if (typeof frame.endpoint !== 'string' || frame.endpoint.length === 0) {
      throw new Error(`webworker tunnel: stream ${String(id)} needs a non-empty endpoint`)
    }
    return { t: 'stream-open', id, endpoint: frame.endpoint, payload: frame.payload }
  }
  if (frame.t !== 'req') throw new Error(`webworker tunnel: unknown frame type ${JSON.stringify(frame.t)}`)
  if (typeof frame.method !== 'string' || typeof frame.url !== 'string') {
    throw new Error(`webworker tunnel: request ${String(id)} needs string method and url`)
  }
  if (typeof frame.headers !== 'object' || frame.headers === null) {
    throw new Error(`webworker tunnel: request ${String(id)} needs a headers object`)
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(frame.headers)) {
    if (typeof value === 'string') headers[key.toLowerCase()] = value
  }
  const body = frame.body
  if (body !== undefined
    && !(body instanceof ArrayBuffer)
    && !(body instanceof Blob)
    && !(body instanceof ReadableStream)) {
    throw new Error(`webworker tunnel: request ${String(id)} body must be an ArrayBuffer, Blob, or ReadableStream`)
  }
  return { t: 'req', id, method: frame.method, url: frame.url, headers, body }
}

/**
 * Validate a storage status received over the page transport.
 * @param data - Worker status event or local HTTP response.
 * @returns The commit state with validated counters and diagnostics.
 */
export function parseStorageStatus(data: unknown): VfsPersistenceStatus {
  if (typeof data !== 'object' || data === null) throw new Error('webworker storage: invalid status')
  const value = data as Record<string, unknown>
  if (!['saved', 'pending', 'failed'].includes(String(value.kind))
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.pending !== 'number' || !Number.isSafeInteger(value.pending) || value.pending < 0
    || value.kind === 'saved' && value.pending !== 0) throw new Error('webworker storage: invalid status')
  if (value.kind === 'failed') {
    if (typeof value.error !== 'object' || value.error === null) throw new Error('webworker storage: missing failure details')
    const error = value.error as Record<string, unknown>
    if (typeof error.code !== 'string' || typeof error.message !== 'string') throw new Error('webworker storage: invalid failure details')
    return { kind: 'failed', revision: value.revision, pending: value.pending, error: { code: error.code, message: error.message } }
  }
  if (value.kind !== 'saved' && value.kind !== 'pending') throw new Error('webworker storage: invalid state')
  return { kind: value.kind, revision: value.revision, pending: value.pending }
}
