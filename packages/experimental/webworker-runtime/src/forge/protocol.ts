/** Wire validation for plugin artifacts targeting this Worker build. */
export const FORGE_GENERATION = 'dsh-worker-rc2-5'

/** Immutable file served by Forge. */
export interface ForgeFile {
  path: string
  sha256: string
  size: number
  objectKey: string
}

/** Published entry metadata retained for Host and Client discovery. */
export interface ForgePackageMetadata {
  repository?: string | { url: string }
  exports?: Record<string, string>
  dsh?: { bundle?: { patch: string }; client?: { inject: string[]; platform: 'web' } }
}

/** One package instance with importer-specific dependency resolution. */
export interface ForgePackage {
  id: string
  name: string
  version: string
  entry: string
  dependencies: Record<string, string>
  files: ForgeFile[]
  metadata?: ForgePackageMetadata
}

/** Complete install plan returned by the build service. */
export interface ForgeManifest {
  protocol: 1
  generation: string
  revision: string
  plugin: { id: string; name: string; version: string; packageId: string; entry: string }
  hostPackages: Record<string, string>
  /** Required page-shared versions; absence requires none and grants no Host imports. */
  clientPackages?: Record<string, string>
  packages: ForgePackage[]
}

/** Refusal before mutation or a failed download. */
export class ForgeError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** Narrow an untrusted JSON object.
 * @param value Decoded JSON.
 * @returns Object fields.
 */
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ForgeError('invalid-manifest', 'Expected an object')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ForgeError('invalid-manifest', 'Expected a nonempty string')
  return value
}

/** Parse a path-safe plugin identifier.
 * @param value Untrusted id.
 * @returns Validated identifier.
 */
export function pluginId(value: unknown): string {
  const id = text(value)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new ForgeError('invalid-id', 'Plugin id must contain letters, digits, hyphens or underscores')
  return id
}

function path(value: unknown): string {
  const result = text(value)
  if (!result.split('/').every(part => /^[a-zA-Z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..')) {
    throw new ForgeError('invalid-path', `Unsupported artifact path: ${result}`)
  }
  return result
}

function hash(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ForgeError('invalid-manifest', 'Expected a SHA-256 digest')
  return result
}

function mapping(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([key, value]) => [key, text(value)]))
}

/** Validate all files, dependency references and the fixed host package set before installation.
 * @param value Decoded service response.
 * @param hostPackages Exact versions supplied by the base image.
 * @param clientPackages Exact page-shared versions supplied by the base image; absent means none.
 * @returns Validated install plan.
 */
