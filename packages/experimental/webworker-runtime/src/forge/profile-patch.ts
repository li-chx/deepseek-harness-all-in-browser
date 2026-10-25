/** YAML edits preserve profile rows and tagged expressions outside the managed plugin entry. */
import { isAlias, isMap, isSeq, isScalar, parseDocument, visit } from 'yaml'
import { ForgeError, pluginId } from './protocol.ts'

/** Insert, replace or remove one Forge-owned Loader registration.
 * @param text Existing profile patch document.
 * @param id Stable Forge-owned entry id.
 * @param entry Module reference to activate, or undefined to remove its registration.
 * @returns Updated YAML with unrelated nodes retained.
 */
export function editForgeProfilePatch(text: string, id: string, entry: string | undefined): string {
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (document.errors.length) throw new ForgeError('invalid-profile', document.errors[0]?.message ?? 'Invalid YAML')
  if (!isSeq(document.contents)) throw new ForgeError('invalid-profile', 'Profile patch must be a YAML sequence')
  for (let index = document.contents.items.length - 1; index >= 0; index--) {
    const row = document.contents.items[index]
    if (!isMap(row)) continue
    const inserted = row.get('insert')
    if (isSeq(inserted)) {
      for (let child = inserted.items.length - 1; child >= 0; child--) {
        const item = inserted.items[child]
        if (isMap(item) && isScalar(item.get('id', true)) && item.get('id', true)?.toJSON() === id) inserted.delete(child)
      }
      if (inserted.items.length === 0 && row.items.length === 1) document.delete(index)
    } else if (isScalar(row.get('id', true)) && row.get('id', true)?.toJSON() === id) {
      throw new ForgeError('profile-conflict', `Profile contains an override of managed row ${id}; remove it before changing this plugin`)
    }
  }
  if (entry !== undefined) document.add({ insert: [{ id, name: entry }] })
  return String(document)
}

/** Read a published self-loading entry with optional literal configuration.
 * @param text Verified bundle patch artifact; its bytes are retained unchanged during installation.
 * @param name Published package name the entry must load.
 * @returns Native entry id required during profile reconciliation.
 */
export function forgeBundleEntry(text: string, name: string): string {
  const document = parseDocument(text)
  if (document.errors.length || document.warnings.length) {
    throw new ForgeError('unsupported-bundle', 'Bundle patch must be valid literal YAML without unsupported tags')
  }
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new ForgeError('unsupported-bundle', 'Bundle patch cannot contain YAML aliases')
    if (isScalar(node) || isMap(node) || isSeq(node)) {
      if (node.tag !== undefined && !/^tag:yaml\.org,2002:(?:null|bool|int|float|str|map|seq)$/.test(node.tag)) {
        throw new ForgeError('unsupported-bundle', `Bundle patch contains unsupported YAML tag ${node.tag}`)
      }
    }
    if (isMap(node) && node.items.some(item => !isScalar(item.key) || typeof item.key.value !== 'string')) {
      throw new ForgeError('unsupported-bundle', 'Bundle patch object keys must be strings')
    }
  })
  const rows: unknown = document.toJSON()
  if (!Array.isArray(rows) || rows.length !== 1) throw new ForgeError('unsupported-bundle', 'Bundle patch must contain one insert')
  const row = bundleObject(rows[0], 'Bundle patch row')
  if (Object.keys(row).some(key => key !== 'insert') || !Array.isArray(row.insert) || row.insert.length !== 1) {
    throw new ForgeError('unsupported-bundle', 'Bundle patch must contain one inserted entry and no other patch operations')
  }
  const entry = bundleObject(row.insert[0], 'Bundle entry')
  for (const key of Object.keys(entry)) {
    if (!['id', 'name', 'config'].includes(key)) {
      throw new ForgeError('unsupported-bundle', `Bundle entry field ${key} is not supported`)
    }
  }
  if (entry.name !== name) throw new ForgeError('unsupported-bundle', 'Bundle entry must load its published package')
  if ('config' in entry) validateLiteral(entry.config)
  return pluginId(entry.id)
}

function bundleObject(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ForgeError('unsupported-bundle', `${subject} must be a literal object`)
  }
  return value as Record<string, unknown>
}

function validateLiteral(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    for (const item of value) validateLiteral(item)
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) validateLiteral(item)
    return
  }
  throw new ForgeError('unsupported-bundle', 'Bundle entry config must contain only JSON literals with finite numbers')
}

/** Identify a legacy Forge registration that needs migration to native bundle selection.
 * @param text Current profile patch.
 * @param id Managed Forge entry id.
 * @returns Whether the patch contains that inserted entry.
 */
export function hasForgeProfileEntry(text: string, id: string): boolean {
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || !isSeq(document.contents)) throw new ForgeError('invalid-profile', 'Profile patch must be a YAML sequence')
  return document.contents.items.some((row) => {
    if (!isMap(row)) return false
    const insert = row.get('insert')
    return isSeq(insert) && insert.items.some(item => isMap(item) && isScalar(item.get('id', true)) && item.get('id', true)?.toJSON() === id)
  })
}
