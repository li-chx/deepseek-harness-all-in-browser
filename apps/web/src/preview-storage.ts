/** Browser persistence selection and commit feedback for the standalone Worker preview. */
import type { TunnelStorageInit, WorkerHostConnection } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import styles from './preview-storage.module.css'

const english = {
  reload: 'Reload',
  failed: 'Local saving stopped. Changes here may be unsaved. Reload to reopen saved data.',
  conflict: 'Another tab saved changes. Changes here are not saved. Reload to open the saved version.',
  bootFailed: 'Startup failed. Local data was not cleared.',
  stopped: 'The Worker stopped. Recent changes may be unsaved. Reload to reopen saved data.',
}
type Copy = { [K in keyof typeof english]: string }
const chinese: Copy = {
  reload: '重新加载',
  failed: '本地保存已停止，当前更改可能尚未保存。重新加载以打开已保存的数据',
  conflict: '另一个标签页已保存更改，当前页面的更改未保存。重新加载以打开已保存的版本',
  bootFailed: '启动失败，本地数据未被清空', stopped: 'Worker 已停止，最近的更改可能尚未保存。重新加载以打开已保存的数据',
}

/**
 * Select an isolated browser store; the Worker supplies the generation and storage schema.
 * @param page - Deployment URL; its Forge service query does not identify user data.
 * @param image - Resolved base image URL.
 * @param overlays - Ordered resolved source overlays.
 * @returns Browser storage selection, or undefined for an explicit temporary session.
 */
export function previewStorageOptions(page: URL, image: URL, overlays: readonly URL[]): TunnelStorageInit | undefined {
  const mode = page.searchParams.get('storage')
  if (mode === 'none' || mode === null && !page.searchParams.has('forge')) return undefined
  if (mode !== null && mode !== 'indexeddb') throw new Error('preview storage: unknown storage mode')
  return { kind: 'indexeddb', deployment: `${page.origin}${page.pathname}`, source: JSON.stringify({ image: image.href, overlays: overlays.map(url => url.href) }) }
}

/** Global failure feedback remains available when the workbench cannot render. */
export interface PreviewStorageUi {
  /** Observe terminal commit and Worker failures after boot. */
  connect(connection: WorkerHostConnection): void
  /** Report failed boot without replacing or clearing durable records. */
  fail(reason: unknown): void
  /** Detach observers and remove failure feedback; no asynchronous save is implied. */
  dispose(): void
}

/**
 * Observe storage failures before boot; routine status and saving belong to dsh-aib.
 * @returns Controls to attach a connection or report failed boot.
 */
export function mountPreviewStorage(): PreviewStorageUi {
  const copy: Copy = navigator.language.startsWith('zh') ? chinese : english
  const bar = document.createElement('aside')
  bar.className = styles.bar ?? ''
  bar.dataset.workerStorage = 'failed'
  const message = document.createElement('output')
  message.className = styles.message ?? ''
  message.setAttribute('role', 'alert')
  message.setAttribute('aria-live', 'polite')
  const actions = document.createElement('div')
  actions.className = styles.actions ?? ''
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = copy.reload
  const events = new AbortController()
  const options = { signal: events.signal }
  reload.addEventListener('click', () => { location.reload() }, options)
  actions.append(reload)
  bar.append(message, actions)
  const previousLayout = document.body.getAttribute('data-preview-storage-layout')
  let release: (() => void) | undefined
  let disposed = false

  function failure(text: string, reason: unknown): void {
    if (disposed) return
    release?.()
    release = undefined
    document.body.setAttribute('data-preview-storage-layout', '')
    document.body.prepend(bar)
    message.textContent = `${text}\n${reason instanceof Error ? reason.message : String(reason)}`
  }
  return {
    connect(value) {
      release = value.tunnel.subscribeStorageStatus((status) => {
        if (status.kind === 'failed') failure(status.error?.code === 'STORAGE_CONFLICT' ? copy.conflict : copy.failed, status.error?.message ?? '')
      })
      value.worker.addEventListener('error', (event) => { failure(copy.stopped, new Error(event.message)) }, options)
    },
    fail(reason) { failure(copy.bootFailed, reason) },
    dispose() {
      disposed = true
      release?.()
      events.abort()
      bar.remove()
      if (previousLayout === null) document.body.removeAttribute('data-preview-storage-layout')
      else document.body.setAttribute('data-preview-storage-layout', previousLayout)
    },
  }
}
