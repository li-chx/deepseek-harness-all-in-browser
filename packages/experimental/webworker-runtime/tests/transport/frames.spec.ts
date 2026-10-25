import { describe, expect, it } from 'vitest'
import { parseInboundFrame, parseStorageStatus } from '../../src/transport/frames.ts'

describe('tunnel init frame', () => {
  it('retains the selected overlay order', () => {
    expect(parseInboundFrame({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })).toEqual({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })
  })

  it('rejects a missing or non-string overlay list', () => {
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz' })).toThrow(/array of string overlay urls/)
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz', overlays: [1] }))
      .toThrow(/array of string overlay urls/)
  })
})

describe('tunnel uplink frames', () => {
  it('parses uplink items with and without a value and the uplink end', () => {
    expect(parseInboundFrame({ t: 'stream-uplink-item', id: 7, value: { line: 'ls' } }))
      .toEqual({ t: 'stream-uplink-item', id: 7, value: { line: 'ls' } })
    expect(parseInboundFrame({ t: 'stream-uplink-item', id: 'seven' }))
      .toEqual({ t: 'stream-uplink-item', id: 'seven', value: undefined })
    expect(parseInboundFrame({ t: 'stream-uplink-end', id: 7 })).toEqual({ t: 'stream-uplink-end', id: 7 })
    expect(() => parseInboundFrame({ t: 'stream-uplink-end' })).toThrow('frame has no usable id')
  })
})

describe('tunnel request bodies', () => {
  it('accepts ArrayBuffer, Blob, and ReadableStream bodies and rejects other values', () => {
    const bytes = Uint8Array.of(1, 2).buffer
    const blob = new Blob(['large'])
    expect(parseInboundFrame({
      t: 'req', id: 1, method: 'POST', url: '/bytes', headers: {}, body: bytes,
    })).toMatchObject({ body: bytes })
    expect(parseInboundFrame({
      t: 'req', id: 2, method: 'POST', url: '/blob', headers: {}, body: blob,
    })).toMatchObject({ body: blob })
    const stream = new ReadableStream<Uint8Array>()
    expect(parseInboundFrame({
      t: 'req', id: 3, method: 'POST', url: '/stream', headers: {}, body: stream,
    })).toMatchObject({ body: stream })
    expect(() => parseInboundFrame({
      t: 'req', id: 4, method: 'POST', url: '/bad', headers: {}, body: 'large',
    })).toThrow('body must be an ArrayBuffer, Blob, or ReadableStream')
  })
})

describe('browser persistence frames', () => {
  it('retains source and deployment identity without accepting a page-selected generation', () => {
    expect(parseInboundFrame({ t: 'init', image: 'base.tar.gz', overlays: [], storage: { kind: 'indexeddb', source: 'none', deployment: 'app', generation: 'untrusted' } }))
      .toEqual({ t: 'init', image: 'base.tar.gz', overlays: [], storage: { kind: 'indexeddb', source: 'none', deployment: 'app' } })
  })
  it.each([null, {}, { kind: 'rpc', source: 'none', deployment: 'app' }, { kind: 'indexeddb', source: '', deployment: 'app' }])('rejects invalid storage selection %j', (storage) => {
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz', overlays: [], storage })).toThrow('invalid storage configuration')
  })
})


it('accepts commit status and rejects a saved claim with uncommitted changes', () => {
  expect(parseStorageStatus({ kind: 'saved', revision: 2, pending: 0 })).toEqual({ kind: 'saved', revision: 2, pending: 0 })
  expect(parseStorageStatus({ kind: 'failed', revision: 2, pending: 1, error: { code: 'STORAGE_CONFLICT', message: 'stale writer' } }))
    .toMatchObject({ kind: 'failed', error: { code: 'STORAGE_CONFLICT' } })
  expect(() => parseStorageStatus({ kind: 'saved', revision: 2, pending: 1 })).toThrow('invalid status')
  expect(() => parseStorageStatus({ kind: 'failed', revision: 2, pending: 1 })).toThrow('missing failure details')
})
