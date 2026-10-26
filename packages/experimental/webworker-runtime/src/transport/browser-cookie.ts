/** Browser-session admission for requests carried by the page that owns this Worker. */
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { SYNTHETIC_HOST } from './tunnel.ts'

/**
 * Exchange the owning Host's launch token through its normal browser sign-in interface.
 * @param connection Connection belonging to this Worker.
 * @returns A fresh cookie for the synthetic loopback authority; no token or cookie crosses to the page.
 * @throws When the Connection does not issue a browser session.
 */
export function workerBrowserCookie(connection: Pick<HostConnectionHandle, 'authenticatedUrl' | 'authorizeIndex'>): string {
  const url = new URL(connection.authenticatedUrl(`http://${SYNTHETIC_HOST}/`))
  let cookie: string | undefined
  connection.authorizeIndex({ method: 'GET', url: `${url.pathname}${url.search}`, headers: { host: SYNTHETIC_HOST } }, {
    writeHead(status, headers) {
      if (status === 303) cookie = headers?.['set-cookie']?.split(';', 1)[0]
    },
    end() {},
  })
  if (!cookie) throw new Error('Worker browser sign-in did not issue a session cookie')
  return cookie
}
