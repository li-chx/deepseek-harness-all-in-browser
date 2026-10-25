/** Validated installed artifact ownership and pre-boot module resolution. */
import { sha256 } from '@noble/hashes/sha2.js'
import type { MemoryVfs } from '../storage/memory.ts'
import type { WorkerModuleLoader } from '../module-system/module-loader.ts'
import { join } from '../module-system/posix-path.ts'
import { forgeSharedPackages } from './package-policy.ts'
import { forgeBundleEntry } from './profile-patch.ts'
import { ForgeError, FORGE_GENERATION, object, parseForgeManifest, type ForgeManifest, type ForgePackageExports } from './protocol.ts'

/** Files applied to the profile, independently of any process's activation outcome. */
export interface ForgeCatalog {
  schema: 1
  generation: string
  phase: 'applied'
  manifests: ForgeManifest[]
  retired: ForgeManifest[]
}

/**
 * Construct the persisted ownership record; activation is recomputed on every boot.
 * @param manifests Current plugin plans.
 * @param retired Plans whose files remain owned until their consumers are disposed.
 * @returns Serializable schema-versioned catalog.
 */
export function forgeCatalog(manifests: ForgeManifest[], retired: ForgeManifest[]): ForgeCatalog {
  return { schema: 1, generation: FORGE_GENERATION, phase: 'applied', manifests, retired }
}

/**
 * Point native root loading at the stable wrapper while retaining declared subpaths.
 * @param exports Original immutable package exports.
 * @returns Public profile package exports.
 */
export function forgePublicExports(exports: ForgePackageExports | undefined): { [key: string]: ForgePackageExports } {
  const subpaths = exports !== null && typeof exports === 'object' && !Array.isArray(exports)
    && Object.keys(exports).some(key => key.startsWith('.')) ? exports : {}
  return { ...subpaths, '.': './index.js' }
}

/**
 * Validate a persisted catalog and all owned artifacts before loading any plugin code.
 * @param vfs Restored filesystem.
 * @param profileDirectory Fixed profile selected by the base image.
 * @param hostPackages Trusted base-image versions.
 * @param clientPackages Trusted page singleton versions.
 * @param staticSpecifiers Trusted Worker module substitutes.
 * @returns Verified ownership, or an empty catalog when none exists.
 * @throws If saved ownership, generation, package metadata, or artifact integrity is invalid; no files are changed.
 */
