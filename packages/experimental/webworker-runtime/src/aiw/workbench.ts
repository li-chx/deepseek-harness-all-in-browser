/** Worker-local AIB operations over the guarded VFS and existing Forge command/installation paths. */
import type { MemoryVfs } from '../storage/memory.ts'
import type { ForgeInstaller } from '../forge/installer.ts'
import type { ForgeCommands } from '../forge/commands.ts'
import { ForgeError, FORGE_GENERATION, object, pluginId } from '../forge/protocol.ts'
import { runShellCommand } from '../shell/interpret.ts'
import type { ShellProgram } from '../shell/types.ts'
import { basename, dirname } from '../module-system/posix-path.ts'
import { AiwFiles } from './files.ts'
import { AiwHistory } from './history.ts'
import type { AiwCommandResult, AiwProject, AiwResponse, AiwSourceSnapshot } from './protocol.ts'

const OFFLINE_BASE = 'http://aiw.local'
const string = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new ForgeError('invalid-request', `${field} must be a nonempty string`)
  return value
}
/** Runtime workbench; every accepted asynchronous action is cancelled and settled on close. */
export class AiwWorkbench {
  private readonly files: AiwFiles
  private readonly pending = new Set<Promise<Response>>()
  private readonly controllers = new Set<AbortController>()
  private closing = false
  constructor(private readonly vfs: MemoryVfs, private readonly root: string,
    private readonly profileDirectory: string, private readonly installer: ForgeInstaller,
    private readonly commands: ForgeCommands, private readonly history: AiwHistory) {
    this.files = new AiwFiles(vfs, root)
  }

