/** Registry GET response streaming, cancellation and browser-only limitations. */
import { afterEach, expect, it, vi } from 'vitest'
import { get } from '../../src/node/builtin_modules/implemented/https.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('delivers status, headers and Buffer chunks before end', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{"name":"plugin"}', { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetcher)
  const result = await new Promise<string>((resolve, reject) => {
    get('https://registry.example/plugin', { headers: { accept: 'application/json' } }, (response) => {
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toBe('application/json')
      let text = ''
      response.on('data', (chunk) => { text += String(chunk) })
      response.on('end', () => { resolve(text) })
      response.on('error', reject)
    }).on('error', reject)
  })
  expect(result).toBe('{"name":"plugin"}')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { accept: 'application/json' }, redirect: 'manual' })
})

it('cancels an unread response and closes the underlying request', async () => {
  const cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))))
  await new Promise<void>((resolve, reject) => {
    const request = get('https://registry.example/plugin', (response) => {
      response.on('close', resolve)
      response.on('error', reject)
      response.destroy()
    })
    request.on('error', reject)
  })
  expect(cancel).toHaveBeenCalledOnce()
})

it('reports a network failure once without delivering a response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')))
  const response = vi.fn()
  const errors: unknown[] = []
  await new Promise<void>((resolve) => {
    const request = get('https://registry.example/plugin', response)
    request.on('error', error => errors.push(error))
    request.on('close', () => { resolve() })
  })
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toContain('network unavailable')
  expect(response).not.toHaveBeenCalled()
})

it('lets the timeout handler abort an in-flight request and suppresses a late response', async () => {
  vi.useFakeTimers()
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve })))
  const response = vi.fn()
  const error = vi.fn()
  const request = get('https://registry.example/plugin', { timeout: 50 }, response)
  request.on('timeout', () => request.destroy())
  request.on('error', error)
  await vi.advanceTimersByTimeAsync(50)
  release(new Response('late'))
  await vi.advanceTimersByTimeAsync(0)
  expect(error).toHaveBeenCalledOnce()
  expect(response).not.toHaveBeenCalled()
})

it('rejects unsupported schemes and TLS options before fetching', () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  expect(() => get('http://registry.example/plugin')).toThrow('HTTPS URL')
  expect(() => get('https://registry.example/plugin', { timeout: -1 })).toThrow('nonnegative')
  const options = { rejectUnauthorized: false }
  expect(() => get('https://registry.example/plugin', Object.assign({ timeout: 1 }, options))).toThrow('rejectUnauthorized')
  expect(fetcher).not.toHaveBeenCalled()
})
