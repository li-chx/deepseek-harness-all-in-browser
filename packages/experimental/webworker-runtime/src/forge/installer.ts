/** Applies complete plugin plans through VFS mutations and Cordis reconciliation. */
import { forgeSharedPackages } from './package-policy.ts'
import { forgeBundleEntry, hasForgeProfileEntry } from './profile-patch.ts'
import { sha256 } from '@noble/hashes/sha2.js'
import type Hmr from '@deepseek-ai/dsh-hmr'
import type { MemoryVfs } from '../storage/memory.ts'
import type { WorkerModuleLoader } from '../module-system/module-loader.ts'
import { dirname, join, pathToFileUrl } from '../module-system/posix-path.ts'
import { ForgeError, FORGE_GENERATION, parseForgeManifest, pluginId, object, type ForgeManifest, type ForgePackage, type ForgePackageExports } from './protocol.ts'

/** The current activation outcome; files may exist even when activation failed. */
export interface ForgeInstalled {
  pluginId: string
  revision: string
  name: string
  version: string
  status: 'active' | 'disabled' | 'activation-failed'
  message?: string
}

/** One update's separate application and activation facts. */
export interface ForgeResult {
  protocol: 1
  pluginId: string
  revision: string
  status: 'active' | 'disabled' | 'removed' | 'activation-failed'
  downloadedFiles: number
  writtenFiles: number
  observerErrors: string[]
  message?: string
}

/** Batch phases annotate ordinary VFS notifications; none implies persistence. */
export interface ForgeBatchEvent {
  pluginId: string
  revision: string
  phase: 'begin' | 'files-applied' | 'activation'
  paths: readonly string[]
  status?: ForgeResult['status']
}

/** Dependencies owned by one running Worker. */
export interface ForgeInstallerOptions {
  vfs: MemoryVfs
  modules: WorkerModuleLoader
  profileDirectory: string
  hostPackages: Readonly<Record<string, string>>
  /** Trusted page-shared versions; omission declares none. They never enter Host resolver scopes. */
  clientPackages?: Readonly<Record<string, string>>
  /** Additional trusted static specifiers owned by this Worker; never supplied by an install manifest. */
  staticSpecifiers?: readonly string[]
  hmr: Pick<Hmr, 'runExclusive' | 'reconcileProfile'>
  fetch: typeof fetch
  /** Inspect the live Loader entry rather than the last installer result. */
  isEntryActive(id: string, name: string): boolean
  /** Read native effective disablement; an inactive or missing fiber does not imply disablement. */
  isEntryDisabled(id: string, name: string): boolean
  /** Preserve unrelated YAML nodes and expressions; absence removes the managed row. */
  editPatch(text: string, id: string, entry: string | undefined): string
}