export function readForgeCatalog(vfs: MemoryVfs, profileDirectory: string,
  hostPackages: Readonly<Record<string, string>>, clientPackages: Readonly<Record<string, string>> = {},
  staticSpecifiers: readonly string[] = []): ForgeCatalog {
  const directory = join(profileDirectory, 'plugins/.forge')
  const path = join(directory, 'installed.json')
  if (!vfs.existsSync(path)) return forgeCatalog([], [])
  try {
    const value = object(JSON.parse(vfs.readFileSync(path, 'utf8') as string))
    if (value.schema !== 1 || value.generation !== FORGE_GENERATION || value.phase !== 'applied'
      || !Array.isArray(value.manifests) || !Array.isArray(value.retired)) {
      throw new ForgeError('invalid-catalog', 'Saved Forge catalog schema or generation is incompatible')
    }
    const shared = forgeSharedPackages(hostPackages, clientPackages, staticSpecifiers)
    const manifests = value.manifests.map(item => parseForgeManifest(item, hostPackages, clientPackages, shared))
    const retired = value.retired.map(item => parseForgeManifest(item, hostPackages, clientPackages, shared))
    const ids = new Set<string>()
    const names = new Set<string>()
    for (const manifest of manifests) {
      if (ids.has(manifest.plugin.id) || names.has(manifest.plugin.name)) throw new ForgeError('invalid-catalog', 'Duplicate installed plugin identity')
      ids.add(manifest.plugin.id)
      names.add(manifest.plugin.name)
    }
    for (const previous of retired) {
      if (!manifests.some(item => item.plugin.id === previous.plugin.id && item.plugin.name === previous.plugin.name)) {
        throw new ForgeError('invalid-catalog', 'Retired artifacts have no installed owner')
      }
    }
    const packages = new Map<string, string>()
    const verify = (path: string, expected: string): void => {
      if (!vfs.existsSync(path) || vfs.readFileSync(path, 'utf8') !== expected) throw new ForgeError('invalid-catalog', `Saved Forge metadata differs: ${path}`)
    }
    for (const manifest of [...manifests, ...retired]) {
      for (const pkg of manifest.packages) {
        const identity = JSON.stringify(pkg)
        const known = packages.get(pkg.id)
        if (known !== undefined && known !== identity) throw new ForgeError('invalid-catalog', `Conflicting saved package identity: ${pkg.id}`)
        if (known !== undefined) continue
        packages.set(pkg.id, identity)
        const packageDirectory = join(directory, 'packages', pkg.id)
        for (const file of pkg.files) {
          const path = join(packageDirectory, file.path)
          if (!vfs.existsSync(path)) throw new ForgeError('invalid-catalog', `Saved Forge artifact is missing: ${path}`)
          const bytes = vfs.readFileSync(path) as Uint8Array
          const hash = [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
          if (bytes.byteLength !== file.size || hash !== file.sha256) throw new ForgeError('invalid-catalog', `Saved Forge artifact failed verification: ${path}`)
        }
        verify(join(packageDirectory, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.entry, ...pkg.metadata }))
      }
      const root = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
      if (root === undefined) throw new ForgeError('invalid-catalog', 'Installed plugin package is missing')
      const patch = root.metadata?.dsh?.bundle?.patch
      if (patch !== undefined) forgeBundleEntry(vfs.readFileSync(join(directory, 'packages', root.id, patch), 'utf8') as string, root.name)
    }
    for (const manifest of manifests) {
      const root = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
      if (root === undefined) throw new ForgeError('invalid-catalog', 'Installed plugin package is missing')
      const publicDirectory = join(profileDirectory, 'node_modules', root.name)
      const implementation = join(directory, 'packages', root.id, root.entry)
      verify(join(publicDirectory, 'index.js'), `module.exports = require(${JSON.stringify(implementation)});\n`)
      verify(join(publicDirectory, 'package.json'), JSON.stringify({ name: root.name, version: root.version,
        main: 'index.js', ...root.metadata, exports: forgePublicExports(root.metadata?.exports) }))
      for (const file of root.files) {
        if (file.path === root.entry || file.path === 'index.js') continue
        const path = join(publicDirectory, file.path)
        if (!vfs.existsSync(path)) throw new ForgeError('invalid-catalog', `Saved public artifact is missing: ${path}`)
        const bytes = vfs.readFileSync(path) as Uint8Array
        const hash = [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
        if (bytes.byteLength !== file.size || hash !== file.sha256) throw new ForgeError('invalid-catalog', `Saved public artifact failed verification: ${path}`)
      }
    }
    return forgeCatalog(manifests, retired)
  } catch (error) {
    if (error instanceof ForgeError) throw error
    throw new ForgeError('invalid-catalog', `Cannot restore Forge catalog: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Publish importer grants and stable aliases before profile composition or after an update.
 * @param modules This Worker's loader.
 * @param profileDirectory Profile owning the saved artifacts.
 * @param hostPackages Trusted base-image inventory for profile-level resolution.
 * @param catalog Validated current and retained manifests.
 */
export function applyForgeMappings(modules: WorkerModuleLoader, profileDirectory: string,
  hostPackages: Readonly<Record<string, string>>, catalog: ForgeCatalog): void {
  const packageDirectory = (id: string): string => join(profileDirectory, 'plugins/.forge/packages', id)
  const scopes = new Map<string, Record<string, string>>()
  for (const manifest of [...catalog.manifests, ...catalog.retired]) {
    for (const pkg of manifest.packages) {
      const directory = packageDirectory(pkg.id)
      const dependencies = scopes.get(directory) ?? {}
      for (const name of pkg.hostDependencies) dependencies[name] = modules.packageDirectory(name)
      for (const [name, id] of Object.entries(pkg.dependencies)) dependencies[name] = packageDirectory(id)
      dependencies[pkg.name] = directory
      scopes.set(directory, dependencies)
    }
  }
  const profileDependencies: Record<string, string> = {}
  for (const name of Object.keys(hostPackages)) profileDependencies[name] = modules.packageDirectory(name)
  const subpathDirectories = new Map<string, string>()
  for (const manifest of catalog.manifests) {
    const publicDirectory = join(profileDirectory, 'node_modules', manifest.plugin.name)
    const implementation = packageDirectory(manifest.plugin.packageId)
    profileDependencies[manifest.plugin.name] = publicDirectory
    const dependencies = scopes.get(implementation)
    if (dependencies === undefined) throw new Error('Forge root package scope is missing')
    scopes.set(publicDirectory, dependencies)
    subpathDirectories.set(publicDirectory, implementation)
  }
  scopes.set(profileDirectory, profileDependencies)
  modules.setPackageScopes(scopes)
  modules.setPackageAliases(new Map(catalog.manifests.map(manifest =>
    [manifest.plugin.name, join(profileDirectory, 'node_modules', manifest.plugin.name)])), subpathDirectories)
}
