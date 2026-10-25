// @vitest-environment jsdom
/** Host API and marketplace requests use the Worker carrier without intercepting unrelated page traffic. */
import { afterEach, expect, it, vi } from 'vitest'
import { forwardWorkerHostRequests } from '../src/worker-host-fetch.ts'

let release: (() => void) | undefined
afterEach(() => { release?.(); release = undefined; vi.unstubAllGlobals() })

it('passes unrelated, cross-origin and lookalike paths to the previous fetch unchanged', async () => {
  const native = vi.fn(async () => new Response('native'))
  const host = vi.fn(async () => new Response('host'))
  vi.stubGlobal('fetch', native)
  release = forwardWorkerHostRequests(host)
  for (const path of ['/assets/app.js', '/api-other/test', '/api%2Ftest', 'https://example.org/api/test', '/dsh-plugin-hub-other', '/dsh-plugin-hub%2Fenv', 'https://example.org/dsh-plugin-hub/env']) {
    const init = { headers: { 'x-test': 'native' } }
    expect(await (await fetch(path, init)).text()).toBe('native')
    expect(native).toHaveBeenLastCalledWith(path, init)
  }
  expect(host).not.toHaveBeenCalled()
})

it.each(['/dsh-plugin-hub/install', '/api/mobile-nav.session.delete'])(
  'retains Request and init semantics and does not retry %s 404 on the static server', async (path) => {
    const native = vi.fn(async () => new Response('native'))
    let captured: RequestInit | undefined
    const host = vi.fn(async (_path: URL | string, init?: RequestInit) => {
      captured = init
      return new Response('missing plugin resource', { status: 404 })
    })
    vi.stubGlobal('fetch', native)
    release = forwardWorkerHostRequests(host)
    const abort = new AbortController()
    const request = new Request(`${location.origin}${path}?task=1`, {
      method: 'POST', body: 'original', headers: { 'content-type': 'application/json', Origin: location.origin }, signal: abort.signal,
    })
    const result = await fetch(request, { method: 'PATCH', body: 'replacement' })
    expect(result.status).toBe(404)
    expect(host.mock.calls[0]?.[0]).toBe(request.url)
    expect(captured?.method).toBe('PATCH')
    expect(new Headers(captured?.headers).get('origin')).toBe(location.origin)
    expect(new Headers(captured?.headers).get('content-type')).toBe('application/json')
    expect(captured?.body).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(captured?.body as ArrayBuffer)).toBe('replacement')
    abort.abort()
    expect(captured?.signal?.aborted).toBe(true)
    expect(native).not.toHaveBeenCalled()
  })

it('restores its previous fetch and does not overwrite a later wrapper', async () => {
  const native = vi.fn(async () => new Response('native'))
  const host = vi.fn(async () => new Response('host'))
  vi.stubGlobal('fetch', native)
  release = forwardWorkerHostRequests(host)
  expect(await (await fetch('/dsh-plugin-hub')).text()).toBe('host')
  release()
  expect(fetch).toBe(native)
  release = forwardWorkerHostRequests(host)
  const owned = fetch
  const later: typeof fetch = (input, init) => owned(input, init)
  globalThis.fetch = later
  release()
  expect(fetch).toBe(later)
  expect(await (await fetch('/dsh-plugin-hub/env')).text()).toBe('native')
  expect(host).toHaveBeenCalledTimes(1)
})

it('does not dispatch an already aborted Host request', async () => {
  const native = vi.fn(async () => new Response('native'))
  const host = vi.fn(async () => new Response('host'))
  vi.stubGlobal('fetch', native)
  release = forwardWorkerHostRequests(host)
  await expect(fetch('/api/mobile-nav.session.delete', {
    method: 'POST', body: '{}', signal: AbortSignal.abort(),
  })).rejects.toMatchObject({ name: 'AbortError' })
  expect(native).not.toHaveBeenCalled()
  expect(host).not.toHaveBeenCalled()
})
