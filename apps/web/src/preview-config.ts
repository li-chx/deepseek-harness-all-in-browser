/** Resolve public build defaults without changing the preview's browser URL. */

/** Build defaults for the preview's existing query parameters. */
export type PreviewDefaults = Readonly<Record<'preview-fixture' | 'forge' | 'storage', string | undefined>>

/**
 * Fill absent query parameters from nonempty build defaults.
 * @param page - Browser URL, preserved unchanged.
 * @param defaults - Public build values; empty values leave the existing startup behavior intact.
 * @returns Effective URL for source selection, Forge seeding and storage configuration.
 */
export function previewPageUrl(page: URL, defaults: PreviewDefaults): URL {
  const effective = new URL(page)
  for (const [name, value] of Object.entries(defaults)) {
    if (!effective.searchParams.has(name) && value !== undefined && value !== '') effective.searchParams.set(name, value)
  }
  return effective
}
