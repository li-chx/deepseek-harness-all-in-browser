/** Fetch-backed curl subset used by Plugin Hub catalog and connectivity requests. */
import type { HttpFetch } from '../../transport/http-transport.ts'
import type { VirtualExecutable, VirtualExecutableExit } from './virtual-executables.ts'

function exit(exitCode: number, stdout = '', stderr = ''): VirtualExecutableExit {
  return { kind: 'exit', exitCode, stdout, stderr }
}

interface CurlRequest {
  url: URL
  timeout: number
  head: boolean
  follow: boolean
  discard: boolean
  range: string | undefined
  writeOut: string
}

function parse(args: readonly string[]): CurlRequest {
  let url: URL | undefined
  let timeout = 0
  let head = false
  let follow = false
  let discard = false
  let range: string | undefined
  let writeOut = ''
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    switch (arg) {
      case '-s': case '-S': case '-sS': case '--compressed': break
      case '-I': head = true; break
      case '-L': follow = true; break
      case '--max-time': {
        const seconds = args[++index]
        timeout = Number(seconds) * 1000
        if (seconds === undefined || seconds.trim() === '' || !Number.isFinite(timeout) || timeout < 0) throw new Error('invalid --max-time')
        break
      }
      case '-o':
        if (args[++index] !== '/dev/null') throw new Error('only -o /dev/null is supported')
        discard = true
        break
      case '-r':
        range = args[++index]
        if (range === undefined || !/^\d+-\d*$/.test(range)) throw new Error('unsupported byte range')
        break
      case '-w':
        writeOut = args[++index] ?? ''
        if (writeOut !== '%{http_code}' && writeOut !== '%{url_effective}') throw new Error('unsupported -w format')
        break
      default:
        if (arg === undefined || arg.startsWith('-') || url !== undefined) throw new Error(`unsupported argument ${arg}`)
        url = new URL(arg)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only HTTP(S) URLs are supported')
    }
  }
  if (url === undefined) throw new Error('a URL is required')
  return { url, timeout, head, follow, discard, range, writeOut }
}

/** Browser curl implementation; honors cancellation and timeouts, rejects proxy and socket options. */
export const CURL_EXECUTABLE: VirtualExecutable = createCurlExecutable((input, init) => fetch(input, init))

/** Bind the curl compatibility command to a host HTTP provider.
 * @param fetcher Outbound Fetch adapter.
 * @returns Command registration owned by its host.
 */
export function createCurlExecutable(fetcher: HttpFetch): VirtualExecutable { return {
  name: 'curl',
  async prepare(args, context) {
    let request: CurlRequest
    try { request = parse(args) }
    catch (error) { return exit(2, '', `curl: ${error instanceof Error ? error.message : String(error)}\n`) }
    if (['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(key => context.env[key])) {
      return exit(2, '', 'curl: browser Fetch cannot use process proxy settings; use the browser network configuration\n')
    }
    const controller = new AbortController()
    const abort = (): void => { controller.abort(context.signal.reason) }
    context.signal.addEventListener('abort', abort, { once: true })
    if (context.signal.aborted) abort()
    let timedOut = false
    const expired = (): boolean => timedOut
    const timer = request.timeout > 0 ? setTimeout(() => { timedOut = true; controller.abort() }, request.timeout) : undefined
    try {
      const response = await fetcher(request.url, {
        method: request.head ? 'HEAD' : 'GET', signal: controller.signal,
        redirect: request.follow ? 'follow' : 'manual',
        headers: request.range === undefined ? {} : { Range: `bytes=${request.range}` },
      })
      if (response.type === 'opaqueredirect') return exit(2, '', 'curl: browser Fetch cannot expose an unfollowed cross-origin redirect\n')
      let body = ''
      if (request.discard) await response.body?.cancel()
      else body = await response.text()
      const suffix = request.writeOut === '%{http_code}' ? String(response.status) : request.writeOut === '%{url_effective}' ? response.url : ''
      return exit(0, body + suffix)
    } catch (error) {
      return exit(expired() ? 28 : context.signal.aborted ? 130 : 7, '', `curl: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener('abort', abort)
    }
  },
  runSync() { return { kind: 'asynchronous' } },
} }
