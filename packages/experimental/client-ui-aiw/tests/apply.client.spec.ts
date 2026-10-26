// @vitest-environment jsdom
/** Workbench navigation and feedback registrations leave with their plugin fiber. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('registers directly after Plugins and removes the panel, navigation and subscriptions on disposal', async (t) => {
  const ctx = new Context()
  t.onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllGlobals() })
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const offNavigation = vi.fn()
  ctx.provide('layout', { panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => offNavigation } })
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected JSON body')
    const value: unknown = JSON.parse(init.body)
    if (value !== null && typeof value === 'object' && 'action' in value && value.action === 'projects') return Response.json({ protocol: 1, action: 'projects', projects: [] })
    return Response.json({ protocol: 1, action: 'status', generation: 'test', root: '/dsh', workspace: '/dsh/workspace', profileDirectory: '/dsh/home/profiles/web', plugins: [], historyPlugins: [] })
  })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    main: { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  expect(slots.entries('sidebar.panellist')).toHaveLength(1)
  expect(slots.entries('sidebar.panellist')[0]?.options).toMatchObject({ id: 'dsh-aiw', order: 1 })
  expect(resolveSlotLabel(slots.entries('sidebar.panellist')[0]?.options.label)).toBe('dsh-aiw')
  expect(slots.entries('main')).toHaveLength(1)
  expect(slots.entries('shell.overlay')).toHaveLength(1)
  await fiber.dispose()
  expect(slots.entries('sidebar.panellist')).toHaveLength(0)
  expect(slots.entries('main')).toHaveLength(0)
  expect(slots.entries('shell.overlay')).toHaveLength(0)
  expect(offNavigation).toHaveBeenCalledOnce()
})
