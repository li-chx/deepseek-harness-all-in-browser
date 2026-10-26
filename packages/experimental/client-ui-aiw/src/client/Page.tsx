/** Workbench views use the registered controller callbacks and DSH presentation primitives. */
import { useId, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchAction, WorkbenchSnapshot } from './controller.ts'
import type { AiwKey } from './locales.ts'
import css from './Page.module.css'

type Tab = 'plugins' | 'files' | 'terminal' | 'backups' | 'settings'
/** The renderer binds the controller's stable source and its scoped callbacks. */
export interface WorkbenchInjected {
  hooks: { workbench: HostObservable<WorkbenchSnapshot> }
  refresh(): Promise<void>
  perform(action: WorkbenchAction, successText?: string): Promise<Record<string, unknown> | undefined>
  openFile(path: string, writable?: boolean): Promise<void>
  newFile(path: string): void
  edit(text: string): void
  discard(): void
  save(successText: string): Promise<void>
  cancel(): void
  flushStorage(): Promise<void>
  reload(): void
}
/** Props derived from the main-slot registration and the workbench locale. */
export type WorkbenchPageProps = PropsRuntime<'main'> & PropsLocale<'aiw'> & InjectFace<WorkbenchInjected>

type Confirmation = { title: string; description: string; accept: string; action: () => void }

