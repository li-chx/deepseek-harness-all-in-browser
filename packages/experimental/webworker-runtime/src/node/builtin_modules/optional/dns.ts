/**
 * Optional DNS namespace for plugins that can continue without native DNS.
 * Browsers own address resolution and result ordering; every operation here
 * refuses with ERR_FEATURE_UNAVAILABLE_ON_PLATFORM rather than simulating it.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'
import promises from './dns/promises.ts'

/** Set DNS result ordering (unavailable because the browser owns resolution). */
export const setDefaultResultOrder: typeof import('node:dns').setDefaultResultOrder = notImplementedFail('node:dns', 'setDefaultResultOrder')

/** Read DNS result ordering (unavailable because the browser owns resolution). */
export const getDefaultResultOrder: typeof import('node:dns').getDefaultResultOrder = notImplementedFail('node:dns', 'getDefaultResultOrder')

/** Resolve an address (unavailable in the Worker host). */
export const lookup: typeof import('node:dns').lookup = notImplementedFail('node:dns', 'lookup')

/** The same optional promise-based namespace served by node:dns/promises. */
export { promises }

/** CommonJS interop marker: default imports receive the exported DNS namespace. */
export const __esModule = true

/** CommonJS default namespace; operations report their missing capabilities when called. */
export default { setDefaultResultOrder, getDefaultResultOrder, lookup, promises } satisfies
  Partial<Omit<typeof import('node:dns'), 'promises'>> & { promises: typeof promises }
