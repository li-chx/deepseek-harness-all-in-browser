/** Profile-scoped plugin CLI operations backed by Forge, without a Node subprocess. */
import { sha256 } from '@noble/hashes/sha2.js'
import type { ForgeInstaller } from './installer.ts'
import { ForgeError, object } from './protocol.ts'
import { readForgeSource } from './source.ts'
import type { VirtualExecutable, VirtualExecutableExit } from '../shell/process/virtual-executables.ts'

function exit(exitCode: number, stdout = '', stderr = ''): VirtualExecutableExit {
  return { kind: 'exit', exitCode, stdout, stderr }
}

function npmName(spec: string): string {
  const match = /^(@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*)(?:@([^\s/\\]+))?$/.exec(spec)
  if (match === null) throw new ForgeError('unsupported-spec', 'Only npm package names with an optional version or tag are supported')
  return `${match[1] ?? ''}${match[2] ?? ''}`
}

/** Configured command bridge belonging to one running profile. */
export class ForgeCommands {
  private baseUrl: string | undefined
  private readonly pending = new Set<Promise<VirtualExecutableExit>>()
  private readonly cancellations = new Set<AbortController>()
  private closing = false

  constructor(private readonly installer: ForgeInstaller, private readonly profile: string, private readonly fetcher: typeof fetch) {}

  /** Set the build endpoint for subsequent commands; in-flight commands retain their endpoint.
   * @param value HTTP service URL supplied by the page.
   * @returns Validated endpoint.
   */
  configure(value: unknown): { protocol: 1; generation: string; baseUrl: string } {
    if (typeof value !== 'string') throw new ForgeError('invalid-url', 'Forge URL is missing')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ForgeError('invalid-url', 'Forge URL must use HTTP or HTTPS without credentials')
    this.baseUrl = url.href
    return { protocol: 1, generation: this.installer.target().generation, baseUrl: url.href }
  }

  /** Local `which dsh` probe, without claiming npm, Node or OS executables exist. */
  readonly which: VirtualExecutable = {
    name: 'which',
    runSync: args => args.length === 1 && args[0] === 'dsh' ? exit(0, '/dsh/bin/dsh\n') : exit(1),
    prepare: args => Promise.resolve(args.length === 1 && args[0] === 'dsh' ? exit(0, '/dsh/bin/dsh\n') : exit(1)),
  }

  /** Only the fixed host version can be answered synchronously. */
  readonly dsh: VirtualExecutable = {
    name: 'dsh',
    runSync: (args) => {
      if (args.length !== 1 || !['--version', '-v'].includes(args[0] ?? '')) return { kind: 'asynchronous' }
      const packages = this.installer.target().hostPackages
      const version = packages['@deepseek-ai/dsh'] ?? packages['@deepseek-ai/dsh-app-boot']
      return version === undefined ? exit(1, '', 'The image does not declare a DSH version\n') : exit(0, `${version}\n`)
    },
    prepare: (args, context) => {
      if (this.closing) return Promise.resolve(exit(1, '', 'The Worker is stopping\n'))
      const controller = new AbortController()
      const cancel = (): void => { controller.abort(context.signal.reason) }
      context.signal.addEventListener('abort', cancel, { once: true })
      if (context.signal.aborted) cancel()
      this.cancellations.add(controller)
      const task = this.run(args, controller.signal, context).catch((error: unknown) =>
        exit(1, '', `${error instanceof Error ? error.message : String(error)}\n`))
      this.pending.add(task)
      void task.finally(() => {
        context.signal.removeEventListener('abort', cancel)
        this.cancellations.delete(controller)
        this.pending.delete(task)
      })
      return task
    },
  }

