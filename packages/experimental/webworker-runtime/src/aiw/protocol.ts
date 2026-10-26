/** Worker-owned AIW file, source-project, history and portable-backup messages. */
import type { ForgeInstalled, ForgeResult, ForgeManifest } from '../forge/protocol.ts'

/** A managed source project discovered under the workspace. */
export interface AiwProject {
  directory: string
  id: string
  name: string
  version: string
  client: boolean
  diagnostic?: string
}
/** One visible filesystem entry; protected entries remain read-only or are omitted. */
export interface AiwFileEntry {
  name: string
  path: string
  directory: boolean
  size: number
  mtimeMs: number
  writable: boolean
}
/** A retained artifact revision; source is present only for observed source builds. */
export interface AiwHistoryVersion {
  pluginId: string
  revision: string
  name: string
  version: string
  createdAt: string
  hasSource: boolean
  status?: ForgeResult['status']
}
/** One portable file; bytes are base64 and the digest covers decoded bytes. */
export interface AiwArchiveFile {
  path: string
  base64: string
  sha256: string
}
/** Portable workspace subtree; it never restores a running profile in place. */
export interface AiwFilesArchive {
  schema: 1
  generation: string
  kind: 'files'
  files: AiwArchiveFile[]
  directories: string[]
}
/** Source files linked to one compiled plugin revision. */
export interface AiwSourceSnapshot {
  directory: string
  files: Record<string, string>
}
/** Portable plugin artifacts and optional source; imported through the normal installer. */
export interface AiwPluginArchive {
  schema: 1
  generation: string
  kind: 'plugin'
  manifest: ForgeManifest
  objects: Record<string, string>
  source?: AiwSourceSnapshot
}
/** A validated backup accepted by the workbench. */
export type AiwArchive = AiwFilesArchive | AiwPluginArchive
/** Inputs accepted by the Worker-local workbench endpoint. */
export type AiwAction =
  | { action: 'status' | 'projects' }
  | { action: 'configure'; baseUrl: string }
  | { action: 'list' | 'read' | 'delete' | 'export'; path: string }
  | { action: 'write'; path: string; text: string; expectedSha256?: string }
  | { action: 'mkdir'; path: string }
  | { action: 'rename'; path: string; to: string }
  | { action: 'create-project'; directory: string; name: string; client: boolean }
  | { action: 'build'; directory: string }
  | { action: 'add'; spec: string }
  | { action: 'remove' | 'history'; pluginId: string }
  | { action: 'restore'; pluginId: string; revision: string }
  | { action: 'shell'; cwd: string; command: string }
  | { action: 'import-preview' | 'import'; archive: AiwFilesArchive; directory: string }
  | { action: 'plugin-export'; pluginId: string; revision?: string }
  | { action: 'plugin-import'; archive: AiwPluginArchive }
/** Current installation and filesystem locations without credential contents. */
export interface AiwStatus {
  protocol: 1
  action: 'status'
  generation: string
  root: string
  workspace: string
  profileDirectory: string
  baseUrl?: string
  plugins: ForgeInstalled[]
  historyPlugins: Array<{ pluginId: string; name: string }>
}
/** Result of a bounded virtual command; a nonzero exit is not transport success. */
export interface AiwCommandResult {
  protocol: 1
  action: 'shell' | 'build' | 'add'
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
}
/** Reviewed file-import result, computed without mutations. */
export interface AiwImportPreview {
  protocol: 1
  action: 'import-preview'
  directory: string
  fileCount: number
  bytes: number
  conflicts: string[]
}
/** Successful workbench responses; failures use the existing structured error envelope. */
export type AiwResponse = AiwStatus | AiwCommandResult | AiwImportPreview
  | { protocol: 1; action: 'projects'; projects: AiwProject[] }
  | { protocol: 1; action: 'list'; path: string; entries: AiwFileEntry[] }
  | { protocol: 1; action: 'read'; path: string; text: string; sha256: string }
  | { protocol: 1; action: 'history'; versions: AiwHistoryVersion[] }
  | { protocol: 1; action: 'export' | 'plugin-export'; archive: AiwArchive }
  | { protocol: 1; action: 'import'; writes: number; directory: string }
  | { protocol: 1; action: 'create-project'; project: AiwProject }
  | { protocol: 1; action: 'configure'; baseUrl: string }
  | { protocol: 1; action: 'write'; path: string; sha256: string }
  | { protocol: 1; action: 'mkdir' | 'rename' | 'delete'; path: string }
  | (ForgeResult & { action: 'restore' | 'remove' | 'plugin-import' })
