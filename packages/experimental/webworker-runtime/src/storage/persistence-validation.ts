/** Validation shared by durable snapshots and IndexedDB operation parsing. */
import type { VfsStoredRecord } from './persistence-types.ts'

/** Persistence failures have stable codes for callers and UI. */
export class VfsPersistenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'VfsPersistenceError' }
}

/**
 * Validate an absolute mutable path without normalizing away traversal.
 * @param path - Stored or queued path.
 * @param root - Mounted VFS root.
 */
export function validateStoragePath(path: string, root: string): void {
  if (!path.startsWith('/') || path.split('/').slice(1).some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))
    || ![`${root}/home`, `${root}/workspace`].some(base => path === base || path.startsWith(base + '/'))) {
    throw new VfsPersistenceError('STORAGE_SCOPE', 'Persistent path is outside the mutable filesystem roots')
  }
}

/**
 * Validate a root supplied by the Worker assembly.
 * @param root - Absolute image root.
 * @returns The unchanged validated root.
 */
export function storageRoot(root: string): string {
  if (!root.startsWith('/') || root.split('/').slice(1).some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw new VfsPersistenceError('STORAGE_SCOPE', 'Invalid persistent filesystem root')
  return root
}

/**
 * Parse persisted records before any overlay mutation occurs.
 * @param value - Untrusted provider records.
 * @param root - Mounted VFS root.
 * @returns Validated records with independent file bytes.
 */
export function parseStoredRecords(value: unknown, root: string): VfsStoredRecord[] {
  if (!Array.isArray(value)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent records')
  const identities = new Set<string>()
  const records: VfsStoredRecord[] = value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('kind' in entry) || !('path' in entry) || typeof entry.path !== 'string') throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent record')
    validateStoragePath(entry.path, root)
    const identity = `${entry.kind === 'remove' ? 'remove' : 'node'}:${entry.path}`
    if (identities.has(identity)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Duplicate persistent record')
    identities.add(identity)
    if (entry.kind === 'remove') return { kind: 'remove', path: entry.path }
    if (!('mode' in entry) || !Number.isInteger(entry.mode) || typeof entry.mode !== 'number' || entry.mode < 0 || entry.mode > 0o777) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent mode')
    const time = 'mtimeMs' in entry ? entry.mtimeMs : undefined
    if (time !== undefined && (typeof time !== 'number' || !Number.isFinite(time))) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent modification time')
    const metadata = time === undefined ? {} : { mtimeMs: time }
    if (entry.kind === 'directory') return { kind: 'directory', path: entry.path, mode: entry.mode, ...metadata }
    if (entry.kind !== 'file' || !('bytes' in entry) || !(entry.bytes instanceof Uint8Array)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Invalid persistent file bytes')
    return { kind: 'file', path: entry.path, mode: entry.mode, ...metadata, bytes: entry.bytes.slice() }
  })
  const files = new Set(records.filter(entry => entry.kind === 'file').map(entry => entry.path))
  for (const entry of records) {
    if (entry.kind === 'remove') continue
    let parent = entry.path.slice(0, entry.path.lastIndexOf('/'))
    while (parent.length > root.length) {
      if (files.has(parent)) throw new VfsPersistenceError('STORAGE_CORRUPT', 'Persistent file is used as a parent directory')
      parent = parent.slice(0, parent.lastIndexOf('/'))
    }
  }
  return records
}