  private async run(args: readonly string[], signal: AbortSignal, context: Parameters<VirtualExecutable['prepare']>[1]): Promise<VirtualExecutableExit> {
    signal.throwIfAborted()
    const probe = this.dsh.runSync(args)
    if (probe.kind === 'exit') return probe
    if (args[0] !== 'plugin') throw new ForgeError('unsupported-command', 'Only dsh plugin operations are available in this Worker')
    const equals = args[1]?.startsWith('--profile=') === true
    const profile = equals ? args[1]?.slice('--profile='.length) : args[1] === '--profile' ? args[2] : undefined
    const action = args[equals ? 2 : 3]
    const spec = args[equals ? 3 : 4]
    if (profile !== this.profile) throw new ForgeError('profile-mismatch', `This Worker manages only profile ${this.profile}`)
    if (args.length !== (equals ? 4 : 5) || !['add', 'update', 'remove', 'build'].includes(action ?? '') || spec === undefined) {
      throw new ForgeError('unsupported-command', 'Use dsh plugin --profile <profile> add|update|remove <npm-package>, or build <directory>')
    }
    const base = this.baseUrl
    if (action !== 'remove' && base === undefined) throw new ForgeError('not-configured', 'Configure a Forge service before installing plugins')
    const source = action === 'build' ? await readForgeSource(spec, context.cwd, context.filesystem, signal) : undefined
    const name = source?.name ?? npmName(spec)
    const installed = this.installer.installed().plugins.find(plugin => plugin.name === name)
    if (source !== undefined) {
      if (installed !== undefined && installed.pluginId !== source.id) throw new ForgeError('name-conflict', 'A plugin with this package name is already installed under another id')
      if (this.installer.installed().plugins.some(plugin => plugin.pluginId === source.id && plugin.name !== source.name)) throw new ForgeError('name-conflict', 'An installed plugin id cannot change its package name')
    }
    if (action === 'remove') {
      if (installed === undefined) throw new ForgeError('not-installed', `${name} is not installed by Forge`)
      const result = await this.installer.remove(installed.pluginId, signal)
      signal.throwIfAborted()
      return result.status === 'removed' ? exit(0, `Removed ${name}\n`) : exit(1, '', `${result.message ?? 'Plugin removal failed'}\n`)
    }
    if (base === undefined) throw new ForgeError('not-configured', 'Configure a Forge service before installing plugins')
    const id = installed?.pluginId ?? `npm-${[...sha256(new TextEncoder().encode(name))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
    context.output('stdout', `Building ${spec} for ${this.installer.target().generation}\n`)
    const response = await this.fetcher(new URL(source === undefined ? '/v1/packages/builds' : '/v1/builds', base), {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ protocol: 1, generation: this.installer.target().generation,
        ...(source === undefined ? { pluginId: id, spec } : { plugin: source }) }),
    })
    const payload: unknown = await response.json()
    if (!response.ok) {
      const failure = object(object(payload).error)
      throw new ForgeError(typeof failure.code === 'string' ? failure.code : 'build-failed', typeof failure.message === 'string' ? failure.message : 'Forge build failed')
    }
    signal.throwIfAborted()
    if (source !== undefined) {
      const returned = object(object(payload).plugin)
      if (returned.id !== source.id || returned.name !== source.name || returned.version !== source.version
        || returned.entry !== source.entry) {
        throw new ForgeError('build-identity-mismatch', 'Forge returned a different source plugin identity or entry')
      }
    }
    const result = await this.installer.install(payload, base, signal)
    signal.throwIfAborted()
    return result.status === 'active' || result.status === 'disabled'
      ? exit(0, `Installed ${name}${result.status === 'disabled' ? ' (disabled)' : ''}\n${result.message ?? ''}`) : exit(1, '', `${result.message ?? 'Plugin activation failed'}\n`)
  }

  /** Cancel network work and wait until accepted commands settle before disposing the host.
   * @returns Resolution after command exit reporting can complete.
   */
  async close(): Promise<void> {
    this.closing = true
    for (const controller of this.cancellations) controller.abort()
    await Promise.allSettled([...this.pending])
  }
}
