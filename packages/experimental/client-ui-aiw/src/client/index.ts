/** Worker management panel and sidebar contribution with plugin-owned request lifetime. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkerStorageControls } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { WorkbenchController } from './controller.ts'
import { WorkbenchPage, type WorkbenchInjected } from './Page.tsx'
import { WorkbenchIcon, WorkbenchToast, type NoticeFace } from './Feedback.tsx'
import { en, zh, type AiwKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Virtual workbench navigation, controls and operation feedback. */
    aiw: AiwKey
  }
}

const PANEL = 'dsh-aiw' as MainPanelId

/** Required registration and navigation services. */
export const inject = ['slots', 'locale', 'layout']

/** Register the workbench directly below Plugins and retain editor drafts across page navigation.
 * @param ctx - Client context whose effects own registrations and pending Worker calls.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('aiw', { en, zh }), 'aiw: dictionaries')
  const storage = (globalThis as { __DSH_TRANSPORT__?: { storage?: WorkerStorageControls } }).__DSH_TRANSPORT__?.storage
  const controller = new WorkbenchController((input, init) => fetch(input, init), storage)
  ctx.effect(() => () => { controller.dispose() }, 'aiw: request lifetime')
  if (storage !== undefined) ctx.effect(() => storage.subscribe((value) => { controller.updateStorage(value) }), 'aiw: storage status')
  const t = ctx.locale.bind('aiw')
  const injected: WorkbenchInjected = {
    hooks: { workbench: controller.source }, refresh: () => controller.refresh(),
    perform: (action, success) => controller.perform(action, success), openFile: (path, writable) => controller.openFile(path, writable),
    newFile: (path) => { controller.newFile(path) },
    discard: () => { controller.discard() },
    edit: (text) => { controller.edit(text) },
    save: success => controller.save(success),
    cancel: () => { controller.cancel() },
    flushStorage: () => controller.flushStorage(),
    reload: () => { window.location.reload() },
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: 'aiw', inject: () => injected }, WorkbenchPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 1, label: () => t('title'), locale: 'aiw' }, WorkbenchIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'aiw.notice', locale: 'aiw', inject: (): NoticeFace => ({ hooks: injected.hooks, dismiss: () => { controller.dismiss() } }) }, WorkbenchToast))
  ctx.effect(() => ctx.layout.panelInfo.subscribe(() => { if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) void controller.refresh() }), 'aiw: refresh on navigation')
  ctx.effect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      const editor = controller.source.getSnapshot().editor
      if (editor !== undefined && editor.text !== editor.original) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn) }
  }, 'aiw: unsaved draft guard')
  void controller.refresh()
}
