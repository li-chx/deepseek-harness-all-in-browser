/** Lifecycle-independent feedback and the sidebar's existing code glyph. */
import { IconCodeOutlineRegular, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { WorkbenchInjected } from './Page.tsx'

/** Source and dismissal callback shared with the shell overlay. */
export type NoticeFace = Pick<WorkbenchInjected, 'hooks'> & { dismiss(): void }

/** Render the code glyph at the sidebar-provided size.
 * @param props - Sidebar-owned icon geometry.
 * @returns Decorative icon; navigation owns its label.
 */
export function WorkbenchIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconCodeOutlineRegular size={size} /> }

/** Keep operation feedback visible after the user leaves the page.
 * @param props - Renderer-bound notice hook, locale and dismissal action.
 * @returns Active notice, or no overlay.
 */
export function WorkbenchToast({ useWorkbench, dismiss, t }: InjectFace<NoticeFace> & PropsLocale<'aiw'>) {
  const notice = useWorkbench(value => value.notice)
  if (notice === undefined) return null
  const message = notice.observerWarning ? t('observerWarning', { message: notice.text })
    : notice.uncertain ? t('unknownOutcome', { message: notice.text }) : notice.text
  return <Toast key={notice.id} text={message} icon={<IconWarningOutlineRegular />} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismiss} />
}
