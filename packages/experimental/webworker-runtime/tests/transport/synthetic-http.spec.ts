/** Node request consumers share one Readable body with decoding and cancellation. */
import { expect, it, vi } from 'vitest'
import { Readable } from '../../src/node/builtin_modules/implemented/stream.ts'
import { createSyntheticExchange, type ResponseSink } from '../../src/transport/synthetic-http.ts'
import type { TunnelRequestFrame } from '../../src/transport/frames.ts'
import type { ServerResponse } from 'node:http'

function fixture(body?: TunnelRequestFrame['body']) {
  const sink = { head: vi.fn(), chunk: vi.fn(), end: vi.fn(), fail: vi.fn() } satisfies ResponseSink
  const exchange = createSyntheticExchange({ t: 'req', id: 1, url: '/api/test', method: 'POST', headers: {},
    ...body === undefined ? {} : { body } }, sink)
  const request = exchange.req as InstanceType<typeof Readable>
  return { exchange, request, sink }
}

it('merges case-insensitive response headers with writeHead taking precedence', () => {
  const { exchange, sink } = fixture()
  const response = exchange.res as ServerResponse
  expect(response.setHeader('X-Kept', 3)).toBe(response)
  response.setHeader('Content-Type', 'text/plain')
  response.setHeader('X-Removed', 'gone')
  expect(response.hasHeader('x-REMOVED')).toBe(true)
  response.removeHeader('X-removed')
  expect(response.getHeader('x-removed')).toBeUndefined()
  response.writeHead(201, { 'content-TYPE': 'application/json' })
  expect(response.getHeader('CONTENT-TYPE')).toBe('application/json')
  response.end('{}')
  expect(sink.end).toHaveBeenCalledWith(expect.objectContaining({ status: 201,
    headers: { 'x-kept': '3', 'content-type': 'application/json' } }))
})

it('preserves statusCode assignments and writeHead reads for unary and streamed responses', () => {
  const first = fixture()
  const response = first.exchange.res as { statusCode: number; writeHead(status: number): void; end(): void }
  expect(response.statusCode).toBe(200)
  response.writeHead(401)
  expect(response.statusCode).toBe(401)
  response.statusCode = 403
  response.end()
  expect(first.sink.end).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }))
  const second = fixture()
  const streaming = second.exchange.res as { statusCode: number; write(body: string): void; end(): void }
  streaming.statusCode = 418
  streaming.write('body')
  streaming.end()
  expect(second.sink.head).toHaveBeenCalledWith(418, {})
})

it('supports the published plugin event reader with split UTF-8 and a single body cursor', async () => {
  const bytes = new TextEncoder().encode('{"sessionId":"中文"}')
  const { request } = fixture(new ReadableStream<Uint8Array>({ start(output) {
    for (const byte of bytes) output.enqueue(new Uint8Array([byte]))
    output.close()
  } }))
  request.setEncoding('utf8')
  const result = await new Promise<string>((resolve, reject) => {
    let text = ''
    request.on('data', (chunk) => { expect(typeof chunk).toBe('string'); text += String(chunk) })
    request.on('end', () => { resolve(text) })
    request.on('error', reject)
  })
  expect(JSON.parse(result)).toEqual({ sessionId: '中文' })
  const later: unknown[] = []
  for await (const chunk of request) later.push(chunk)
  expect(later).toEqual([])
})

it('retains binary async iteration for existing core routes', async () => {
  const { request } = fixture(new TextEncoder().encode('body').buffer)
  const values: Uint8Array[] = []
  for await (const chunk of request) values.push(chunk as Uint8Array)
  expect(values.every(value => value instanceof Uint8Array)).toBe(true)
  expect(values.map(value => new TextDecoder().decode(value)).join('')).toBe('body')
})

it('aborts a pending body read and reports the error only to its route consumer', async () => {
  const waiting = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const { exchange, request, sink } = fixture(new ReadableStream<Uint8Array>({
    pull() { waiting.resolve(undefined) }, cancel() { cancelled.resolve(undefined) },
  }))
  const error = Promise.withResolvers<unknown>()
  const closed = Promise.withResolvers<undefined>()
  const aborted = vi.fn()
  const end = vi.fn()
  request.on('aborted', aborted)
  request.on('error', error.resolve)
  request.on('close', () => { closed.resolve(undefined) })
  request.on('end', end)
  request.on('data', () => {})
  await waiting.promise
  exchange.abort()
  expect(await error.promise).toMatchObject({ name: 'AbortError' })
  await Promise.all([closed.promise, cancelled.promise])
  expect(aborted).toHaveBeenCalledOnce()
  expect(end).not.toHaveBeenCalled()
  expect(sink.fail).not.toHaveBeenCalled()
})

it('delivers source errors once and lets the route write its own failure response', async () => {
  const failure = new Error('body read failed')
  const { exchange, request, sink } = fixture(new ReadableStream({ start(output) { output.error(failure) } }))
  const errors: unknown[] = []
  await new Promise<void>((resolve) => {
    request.on('error', (error) => {
      errors.push(error)
      const response = exchange.res as { writeHead(status: number): void; end(body: string): void }
      response.writeHead(400)
      response.end('invalid body')
    })
    request.on('close', () => { resolve() })
    request.resume()
  })
  expect(errors).toEqual([failure])
  expect(sink.fail).not.toHaveBeenCalled()
  expect(sink.end).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }))
})

it('cancels an unread body when a route finishes without consuming it', async () => {
  const cancelled = Promise.withResolvers<undefined>()
  const { exchange, request } = fixture(new ReadableStream({ cancel() { cancelled.resolve(undefined) } }))
  const closed = Promise.withResolvers<undefined>()
  request.on('close', () => { closed.resolve(undefined) })
  ;(exchange.res as { end(): void }).end()
  await Promise.all([cancelled.promise, closed.promise])
  expect(request.destroyed).toBe(true)
})

it('reports an unhandled body failure through the exchange without an uncaught stream error', async () => {
  const { request, sink } = fixture(new ReadableStream({ start(output) { output.error(new Error('unreadable body')) } }))
  await new Promise<void>((resolve) => { request.on('close', () => { resolve() }); request.resume() })
  expect(sink.fail).toHaveBeenCalledExactlyOnceWith('unreadable body')
  expect(sink.end).not.toHaveBeenCalled()
})
