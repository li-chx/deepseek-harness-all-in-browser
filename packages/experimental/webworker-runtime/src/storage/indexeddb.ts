/** IndexedDB overlay storage with transactional revisions and bounded file chunks. */
import type { VfsPersistenceProvider, VfsStorageOperation, VfsStorageSnapshot, VfsStoredRecord } from './persistence-types.ts'
import { parseStoredRecords, storageRoot, validateStoragePath, VfsPersistenceError } from './persistence-validation.ts'

const SCHEMA = 1
const CHUNK_BYTES = 64 * 1024
declare const namespaceBrand: unique symbol
/** Namespace derived from the storage schema, runtime generation and deployment source. */
export type VfsPersistenceNamespace = string & { readonly [namespaceBrand]: true }
/** Stable assembly inputs; changing any field selects a distinct retained database. */
export interface VfsPersistenceIdentity { generation: string; source: string; deployment: string }
/**
 * Derive an isolated database name without deleting earlier namespaces.
 * @param identity - Runtime build and deployment identity.
 * @returns A branded namespace for the IndexedDB provider.
 */
export function vfsPersistenceNamespace(identity: VfsPersistenceIdentity): VfsPersistenceNamespace {
  if (Object.values(identity).some(value => typeof value !== 'string' || !value || value.length > 4096)) throw new VfsPersistenceError('STORAGE_NAMESPACE', 'Invalid storage identity')
  return `dsh-vfs:${JSON.stringify([SCHEMA, identity.generation, identity.source, identity.deployment])}` as VfsPersistenceNamespace
}
type StoredNode =
  | { key: string; kind: 'file'; path: string; mode: number; size: number; mtimeMs?: number }
  | { key: string; kind: 'directory'; path: string; mode: number; mtimeMs?: number }
  | { key: string; kind: 'remove'; path: string }
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => { resolve(request.result) }; request.onerror = () => { reject(request.error ?? new VfsPersistenceError('STORAGE_FAILED', 'IndexedDB request failed')) } })
}
function node(value: unknown, root: string): StoredNode {
  if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' || !('kind' in value) || !('key' in value) || typeof value.key !== 'string') throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored node')
  validateStoragePath(value.path, root)
  if (value.key !== `${value.kind === 'remove' ? 'remove' : 'node'}:${value.path}`) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored node key')
  if (value.kind === 'remove') return { key: value.key, kind: 'remove', path: value.path }
  if (!('mode' in value) || typeof value.mode !== 'number' || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored permissions')
  const time = 'mtimeMs' in value ? value.mtimeMs : undefined
  if (time !== undefined && (typeof time !== 'number' || !Number.isFinite(time))) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored modification time')
  const metadata = time === undefined ? {} : { mtimeMs: time }
  if (value.kind === 'directory') return { key: value.key, kind: 'directory', path: value.path, mode: value.mode, ...metadata }
  if (value.kind !== 'file' || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored file size')
  return { key: value.key, kind: 'file', path: value.path, mode: value.mode, ...metadata, size: value.size }
}
function revision(value: unknown): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid stored revision')
  return value
}

