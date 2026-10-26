/** Validated Worker responses and page-owned request cancellation. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  AiwAction, AiwCommandResult, AiwFileEntry, AiwHistoryVersion, AiwImportPreview, AiwProject, AiwStatus,
  VfsPersistenceStatus, WorkerStorageControls,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

/** Imported JSON remains untrusted until the Worker validates its archive. */
export type WorkbenchAction = AiwAction
  | { action: 'import-preview' | 'import'; archive: unknown; directory: string }
  | { action: 'plugin-import'; archive: unknown }

/** Request-level feedback that outlives the main panel. */
export interface WorkbenchNotice {
  id: number
  text: string
  success: boolean
  uncertain?: boolean
  observerWarning?: boolean
  storageWarning?: boolean
}
/** An unsaved editor draft survives page and tab navigation. */
export interface WorkbenchDraft { path: string; text: string; original: string; sha256?: string; writable: boolean }
/** Stable projection owned by one workbench controller. */
export interface WorkbenchSnapshot {
  ready: boolean
  busy: boolean
  flushing: boolean
  storage?: VfsPersistenceStatus | undefined
  storageError?: string | undefined
  status?: AiwStatus | undefined
  projects: AiwProject[]
  directory: string
  entries: AiwFileEntry[]
  historyPlugin?: string | undefined
  versions: AiwHistoryVersion[]
  command?: AiwCommandResult | undefined
  preview?: AiwImportPreview | undefined
  output: string
  editor?: WorkbenchDraft | undefined
  error?: string | undefined
  notice?: WorkbenchNotice | undefined
}

class ReportedWorkbenchError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid workbench response')
  return value as Record<string, unknown>
}
/** Validate one consumed JSON text field. */
function text(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`Invalid workbench field: ${key}`)
  return field
}
function number(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new Error(`Invalid workbench field: ${key}`)
  return field
}
function boolean(value: Record<string, unknown>, key: string): boolean {
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`Invalid workbench field: ${key}`)
  return field
}
function list<T>(value: Record<string, unknown>, key: string, parse: (row: Record<string, unknown>) => T): T[] {
  const rows = value[key]
  if (!Array.isArray(rows)) throw new Error(`Invalid workbench list: ${key}`)
  return rows.map(row => parse(object(row)))
}
function stringList(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  if (!Array.isArray(field) || !field.every((item: unknown): item is string => typeof item === 'string')) throw new Error(`Invalid workbench list: ${key}`)
  return field
}
function project(row: Record<string, unknown>): AiwProject {
  return { directory: text(row, 'directory'), id: text(row, 'id'), name: text(row, 'name'), version: text(row, 'version'), client: boolean(row, 'client'),
    ...typeof row.diagnostic === 'string' ? { diagnostic: row.diagnostic } : {} }
}
function status(value: Record<string, unknown>): AiwStatus {
  const plugins = list<AiwStatus['plugins'][number]>(value, 'plugins', (row) => {
    const state = row.status
    if (state !== 'active' && state !== 'disabled' && state !== 'activation-failed') throw new Error('Invalid plugin activation state')
    return { pluginId: text(row, 'pluginId'), revision: text(row, 'revision'), name: text(row, 'name'), version: text(row, 'version'), status: state,
      ...typeof row.message === 'string' ? { message: row.message } : {} }
  })
  return { protocol: 1, action: 'status', generation: text(value, 'generation'), root: text(value, 'root'), workspace: text(value, 'workspace'),
    profileDirectory: text(value, 'profileDirectory'), plugins, historyPlugins: list(value, 'historyPlugins', row => ({ pluginId: text(row, 'pluginId'), name: text(row, 'name') })), ...typeof value.baseUrl === 'string' ? { baseUrl: value.baseUrl } : {} }
}

/** One instance owns requests and observable data; disposal aborts every accepted call. */
export class WorkbenchController {
  private readonly state = createSnapshotStore<WorkbenchSnapshot>({ ready: false, busy: false, flushing: false, projects: [], directory: '/dsh/workspace', entries: [], versions: [], output: '' })
  /** Stable renderer-bound snapshot source for the page and shell feedback. */
  readonly source = { getSnapshot: () => this.state.getSnapshot(), subscribe: (listener: () => void) => this.state.subscribe(listener) }
  private readonly requests = new Set<AbortController>()
  private closed = false
  private noticeId = 0
  private loading: Promise<void> | undefined

  constructor(private readonly fetcher: typeof fetch, private readonly storage?: WorkerStorageControls) {}

