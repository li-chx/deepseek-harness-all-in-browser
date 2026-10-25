/** Durable overlay records and the asynchronous provider seam. */

/** One materialized overlay node; removals are retained separately from recreated nodes. */
export type VfsStoredRecord =
  | { kind: 'file'; path: string; mode: number; mtimeMs?: number; bytes: Uint8Array }
  | { kind: 'directory'; path: string; mode: number; mtimeMs?: number }
  | { kind: 'remove'; path: string }

/** Atomic operations over mutable overlay records. */
export type VfsStorageOperation =
  | { kind: 'write'; path: string; mode: number; mtimeMs?: number; bytes: Uint8Array }
  | { kind: 'append'; path: string; mode: number; mtimeMs?: number; offset: number; bytes: Uint8Array }
  | { kind: 'mkdir'; path: string; mode: number; mtimeMs?: number }
  | { kind: 'remove'; path: string }
  | { kind: 'chmod'; path: string; mode: number; mtimeMs?: number }

/** Records and their revision read from one consistent transaction. */
export interface VfsStorageSnapshot { revision: number; records: VfsStoredRecord[] }

/** Replaceable persistence provider; rejected commits must never be retried implicitly. */
export interface VfsPersistenceProvider {
  /** Read and validate a consistent overlay snapshot. */
  load(): Promise<VfsStorageSnapshot>
  /**
   * Commit all operations atomically if the expected revision is current.
   * @param expectedRevision - Revision returned by the last successful load or apply.
   * @param operations - Ordered changes in one atomic commit.
   * @returns The revision acknowledged after transaction completion.
   */
  apply(expectedRevision: number, operations: readonly VfsStorageOperation[]): Promise<number>
  /** Release provider resources after all submitted operations settle. */
  close?(): Promise<void>
}

/** Observable durability state, independent of successful in-memory VFS operations. */
export interface VfsPersistenceStatus {
  kind: 'saved' | 'pending' | 'failed'
  revision: number
  pending: number
  error?: { code: string; message: string }
}