/** Atomic IndexedDB provider; CAS protects concurrent tabs without secure-context Web Locks. */
export class IndexedDbVfsProvider implements VfsPersistenceProvider {
  private readonly root: string
  private readonly factory: IDBFactory
  private database: Promise<IDBDatabase> | undefined
  constructor(private readonly options: { namespace: VfsPersistenceNamespace; root?: string; indexedDB?: IDBFactory }) {
    this.root = storageRoot(options.root ?? '/dsh')
    const factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB)
    if (!factory) throw new VfsPersistenceError('STORAGE_UNAVAILABLE', 'IndexedDB is unavailable')
    this.factory = factory
  }
  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.options.namespace, SCHEMA)
      let blocked = false
      request.onupgradeneeded = () => {
        request.result.createObjectStore('metadata')
        request.result.createObjectStore('nodes', { keyPath: 'key' })
        request.result.createObjectStore('chunks')
      }
      request.onblocked = () => { blocked = true; reject(new VfsPersistenceError('STORAGE_BLOCKED', 'IndexedDB initialization is blocked by another connection')) }
      request.onerror = () => { reject(request.error ?? new VfsPersistenceError('STORAGE_FAILED', 'Cannot open IndexedDB')) }
      request.onsuccess = () => {
        const database = request.result
        if (blocked) { database.close(); return }
        database.onversionchange = () => { database.close() }
        resolve(database)
      }
    })
    return this.database
  }
  private async transact<T>(mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    const database = await this.open()
    const transaction = database.transaction(['metadata', 'nodes', 'chunks'], mode)
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => { resolve() }
      transaction.onabort = () => { reject(transaction.error ?? new VfsPersistenceError('STORAGE_ABORTED', 'IndexedDB transaction aborted')) }
      transaction.onerror = () => { /* The abort event reports the final transaction outcome. */ }
    })
    // Attach a rejection observer before a request can abort the transaction.
    void completed.catch(() => {})
    try { const output = await operation(transaction); await completed; return output }
    catch (error) {
      try { transaction.abort() } catch (abortError) { if (!(abortError instanceof Error) || abortError.name !== 'InvalidStateError') console.error('webworker storage: transaction abort failed', abortError) }
      try { await completed } catch (completionError) {
        // The initiating operation error retains the useful classification.
        void completionError
      }
      throw error
    }
  }
  async load(): Promise<VfsStorageSnapshot> {
    return this.transact('readonly', async (transaction) => {
      const current = revision(await result<unknown>(transaction.objectStore('metadata').get('revision')))
      const values: unknown[] = await result(transaction.objectStore('nodes').getAll())
      const records: VfsStoredRecord[] = []
      for (const value of values) {
        const entry = node(value, this.root)
        if (entry.kind === 'remove') { records.push({ kind: 'remove', path: entry.path }); continue }
        if (entry.kind === 'directory') { records.push({ kind: 'directory', path: entry.path, mode: entry.mode, ...entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs } }); continue }
        const bytes = new Uint8Array(entry.size)
        for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
          const chunk: unknown = await result(transaction.objectStore('chunks').get([entry.path, offset / CHUNK_BYTES]))
          if (!(chunk instanceof Uint8Array) || chunk.length !== Math.min(CHUNK_BYTES, bytes.length - offset)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Missing or invalid persistent file chunk')
          bytes.set(chunk, offset)
        }
        records.push({ kind: 'file', path: entry.path, mode: entry.mode, ...entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }, bytes })
      }
      return { revision: current, records: parseStoredRecords(records, this.root) }
    })
  }
  async apply(expectedRevision: number, operations: readonly VfsStorageOperation[]): Promise<number> {
    return this.transact('readwrite', async (transaction) => {
      const metadata = transaction.objectStore('metadata')
      const current = revision(await result<unknown>(metadata.get('revision')))
      if (current !== expectedRevision) throw new VfsPersistenceError('STORAGE_CONFLICT', 'Another tab changed persistent data; this writer has stopped')
      if (current === Number.MAX_SAFE_INTEGER) throw new VfsPersistenceError('STORAGE_REVISION_LIMIT', 'Persistent revision limit reached')
      const nodes = transaction.objectStore('nodes')
      const chunks = transaction.objectStore('chunks')
      const eraseChunks = (entry: StoredNode): void => {
        if (entry.kind !== 'file') return
        for (let offset = 0; offset < entry.size; offset += CHUNK_BYTES) chunks.delete([entry.path, offset / CHUNK_BYTES])
      }
      for (const operation of operations) {
        validateStoragePath(operation.path, this.root)
        const key = `node:${operation.path}`
        if (operation.kind === 'remove') {
          const all: unknown[] = await result(nodes.getAll())
          for (const value of all) {
            const entry = node(value, this.root)
            if (entry.path === operation.path || entry.path.startsWith(operation.path + '/')) { nodes.delete(entry.key); eraseChunks(entry) }
          }
          nodes.put({ key: `remove:${operation.path}`, kind: 'remove', path: operation.path })
          continue
        }
        if (!Number.isInteger(operation.mode) || operation.mode < 0 || operation.mode > 0o777) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid operation permissions')
        const time = operation.mtimeMs
        if (time !== undefined && !Number.isFinite(time)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid operation modification time')
        const times = time === undefined ? {} : { mtimeMs: time }
        const existing: unknown = await result(nodes.get(key))
        if (operation.kind === 'chmod') {
          const old = node(existing, this.root)
          nodes.put({ ...old, mode: operation.mode, ...times }); continue
        }
        if (operation.kind === 'mkdir') { if (existing !== undefined) eraseChunks(node(existing, this.root)); nodes.put({ key, kind: 'directory', path: operation.path, mode: operation.mode, ...times }); continue }
        if (!(operation.bytes instanceof Uint8Array)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid operation bytes')
        let offset = 0
        let bytes = operation.bytes
        if (operation.kind === 'append') {
          const old = node(existing, this.root)
          if (old.kind !== 'file' || old.size !== operation.offset) throw new VfsPersistenceError('STORAGE_APPEND_CONFLICT', 'Persistent append offset does not match the file')
          offset = operation.offset
          const partial = offset % CHUNK_BYTES
          if (partial) {
            const prefix: unknown = await result(chunks.get([operation.path, Math.floor(offset / CHUNK_BYTES)]))
            if (!(prefix instanceof Uint8Array) || prefix.length !== partial) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid append tail chunk')
            bytes = new Uint8Array(partial + operation.bytes.length)
            bytes.set(prefix)
            bytes.set(operation.bytes, partial)
            offset -= partial
          }
        } else if (existing !== undefined) eraseChunks(node(existing, this.root))
        for (let position = 0; position < bytes.length; position += CHUNK_BYTES) {
          chunks.put(bytes.slice(position, position + CHUNK_BYTES), [operation.path, (offset + position) / CHUNK_BYTES])
        }
        nodes.put({ key, kind: 'file', path: operation.path, mode: operation.mode, ...times, size: offset + bytes.length })
      }
      metadata.put(current + 1, 'revision')
      return current + 1
    })
  }
  /**
   * Release this provider's connection after its caller has settled outstanding work.
   * @returns Completion of connection acquisition and close.
   */
  async close(): Promise<void> { if (this.database) (await this.database).close() }
}