  /** Handle one Worker-local JSON request.
   * @param request Page-owned request carrying its cancellation signal.
   * @returns Structured result or actionable error; HTTP success does not imply a command exited zero.
   */
  fetch(request: Request): Promise<Response> {
    if (this.closing) return Promise.resolve(Response.json({ error: { code: 'closed', message: 'The Worker is stopping' } }, { status: 503 }))
    const lifetime = new AbortController()
    const abort = (): void => { lifetime.abort(request.signal.reason) }
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    this.controllers.add(lifetime)
    const task = (async () => {
      try {
        lifetime.signal.throwIfAborted()
        const path = new URL(request.url).pathname
        if (path === '/__aiw/status' && request.method === 'GET') return Response.json(this.status())
        if (path !== '/__aiw/action' || request.method !== 'POST') return Response.json({ error: { code: 'not-found', message: 'Unknown AIB operation' } }, { status: 404 })
        const text = await request.text()
        if (new TextEncoder().encode(text).byteLength > 48 * 1024 * 1024) throw new ForgeError('request-limit', 'AIB request exceeds 48 MiB')
        let parsed: unknown
        try { parsed = JSON.parse(text) }
        catch (error) { throw new ForgeError('invalid-json', `AIB request must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
        const body = object(parsed)
        lifetime.signal.throwIfAborted()
        return Response.json(await this.action(body, lifetime.signal))
      } catch (error) {
        return Response.json({ error: { code: error instanceof ForgeError ? error.code : 'operation-failed',
          message: error instanceof Error ? error.message : String(error) } }, { status: error instanceof ForgeError ? 400 : 500 })
      }
    })()
    this.pending.add(task)
    void task.finally(() => {
      request.signal.removeEventListener('abort', abort)
      this.controllers.delete(lifetime); this.pending.delete(task)
    })
    return task
  }

  /** Cancel accepted work and await its settlement before disposing the installer.
   * @returns Resolution after accepted operations and their providers have settled.
   */
  async close(): Promise<void> {
    this.closing = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.pending])
  }

  private status(): AiwResponse {
    const baseUrl = this.commands.endpoint()
    return { protocol: 1, action: 'status', generation: FORGE_GENERATION, root: this.root,
      workspace: this.files.workspace, profileDirectory: this.profileDirectory,
      ...baseUrl === undefined ? {} : { baseUrl }, plugins: this.installer.installed().plugins, historyPlugins: this.history.owners() }
  }

  private retainCurrent(id: string): void {
    const snapshot = this.installer.snapshot(id)
    if (snapshot !== undefined && !this.history.versions(id).some(version => version.revision === snapshot.manifest.revision)) {
      this.history.capture(snapshot.manifest, snapshot.artifacts)
      const current = this.installer.installed().plugins.find(plugin => plugin.pluginId === id)
      if (current !== undefined) this.history.mark(current)
    }
  }

  private projects(): AiwProject[] {
    const projects: AiwProject[] = []
    let visited = 0
    const walk = (directory: string, depth: number): void => {
      if (++visited > 1000 || depth > 6) throw new ForgeError('project-scan-limit', 'Project discovery supports 1000 directories and six levels; keep source projects near the workspace root')
      if (this.vfs.existsSync(`${directory}/forge.json`)) {
        try {
          const descriptor = object(JSON.parse(this.files.read(`${directory}/forge.json`).text))
          projects.push({ directory, id: string(descriptor.id, 'id'), name: string(descriptor.name, 'name'), version: string(descriptor.version, 'version'), client: descriptor.client !== undefined })
        } catch (error) { projects.push({ directory, id: basename(directory), name: basename(directory), version: '', client: false, diagnostic: error instanceof Error ? error.message : String(error) }) }
        return
      }
      for (const entry of this.files.list(directory).entries) if (entry.directory && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(entry.path, depth + 1)
    }
    walk(this.files.workspace, 0)
    return projects
  }

  private createProject(directoryValue: unknown, nameValue: unknown, clientValue: unknown): AiwProject {
    const directory = this.files.path(directoryValue, true), name = pluginId(nameValue)
    if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof clientValue !== 'boolean') throw new ForgeError('invalid-project', 'Use a lowercase project name with letters, digits and hyphens')
    if (!directory.startsWith(`${this.files.workspace}/`)) throw new ForgeError('invalid-project', 'Create source projects under the workspace')
    if (this.vfs.existsSync(directory) && (!this.vfs.statSync(directory).isDirectory() || this.vfs.readdirSync(directory).length)) throw new ForgeError('file-conflict', 'Project destination must be empty')
    const descriptor = { id: name, name, version: '1.0.0', entry: 'index.ts', files: ['index.ts', ...clientValue ? ['client.tsx'] : []],
      ...clientValue ? { client: { entry: 'client.tsx', inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-locale'], peerDependencies: { react: '*' } } } : {} }
    const host = `export const name = ${JSON.stringify(name)}\nexport const inject = ['commands']\nexport function apply(ctx: any) {\n  ctx.effect(() => ctx.commands.register({ name: ${JSON.stringify(name)}, description: 'Local plugin command', handler: () => ({ kind: 'success', text: ${JSON.stringify(`${name} v1`)} }) }))\n}\n`
    const browser = `export const inject = ['slots', 'locale']\nexport function apply(ctx: any) {\n  ctx.effect(() => ctx.locale.register(${JSON.stringify(name)}, { en: { label: ${JSON.stringify(`${name} v1`)} }, zh: { label: ${JSON.stringify(`${name} v1`)} } }))\n  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: ${JSON.stringify(name)}, locale: ${JSON.stringify(name)} }, ({ t }: any) => <output data-aiw-project=${JSON.stringify(name)}>{t('label')}</output>))\n}\n`
    this.vfs.mkdirSync(directory, { recursive: true })
    this.vfs.writeFileSync(`${directory}/forge.json`, JSON.stringify(descriptor, null, 2) + '\n')
    this.vfs.writeFileSync(`${directory}/index.ts`, host)
    if (clientValue) this.vfs.writeFileSync(`${directory}/client.tsx`, browser)
    return { directory, id: name, name, version: '1.0.0', client: clientValue }
  }

  private async command(action: 'build' | 'add', value: string, signal: AbortSignal): Promise<AiwCommandResult> {
    const output: string[] = []
    const result = await this.commands.dsh.prepare(['plugin', '--profile', basename(this.profileDirectory), action, value], {
      cwd: this.files.workspace, env: {}, signal, filesystem: this.files.shell(), output: (_stream, text) => { output.push(text) },
    })
    if (result.kind !== 'exit') throw new ForgeError('unsupported-command', 'This operation cannot delegate to an OS process')
    return { protocol: 1, action, cwd: this.files.workspace, exitCode: result.exitCode, stdout: output.join('') + result.stdout, stderr: result.stderr }
  }

  private prepareSource(source: AiwSourceSnapshot): Array<{ path: string; text: string }> {
    const directory = this.files.path(source.directory, true)
    if (Object.keys(source.files).length > 1000) throw new ForgeError('invalid-source', 'Retained source has too many files')
    return Object.entries(source.files).map(([relative, text]) => {
      if (!relative || !relative.split('/').every(part => /^[a-zA-Z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..')) throw new ForgeError('invalid-source', 'Retained source path is unsafe')
      const path = this.files.path(`${directory}/${relative}`, true)
      if (new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new ForgeError('text-limit', 'Retained source exceeds the editor file limit')
      return { path, text }
    })
  }
  private applySource(files: Array<{ path: string; text: string }>): void {
    for (const file of files) { this.vfs.mkdirSync(dirname(file.path), { recursive: true }); this.vfs.writeFileSync(file.path, file.text) }
  }

  private async action(body: Record<string, unknown>, signal: AbortSignal): Promise<AiwResponse> {
    switch (body.action) {
      case 'status': return this.status()
      case 'configure': {
        const result = this.commands.configure(body.baseUrl)
        this.vfs.mkdirSync(`${this.files.home}/.aiw`, { recursive: true })
        this.vfs.writeFileSync(`${this.files.home}/.aiw/settings.json`, JSON.stringify({ schema: 1, baseUrl: result.baseUrl }))
        return { ...result, action: 'configure' }
      }
      case 'list': return { protocol: 1, action: 'list', ...this.files.list(body.path) }
      case 'read': return { protocol: 1, action: 'read', ...this.files.read(body.path) }
      case 'write': return { protocol: 1, action: 'write', ...this.files.write(body.path, body.text, body.expectedSha256) }
      case 'mkdir': {
        const path = this.files.path(body.path, true)
        if (this.vfs.existsSync(path)) throw new ForgeError('file-conflict', 'Directory destination already exists')
        this.vfs.mkdirSync(path, { recursive: true }); return { protocol: 1, action: 'mkdir', path }
      }
      case 'rename': return { protocol: 1, action: 'rename', path: this.files.rename(body.path, body.to) }
      case 'delete': return { protocol: 1, action: 'delete', path: this.files.remove(body.path) }
      case 'projects': return { protocol: 1, action: 'projects', projects: this.projects() }
      case 'create-project': return { protocol: 1, action: 'create-project', project: this.createProject(body.directory, body.name, body.client) }
      case 'build': return this.command('build', this.files.path(body.directory, true), signal)
      case 'add': return this.command('add', string(body.spec, 'spec'), signal)
      case 'remove': {
        const id = pluginId(body.pluginId); this.retainCurrent(id)
        return { ...await this.installer.remove(id, signal), action: 'remove' }
      }
      case 'history': {
        const id = pluginId(body.pluginId); this.retainCurrent(id)
        return { protocol: 1, action: 'history', versions: this.history.versions(id) }
      }
      case 'restore': {
        const id = pluginId(body.pluginId), revision = string(body.revision, 'revision')
        this.retainCurrent(id)
        const archive = this.history.export(id, revision)
        const source = archive.source === undefined ? [] : this.prepareSource(archive.source)
        const previous = source.map(file => this.vfs.existsSync(file.path) ? this.vfs.readFileSync(file.path, 'utf8') as string : undefined)
        const result = await this.installer.install(archive.manifest, OFFLINE_BASE, signal)
        if (result.status === 'active' || result.status === 'disabled') {
          if (source.some((file, index) => (this.vfs.existsSync(file.path) ? this.vfs.readFileSync(file.path, 'utf8') as string : undefined) !== previous[index])) throw new ForgeError('source-conflict', 'Plugin restored, but its source changed during restoration and was not overwritten')
          this.applySource(source)
        }
        return { ...result, action: 'restore' }
      }
      case 'shell': {
        const cwd = this.files.path(body.cwd), source = string(body.command, 'command')
        if (!this.vfs.statSync(cwd).isDirectory() || source.length > 8192) throw new ForgeError('invalid-command', 'Use an existing directory and a command shorter than 8192 characters')
        const lifetime = new AbortController(), cancel = (): void => { lifetime.abort(signal.reason) }
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
        const timer = setTimeout(() => { lifetime.abort(new Error('Command exceeded its 30 second deadline')) }, 30000)
        let bytes = 0
        const program: ShellProgram = async (argv, io, state, fs) => {
          const result = await this.commands.dsh.prepare(argv.slice(1), { cwd: state.cwd, env: state.environment, signal: lifetime.signal, filesystem: fs, stdin: io.stdin, output: (stream, text) => { if (stream === 'stdout') io.out(text); else io.err(text) } })
          if (result.kind !== 'exit') { io.err('OS process delegation is unavailable\n'); return 1 }
          io.out(result.stdout); io.err(result.stderr); return result.exitCode
        }
        try {
          const result = await runShellCommand(source, { cwd, env: {}, fs: this.files.shell(), signal: lifetime.signal, programs: new Map([['dsh', program]]),
            onOutput: (_stream, text) => { bytes += new TextEncoder().encode(text).byteLength; if (bytes > 1024 * 1024) throw new ForgeError('output-limit', 'Command output exceeds 1 MiB') } })
          return { protocol: 1, action: 'shell', cwd, ...result }
        } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel) }
      }
      case 'export': return { protocol: 1, action: 'export', archive: this.files.export(body.path) }
      case 'import-preview': return this.files.preview(body.archive, body.directory).preview
      case 'import': return { protocol: 1, action: 'import', ...this.files.import(body.archive, body.directory) }
      case 'plugin-export': {
        const id = pluginId(body.pluginId); this.retainCurrent(id)
        const selected = body.revision === undefined ? this.installer.installed().plugins.find(plugin => plugin.pluginId === id)?.revision : string(body.revision, 'revision')
        if (selected === undefined) throw new ForgeError('history-not-found', 'Select a retained plugin revision')
        return { protocol: 1, action: 'plugin-export', archive: this.history.export(id, selected) }
      }
      case 'plugin-import': {
        const imported = this.history.validateImport(body.archive)
        let source = imported.source
        if (source !== undefined) {
          let directory = `${this.files.workspace}/imported-${imported.manifest.plugin.id}-${imported.manifest.revision.slice(0, 8)}`
          let suffix = 0
          while (this.vfs.existsSync(directory)) directory = `${this.files.workspace}/imported-${imported.manifest.plugin.id}-${imported.manifest.revision.slice(0, 8)}-${String(++suffix)}`
          source = { ...source, directory }
          this.prepareSource(source)
          this.history.stageSource(imported.manifest.revision, source)
        }
        this.history.capture(imported.manifest, imported.artifacts)
        const result = await this.installer.install(imported.manifest, OFFLINE_BASE, signal)
        if (source !== undefined && (result.status === 'active' || result.status === 'disabled')) this.applySource(this.prepareSource(source))
        return { ...result, action: 'plugin-import' }
      }
      default: throw new ForgeError('invalid-action', 'Unknown AIB action')
    }
  }
}