  /** Publish acknowledged filesystem status independently of page navigation.
   * @param value - Validated status from the owning Worker connection.
   */
  updateStorage(value: VfsPersistenceStatus): void {
    if (this.state.getSnapshot().storage?.kind !== 'failed') this.set({ storage: value })
  }

  /** Wait for application buffers and browser commits; failures retain an unconfirmed save state. */
  async flushStorage(): Promise<void> {
    const state = this.state.getSnapshot()
    if (this.closed || this.storage === undefined || state.flushing || state.storage?.kind === 'failed' || state.storageError !== undefined) return
    const lifetime = new AbortController()
    this.requests.add(lifetime)
    this.set({ flushing: true })
    try {
      const storage = await this.storage.flush(lifetime.signal)
      lifetime.signal.throwIfAborted()
      this.updateStorage(storage)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.set({ storageError: message, notice: { id: ++this.noticeId, text: message, success: false, storageWarning: true } })
    } finally { this.requests.delete(lifetime); this.set({ flushing: false }) }
  }

  private set(fields: Partial<WorkbenchSnapshot>): void {
    if (!this.closed) this.state.set({ ...this.state.getSnapshot(), ...fields })
  }

  private async request(action: WorkbenchAction): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('Workbench closed')
    const lifetime = new AbortController()
    this.requests.add(lifetime)
    try {
      const response = await this.fetcher('/__aiw/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action), signal: lifetime.signal })
      const result = object(await response.json())
      if (!response.ok) {
        const error = object(result.error)
        throw new ReportedWorkbenchError(`${text(error, 'code')}: ${text(error, 'message')}`)
      }
      if (result.protocol !== 1 || result.action !== action.action) throw new Error('Unexpected workbench response')
      lifetime.signal.throwIfAborted()
      return result
    } finally { this.requests.delete(lifetime) }
  }

  /** Refresh authoritative status and source projects; query failures retain prior data. */
  refresh(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    const load = async (): Promise<void> => {
      try {
        const [current, projects] = await Promise.all([this.request({ action: 'status' }), this.request({ action: 'projects' })])
        const currentStatus = status(current)
        this.set({ ready: true, status: currentStatus, projects: list(projects, 'projects', project), error: undefined })
      } catch (error) { this.set({ ready: true, error: error instanceof Error ? error.message : String(error) }) }
    }
    this.loading = load().finally(() => { this.loading = undefined })
    return this.loading
  }

  private async refreshAfterMutation(): Promise<void> {
    if (this.loading !== undefined) await this.loading
    await this.refresh()
  }

