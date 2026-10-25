/** Browser persistence selection and commit feedback for the standalone Worker preview. */
import { parseStorageStatus, type TunnelStorageInit, type VfsPersistenceStatus, type WorkerHostConnection } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import styles from './preview-storage.module.css'

const english = {
  restoring: 'Opening local data…', saved: 'Saved in this browser', pending: 'Saving locally…', save: 'Save now', reload: 'Reload',
  failed: 'Local saving stopped. Changes here may be unsaved. Reload to reopen saved data.',
  conflict: 'Another tab saved changes. Changes here are not saved. Reload to open the saved version.',
  bootFailed: 'Startup failed. Local data was not cleared.',
  stopped: 'The Worker stopped. Recent changes may be unsaved. Reload to reopen saved data.',
}
type Copy = { [K in keyof typeof english]: string }
const chinese: Copy = {
  restoring: '正在读取本地数据…', saved: '已保存在此浏览器', pending: '正在保存到本地…', save: '立即保存', reload: '重新加载',
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

/** A normal-flow toolbar that keeps persistence failures visible above the application. */
export interface PreviewStorageUi {
  /** Parent for the existing Forge launcher, outside the application’s menus. */
  readonly actions: HTMLElement
  /** Observe live commits after boot; status before boot remains a loading state. */
  connect(connection: WorkerHostConnection): void
  /** Report failed boot without replacing or clearing durable records. */
  fail(reason: unknown): void
  /** Detach observers and remove the toolbar; no asynchronous save is implied. */
  dispose(): void
}

/**
 * Mount persistence feedback before Worker boot, including a commit-confirmed flush action.
 * @returns Controls to attach a connection or report failed boot.
 */
export function mountPreviewStorage(): PreviewStorageUi {
  const copy: Copy = navigator.language.startsWith('zh') ? chinese : english
  const bar = document.createElement('aside')
  bar.className = styles.bar ?? ''
  bar.dataset.workerStorage = 'opening'
  const message = document.createElement('output')
  message.className = styles.message ?? ''
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  message.textContent = copy.restoring
  const actions = document.createElement('div')
  actions.className = styles.actions ?? ''
  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = copy.save
  save.disabled = true
  const reload = document.createElement('button')
  reload.type = 'button'
  reload.textContent = copy.reload
  reload.hidden = true
  const events = new AbortController()
  const options = { signal: events.signal }
  reload.addEventListener('click', () => { location.reload() }, options)
  actions.append(save, reload)
  bar.append(message, actions)
  const previousLayout = document.body.getAttribute('data-preview-storage-layout')
  document.body.setAttribute('data-preview-storage-layout', '')
  document.body.prepend(bar)
  let connection: WorkerHostConnection | undefined
  let release: (() => void) | undefined
  let flushing = false
  let state: VfsPersistenceStatus | undefined
  let disposed = false

  function render(value: VfsPersistenceStatus): void {
    if (disposed) return
    state = value
    bar.dataset.workerStorage = value.kind
    message.textContent = value.kind === 'saved' ? copy.saved : value.kind === 'pending' ? copy.pending
      : `${value.error?.code === 'STORAGE_CONFLICT' ? copy.conflict : copy.failed}\n${value.error?.message ?? ''}`
    save.disabled = flushing || value.kind === 'failed'
    reload.hidden = value.kind !== 'failed'
  }
  function failure(text: string, reason: unknown): void {
    if (disposed) return
    release?.()
    release = undefined
    bar.dataset.workerStorage = 'failed'
    message.textContent = `${text}\n${reason instanceof Error ? reason.message : String(reason)}`
    save.disabled = true
    reload.hidden = false
  }
  save.addEventListener('click', () => {
    if (!connection || flushing || state?.kind === 'failed') return
    flushing = true
    save.disabled = true
    void connection.tunnel.fetch('/__storage/flush', { method: 'POST' }).then(async (response) => {
      if (!response.ok) throw new Error(`Storage confirmation returned HTTP ${String(response.status)}`)
      render(parseStorageStatus(await response.json()))
    }).catch((error: unknown) => { failure(copy.failed, error) }).finally(() => {
      flushing = false
      if (state && bar.dataset.workerStorage !== 'failed') render(state)
    })
  }, options)
  return {
    actions,
    connect(value) {
      connection = value
      release = value.tunnel.subscribeStorageStatus(render)
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
