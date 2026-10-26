/** The Worker uses the Host's browser-session exchange without exporting its credential. */
import { expect, it, vi } from 'vitest'
import { workerBrowserCookie } from '../../src/transport/browser-cookie.ts'

it('uses the synthetic authority and retains only the issued cookie pair', () => {
  const authenticatedUrl = vi.fn((base: string) => `${base}?token=fixture-token`)
  const authorizeIndex = vi.fn<Parameters<typeof workerBrowserCookie>[0]['authorizeIndex']>((request, response) => {
    expect(request).toEqual({ method: 'GET', url: '/?token=fixture-token', headers: { host: '127.0.0.1' } })
    response.writeHead(303, { 'set-cookie': 'session=fixture; HttpOnly; Path=/' })
    response.end()
    return false
  })
  expect(workerBrowserCookie({ authenticatedUrl, authorizeIndex })).toBe('session=fixture')
  expect(authenticatedUrl).toHaveBeenCalledWith('http://127.0.0.1/')
})

it('refuses a failed session exchange', () => {
  expect(() => workerBrowserCookie({ authenticatedUrl: base => base,
    authorizeIndex: (_request, response) => { response.writeHead(401); response.end(); return false },
  })).toThrow('did not issue a session cookie')
})
