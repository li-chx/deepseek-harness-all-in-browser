/** Module records supplied by a host that owns its loader instead of using Node's module caches. */
export interface ReloadableModule {
  /** Canonical file URL used by the loader and filesystem watcher. */
  readonly url: string
  /** Current exports; only completed modules can supply a running plugin. */
  readonly exports: unknown
  /** Whether module evaluation completed successfully. */
  readonly loaded: boolean
  /** File URLs requested by this module, including requests served from cache. */
  readonly dependencies: readonly string[]
}

/** Host-owned module inspection and invalidation used by profile HMR. */
export interface HmrModuleSource {
  /**
   * Inspect the modules retained by this loader.
   * @returns A snapshot of evaluated, evaluating and failed module records.
   */
  records(): readonly ReloadableModule[]
  /**
   * Identify code that cannot be replaced within this host.
   * @returns Modules retained by the host bootstrap that require a host restart.
   */
  protectedUrls(): readonly string[]
  /**
   * Evict the selected modules and cached package metadata before Loader imports their replacements.
   * The caller owns dependency closure and serializes this operation with plugin teardown and activation.
   * @param urls - Canonical module URLs to evict.
   * @throws If a protected module is selected; no records may be removed in that case.
   */
  invalidate(urls: readonly string[]): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional host module provider; absent hosts use Node's native module caches. */
    hmrModules: HmrModuleSource
  }
}
