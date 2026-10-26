/** Explicit Worker-local source selection for Forge's source build endpoint. */
import { resolve } from '../module-system/posix-path.ts'
import type { ShellFileSystem } from '../shell/types.ts'
import { ForgeError, object, pluginId } from './protocol.ts'

/** Source payload supported by the build service; runtime target fields come from the host. */
export interface ForgeSourcePlugin {
  id: string
  name: string
  version: string
  entry: string
  files: Record<string, string>
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
function fail(message: string): never { throw new ForgeError('invalid-source', `forge.json: ${message}`) }
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a nonempty string`)
  return value
}
function sourcePath(value: unknown): string {
  const path = text(value, 'source path')
  const segments = path.split('/')
  if (!segments.every(part => /^[a-zA-Z0-9_@.+-]+$/.test(part) && part !== '.' && part !== '..'
    && part !== 'node_modules' && !part.startsWith('.env')) || path === 'package.json') fail(`unsafe or reserved source path ${path}`)
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(path) || /\.d\.[cm]?tsx?$/.test(path)) fail(`unsupported source file ${path}; use runtime JS, TS or JSON files`)
  return path
}
function dependencies(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(object(value)).map(([name, range]) => {
    if (!packageName.test(name) || typeof range !== 'string') fail(`${field} must map npm package names to version strings`)
    return [name, range]
  }))
}
function peerMetadata(value: unknown): Record<string, { optional?: boolean }> | undefined {
  if (value === undefined) return undefined
  return Object.fromEntries(Object.entries(object(value)).map(([name, metadata]) => {
    const fields = object(metadata)
    if (!packageName.test(name) || Object.keys(fields).some(key => key !== 'optional')
      || (fields.optional !== undefined && typeof fields.optional !== 'boolean')) fail('peerDependenciesMeta requires package names and optional boolean flags')
    return [name, fields.optional === undefined ? {} : { optional: fields.optional }]
  }))
}

/**
 * Read only explicitly listed sources, after validating every descriptor field.
 * @param directory - Absolute directory or path relative to the invocation's working directory.
 * @param cwd - Invocation working directory.
 * @param filesystem - Invocation-owned filesystem; no ambient filesystem is used.
 * @param signal - Cancellation checked around every filesystem await.
 * @returns Selected source contents ready for the source build request.
 */
export async function readForgeSource(
  directory: string, cwd: string, filesystem: ShellFileSystem, signal: AbortSignal,
): Promise<ForgeSourcePlugin> {
  signal.throwIfAborted()
  if (!directory || directory.includes('\\') || directory.includes('\0')) fail('invalid build directory')
  const root = resolve(cwd, directory)
  const directoryStat = await filesystem.stat(root)
  signal.throwIfAborted()
  if (!directoryStat?.directory) fail('build directory does not exist or is not a directory')
  const descriptorPath = resolve(root, 'forge.json')
  const descriptorStat = await filesystem.stat(descriptorPath)
  signal.throwIfAborted()
  if (!descriptorStat || descriptorStat.directory) fail('expected a regular forge.json file in the build directory')
  const descriptorText = await filesystem.readText(descriptorPath)
  signal.throwIfAborted()
  let parsed: unknown
  try { parsed = JSON.parse(descriptorText) }
  catch (error) { throw new ForgeError('invalid-source', `forge.json: invalid JSON (${error instanceof Error ? error.message : 'parse failed'})`) }
  const descriptor = object(parsed)
  const allowed = new Set(['id', 'name', 'version', 'entry', 'files', 'dependencies', 'peerDependencies', 'peerDependenciesMeta'])
  if (Object.keys(descriptor).some(field => !allowed.has(field))) fail('unexpected descriptor field; protocol and generation are supplied by the host')
  const id = pluginId(descriptor.id)
  const name = text(descriptor.name, 'name')
  if (!packageName.test(name)) fail('name must be an npm package name')
  const version = text(descriptor.version, 'version')
  const entry = sourcePath(descriptor.entry)
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0 || descriptor.files.length > 1000) fail('files must list 1–1000 source paths')
  const paths = descriptor.files.map(sourcePath)
  if (new Set(paths).size !== paths.length) fail('files must not contain duplicate paths')
  if (!paths.includes(entry)) fail('entry must appear in files')
  const dependencyMap = dependencies(descriptor.dependencies, 'dependencies')
  const peers = dependencies(descriptor.peerDependencies, 'peerDependencies')
  const metadata = peerMetadata(descriptor.peerDependenciesMeta)
  const selected: Array<[string, string]> = []
  for (const path of paths) {
    const absolute = resolve(root, path)
    const stat = await filesystem.stat(absolute)
    signal.throwIfAborted()
    if (!stat || stat.directory) fail(`selected source is missing or is not a regular file: ${path}`)
    const contents = await filesystem.readText(absolute)
    signal.throwIfAborted()
    selected.push([path, contents])
  }
  return { id, name, version, entry, files: Object.fromEntries(selected), dependencies: dependencyMap, peerDependencies: peers,
    ...(metadata === undefined ? {} : { peerDependenciesMeta: metadata }) }
}