export function parseForgeManifest(value: unknown, hostPackages: Readonly<Record<string, string>>,
  clientPackages: Readonly<Record<string, string>> = {}): ForgeManifest {
  const raw = object(value)
  if (raw.protocol !== 1 || raw.generation !== FORGE_GENERATION) throw new ForgeError('generation-mismatch', 'Rebuild the plugin for this frontend generation')
  const plugin = object(raw.plugin)
  const requiredHost = mapping(raw.hostPackages)
  for (const [name, version] of Object.entries(requiredHost)) {
    if (hostPackages[name] !== version) throw new ForgeError('host-version-mismatch', `Host package ${name} requires ${version}`)
  }
  const requiredClient = raw.clientPackages === undefined ? undefined : mapping(raw.clientPackages)
  for (const [name, version] of Object.entries(requiredClient ?? {})) {
    if (clientPackages[name] !== version) throw new ForgeError('client-version-mismatch', `Client package ${name} requires ${version}`)
  }
  if (!Array.isArray(raw.packages) || raw.packages.length === 0) throw new ForgeError('invalid-manifest', 'No packages supplied')
  const packages = raw.packages.map((value): ForgePackage => {
    const pkg = object(value)
    const name = text(pkg.name)
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new ForgeError('invalid-manifest', 'Invalid package name')
    if (Object.hasOwn(hostPackages, name) || Object.hasOwn(clientPackages, name) || name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-') || name.startsWith('@deepseek-ai/cordis')) {
      throw new ForgeError('core-package', `The frontend owns ${name}; plugins cannot replace it`)
    }
    if (!Array.isArray(pkg.files)) throw new ForgeError('invalid-manifest', 'Package files are missing')
    const files = pkg.files.map((value): ForgeFile => {
      const file = object(value)
      const sha256 = hash(file.sha256)
      if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) throw new ForgeError('invalid-manifest', 'Invalid file size')
      if (file.objectKey !== `${FORGE_GENERATION}/objects/${sha256}`) throw new ForgeError('invalid-path', 'Artifact key must address its digest in this generation')
      return { path: path(file.path), sha256, size: file.size, objectKey: file.objectKey }
    })
    if (new Set(files.map(file => file.path)).size !== files.length || files.some(file => file.path === 'package.json')) {
      throw new ForgeError('invalid-manifest', 'Duplicate or reserved package file')
    }
    const entry = path(pkg.entry)
    if (!files.some(file => file.path === entry)) throw new ForgeError('invalid-manifest', 'Package entry is missing')
    const metadata = pkg.metadata === undefined ? undefined : parseMetadata(pkg.metadata, files)
    return { id: pluginId(pkg.id), name, version: text(pkg.version), entry, dependencies: mapping(pkg.dependencies), files,
      ...metadata === undefined ? {} : { metadata } }
  })
  const objectSizes = new Map<string, number>()
  for (const pkg of packages) for (const file of pkg.files) {
    const size = objectSizes.get(file.sha256)
    if (size !== undefined && size !== file.size) throw new ForgeError('invalid-manifest', 'One object digest has conflicting file sizes')
    objectSizes.set(file.sha256, file.size)
  }
  const byId = new Map(packages.map(pkg => [pkg.id, pkg]))
  if (byId.size !== packages.length) throw new ForgeError('invalid-manifest', 'Duplicate package id')
  for (const pkg of packages) {
    for (const [name, id] of Object.entries(pkg.dependencies)) {
      if (Object.hasOwn(hostPackages, name) || Object.hasOwn(clientPackages, name)) {
        throw new ForgeError('core-package', `Shared dependency ${name} cannot be remapped`)
      }
      if (byId.get(id)?.name !== name) throw new ForgeError('invalid-manifest', `Missing dependency ${name}`)
    }
    for (const left of pkg.files) {
      if (pkg.files.some(right => right.path.startsWith(`${left.path}/`))) throw new ForgeError('invalid-path', 'A package file cannot also be a directory')
    }
  }
  const packageId = pluginId(plugin.packageId)
  const entry = path(plugin.entry)
  const primary = byId.get(packageId)
  if (primary === undefined || primary.name !== plugin.name || primary.version !== plugin.version || primary.entry !== entry) {
    throw new ForgeError('invalid-manifest', 'Plugin entry does not match its package')
  }
  return {
    protocol: 1, generation: FORGE_GENERATION, revision: hash(raw.revision),
    plugin: { id: pluginId(plugin.id), name: text(plugin.name), version: text(plugin.version), packageId, entry },
    hostPackages: requiredHost, packages, ...requiredClient === undefined ? {} : { clientPackages: requiredClient },
  }
}

function parseMetadata(value: unknown, files: ForgeFile[]): ForgePackageMetadata {
  const raw = object(value)
  const metadata: ForgePackageMetadata = {}
  if (raw.repository !== undefined) metadata.repository = typeof raw.repository === 'string' ? raw.repository : { url: text(object(raw.repository).url) }
  const filePath = (value: unknown): string => {
    const target = text(value).replace(/^\.\//, '')
    path(target)
    if (target !== 'package.json' && !files.some(file => file.path === target)) throw new ForgeError('invalid-manifest', 'Metadata points at a missing file')
    return target
  }
  if (raw.exports !== undefined) {
    metadata.exports = Object.fromEntries(Object.entries(mapping(raw.exports)).map(([key, value]) => {
      if (key !== '.') { if (!key.startsWith('./')) throw new ForgeError('invalid-manifest', 'Invalid export key'); path(key.slice(2)) }
      return [key, `./${filePath(value)}`]
    }))
  }
  if (raw.dsh !== undefined) {
    const dsh = object(raw.dsh)
    metadata.dsh = {}
    if (dsh.bundle !== undefined) metadata.dsh.bundle = { patch: filePath(object(dsh.bundle).patch) }
    if (dsh.client !== undefined) {
      const client = object(dsh.client)
      if (client.platform !== 'web' || !Array.isArray(client.inject) || !client.inject.every(value => typeof value === 'string')) throw new ForgeError('invalid-manifest', 'Invalid Client metadata')
      metadata.dsh.client = { platform: 'web', inject: client.inject }
    }
  }
  return metadata
}