  /** Run a user action, publish outcomes and refresh changed data without hiding command failures.
   * @param action - Worker operation, including untrusted imported JSON.
   * @param successText - Localized completion message; a nonzero command never uses it.
   * @returns Validated envelope, or undefined after a reported failure.
   */
  async perform(action: WorkbenchAction, successText?: string): Promise<Record<string, unknown> | undefined> {
    if (this.state.getSnapshot().busy || this.closed) return undefined
    this.set({ busy: true })
    let commandFailed = false
    try {
      const result = await this.request(action)
      let observerWarning: string | undefined
      if (action.action === 'read') { text(result, 'path'); text(result, 'text'); text(result, 'sha256') }
      if (action.action === 'write') { text(result, 'path'); text(result, 'sha256') }
      if (action.action === 'export' || action.action === 'plugin-export') {
        const archive = object(result.archive)
        if (archive.schema !== 1 || (archive.kind !== 'files' && archive.kind !== 'plugin')) throw new Error('Invalid workbench archive')
      }
      if (action.action === 'restore' || action.action === 'remove' || action.action === 'plugin-import') {
        const observers = result.observerErrors === undefined ? [] : stringList(result, 'observerErrors')
        if (observers.length > 0) observerWarning = observers.join('\n')
        if (result.status === 'activation-failed') {
          const reason = typeof result.message === 'string' ? result.message : 'Plugin activation failed'
          throw new ReportedWorkbenchError(observerWarning === undefined ? reason : `${reason}\n${observerWarning}`)
        }
        if (result.status !== 'active' && result.status !== 'disabled' && result.status !== 'removed') throw new Error('Unknown plugin operation outcome')
      }
      if (action.action === 'rename' || action.action === 'delete') {
        const editor = this.state.getSnapshot().editor
        const from = action.path.replace(/\/+$/, '')
        if (editor !== undefined && (editor.path === from || editor.path.startsWith(`${from}/`))) {
          this.set({ editor: action.action === 'delete' ? undefined : { ...editor, path: text(result, 'path') + editor.path.slice(from.length) } })
        }
      }
      if (action.action === 'list') {
        this.set({ directory: text(result, 'path'), entries: list(result, 'entries', row => ({ name: text(row, 'name'), path: text(row, 'path'), directory: boolean(row, 'directory'), size: number(row, 'size'), mtimeMs: number(row, 'mtimeMs'), writable: boolean(row, 'writable') })) })
      }
      if (action.action === 'history') {
        this.set({ historyPlugin: action.pluginId, versions: list(result, 'versions', row => ({ pluginId: text(row, 'pluginId'), revision: text(row, 'revision'), name: text(row, 'name'), version: text(row, 'version'), createdAt: text(row, 'createdAt'), hasSource: boolean(row, 'hasSource') })) })
      }
      if (action.action === 'shell' || action.action === 'build' || action.action === 'add') {
        const command: AiwCommandResult = { protocol: 1, action: action.action, cwd: text(result, 'cwd'), exitCode: number(result, 'exitCode'), stdout: text(result, 'stdout'), stderr: text(result, 'stderr') }
        this.set({ command, output: `${command.stdout}${command.stderr}\n[exit ${String(command.exitCode)}]` })
        if (command.exitCode !== 0) { commandFailed = true; throw new Error(command.stderr || `Command exited with ${String(command.exitCode)}`) }
      }
      if (action.action === 'import-preview') this.set({ preview: { protocol: 1, action: 'import-preview', directory: text(result, 'directory'), fileCount: number(result, 'fileCount'), bytes: number(result, 'bytes'), conflicts: stringList(result, 'conflicts') } })
      if (action.action !== 'list' && action.action !== 'read' && action.action !== 'history' && action.action !== 'import-preview' && action.action !== 'export' && action.action !== 'plugin-export') await this.refreshAfterMutation()
      if (observerWarning !== undefined) {
        this.set({ notice: { id: ++this.noticeId, text: observerWarning, success: false, observerWarning: true }, output: observerWarning })
      } else if (successText !== undefined) this.set({ notice: { id: ++this.noticeId, text: successText, success: true } })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const mutation = !['list', 'read', 'history', 'import-preview', 'export', 'plugin-export', 'status', 'projects'].includes(action.action)
      const uncertain = mutation && !commandFailed && !(error instanceof ReportedWorkbenchError)
      this.set({
        notice: { id: ++this.noticeId, text: message, success: false, uncertain },
        output: commandFailed ? this.state.getSnapshot().output : message,
      })
      if (mutation) await this.refreshAfterMutation()
      return undefined
    } finally { this.set({ busy: false }) }
  }

  /** Read a selected text file into the persistent editor draft.
   * @param path - Absolute VFS file selected by the user.
   * @param writable - Whether the listing permits editing; the Worker still enforces write access.
   */
  async openFile(path: string, writable = true): Promise<void> {
    const result = await this.perform({ action: 'read', path })
    if (result !== undefined) this.set({ editor: { path: text(result, 'path'), text: text(result, 'text'), original: text(result, 'text'), sha256: text(result, 'sha256'), writable } })
  }
  /** Start an explicitly new file; the Worker rejects an existing-path collision.
   * @param path - Intended VFS destination; no file is written until save.
   */
  newFile(path: string): void { this.set({ editor: { path, text: '', original: '', writable: true } }) }
  /** Restore the last-read draft without changing its file. */
  discard(): void {
    const editor = this.state.getSnapshot().editor
    if (editor !== undefined) this.set({ editor: { ...editor, text: editor.original } })
  }
  /** Update only the editor's in-memory draft.
   * @param text - Edited text; the observed baseline and hash remain unchanged.
   */
  edit(text: string): void {
    const editor = this.state.getSnapshot().editor
    if (editor !== undefined) this.set({ editor: { ...editor, text } })
  }
  /** Commit using the observed file hash and retain a draft after conflicts.
   * @param successText - Localized feedback shown only after the write is confirmed.
   */
  async save(successText: string): Promise<void> {
    const editor = this.state.getSnapshot().editor
    if (editor === undefined) return
    const result = await this.perform({ action: 'write', path: editor.path, text: editor.text, ...editor.sha256 === undefined ? {} : { expectedSha256: editor.sha256 } }, successText)
    const current = this.state.getSnapshot().editor
    if (result !== undefined && current?.path === editor.path) this.set({ editor: { ...current, original: editor.text, sha256: text(result, 'sha256') } })
  }

  /** Cancel active work; the Worker decides whether an already committed mutation can be interrupted. */
  cancel(): void { for (const lifetime of this.requests) lifetime.abort() }
  /** Dismiss the active feedback banner. */
  dismiss(): void { this.set({ notice: undefined }) }
  /** Abort in-flight calls and prevent late results from publishing. */
  dispose(): void { this.closed = true; this.cancel() }
}
