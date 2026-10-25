/** Write-behind durability for mutable VFS roots; in-memory state remains authoritative. */
import type { Vfs, VfsMutation, VfsMutationSink } from './types.ts'
import type { VfsPersistenceProvider, VfsPersistenceStatus, VfsStorageOperation } from './persistence-types.ts'
import { parseStoredRecords, storageRoot, validateStoragePath, VfsPersistenceError } from './persistence-validation.ts'
export type { VfsPersistenceStatus, VfsPersistenceProvider, VfsStorageSnapshot, VfsStoredRecord, VfsStorageOperation } from './persistence-types.ts'

/** Serializes atomic mutation groups and stops permanently after a storage failure. */
export class VfsPersistenceController implements VfsMutationSink {
  private readonly root: string
  private vfs: Vfs | undefined
  private ready = false
  private closed = false
  private revision = 0
  private failure: VfsPersistenceStatus['error']
  private readonly knownFiles = new Set<string>()
  private readonly listeners = new Set<(status: VfsPersistenceStatus) => void>()
  private queue: VfsStorageOperation[] = []
  private inflight = 0
  private depth = 0
  private running: Promise<void> | undefined
  private disposal: Promise<void> | undefined

  constructor(private readonly provider: VfsPersistenceProvider, options: { root?: string } = {}) { this.root = storageRoot(options.root ?? '/dsh') }

  /**
   * Overlay a validated snapshot after image seeding and before application boot.
   * @param vfs - The same filesystem whose mutation sink is this controller.
   * @returns Completion, or rejection that prevents boot with corrupt or inaccessible storage.
   */
  async hydrate(vfs: Vfs): Promise<void> {
    if (this.vfs) throw new VfsPersistenceError('STORAGE_STATE', 'Persistence has already been initialized')
    this.vfs = vfs
    try {
      const snapshot = await this.provider.load()
      if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent revision')
      const records = parseStoredRecords(snapshot.records, this.root)
      for (const record of records) if (record.kind === 'remove') vfs.rmSync(record.path, { recursive: true, force: true })
      for (const record of records.filter(record => record.kind !== 'remove').sort((a, b) => a.path.length - b.path.length)) {
        if (record.kind === 'directory') vfs.seedDirectory(record.path, { mode: record.mode, ...record.mtimeMs === undefined ? {} : { mtimeMs: record.mtimeMs } })
        else {
          vfs.seed(record.path, record.bytes, { mode: record.mode, ...record.mtimeMs === undefined ? {} : { mtimeMs: record.mtimeMs } })
          this.knownFiles.add(record.path)
        }
      }
      // Seeding children updates parent timestamps; restore explicit directory metadata last.
      for (const record of records) if (record.kind === 'directory') vfs.seedDirectory(record.path, { mode: record.mode, ...record.mtimeMs === undefined ? {} : { mtimeMs: record.mtimeMs } })
      this.revision = snapshot.revision
      this.ready = true
      this.emit()
    } catch (error) { this.fail(error); throw error }
  }

  /**
   * Hold only synchronous mutations together; never await within the callback.
   * @param operation - Synchronous VFS/catalog updates to commit atomically.
   */
  batch(operation: () => void): void {
    if (this.closed) throw new VfsPersistenceError('STORAGE_CLOSED', 'Persistence has been closed')
    this.depth++
    try {
      operation()
    } catch (error) {
      this.fail(new VfsPersistenceError('STORAGE_BATCH_FAILED', 'A filesystem batch failed; partial in-memory changes were not saved'))
      throw error
    } finally { this.depth--; this.schedule() }
  }

