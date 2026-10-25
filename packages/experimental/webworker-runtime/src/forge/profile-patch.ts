/** YAML edits preserve profile rows and tagged expressions outside the managed plugin entry. */
import { isMap, isSeq, isScalar, parseDocument } from 'yaml'
import { ForgeError, object, pluginId } from './protocol.ts'

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

/** Read the supported published bundle's native Loader entry identifier.
 * @param text Verified bundle patch artifact.
 * @param name Published package name the entry must load.
 * @returns Native entry id required during profile reconciliation.
 */
export function forgeBundleEntry(text: string, name: string): string {
  const document = parseDocument(text)
  if (document.errors.length || document.warnings.length) throw new ForgeError('unsupported-bundle', 'Bundle patch must contain one literal insert')
  const rows: unknown = document.toJSON()
  if (!Array.isArray(rows) || rows.length !== 1) throw new ForgeError('unsupported-bundle', 'Bundle patch must contain one insert')
  const row = object(rows[0])
  if (Object.keys(row).length !== 1 || !Array.isArray(row.insert) || row.insert.length !== 1) {
    throw new ForgeError('unsupported-bundle', 'Bundle patch must contain one inserted entry')
  }
  const entry = object(row.insert[0])
  if (Object.keys(entry).length !== 2 || entry.name !== name) throw new ForgeError('unsupported-bundle', 'Bundle entry must load its published package')
  return pluginId(entry.id)
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
