/** Guarded VFS access shared by the AIW file manager, backups and limited command line. */
import { Buffer } from 'buffer'
import type { MemoryVfs } from '../storage/memory.ts'
import type { ShellFileSystem } from '../shell/types.ts'
import { dirname, resolve } from '../module-system/posix-path.ts'
import { ForgeError, FORGE_GENERATION, object } from '../forge/protocol.ts'
import { aiwDigest } from './history.ts'
import type { AiwFileEntry, AiwFilesArchive, AiwImportPreview } from './protocol.ts'

const MAX_FILES = 1000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const below = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)
const relativePath = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || !value.split('/').every(part => part !== '' && part !== '.' && part !== '..'
    && !part.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new ForgeError('invalid-path', 'Backup paths must be relative paths without traversal or control characters')
  return value
}
/** Applies one path policy to file operations and shell redirections. */
export class AiwFiles {
  /** Writable workspace root offered by the management page. */
  readonly workspace: string
  /** Application home; managed descendants retain their separate protections. */
  readonly home: string
  constructor(readonly vfs: MemoryVfs, readonly root: string) { this.workspace = `${root}/workspace`; this.home = `${root}/home` }

  /** Normalize a path and reject protected or out-of-image references.
   * @param value Requested absolute VFS path.
   * @param write Whether the operation mutates the path.
   * @returns Normalized path.
   */
  path(value: unknown, write = false): string {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\\') || value.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ForgeError('invalid-path', 'Use an absolute VFS path without control characters')
    const path = resolve('/', value)
    if (this.vfs.existsSync(path)) {
      const stat = this.vfs.statSync(path, { bigint: true })
      if ('nlink' in stat && stat.nlink > 1n) throw new ForgeError('protected-path', 'Hard-linked files cannot be managed or exported through this page')
    }
    if (!below(path, this.root)) throw new ForgeError('protected-path', 'The path is outside this Worker filesystem')
    const parts = path.slice(this.root.length).split('/')
    if (parts.some(part => part.startsWith('.env') || /credentials?/i.test(part) || part === '.aiw' || part === '.forge')) throw new ForgeError('protected-path', 'Credentials and managed artifact/history files are protected')
    if (write && (!below(path, this.workspace) && !below(path, this.home)
      || path === this.workspace || path === this.home
      || below(path, `${this.home}/profiles`) || below(path, `${this.home}/sessions`)
      || /^cordis(?:\.patch)?\.ya?ml$/.test(path.slice(this.home.length + 1)))) throw new ForgeError('protected-path', 'This path is managed by the application or is read-only')
    return path
  }

