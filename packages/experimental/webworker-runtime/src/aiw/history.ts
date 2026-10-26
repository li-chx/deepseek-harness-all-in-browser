/** Content-addressed local plugin revisions retained independently of installed-artifact garbage collection. */
import { Buffer } from 'buffer'
import { sha256 } from '@noble/hashes/sha2.js'
import type { MemoryVfs } from '../storage/memory.ts'
import type { ForgeInstalled, ForgeResult } from '../forge/protocol.ts'
import { FORGE_GENERATION, ForgeError, object, parseForgeManifest, pluginId, type ForgeManifest } from '../forge/protocol.ts'
import type { AiwHistoryVersion, AiwPluginArchive, AiwSourceSnapshot } from './protocol.ts'

/** Digest of exact VFS bytes, shared by backups and historical objects.
 * @param bytes Original file bytes.
 * @returns Lowercase SHA-256 digest.
 */
export function aiwDigest(bytes: Uint8Array): string {
  return [...sha256(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
interface RevisionRecord {
  schema: 1
  createdAt: string
  manifest: ForgeManifest
  source?: AiwSourceSnapshot
  status?: ForgeResult['status']
}
/** Fixed target used to validate portable manifests before any imported bytes are applied. */
export interface AiwHistoryTarget {
  hostPackages: Readonly<Record<string, string>>
  clientPackages: Readonly<Record<string, string>>
  sharedPackages: readonly string[]
}
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ForgeError('invalid-history', 'Expected a content digest')
  return value
}
/** Retains every accepted artifact plan; activation is recorded separately and never inferred. */
export class AiwHistory {
  private readonly sources = new Map<string, AiwSourceSnapshot>()
  constructor(private readonly vfs: MemoryVfs, private readonly directory: string, private readonly target: AiwHistoryTarget) {}

  /** Stage source observed by a build command without claiming the build activated.
   * @param revision Artifact revision returned by Forge.
   * @param source Selected source snapshot.
   */
  stageSource(revision: string, source: AiwSourceSnapshot): void { this.sources.set(hash(revision), source) }

  /** Release a build's staged source after its install attempt settles.
   * @param revision Build revision.
   */
  unstage(revision: string): void { this.sources.delete(revision) }

  /** Archive verified artifact bytes before the installer mutates the selected profile.
   * @param manifest Validated install plan.
   * @param artifacts Complete digest-to-bytes map for the plan.
   */
  capture(manifest: ForgeManifest, artifacts: ReadonlyMap<string, Uint8Array>): void {
    const old = this.read(manifest.plugin.id, manifest.revision)
    for (const pkg of manifest.packages) for (const file of pkg.files) {
      const bytes = artifacts.get(file.sha256)
      if (bytes === undefined || bytes.byteLength !== file.size || aiwDigest(bytes) !== file.sha256) {
        throw new ForgeError('invalid-history', `Cannot retain unverified artifact ${file.path}`)
      }
      const path = `${this.directory}/objects/${file.sha256}`
      if (this.vfs.existsSync(path)) {
        if (aiwDigest(this.vfs.readFileSync(path) as Uint8Array) !== file.sha256) throw new ForgeError('invalid-history', 'A retained plugin object is corrupt')
      } else { this.vfs.mkdirSync(`${this.directory}/objects`, { recursive: true }); this.vfs.writeFileSync(path, bytes) }
    }
    const source = this.sources.get(manifest.revision) ?? old?.source
    const record: RevisionRecord = { schema: 1, createdAt: old?.createdAt ?? new Date().toISOString(), manifest,
      ...source === undefined ? {} : { source }, ...old?.status === undefined ? {} : { status: old.status } }
    this.write(record)
    this.sources.delete(manifest.revision)
  }

  /** Record the actual installer outcome after profile reconciliation.
   * @param result Installation/removal result; removal keeps retained revisions.
   */
  mark(result: Pick<ForgeInstalled, 'pluginId' | 'revision'> & { status: ForgeResult['status'] }): void {
    const record = this.read(result.pluginId, result.revision)
    if (record !== undefined) this.write({ ...record, status: result.status })
  }

  /** List retained revisions without reading their object bytes.
   * @param id Valid plugin id.
   * @returns Newest retained versions first.
   */
  versions(id: string): AiwHistoryVersion[] {
    const root = `${this.directory}/revisions/${pluginId(id)}`
    if (!this.vfs.existsSync(root)) return []
    return this.vfs.readdirSync(root).map((file) => {
      if (!file.endsWith('.json')) throw new ForgeError('invalid-history', 'Unexpected file in retained plugin history')
      const record = this.read(id, file.slice(0, -5))
      if (record === undefined) throw new ForgeError('invalid-history', 'Retained plugin revision disappeared')
      return { pluginId: id, revision: record.manifest.revision, name: record.manifest.plugin.name,
        version: record.manifest.plugin.version, createdAt: record.createdAt, hasSource: record.source !== undefined,
        ...record.status === undefined ? {} : { status: record.status } }
    }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** List plugin identities that still have retained revisions, including removed installations.
   * @returns Discoverable retained plugin ids and package names.
   */
  owners(): Array<{ pluginId: string; name: string }> {
    const root = `${this.directory}/revisions`
    if (!this.vfs.existsSync(root)) return []
    return this.vfs.readdirSync(root).flatMap((id) => {
      const version = this.versions(pluginId(id))[0]
      return version === undefined ? [] : [{ pluginId: id, name: version.name }]
    })
  }

  /** Read a retained object for the installer's ordinary integrity-checked download path.
   * @param key Full immutable Forge object key.
   * @returns Bytes when retained locally, otherwise undefined.
   */
  object(key: string): Uint8Array | undefined {
    const match = new RegExp(`^${FORGE_GENERATION}/objects/([a-f0-9]{64})$`).exec(key)
    if (match === null) return undefined
    const digest = match[1] ?? ''
    const path = `${this.directory}/objects/${digest}`
    if (!this.vfs.existsSync(path)) return undefined
    const bytes = this.vfs.readFileSync(path) as Uint8Array
    if (aiwDigest(bytes) !== digest) throw new ForgeError('invalid-history', 'A retained plugin object is corrupt')
    return bytes
  }

  /** Export one revision with all verified bytes; credentials and whole-profile state are excluded.
   * @param id Plugin id.
   * @param revision Selected digest.
   * @returns Portable plugin archive.
   */
  export(id: string, revision: string): AiwPluginArchive {
    const record = this.read(id, revision)
    if (record === undefined) throw new ForgeError('history-not-found', 'The requested plugin revision is not retained')
    const objects: Record<string, string> = {}
    for (const pkg of record.manifest.packages) for (const file of pkg.files) {
      const bytes = this.object(file.objectKey)
      if (bytes === undefined || bytes.byteLength !== file.size) throw new ForgeError('invalid-history', 'A retained plugin artifact is missing')
      objects[file.sha256] = Buffer.from(bytes).toString('base64')
    }
    return { schema: 1, generation: FORGE_GENERATION, kind: 'plugin', manifest: record.manifest, objects,
      ...record.source === undefined ? {} : { source: record.source } }
  }

  /** Validate an untrusted plugin archive completely before retaining any bytes.
   * @param value JSON archive supplied by the page.
   * @returns Validated manifest and decoded artifacts.
   */
  validateImport(value: unknown): { manifest: ForgeManifest; artifacts: Map<string, Uint8Array>; source?: AiwSourceSnapshot } {
    const archive = object(value)
    if (archive.schema !== 1 || archive.generation !== FORGE_GENERATION || archive.kind !== 'plugin') throw new ForgeError('invalid-archive', 'Plugin backup belongs to another schema or runtime generation')
    const manifest = parseForgeManifest(archive.manifest, this.target.hostPackages, this.target.clientPackages, this.target.sharedPackages)
    const encoded = object(archive.objects)
    const artifacts = new Map<string, Uint8Array>()
    let total = 0
    for (const pkg of manifest.packages) for (const file of pkg.files) {
      const value = encoded[file.sha256]
      if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/.test(value)) throw new ForgeError('invalid-archive', 'Plugin backup contains invalid base64')
      const bytes = new Uint8Array(Buffer.from(value, 'base64'))
      if (bytes.byteLength !== file.size || aiwDigest(bytes) !== file.sha256) throw new ForgeError('invalid-archive', 'Plugin backup artifact verification failed')
      if (!artifacts.has(file.sha256)) total += bytes.byteLength
      if (total > 32 * 1024 * 1024) throw new ForgeError('archive-limit', 'Plugin backup exceeds 32 MiB')
      artifacts.set(file.sha256, bytes)
    }
    let source: AiwSourceSnapshot | undefined
    if (archive.source !== undefined) {
      const raw = object(archive.source), files = object(raw.files)
      if (typeof raw.directory !== 'string' || !Object.values(files).every(text => typeof text === 'string')) throw new ForgeError('invalid-archive', 'Plugin backup source fields are invalid')
      source = { directory: raw.directory, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, String(text)])) }
      this.validateSource(source, manifest)
    }
    return { manifest, artifacts, ...source === undefined ? {} : { source } }
  }

  private validateSource(source: AiwSourceSnapshot, manifest: ForgeManifest): void {
    const files = Object.entries(source.files)
    if (files.length > 1001 || files.reduce((sum, [, text]) => sum + new TextEncoder().encode(text).byteLength, 0) > 32 * 1024 * 1024) {
      throw new ForgeError('archive-limit', 'Plugin source backup exceeds 1001 files or 32 MiB')
    }
    const paths = new Set(files.map(([path]) => path))
    for (const path of paths) {
      const segments = path.split('/')
      segments.pop()
      while (segments.length) {
        if (paths.has(segments.join('/'))) throw new ForgeError('invalid-source', 'Plugin source contains conflicting file and directory paths')
        segments.pop()
      }
    }
    const descriptorText = source.files['forge.json']
    let parsed: unknown
    try { parsed = JSON.parse(descriptorText ?? '') }
    catch (error) { throw new ForgeError('invalid-source', `Retained source descriptor is unreadable: ${error instanceof Error ? error.message : String(error)}`) }
    const descriptor = object(parsed)
    if (descriptor.id !== manifest.plugin.id || descriptor.name !== manifest.plugin.name || descriptor.version !== manifest.plugin.version
      || descriptor.entry !== manifest.plugin.entry || !Array.isArray(descriptor.files)
      || !descriptor.files.every(path => typeof path === 'string' && typeof source.files[path] === 'string')) {
      throw new ForgeError('invalid-source', 'Retained source descriptor does not match the compiled plugin identity or selected files')
    }
  }

  private read(id: string, revision: string): RevisionRecord | undefined {
    const path = `${this.directory}/revisions/${pluginId(id)}/${hash(revision)}.json`
    if (!this.vfs.existsSync(path)) return undefined
    let parsed: unknown
    try { parsed = JSON.parse(this.vfs.readFileSync(path, 'utf8') as string) }
    catch (error) { throw new ForgeError('invalid-history', `Retained plugin history is unreadable: ${error instanceof Error ? error.message : String(error)}`) }
    const value = object(parsed)
    if (value.schema !== 1 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new ForgeError('invalid-history', 'Retained plugin history has invalid metadata')
    const manifest = parseForgeManifest(value.manifest, this.target.hostPackages, this.target.clientPackages, this.target.sharedPackages)
    if (manifest.plugin.id !== id || manifest.revision !== revision) throw new ForgeError('invalid-history', 'Retained plugin history identity differs')
    const status = value.status
    if (status !== undefined && (typeof status !== 'string' || !['active', 'disabled', 'removed', 'activation-failed'].includes(status))) throw new ForgeError('invalid-history', 'Retained plugin history has invalid activation metadata')
    let source: AiwSourceSnapshot | undefined
    if (value.source !== undefined) {
      const raw = object(value.source), files = object(raw.files)
      if (typeof raw.directory !== 'string' || !Object.values(files).every(text => typeof text === 'string')) throw new ForgeError('invalid-history', 'Retained plugin source fields are invalid')
      source = { directory: raw.directory, files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, String(text)])) }
      this.validateSource(source, manifest)
    }
    return { schema: 1, createdAt: value.createdAt, manifest,
      ...source === undefined ? {} : { source },
      ...status === undefined ? {} : { status: status as ForgeResult['status'] } }
  }
  private write(record: RevisionRecord): void {
    const directory = `${this.directory}/revisions/${record.manifest.plugin.id}`
    this.vfs.mkdirSync(directory, { recursive: true })
    const path = `${directory}/${record.manifest.revision}.json`, text = JSON.stringify(record)
    if (!this.vfs.existsSync(path) || this.vfs.readFileSync(path, 'utf8') !== text) this.vfs.writeFileSync(path, text)
  }
}
