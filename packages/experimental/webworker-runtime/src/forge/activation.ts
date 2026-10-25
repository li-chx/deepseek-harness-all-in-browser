/** Live entry checks use Cordis's numeric state without requiring an erased const enum. */
import type { FiberState } from '@deepseek-ai/cordis'

interface EntryState {
  options: { id?: string; name?: string }
  fiber?: { state: FiberState }
}

// Cordis artifacts erase this enum; the member type keeps its numeric value checked.
const ACTIVE_FIBER_STATE: FiberState.ACTIVE = 2

/** Inspect an entry in the running native Loader tree.
 * @param loader Native Loader registry owned by this Worker.
 * @param id Profile entry id, before the enclosing include prefix.
 * @param name Exact module reference declared by the profile.
 * @returns Whether a matching entry has an active fiber.
 */
export function isForgeEntryActive(loader: { entries(): Iterable<EntryState> }, id: string, name: string): boolean {
  return [...loader.entries()].some(entry => entry.options.id === id
    && entry.options.name === name && entry.fiber?.state === ACTIVE_FIBER_STATE)
}