  /** List visible children without exposing secret or private cache entries.
   * @param value Directory path.
   * @returns Visible directory entries.
   */
  list(value: unknown): { path: string; entries: AiwFileEntry[] } {
    const path = this.path(value)
    const entries: AiwFileEntry[] = []
    for (const name of this.vfs.readdirSync(path)) {
      const child = `${path}/${name}`
      try { this.path(child) } catch (error) { if (error instanceof ForgeError && error.code === 'protected-path') continue; throw error }
      const stat = this.vfs.statSync(child)
      let writable = true
      try { this.path(child, true) } catch (error) { if (error instanceof ForgeError && error.code === 'protected-path') writable = false; else throw error }
      entries.push({ name, path: child, directory: stat.isDirectory(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), writable })
      if (entries.length > MAX_FILES) throw new ForgeError('file-limit', 'Directory contains more than 1000 visible entries')
    }
    return { path, entries: entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) }
  }

  /** Read an editable UTF-8 file and its compare-before-save digest.
   * @param value File path.
   * @returns Text and byte digest.
   */
  read(value: unknown): { path: string; text: string; sha256: string } {
    const path = this.path(value)
    const bytes = this.vfs.readFileSync(path) as Uint8Array
    if (bytes.byteLength > MAX_TEXT_BYTES) throw new ForgeError('text-limit', 'Text editor supports files up to 1 MiB; export the file to download it')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch (error) { throw new ForgeError('binary-file', `This file is not UTF-8 text: ${error instanceof Error ? error.message : String(error)}`) }
    if (text.includes('\0')) throw new ForgeError('binary-file', 'This file contains binary NUL bytes; export it instead of editing text')
    return { path, text, sha256: aiwDigest(bytes) }
  }

  /** Save text only if the caller observed the current contents.
   * @param value File path.
   * @param text UTF-8 contents.
   * @param expected Digest returned by read; required before overwriting an existing file.
   * @returns Saved path and digest.
   */
  write(value: unknown, text: unknown, expected?: unknown): { path: string; sha256: string } {
    const path = this.path(value, true)
    if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new ForgeError('text-limit', 'Text editor supports UTF-8 files up to 1 MiB')
    if (this.vfs.existsSync(path) && aiwDigest(this.vfs.readFileSync(path) as Uint8Array) !== expected) throw new ForgeError('file-conflict', 'This file changed; read its latest contents before saving')
    this.vfs.writeFileSync(path, text)
    return { path, sha256: aiwDigest(new TextEncoder().encode(text)) }
  }

  /** Export one visible subtree with hashes; private caches and credentials are excluded.
   * @param value Directory or file to export.
   * @returns Portable file archive.
   */
  export(value: unknown): AiwFilesArchive {
    const root = this.path(value)
    const files: AiwFilesArchive['files'] = [], directories: string[] = []
    let total = 0
    const visit = (path: string, relative: string): void => {
      this.path(path)
      const stat = this.vfs.statSync(path)
      if (stat.isDirectory()) {
        if (relative) directories.push(relative)
        if (directories.length > MAX_FILES || relative.split('/').length > 64) throw new ForgeError('archive-limit', 'File backup contains too many or too deeply nested directories')
        for (const entry of this.list(path).entries) visit(entry.path, relative ? `${relative}/${entry.name}` : entry.name)
      } else {
        const bytes = this.vfs.readFileSync(path) as Uint8Array
        total += bytes.byteLength
        if (files.length >= MAX_FILES || total > MAX_BYTES) throw new ForgeError('archive-limit', 'File backup exceeds 1000 files or 32 MiB')
        files.push({ path: relative, base64: Buffer.from(bytes).toString('base64'), sha256: aiwDigest(bytes) })
      }
    }
    visit(root, this.vfs.statSync(root).isDirectory() ? '' : root.slice(root.lastIndexOf('/') + 1))
    return { schema: 1, generation: FORGE_GENERATION, kind: 'files', files, directories }
  }

  /** Validate an archive and destination without changing any files.
   * @param value Untrusted archive JSON.
   * @param destination Empty destination directory under the workspace.
   * @returns Fully decoded entries and the user-visible preview.
   */
  preview(value: unknown, destination: unknown): {
    files: Array<{ path: string; bytes: Uint8Array }>
    directories: string[]
    preview: AiwImportPreview
  } {
    const archive = object(value), directory = this.path(destination, true)
    if (!below(directory, this.workspace) || directory === this.workspace) throw new ForgeError('invalid-destination', 'Import into a new workspace subdirectory')
    if (archive.schema !== 1 || archive.generation !== FORGE_GENERATION || archive.kind !== 'files'
      || !Array.isArray(archive.files) || !Array.isArray(archive.directories) || archive.files.length > MAX_FILES || archive.directories.length > MAX_FILES) throw new ForgeError('invalid-archive', 'File backup schema, generation or file list is invalid')
    const seen = new Set<string>()
    let total = 0
    const files = archive.files.map((value) => {
      const entry = object(value), path = relativePath(entry.path)
      this.path(`${directory}/${path}`, true)
      if (seen.has(path)) throw new ForgeError('invalid-archive', 'File backup contains duplicate paths')
      seen.add(path)
      if (typeof entry.base64 !== 'string' || entry.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/.test(entry.base64)) throw new ForgeError('invalid-archive', 'File backup contains invalid base64')
      const bytes = new Uint8Array(Buffer.from(entry.base64, 'base64'))
      if (aiwDigest(bytes) !== entry.sha256) throw new ForgeError('invalid-archive', 'File backup hash verification failed')
      total += bytes.byteLength
      if (total > MAX_BYTES) throw new ForgeError('archive-limit', 'File backup exceeds 32 MiB')
      return { path, bytes }
    })
    const directories = archive.directories.map(relativePath)
    if (new Set(directories).size !== directories.length || directories.some(path => seen.has(path))
      || files.some(file => files.some(other => other !== file && other.path.startsWith(`${file.path}/`)))
      || directories.some(path => files.some(file => path.startsWith(`${file.path}/`)))) throw new ForgeError('invalid-archive', 'File backup contains conflicting file and directory paths')
    for (const path of directories) this.path(`${directory}/${path}`, true)
    const conflicts = this.vfs.existsSync(directory) ? this.vfs.statSync(directory).isDirectory()
      ? this.vfs.readdirSync(directory).map(name => `${directory}/${name}`) : [directory] : []
    return { files, directories, preview: { protocol: 1, action: 'import-preview', directory, fileCount: files.length, bytes: total, conflicts } }
  }

  private checkTree(path: string, depth = 0, count = { value: 0 }): void {
    this.path(path, true)
    if (++count.value > MAX_FILES || depth > 64) throw new ForgeError('file-limit', 'Operation contains more than 1000 entries or 64 directory levels')
    if (this.vfs.existsSync(path) && this.vfs.statSync(path).isDirectory()) {
      for (const name of this.vfs.readdirSync(path)) this.checkTree(`${path}/${name}`, depth + 1, count)
    }
  }

  /** Remove a subtree only after checking every descendant for protected aliases and files.
   * @param value Path to remove.
   * @param force Whether an absent target is tolerated.
   * @param recursive Whether directory descendants may be removed.
   * @returns Removed path.
   */
  remove(value: unknown, force = false, recursive = true): string {
    const path = this.path(value, true)
    this.checkTree(path)
    this.vfs.rmSync(path, { recursive, force })
    return path
  }

  /** Rename a subtree without overwriting a destination or moving protected descendants.
   * @param from Source path.
   * @param to Destination path.
   * @returns Destination path.
   */
  rename(from: unknown, to: unknown): string {
    const source = this.path(from, true), target = this.path(to, true)
    this.checkTree(source)
    if (this.vfs.existsSync(target)) throw new ForgeError('file-conflict', 'Rename destination already exists')
    this.vfs.renameSync(source, target)
    return target
  }

  /** Guarded shell filesystem; terminal redirections have no broader access than the file manager.
   * @returns Asynchronous filesystem adapter with the same path and compare-before-save rules.
   */
  shell(): ShellFileSystem {
    return {
      stat: path => Promise.resolve(this.vfs.existsSync(this.path(path)) ? (() => {
        const stat = this.vfs.statSync(path)
        return { directory: stat.isDirectory(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) }
      })() : undefined),
      list: path => Promise.resolve(this.list(path).entries.map(entry => ({ name: entry.name, directory: entry.directory }))),
      readText: path => Promise.resolve(this.read(path).text),
      writeText: (path, text, append = false) => {
        const target = this.path(path, true)
        const old = this.vfs.existsSync(target) ? this.read(target) : undefined
        this.write(target, append ? `${old?.text ?? ''}${text}` : text, old?.sha256)
        return Promise.resolve()
      },
      mkdir: (path, recursive) => { this.vfs.mkdirSync(this.path(path, true), { recursive }); return Promise.resolve() },
      remove: (path, options) => { this.remove(path, options.force, options.recursive); return Promise.resolve() },
      rename: (from, to) => { this.rename(from, to); return Promise.resolve() },
    }
  }

  /** Materialize a validated backup into an empty destination.
   * @param value Untrusted file archive.
   * @param destination New workspace subdirectory.
   * @returns File count and destination.
   */
  import(value: unknown, destination: unknown): { writes: number; directory: string } {
    const parsed = this.preview(value, destination)
    if (parsed.preview.conflicts.length) throw new ForgeError('import-conflict', 'Import destination must be empty; choose a new directory')
    const directory = parsed.preview.directory
    this.vfs.mkdirSync(directory, { recursive: true })
    for (const path of parsed.directories) this.vfs.mkdirSync(`${directory}/${path}`, { recursive: true })
    for (const file of parsed.files) {
      const path = `${directory}/${file.path}`
      this.vfs.mkdirSync(dirname(path), { recursive: true }); this.vfs.writeFileSync(path, file.bytes)
    }
    return { writes: parsed.files.length, directory }
  }
}