function digest(bytes: Uint8Array): string {
  return [...sha256(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function publicExports(exports: ForgePackageExports | undefined): { [key: string]: ForgePackageExports } {
  const subpaths = exports !== null && typeof exports === 'object' && !Array.isArray(exports)
    && Object.keys(exports).some(key => key.startsWith('.')) ? exports : {}
  return { ...subpaths, '.': './index.js' }
}

/** Plugin artifacts are owned by their manifest until explicitly replaced or removed. */
export class ForgeInstaller {
  private readonly manifests = new Map<string, ForgeManifest>()
  private readonly states = new Map<string, ForgeInstalled>()
  private readonly retired = new Map<string, ForgeManifest[]>()
  private readonly listeners = new Set<(event: ForgeBatchEvent) => void>()
  private readonly batches = new Map<string, ForgeBatchEvent>()
  private operations: Promise<unknown> = Promise.resolve()
  private closing = false
  private readonly directory: string
  private readonly clientPackages: Readonly<Record<string, string>>
  private readonly sharedPackages: readonly string[]
  private readonly hostPackages: Readonly<Record<string, string>>

  constructor(private readonly options: ForgeInstallerOptions) {
    this.directory = join(options.profileDirectory, 'plugins/.forge')
    this.clientPackages = Object.freeze({ ...options.clientPackages })
    this.hostPackages = Object.freeze({ ...options.hostPackages })
    this.sharedPackages = Object.freeze(forgeSharedPackages(this.hostPackages, this.clientPackages, options.staticSpecifiers))
  }

  /** Fixed image dependencies and the frontend's embedded generation.
   * @returns Target suitable for backend compatibility checks.
   */
  target(): {
    protocol: 1
    generation: string
    hostPackages: Readonly<Record<string, string>>
    clientPackages: Readonly<Record<string, string>>
    sharedPackages: readonly string[]
  } {
    return { protocol: 1, generation: FORGE_GENERATION, hostPackages: this.hostPackages,
      clientPackages: this.clientPackages, sharedPackages: this.sharedPackages }
  }

  /** Read activation state and the latest batch per plugin.
   * @returns Current in-memory installation information.
   */
  installed(): { protocol: 1; generation: string; plugins: ForgeInstalled[]; batches: ForgeBatchEvent[] } {
    return { protocol: 1, generation: FORGE_GENERATION,
      plugins: [...this.states.values()].map(state => this.currentState(state)), batches: [...this.batches.values()] }
  }

  /** Observe file application and activation independently from persistence.
   * @param listener Synchronous observer; exceptions are reported in the operation result.
   * @returns Remove this observer.
   */
  subscribe(listener: (event: ForgeBatchEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(event: ForgeBatchEvent, result: ForgeResult): void {
    this.batches.set(event.pluginId, event)
    for (const listener of this.listeners) {
      try { listener(event) }
      catch (error) { result.observerErrors.push(error instanceof Error ? error.message : String(error)) }
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ForgeError('closed', 'The Worker is stopping'))
    const task = this.operations.then(operation)
    this.operations = task.catch((error: unknown) => {
      // The caller receives this rejection; later independent requests may still run.
      void error
    })
    return task
  }

  /** Refuse new work and settle already accepted operations before host disposal.
   * @returns Resolution after updates and their observers have finished.
   */
  async close(): Promise<void> {
    this.closing = true
    await this.operations
    this.listeners.clear()
  }

  private packageDirectory(id: string): string { return join(this.directory, 'packages', id) }

  private ownedManifests(): ForgeManifest[] {
    return [...this.manifests.values(), ...[...this.retired.values()].flat()]
  }

  private mappings(): void {
    const scopes = new Map<string, Record<string, string>>()
    for (const manifest of this.ownedManifests()) {
      for (const pkg of manifest.packages) {
        const directory = this.packageDirectory(pkg.id)
        const dependencies = scopes.get(directory) ?? {}
        for (const name of pkg.hostDependencies) dependencies[name] = this.options.modules.packageDirectory(name)
        for (const [name, id] of Object.entries(pkg.dependencies)) dependencies[name] = this.packageDirectory(id)
        dependencies[pkg.name] = directory
        scopes.set(directory, dependencies)
      }
    }
    const profileDependencies: Record<string, string> = {}
    for (const name of Object.keys(this.hostPackages)) profileDependencies[name] = this.options.modules.packageDirectory(name)
    const subpathDirectories = new Map<string, string>()
    for (const manifest of this.manifests.values()) {
      const publicDirectory = join(this.options.profileDirectory, 'node_modules', manifest.plugin.name)
      const implementation = this.packageDirectory(manifest.plugin.packageId)
      profileDependencies[manifest.plugin.name] = publicDirectory
      const dependencies = scopes.get(implementation)
      if (dependencies === undefined) throw new Error('Forge root package scope is missing')
      scopes.set(publicDirectory, dependencies)
      subpathDirectories.set(publicDirectory, implementation)
    }
    scopes.set(this.options.profileDirectory, profileDependencies)
    this.options.modules.setPackageScopes(scopes)
    this.options.modules.setPackageAliases(new Map([...this.manifests.values()].map(manifest =>
      [manifest.plugin.name, join(this.options.profileDirectory, 'node_modules', manifest.plugin.name)])), subpathDirectories)
  }

  private patch(id: string, entry: string | undefined): { path: string; text: string } {
    const path = join(this.options.profileDirectory, 'cordis.patch.yml')
    const previous = this.options.vfs.existsSync(path) ? this.options.vfs.readFileSync(path, 'utf8') as string : '[]\n'
    return { path, text: this.options.editPatch(previous, `forge-${id}`, entry) }
  }

  private write(path: string, data: string | Uint8Array, result: ForgeResult, paths: string[]): void {
    const vfs = this.options.vfs
    if (vfs.existsSync(path)) {
      const previous = vfs.readFileSync(path) as Uint8Array
      const next = typeof data === 'string' ? new TextEncoder().encode(data) : data
      if (digest(previous) === digest(next)) return
    }
    vfs.mkdirSync(dirname(path), { recursive: true })
    vfs.writeFileSync(path, data)
    result.writtenFiles++
    paths.push(path)
  }

  private assertPackageOwnership(manifest: ForgeManifest): void {
    if (this.manifests.has(manifest.plugin.id)) return
    const name = manifest.plugin.name
    if (this.options.vfs.existsSync(join(this.options.profileDirectory, 'node_modules', name))) {
      throw new ForgeError('package-not-owned', `${name} already exists outside Forge ownership`)
    }
    const path = join(this.options.profileDirectory, 'package.json')
    if (!this.options.vfs.existsSync(path)) return
    const pkg = object(JSON.parse(this.options.vfs.readFileSync(path, 'utf8') as string))
    if (pkg.dependencies !== undefined && Object.hasOwn(object(pkg.dependencies), name)) {
      throw new ForgeError('package-not-owned', `${name} is already declared outside Forge ownership`)
    }
  }

  private profileManifest(): Record<string, unknown> {
    const path = join(this.options.profileDirectory, 'package.json')
    return this.options.vfs.existsSync(path) ? object(JSON.parse(this.options.vfs.readFileSync(path, 'utf8') as string)) : {}
  }

  private bundles(pkg: Record<string, unknown>): string[] {
    const dsh = pkg.dsh === undefined ? {} : object(pkg.dsh)
    const profile = dsh.profile === undefined ? {} : object(dsh.profile)
    if (profile.bundles === undefined) return []
    if (!Array.isArray(profile.bundles) || !profile.bundles.every((name): name is string => typeof name === 'string')) {
      throw new ForgeError('invalid-profile', 'Profile dsh.profile.bundles must contain package names')
    }
    return profile.bundles
  }

  private bundleEntry(manifest: ForgeManifest, prepared: ReadonlyMap<string, Uint8Array> = new Map()): string | undefined {
    const root = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
    const patch = root?.metadata?.dsh?.bundle?.patch
    if (root === undefined || patch === undefined) return undefined
    const file = root.files.find(file => file.path === patch.replace(/^\.\//, ''))
    if (file === undefined) throw new ForgeError('invalid-manifest', 'Bundle patch artifact is missing')
    const bytes = prepared.get(file.sha256) ?? this.options.vfs.readFileSync(join(this.packageDirectory(root.id), file.path))
    return forgeBundleEntry(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes), manifest.plugin.name)
  }

  private currentState(state: ForgeInstalled): ForgeInstalled {
    const manifest = this.manifests.get(state.pluginId)
    if (manifest === undefined) return state
    const bundle = this.bundleEntry(manifest)
    const enabled = bundle === undefined || this.bundles(this.profileManifest()).includes(state.name)
    const id = bundle ?? `forge-${state.pluginId}`
    const expectedActive = enabled && !this.options.isEntryDisabled(id, state.name)
    const active = this.options.isEntryActive(id, state.name)
    const status = expectedActive && active && state.status !== 'activation-failed' ? 'active' : !expectedActive && !active ? 'disabled' : 'activation-failed'
    const { message, ...rest } = state
    return { ...rest, status, ...(status === 'activation-failed' ? {
      message: message ?? (expectedActive ? 'The selected plugin is not active' : enabled ? 'The disabled plugin is still active' : 'The deselected plugin is still active'),
    } : {}) }
  }

  private profileDependency(name: string, version: string | undefined, selected?: boolean): { path: string; text: string } {
    const path = join(this.options.profileDirectory, 'package.json')
    const pkg = this.profileManifest()
    const dependencies = pkg.dependencies === undefined ? {} : object(pkg.dependencies)
    const updated = Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== name))
    if (version !== undefined) updated[name] = version
    if (selected !== undefined) {
      const dsh = pkg.dsh === undefined ? {} : object(pkg.dsh)
      const profile = dsh.profile === undefined ? {} : object(dsh.profile)
      const previous = this.bundles(pkg)
      const bundles = previous.filter((bundle, index) => bundle !== name || (selected && previous.indexOf(name) === index))
      if (selected && !bundles.includes(name)) bundles.push(name)
      pkg.dsh = { ...dsh, profile: { ...profile, bundles } }
    }
    return { path, text: JSON.stringify({ ...pkg, dependencies: updated }, null, 2) + '\n' }
  }

  private record(result: ForgeResult, paths: string[]): void {
    this.write(join(this.directory, 'installed.json'), JSON.stringify({ protocol: 1, generation: FORGE_GENERATION,
      plugins: [...this.states.values()], manifests: [...this.manifests.values()] }, null, 2) + '\n', result, paths)
  }

  private collect(previous: readonly ForgePackage[], paths: string[]): void {
    const retained = new Set(this.ownedManifests().flatMap(manifest => manifest.packages.map(pkg => pkg.id)))
    for (const pkg of previous) {
      if (retained.has(pkg.id)) continue
      const directory = this.packageDirectory(pkg.id)
      const urls = this.options.modules.hmrModules.records().filter(record => record.url.startsWith(pathToFileUrl(directory) + '/')).map(record => record.url)
      this.options.modules.hmrModules.invalidate(urls)
      this.options.vfs.rmSync(directory, { recursive: true, force: true })
      paths.push(directory)
    }
    this.mappings()
  }

  /** Download and verify all missing artifacts before applying one serialized update.
   * @param value Untrusted manifest JSON.
   * @param baseUrl Forge service URL used only for its artifact route.
   * @param signal Cancels before application when supplied; omission runs without cancellation. Committed batches finish reconciliation.
   * @returns Committed file counts and activation outcome; preflight failures reject without writes.
   */
  install(value: unknown, baseUrl: string, signal?: AbortSignal): Promise<ForgeResult> {
    return this.serial(async () => {
      signal?.throwIfAborted()
      const manifest = parseForgeManifest(value, this.hostPackages, this.clientPackages, this.sharedPackages)
      const duplicate = [...this.manifests.values()].find(item =>
        item.plugin.name === manifest.plugin.name && item.plugin.id !== manifest.plugin.id)
      if (duplicate !== undefined) throw new ForgeError('name-conflict', 'A plugin with this package name is already installed')
      const base = new URL(baseUrl)
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new ForgeError('invalid-url', 'Forge URL must use HTTP or HTTPS without credentials')
      const old = this.manifests.get(manifest.plugin.id)
      if (old !== undefined && old.plugin.name !== manifest.plugin.name) {
        throw new ForgeError('name-conflict', 'An installed plugin id cannot change its package name')
      }
      this.assertPackageOwnership(manifest)
      for (const existing of this.ownedManifests()) {
        for (const pkg of manifest.packages) {
          const known = existing.packages.find(candidate => candidate.id === pkg.id)
          if (known !== undefined && JSON.stringify(known) !== JSON.stringify(pkg)) throw new ForgeError('package-id-conflict', `Package ${pkg.id} has changed without changing its identity`)
        }
      }
      const result: ForgeResult = { protocol: 1, pluginId: manifest.plugin.id, revision: manifest.revision, status: 'active', downloadedFiles: 0, writtenFiles: 0, observerErrors: [] }
      const prepared = new Map<string, Uint8Array>()
      const localArtifacts = new Map<string, string>()
      for (const owned of this.ownedManifests()) {
        for (const pkg of owned.packages) {
          for (const file of pkg.files) localArtifacts.set(file.sha256, join(this.packageDirectory(pkg.id), file.path))
        }
      }
      for (const pkg of manifest.packages) {
        for (const file of pkg.files) {
          const path = join(this.packageDirectory(pkg.id), file.path)
          if (this.options.vfs.existsSync(path)) {
            const bytes = this.options.vfs.readFileSync(path) as Uint8Array
            if (bytes.byteLength === file.size && digest(bytes) === file.sha256) continue
          }
          let bytes = prepared.get(file.sha256)
          const local = localArtifacts.get(file.sha256)
          if (bytes === undefined && local !== undefined && this.options.vfs.existsSync(local)) {
            const candidate = this.options.vfs.readFileSync(local) as Uint8Array
            if (candidate.byteLength === file.size && digest(candidate) === file.sha256) {
              bytes = candidate
              prepared.set(file.sha256, bytes)
            }
          }
          if (bytes === undefined) {
            const response = await this.options.fetch(new URL(`/v1/artifacts/${file.objectKey}`, base), { ...(signal === undefined ? {} : { signal }) })
            if (!response.ok) throw new ForgeError('download-failed', `Artifact download returned HTTP ${response.status}`)
            bytes = new Uint8Array(await response.arrayBuffer())
            if (bytes.byteLength !== file.size || digest(bytes) !== file.sha256) throw new ForgeError('integrity-failed', `Artifact verification failed for ${file.path}`)
            prepared.set(file.sha256, bytes)
            result.downloadedFiles++
          }
        }
      }
      const bundle = this.bundleEntry(manifest, prepared)
      return this.options.hmr.runExclusive(async () => {
        signal?.throwIfAborted()
        // Revalidate at the mutation entry; no caller can install outside its fixed target.
        parseForgeManifest(manifest, this.hostPackages, this.clientPackages, this.sharedPackages)
        this.assertPackageOwnership(manifest)
        const publicDirectory = join(this.options.profileDirectory, 'node_modules', manifest.plugin.name)
        const entryPath = join(publicDirectory, 'index.js')
        const entry = manifest.plugin.name
        const implementation = join(this.packageDirectory(manifest.plugin.packageId), manifest.plugin.entry)
        const patchPath = join(this.options.profileDirectory, 'cordis.patch.yml')
        const previousPatch = this.options.vfs.existsSync(patchPath) ? this.options.vfs.readFileSync(patchPath, 'utf8') as string : '[]\n'
        const legacy = hasForgeProfileEntry(previousPatch, `forge-${manifest.plugin.id}`)
        const enabled = bundle === undefined || old === undefined || legacy || this.bundleEntry(old) === undefined
          || this.bundles(this.profileManifest()).includes(manifest.plugin.name)
        const patch = this.patch(manifest.plugin.id, bundle === undefined ? entry : undefined)
        const profilePackage = this.profileDependency(manifest.plugin.name, manifest.plugin.version,
          bundle === undefined ? old !== undefined && this.bundleEntry(old) !== undefined ? false : undefined : enabled)
        const paths: string[] = []
        this.publish({ pluginId: result.pluginId, revision: result.revision, phase: 'begin', paths: [] }, result)
        for (const pkg of manifest.packages) {
          for (const file of pkg.files) {
            const bytes = prepared.get(file.sha256)
            if (bytes !== undefined) this.write(join(this.packageDirectory(pkg.id), file.path), bytes, result, paths)
          }
          this.write(join(this.packageDirectory(pkg.id), 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.entry, ...pkg.metadata }), result, paths)
        }
        if (old !== undefined) this.retired.set(manifest.plugin.id, [...this.retired.get(manifest.plugin.id) ?? [], old])
        this.manifests.set(manifest.plugin.id, manifest)
        this.mappings()
        const rootPackage = manifest.packages.find(pkg => pkg.id === manifest.plugin.packageId)
        if (rootPackage === undefined) throw new ForgeError('invalid-manifest', 'Plugin package is missing')
        for (const file of rootPackage.files) {
          if (file.path === rootPackage.entry || file.path === 'index.js') continue
          const data = this.options.vfs.readFileSync(join(this.packageDirectory(rootPackage.id), file.path))
          this.write(join(publicDirectory, file.path), data, result, paths)
        }
        this.write(join(publicDirectory, 'package.json'), JSON.stringify({ name: rootPackage.name, version: rootPackage.version,
          main: 'index.js', ...rootPackage.metadata, exports: publicExports(rootPackage.metadata?.exports) }), result, paths)
        this.write(profilePackage.path, profilePackage.text, result, paths)
        this.write(entryPath, `module.exports = require(${JSON.stringify(implementation)});\n`, result, paths)
        this.write(patch.path, patch.text, result, paths)
        this.publish({ pluginId: result.pluginId, revision: result.revision, phase: 'files-applied', paths: [...paths] }, result)
        try {
          const activation = await this.options.hmr.reconcileProfile(enabled ? [bundle ?? `forge-${manifest.plugin.id}`] : [])
          if (activation.warnings.length) result.message = activation.warnings.join('\n')
          if (activation.pending.length || activation.restartReason) {
            throw new ForgeError('activation-failed', JSON.stringify(activation))
          }
          const id = bundle ?? `forge-${manifest.plugin.id}`
          const expectedActive = enabled && !this.options.isEntryDisabled(id, manifest.plugin.name)
          if (this.options.isEntryActive(id, manifest.plugin.name) !== expectedActive) {
            throw new ForgeError('activation-failed', expectedActive ? 'The selected plugin is not active'
              : enabled ? 'The disabled plugin is still active' : 'The deselected plugin is still active')
          }
          result.status = expectedActive ? 'active' : 'disabled'
        } catch (error) {
          result.status = 'activation-failed'
          result.message = error instanceof Error ? error.message : String(error)
        }
        this.states.set(manifest.plugin.id, { pluginId: manifest.plugin.id, revision: manifest.revision, name: manifest.plugin.name, version: manifest.plugin.version, status: result.status === 'active' || result.status === 'disabled' ? result.status : 'activation-failed', ...result.message === undefined ? {} : { message: result.message } })
        if (result.status === 'active' || result.status === 'disabled') {
          const currentFiles = new Set(rootPackage.files.filter(file => file.path !== rootPackage.entry).map(file => file.path))
          for (const previous of this.retired.get(manifest.plugin.id) ?? []) {
            const previousRoot = previous.packages.find(pkg => pkg.id === previous.plugin.packageId)
            for (const file of previousRoot?.files ?? []) {
              if (file.path === previousRoot?.entry || file.path === 'index.js' || currentFiles.has(file.path)) continue
              const obsolete = join(publicDirectory, file.path)
              this.options.vfs.rmSync(obsolete, { force: true })
              paths.push(obsolete)
            }
          }
          const retired = this.retired.get(manifest.plugin.id) ?? []
          this.retired.delete(manifest.plugin.id)
          this.collect(retired.flatMap(item => item.packages), paths)
        }
        this.record(result, paths)
        this.publish({ pluginId: result.pluginId, revision: result.revision, phase: 'activation', status: result.status, paths: [...paths] }, result)
        return result
      })
    })
  }

  /** Unload a plugin before deleting its unshared package files.
   * @param value Plugin identifier from the page.
   * @param signal Cancels before application when supplied; omission runs without cancellation. Committed removal finishes reconciliation.
   * @returns Removal result or activation failure with files retained.
   */
  remove(value: unknown, signal?: AbortSignal): Promise<ForgeResult> {
    return this.serial(() => this.options.hmr.runExclusive(async () => {
      signal?.throwIfAborted()
      const id = pluginId(value)
      const manifest = this.manifests.get(id)
      if (manifest === undefined) throw new ForgeError('not-installed', `Plugin ${id} is not installed`)
      const patch = this.patch(id, undefined)
      const profilePackage = this.profileDependency(manifest.plugin.name, undefined,
        this.bundleEntry(manifest) === undefined ? undefined : false)
      const paths: string[] = []
      const result: ForgeResult = { protocol: 1, pluginId: id, revision: manifest.revision, status: 'removed', downloadedFiles: 0, writtenFiles: 0, observerErrors: [] }
      this.publish({ pluginId: id, revision: manifest.revision, phase: 'begin', paths: [] }, result)
      this.write(patch.path, patch.text, result, paths)
      if (this.bundleEntry(manifest) !== undefined) {
        const deselected = this.profileDependency(manifest.plugin.name, manifest.plugin.version, false)
        this.write(deselected.path, deselected.text, result, paths)
      }
      this.publish({ pluginId: id, revision: manifest.revision, phase: 'files-applied', paths: [...paths] }, result)
      try {
        const activation = await this.options.hmr.reconcileProfile()
        if (activation.warnings.length) result.message = activation.warnings.join('\n')
        if (activation.pending.length || activation.restartReason) throw new ForgeError('activation-failed', JSON.stringify(activation))
        if (this.options.isEntryActive(this.bundleEntry(manifest) ?? `forge-${id}`, manifest.plugin.name)) {
          throw new ForgeError('activation-failed', 'The removed plugin is still active')
        }
      } catch (error) {
        result.status = 'activation-failed'
        result.message = error instanceof Error ? error.message : String(error)
      }
      if (result.status === 'removed') {
        this.manifests.delete(id)
        this.states.delete(id)
        const publicDirectory = join(this.options.profileDirectory, 'node_modules', manifest.plugin.name)
        const entryPath = join(publicDirectory, 'index.js')
        this.options.modules.hmrModules.invalidate([pathToFileUrl(entryPath)])
        this.options.vfs.rmSync(publicDirectory, { recursive: true, force: true })
        paths.push(publicDirectory)
        this.write(profilePackage.path, profilePackage.text, result, paths)
        const retired = this.retired.get(id) ?? []
        this.retired.delete(id)
        this.collect([...manifest.packages, ...retired.flatMap(item => item.packages)], paths)
      } else {
        this.states.set(id, { pluginId: id, revision: manifest.revision, name: manifest.plugin.name, version: manifest.plugin.version, status: 'activation-failed', ...result.message === undefined ? {} : { message: result.message } })
      }
      this.record(result, paths)
      this.publish({ pluginId: id, revision: manifest.revision, phase: 'activation', status: result.status, paths: [...paths] }, result)
      return result
    }))
  }
}