  record(mutation: VfsMutation): void {
    if (!this.ready || !this.vfs || this.failure || this.closed) return
    if (![`${this.root}/home`, `${this.root}/workspace`].some(base => mutation.path === base || mutation.path.startsWith(base + '/'))) return
    try {
      validateStoragePath(mutation.path, this.root)
      const metadata = mutation.kind === 'remove' ? {} : { mtimeMs: Number(this.vfs.statSync(mutation.path).mtimeMs) }
      if (mutation.kind === 'write') {
        const offset = mutation.appendedFrom
        if (offset !== undefined && this.knownFiles.has(mutation.path)) this.queue.push({ kind: 'append', path: mutation.path, mode: mutation.mode, ...metadata, offset, bytes: mutation.bytes.slice(offset) })
        else this.queue.push({ kind: 'write', path: mutation.path, mode: mutation.mode, ...metadata, bytes: mutation.bytes.slice() })
        this.knownFiles.add(mutation.path)
      } else if (mutation.kind === 'chmod' && !this.knownFiles.has(mutation.path) && this.vfs.statSync(mutation.path).isFile()) {
        const bytes = this.vfs.readFileSync(mutation.path)
        this.queue.push({ kind: 'write', path: mutation.path, mode: mutation.mode, ...metadata, bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice() })
        this.knownFiles.add(mutation.path)
      } else if (mutation.kind === 'chmod' && this.vfs.statSync(mutation.path).isDirectory()) {
        this.queue.push({ kind: 'mkdir', path: mutation.path, mode: mutation.mode, ...metadata })
      } else {
        this.queue.push({ ...mutation, ...metadata })
        if (mutation.kind === 'remove') for (const path of this.knownFiles) if (path === mutation.path || path.startsWith(mutation.path + '/')) this.knownFiles.delete(path)
      }
      this.emit()
      this.schedule()
    } catch (error) { this.fail(error) }
  }

  /**
   * Read the current durability state; saved acknowledges completed storage transactions only.
   * @returns Current status and any terminal failure.
   */
  status(): VfsPersistenceStatus { return { kind: this.failure ? 'failed' : !this.ready || this.queue.length + this.inflight ? 'pending' : 'saved', revision: this.revision, pending: this.queue.length + this.inflight, ...(this.failure ? { error: { ...this.failure } } : {}) } }

  /**
   * Observe current and subsequent states; listener errors do not stop storage.
   * @param listener - Status observer.
   * @returns Synchronous listener disposer.
   */
  subscribe(listener: (status: VfsPersistenceStatus) => void): () => void {
    this.listeners.add(listener)
    this.notify(listener)
    return () => { this.listeners.delete(listener) }
  }

  async flush(): Promise<void> {
    if (this.depth) throw new VfsPersistenceError('STORAGE_BATCH_ACTIVE', 'Cannot flush inside a synchronous persistence batch')
    this.schedule()
    while (this.running) await this.running
  }

  /**
   * Stop accepting mutations, settle prior work and close the owned provider once.
   * Provider close failures retain a terminal status; an earlier failure remains primary.
   * @returns Completion of pending commits and provider close without masking a boot failure.
   */
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.closed = true
      await this.flush()
      try { await this.provider.close?.() } catch (error) { this.fail(error) }
      this.listeners.clear()
    })()
    return this.disposal
  }

  private schedule(): void {
    if (this.running || this.depth || this.failure || !this.queue.length) return
    this.running = Promise.resolve().then(async () => {
      while (this.queue.length && !this.failure) {
        const operations = this.queue.splice(0)
        this.inflight = operations.length
        try { this.revision = await this.provider.apply(this.revision, operations) }
        catch (error) { this.fail(error); break }
        this.inflight = 0
        this.emit()
      }
    }).finally(() => { this.running = undefined; this.schedule() })
  }
  private fail(error: unknown): void {
    this.failure ??= { code: error instanceof VfsPersistenceError ? error.code : 'STORAGE_FAILED', message: error instanceof Error ? error.message : 'Persistent storage failed' }
    this.emit()
  }
  private notify(listener: (status: VfsPersistenceStatus) => void): void { try { listener(this.status()) } catch (error) { console.error('webworker storage: status observer failed', error) } }
  private emit(): void { for (const listener of this.listeners) this.notify(listener) }
}