function parent(path: string): string { return path.replace(/\/+$/, '').slice(0, path.replace(/\/+$/, '').lastIndexOf('/')) || '/' }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function download(archive: unknown, name: string): void {
  const blob = new Blob([JSON.stringify(archive, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name
  document.body.append(link); link.click(); link.remove()
  // The browser receives the clicked URL before its next task.
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/** Render the source, filesystem and recovery workbench inside the normal DSH main column.
 * @param props - Renderer-bound controller actions, current state and localized text.
 * @returns The selected workbench view and its confirmation surface.
 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const { t, useWorkbench, perform, refresh, openFile, newFile, edit, discard, save, cancel, flushStorage, reload } = props
  const state = useWorkbench(value => value)
  const [tab, setTab] = useState<Tab>('plugins')
  const [path, setPath] = useState('/dsh/workspace')
  const [renameTo, setRenameTo] = useState('')
  const [projectDirectory, setProjectDirectory] = useState('/dsh/workspace/my-plugin')
  const [packageName, setPackageName] = useState('my-plugin')
  const [includeClient, setIncludeClient] = useState(true)
  const [npmSpec, setNpmSpec] = useState('')
  const [cwd, setCwd] = useState('/dsh/workspace')
  const [command, setCommand] = useState('pwd')
  const [server, setServer] = useState<string>()
  const [exportDirectory, setExportDirectory] = useState('/dsh/workspace')
  const [importDirectory, setImportDirectory] = useState('/dsh/workspace/imported')
  const [archive, setArchive] = useState<unknown>()
  const [archiveError, setArchiveError] = useState<string>()
  const [reviewed, setReviewed] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const id = useId()
  const dirty = state.editor !== undefined && state.editor.text !== state.editor.original
  const busy = state.busy
  const storageFailed = state.storage?.kind === 'failed' || state.storageError !== undefined
  const storageMessage = t(state.storageError !== undefined ? 'storageUnconfirmed' : state.storage?.kind === 'failed'
    ? state.storage.error?.code === 'STORAGE_CONFLICT' ? 'storageConflict' : 'storageFailed'
    : state.flushing || state.storage?.kind === 'pending' ? 'storagePending' : state.storage?.kind === 'saved' ? 'storageSaved' : 'storageDisabled')
  const guard = (action: () => void): void => {
    if (!dirty) { action(); return }
    setConfirmation({ title: t('discardTitle'), description: t('discardDetail'), accept: t('discard'), action: () => { discard(); action() } })
  }
  const confirm = (description: string, action: () => void): void => { setConfirmation({ title: t('confirmTitle'), description, accept: t('done'), action }) }
  const directory = async (next: string): Promise<boolean> => {
    const result = await perform({ action: 'list', path: next })
    if (result !== undefined) { setPath(next); setTab('files'); return true }
    return false
  }
  const open = (next: string, writable = true): void =>{  guard(() => { setPath(next); setTab('files'); void openFile(next, writable) }) }
  const exportArchive = async (action: WorkbenchAction, filename: string): Promise<void> => {
    const result = await perform(action)
    if (result !== undefined && result.archive !== undefined) download(result.archive, filename)
  }
  const field = (label: AiwKey, value: string, change: (value: string) => void, type = 'text'): ReactNode => (
    <label className={css.field}>
      <span>{t(label)}</span>
      <Input type={type} aria-label={t(label)} value={value} onChange={(event) => { change(event.target.value) }} disabled={busy} />
    </label>
  )
  const archiveRecord = record(archive) ? archive : undefined
  const archiveManifest = record(archiveRecord?.manifest) ? archiveRecord.manifest : undefined
  const archivePlugin = record(archiveManifest?.plugin) ? archiveManifest.plugin : undefined
  const archiveSource = record(archiveRecord?.source) ? archiveRecord.source : undefined
  const archiveText = (value: unknown): string => typeof value === 'string' ? value : '—'
  const archiveCount = (value: unknown): string => record(value) ? String(Object.keys(value).length) : '—'
  const section = (title: AiwKey, children: ReactNode): ReactNode => <section className={css.card}>
    <h2>{t(title)}</h2>{children}</section>
  type TabItem = { value: Tab; label: string; id: string; panelId: string }
  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'plugins', label: t('plugins'), id: `${id}-plugins`, panelId: `${id}-panel` },
    { value: 'files', label: t('files'), id: `${id}-files`, panelId: `${id}-panel` },
    { value: 'terminal', label: t('terminal'), id: `${id}-terminal`, panelId: `${id}-panel` },
    { value: 'backups', label: t('backups'), id: `${id}-backups`, panelId: `${id}-panel` },
    { value: 'settings', label: t('settings'), id: `${id}-settings`, panelId: `${id}-panel` },
  ]

  return <section className={css.page} data-aiw-panel aria-busy={busy}>
    <header className={css.head} data-drag-region>
      <div>
        <h1>{t('title')}</h1>
        <p>{t('subtitle')}</p>
      </div>
      <div className={css.actions}>
        <Button variant="outline" disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
        <Button variant="primary" disabled={state.flushing || state.storage === undefined || storageFailed} onClick={() => { void flushStorage() }}>{t('saveNow')}</Button>
      </div>
    </header>
    <div className={css.notice}
      data-aiw-storage={storageFailed ? 'failed' : state.storage?.kind ?? 'disabled'} role={storageFailed ? 'alert' : 'status'}>
      <span>{storageMessage}
        {storageFailed && <span className={css.location}>{state.storageError ?? state.storage?.error?.message}</span>}
      </span>
      {storageFailed && <Button onClick={() => { guard(reload) }}>{t('reload')}</Button>}
    </div>
    <div className={css.tabs}>
      <SegmentedTabs items={tabs} value={tab} label={t('tabs')} onChange={(next) => { guard(() => { setTab(next); if (next === 'files') void directory(state.directory) }) }} />
    </div>
    {state.error !== undefined && <div className={css.notice} role="alert">
      <span>{state.error}</span>
      <Button onClick={() => { void refresh() }}>{t('retry')}</Button>
    </div>}
    {!state.ready ? <div className={css.loading} role="status" aria-label={t('loading')}>
      <span className={css.spinner} />
    </div> : <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={css.content}>
      {tab === 'plugins' && <>
        {section('projects', <>
          <div className={css.form}>{field('projectDirectory', projectDirectory, setProjectDirectory)}{field('packageName', packageName, setPackageName)}<Checkbox className={css.check} checked={includeClient} onChange={setIncludeClient} disabled={busy} label={t('includeClient')} />
            <Button variant="primary" disabled={busy || !projectDirectory || !packageName} onClick={() => { void perform({ action: 'create-project', directory: projectDirectory, name: packageName, client: includeClient }, t('projectCreated')) }}>{t('createProject')}</Button>
          </div>
          {state.projects.length === 0 ? <p className={css.empty}>{t('noProjects')}</p> : <div className={css.rows}>{state.projects.map(project => <article className={css.row} key={project.directory} data-aiw-project={project.directory}>
            <div className={css.rowText}>
              <strong>{project.name}</strong>
              <code>{project.directory}</code>{project.diagnostic !== undefined && <p role="alert">{project.diagnostic}</p>}</div>
            <div className={css.actions}>{project.client && <Tag>{t('client')}</Tag>}<Button disabled={busy} onClick={() => { void perform({ action: 'build', directory: project.directory }, t('done')) }}>{t('buildProject')}</Button>
              <Button disabled={busy} onClick={() => { guard(() => { void directory(project.directory).then(async (opened) => { if (opened) { setPath(`${project.directory}/index.ts`); await openFile(`${project.directory}/index.ts`) } }) }) }}>{t('openSource')}</Button>
            </div>
          </article>)}</div>}
          <p className={css.muted}>{t('hostOutcome')}</p>
        </>)}
        {section('installed', <>
          {state.status?.plugins.length === 0 ? <p className={css.empty}>{t('noPlugins')}</p> : <div className={css.rows}>{state.status?.plugins.map(plugin => <article className={css.row} key={plugin.pluginId} data-aiw-plugin={plugin.pluginId}>
            <div className={css.rowText}>
              <strong>{plugin.name}</strong>
              <code>{plugin.version} · {plugin.revision.slice(0, 12)}</code>
              <span>{t(plugin.status === 'active' ? 'active' : plugin.status === 'disabled' ? 'disabled' : 'failed')}</span>{plugin.message !== undefined && <p role="alert">{plugin.message}</p>}</div>
            <div className={css.actions}>
              <Button disabled={busy} onClick={() => { void perform({ action: 'history', pluginId: plugin.pluginId }) }}>{t('history')}</Button>
              <Button disabled={busy} onClick={() => { void exportArchive({ action: 'plugin-export', pluginId: plugin.pluginId }, `${plugin.name.replaceAll('/', '-')}.aiw.json`) }}>{t('exportPlugin')}</Button>
              <Button disabled={busy} onClick={() => { confirm(t('removeDetail', { name: plugin.name }), () => { void perform({ action: 'remove', pluginId: plugin.pluginId }, t('pluginRemoved')) }) }}>{t('removePlugin')}</Button>
            </div>
          </article>)}</div>}
          {state.status !== undefined && state.status.historyPlugins.length > 0 && <div className={css.history}>
            <h3>{t('versions')}</h3>
            <div className={css.actions}>{state.status.historyPlugins.map(owner => <Button key={owner.pluginId} disabled={busy} onClick={() => { void perform({ action: 'history', pluginId: owner.pluginId }) }}>{owner.name}</Button>)}</div>
          </div>}
          {state.historyPlugin !== undefined && <section className={css.history}>
            <h3>{t('versions')}</h3>{state.versions.length === 0 ? <p className={css.empty}>{t('noVersions')}</p> : state.versions.map(version => <article className={css.row} key={version.revision} data-aiw-version={version.revision}>
              <div className={css.rowText}>
                <strong>{version.name} · {version.version}</strong>
                <code>{version.revision.slice(0, 12)}</code>
                <span>{version.createdAt} · {t(version.hasSource ? 'sourceIncluded' : 'artifactsOnly')}</span>
              </div>
              <div className={css.actions}>
                <Button disabled={busy} onClick={() => { confirm(t('restoreDetail'), () => { void perform({ action: 'restore', pluginId: version.pluginId, revision: version.revision }, t('versionRestored')) }) }}>{t('restore')}</Button>
                <Button disabled={busy} onClick={() => { void exportArchive({ action: 'plugin-export', pluginId: version.pluginId, revision: version.revision }, `${version.name.replaceAll('/', '-')}-${version.revision.slice(0, 12)}.aiw.json`) }}>{t('exportPlugin')}</Button>
              </div>
            </article>)}</section>}
        </>)}
        {section('installPackage', <>
          <p className={css.muted}>{t('temporaryInstall')}</p>
          <div className={css.inline}>{field('npmPackage', npmSpec, setNpmSpec)}<Button variant="outline" disabled={busy || !npmSpec} onClick={() => { void perform({ action: 'add', spec: npmSpec }, t('done')) }}>{t('installPackage')}</Button>
          </div>
        </>)}
      </>}
      {tab === 'files' && <>
        <section className={css.card}>
          <div className={css.form}>{field('path', path, setPath)}<div className={css.actions}>
            <Button variant="outline" disabled={busy} onClick={() => { guard(() => { void directory(path) }) }}>{t('openDirectory')}</Button>
            <Button disabled={busy} onClick={() => { open(path) }}>{t('readFile')}</Button>
            <Button disabled={busy} onClick={() => { guard(() => { newFile(path) }) }}>{t('newFile')}</Button>
            <Button disabled={busy} onClick={() => { void perform({ action: 'mkdir', path }, t('folderCreated')).then((result) => { if (result !== undefined) void directory(parent(path)) }) }}>{t('newFolder')}</Button>
            <Button disabled={busy} onClick={() => { guard(() => { void directory(parent(state.directory)) }) }}>{t('parent')}</Button>
          </div>
          </div>
          <code className={css.location}>{state.directory}</code>
          <div className={css.fileRows}>{state.entries.length === 0 ? <p className={css.empty}>{t('emptyDirectory')}</p> : state.entries.map(entry => <button type="button" className={css.fileRow} key={entry.path} disabled={busy} onClick={() => { if (entry.directory) guard(() => { void directory(entry.path) }); else open(entry.path, entry.writable) }}>
            <span className={css.fileName}>{entry.directory ? '▸ ' : ''}{entry.name}</span>
            <span>{entry.writable ? `${String(entry.size)} B` : t('readOnly')}</span>
          </button>)}</div>
        </section>
        <section className={css.card}>
          <div className={css.inline}>
            <span className={css.rowText}>
              <strong>{t('editing')}</strong>
              <code>{state.editor?.path ?? path}</code>
            </span>{dirty && <Tag>{t('unsaved')}</Tag>}<Button variant="primary" disabled={busy || state.editor === undefined || !state.editor.writable} onClick={() => { void save(t('fileSaved')) }}>{t('saveFile')}</Button>
          </div>
          <label className={css.field}>
            <span>{t('fileContents')}</span>
            <textarea className={css.editor} aria-label={t('fileContents')} spellCheck={false} value={state.editor?.text ?? ''} disabled={busy || state.editor === undefined || !state.editor.writable} onChange={(event) => { edit(event.target.value) }} />
          </label>
          <div className={css.inline}>{field('targetPath', renameTo, setRenameTo)}<Button disabled={busy || !renameTo} onClick={() => { guard(() => { void perform({ action: 'rename', path, to: renameTo }, t('renamed')).then((result) => { if (result !== undefined) void directory(parent(renameTo)) }) }) }}>{t('rename')}</Button>
            <Button disabled={busy} onClick={() => { confirm(t('deleteDetail', { path }), () => { void perform({ action: 'delete', path }, t('deleted')).then((result) => { if (result !== undefined) void directory(parent(path)) }) }) }}>{t('delete')}</Button>
          </div>
        </section>
      </>}
      {tab === 'terminal' && section('terminal', <>
        <p className={css.muted}>{t('shellHint')}</p>
        <div className={css.form}>{field('workingDirectory', cwd, setCwd)}<label className={css.field}>
          <span>{t('command')}</span>
          <textarea aria-label={t('command')} className={css.command} rows={3} value={command} disabled={busy} onChange={(event) => { setCommand(event.target.value) }} />
        </label>
        <div className={css.actions}>
          <Button variant="primary" disabled={busy || !command} onClick={() => { void perform({ action: 'shell', cwd, command }) }}>{t('runCommand')}</Button>
          <Button disabled={!busy} onClick={cancel}>{t('cancelCommand')}</Button>
        </div>
        </div>
      </>)}
      {tab === 'backups' && <>
        {section('exportFiles', <div className={css.inline}>{field('exportDirectory', exportDirectory, setExportDirectory)}<Button variant="outline" disabled={busy} onClick={() => { void exportArchive({ action: 'export', path: exportDirectory }, 'aiw-files.json') }}>{t('exportFiles')}</Button>
        </div>)}
        {section('importFile', <>
          <p className={css.muted}>{t('importHint')}</p>
          <label className={css.field}>
            <span>{t('importFile')}</span>
            <input type="file" aria-label={t('importFile')} accept="application/json,.json" disabled={busy} onChange={(event) => { const input = event.currentTarget; const file = input.files?.[0]; setReviewed(false); setArchive(undefined); setArchiveError(undefined); if (file !== undefined && file.size > 48 * 1024 * 1024) { setArchiveError(t('importTooLarge')); return } if (file !== undefined) void file.text().then((content) => { if (input.files?.[0] !== file) return; const parsed: unknown = JSON.parse(content); if (!record(parsed) || parsed.schema !== 1 || (parsed.kind !== 'files' && parsed.kind !== 'plugin')) throw new Error(t('invalidArchive')); setArchive(parsed) }).catch(() => { if (input.files?.[0] === file) setArchiveError(t('invalidArchive')) }) }} />
          </label>{field('importDirectory', importDirectory, (value) => { setImportDirectory(value); setReviewed(false) })}{archiveError !== undefined && <p role="alert">{archiveError}</p>}{archive === undefined ? <p className={css.empty}>{t('noImport')}</p> : <>
            <p>{t(record(archive) && archive.kind === 'plugin' ? 'pluginBackup' : 'filesBackup')}</p>
            <div className={css.actions}>
              <Button disabled={busy} onClick={() => { if (record(archive) && archive.kind === 'plugin') setReviewed(true); else void perform({ action: 'import-preview', archive, directory: importDirectory }).then((result) => { setReviewed(result !== undefined) }) }}>{t('previewImport')}</Button>
              <Button variant="primary" disabled={busy || !reviewed || record(archive) && archive.kind === 'files' && (state.preview?.conflicts.length ?? 0) > 0} onClick={() => { if (record(archive) && archive.kind === 'plugin') confirm(t('pluginImportDetail'), () => { void perform({ action: 'plugin-import', archive }, t('importComplete')).then(() => { setReviewed(false) }) }); else void perform({ action: 'import', archive, directory: importDirectory }, t('importComplete')).then(() => { setReviewed(false) }) }}>{t('applyImport')}</Button>
            </div>{reviewed && <div className={css.preview} data-aiw-import-preview>
              <strong>{t('importPreview')}</strong>{state.preview !== undefined && record(archive) && archive.kind === 'files' ? <>
                <p>{t('previewFiles', { count: String(state.preview.fileCount), bytes: String(state.preview.bytes) })}</p>{state.preview.conflicts.length > 0 && <p role="alert">{t('conflicts')}: {state.preview.conflicts.join(', ')}</p>}</> : <>
                <p className={css.muted}>{t('previewHint')}</p>
                <dl className={css.facts}>
                  <dt>{t('backupName')}</dt>
                  <dd>{archiveText(archivePlugin?.name)}</dd>
                  <dt>{t('backupId')}</dt>
                  <dd>{archiveText(archivePlugin?.id)}</dd>
                  <dt>{t('backupVersion')}</dt>
                  <dd>{archiveText(archivePlugin?.version)}</dd>
                  <dt>{t('backupRevision')}</dt>
                  <dd>{archiveText(archiveManifest?.revision)}</dd>
                  <dt>{t('generation')}</dt>
                  <dd>{archiveText(archiveRecord?.generation)}</dd>
                  <dt>{t('backupFiles')}</dt>
                  <dd>{archiveCount(archiveSource?.files)}</dd>
                  <dt>{t('backupObjects')}</dt>
                  <dd>{archiveCount(archiveRecord?.objects)}</dd>
                </dl>
              </>}</div>}</>}</>)}
      </>}
      {tab === 'settings' && section('settings', <>
        <div className={css.inline}>{field('forgeUrl', server ?? state.status?.baseUrl ?? '', setServer, 'url')}<Button variant="primary" disabled={busy || !(server ?? state.status?.baseUrl)} onClick={() => { void perform({ action: 'configure', baseUrl: server ?? state.status?.baseUrl ?? '' }, t('settingsSaved')) }}>{t('saveSettings')}</Button>
        </div>
        <dl className={css.facts}>
          <dt>{t('generation')}</dt>
          <dd>{state.status?.generation}</dd>
          <dt>{t('workspace')}</dt>
          <dd>{state.status?.workspace}</dd>
          <dt>{t('profile')}</dt>
          <dd>{state.status?.profileDirectory}</dd>
        </dl>
        <p className={css.muted}>{t('storageHint')}</p>
      </>)}
      {(state.output !== '' || tab === 'terminal') && <section className={css.card}>
        <h2>{t('output')}</h2>
        <pre className={css.output} data-aiw-command-output data-aiw-feedback role="status">{state.output}</pre>
      </section>}
    </div>}
    <Modal open={confirmation !== undefined} title={confirmation?.title ?? t('confirmTitle')} closeLabel={t('close')} onClose={() => { setConfirmation(undefined) }} {...confirmation === undefined ? {} : { description: confirmation.description }} footer={<>
      <Button onClick={() => { setConfirmation(undefined) }}>{confirmation?.title === t('discardTitle') ? t('keepEditing') : t('cancel')}</Button>
      <Button variant="primary" onClick={() => { const action = confirmation?.action; setConfirmation(undefined); action?.() }}>{confirmation?.accept ?? t('done')}</Button>
    </>} />
  </section>
}
