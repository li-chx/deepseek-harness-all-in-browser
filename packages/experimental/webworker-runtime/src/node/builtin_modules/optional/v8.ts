/**
 * Optional V8 namespace for plugins that can continue without engine statistics.
 * The browser exposes no equivalent synchronous Worker heap usage and limit;
 * statistics requests refuse rather than returning estimated or invented values.
 */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Read V8 heap statistics (unavailable in the Worker host). */
export const getHeapStatistics: typeof import('node:v8').getHeapStatistics = notImplementedFail('node:v8', 'getHeapStatistics')

/** CommonJS interop marker: default imports receive the exported V8 namespace. */
export const __esModule = true

/** CommonJS default namespace; heap statistics report their missing capability when called. */
export default { getHeapStatistics } satisfies Partial<typeof import('node:v8')>
