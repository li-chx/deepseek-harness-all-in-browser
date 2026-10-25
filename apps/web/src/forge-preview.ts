import type { HttpTransport } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
/** Opt-in Forge controls for the static Worker preview, independent of the product client. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import styles from './forge-preview.module.css'
import { forwardWorkerHostRequests } from './worker-host-fetch.ts'

const english = {
  npmPackage: 'npm package', installPackage: 'Install npm package',
  title: 'DSH Forge', close: 'Close', backend: 'Forge server URL', pluginId: 'Plugin ID',
  name: 'Package name', version: 'Package version', entry: 'Entry file', source: 'TypeScript source',
  dependencies: 'Dependencies (JSON)', peers: 'Peer dependencies (JSON)',
  install: 'Build and install', remove: 'Remove plugin', refresh: 'Refresh status',
  installed: 'Installed plugins', empty: 'No Forge plugins installed',
  ephemeral: 'Plugins are stored in Worker memory. Reloading this page discards them.',
  hint: 'The example registers /forge-test. Change test v1 to test v2 and build again to test hot replacement.',
  idle: 'Ready', busy: 'Working…', active: 'Active', disabled: 'Installed (disabled)', removed: 'Removed', failed: 'Activation failed',
  generation: 'Build generation', revision: 'Revision', downloaded: 'Downloaded files', written: 'Written files',
  unknownResult: 'The update was sent, but its result could not be confirmed. Refresh status before retrying.',
  persistent: 'Changes are saved in this browser. Check the storage status before closing this page.',
  response: 'The server returned an invalid response.', target: 'The Forge server targets a different build generation.',
  packageTarget: 'The Forge server targets different shared package versions.',
  dependencyError: 'Dependencies must be a JSON object mapping package names to version strings.',
  address: 'Enter an HTTP or HTTPS server URL without a query or fragment.',
  observer: 'File observer errors', statusFailure: 'Could not refresh installed plugins',
}
type Copy = { [K in keyof typeof english]: string }
const chinese: Copy = {
  npmPackage: 'npm 包', installPackage: '安装 npm 包',
  title: 'DSH Forge', close: '关闭', backend: 'Forge 服务地址', pluginId: '插件 ID',
  name: '包名', version: '包版本', entry: '入口文件', source: 'TypeScript 源码',
  dependencies: '依赖（JSON）', peers: 'Peer 依赖（JSON）',
  install: '构建并安装', remove: '删除插件', refresh: '刷新状态', installed: '已安装插件',
  empty: '尚未安装 Forge 插件', ephemeral: '插件保存在 Worker 内存中，刷新页面后会丢失',
  hint: '示例注册 /forge-test 命令。将 test v1 改为 test v2 后重新构建，可测试热替换',
  idle: '就绪', busy: '处理中…', active: '已激活', disabled: '已安装（已禁用）', removed: '已删除', failed: '激活失败',
  generation: '构建代际', revision: '修订', downloaded: '下载文件数', written: '写入文件数',
  unknownResult: '更新已发送，但无法确认结果。请先刷新状态再重试',
  persistent: '更改保存在此浏览器中，关闭页面前请确认保存状态',
  response: '服务返回了无效响应', target: 'Forge 服务与当前页面的构建代际不一致',
  packageTarget: 'Forge 服务的共享包版本与当前页面不一致',
  dependencyError: '依赖必须是以包名为键、版本字符串为值的 JSON 对象',
  address: '请输入 HTTP 或 HTTPS 服务地址，不包含查询参数或片段',
  observer: '文件观察者错误', statusFailure: '无法刷新已安装插件',
}

const example = `import type { Context } from '@deepseek-ai/cordis'

export const name = 'forge-test'
export const inject = ['commands']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.commands.register({
    name: 'forge-test',
    description: 'Test Forge hot replacement',
    handler: () => ({ kind: 'success', text: 'test v1' }),
  }))
}
`

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class ForgeResponseError extends Error {}

async function readResponse(response: Response, copy: Copy): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (!response.ok) {
    if (record(value) && record(value.error) && typeof value.error.message === 'string') {
      throw new ForgeResponseError(`${String(value.error.code)}: ${value.error.message}`)
    }
    throw new ForgeResponseError(`${response.status}: ${copy.response}`)
  }
  if (!record(value) || value.protocol !== 1) throw new Error(copy.response)
  return value
}

function dependencies(text: string, copy: Copy): Record<string, string> {
  let value: unknown
  try { value = JSON.parse(text) } catch (error) {
    throw new Error(copy.dependencyError, { cause: error })
  }
  if (!record(value) || !Object.values(value).every(version => typeof version === 'string')) {
    throw new Error(copy.dependencyError)
  }
  return Object.fromEntries(Object.entries(value).map(([key, version]) => [key, String(version)]))
}

/**
 * Mount the opt-in plugin editor; installs are transient until a persistence provider is connected.
 * @param serverUrl - Initial Forge endpoint selected by the preview URL.
 * @param hostFetch - Existing Worker transport used for target, install, and removal operations.
 * @param httpTransport - Optional outbound provider shared with Worker boot.
 * @param presentation - Optional toolbar parent and browser-persistence notice.
 * @returns Disposer for the controls and their event listeners; closing the dialog preserves drafts.
 */
export function mountForgePreview(serverUrl: string, hostFetch: TunnelFetch, httpTransport?: HttpTransport, presentation?: {
  launcherParent?: HTMLElement
  persistentStorage?: boolean
}): () => void {
  const request = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    httpTransport === undefined ? fetch(input, init) : httpTransport.fetch(new Request(input, init))
  const copy: Copy = navigator.language.startsWith('zh') ? chinese : english
  const releaseFetch = forwardWorkerHostRequests(hostFetch)
  const events = new AbortController()
  const options = { signal: events.signal }
  const launcher = document.createElement('button')
  launcher.type = 'button'
  launcher.className = styles.launcher ?? ''
  launcher.textContent = copy.title
  const dialog = document.createElement('dialog')
  dialog.className = styles.dialog ?? ''
  dialog.dataset.forgePreview = ''
  dialog.setAttribute('aria-labelledby', 'forge-preview-title')
  const header = document.createElement('header')
  const title = document.createElement('h2')
  title.id = 'forge-preview-title'
  title.textContent = copy.title
  const close = button(copy.close, () => { dialog.close() })
  header.append(title, close)
  const body = document.createElement('div')
  body.className = styles.body ?? ''
  const notice = document.createElement('p')
  notice.textContent = presentation?.persistentStorage === true ? copy.persistent : copy.ephemeral
  const hint = document.createElement('p')
  hint.textContent = copy.hint
  const target = document.createElement('p')
  const form = document.createElement('form')
  const fields = document.createElement('fieldset')
  fields.className = styles.fields ?? ''
  const backend = input(copy.backend, serverUrl, 'url')
  const id = input(copy.pluginId, 'forge-test')
  const npmSpec = input(copy.npmPackage, 'dsh-plugin@2.2.1')
  const packageInstall = button(copy.installPackage, () => { void run(installPackage) })
  fields.append(packageInstall)
  const name = input(copy.name, 'local-forge-test')
  const version = input(copy.version, '0.0.1')
  const entry = input(copy.entry, 'src/index.ts')
  const source = textarea(copy.source, example, 13)
  const deps = textarea(copy.dependencies, '{}', 2)
  const peers = textarea(copy.peers, '{}', 2)
  const actions = document.createElement('div')
  actions.className = styles.actions ?? ''
  const install = document.createElement('button')
  install.type = 'submit'
  install.textContent = copy.install
  const remove = button(copy.remove, () => { void run(removePlugin) })
  const refresh = button(copy.refresh, () => { void run(refreshInstalled) })
  actions.append(install, remove, refresh)
  fields.append(actions)
  form.append(fields)
  const outcome = document.createElement('pre')
  outcome.className = styles.outcome ?? ''
  outcome.setAttribute('role', 'status')
  outcome.setAttribute('aria-live', 'polite')
  outcome.textContent = copy.idle
  const installedTitle = document.createElement('h3')
  installedTitle.textContent = copy.installed
  const installed = document.createElement('ul')
  installed.className = styles.installed ?? ''
  body.append(notice, hint, target, form, outcome, installedTitle, installed)
  dialog.append(header, body)
  const launcherParent = presentation?.launcherParent ?? document.body
  launcherParent.append(launcher)
  document.body.append(dialog)
  let busy = false
  let disposed = false

  function button(text: string, action: () => void): HTMLButtonElement {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = text
    element.addEventListener('click', action, options)
    return element
  }

  function label(text: string, control: HTMLElement): void {
    const element = document.createElement('label')
    const caption = document.createElement('span')
    caption.textContent = text
    element.append(caption, control)
    fields.append(element)
  }

  function input(text: string, value: string, type = 'text'): HTMLInputElement {
    const element = document.createElement('input')
    element.type = type
    element.value = value
    element.required = true
    label(text, element)
    return element
  }

  function textarea(text: string, value: string, rows: number): HTMLTextAreaElement {
    const element = document.createElement('textarea')
    element.value = value
    element.rows = rows
    element.required = true
    element.spellcheck = false
    label(text, element)
    return element
  }

  async function runtime(path: string, value?: object): Promise<Record<string, unknown>> {
    return readResponse(await hostFetch(`/__forge/${path}`, value === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    }), copy)
  }

  async function refreshInstalled(): Promise<void> {
    const value = await runtime('installed')
    if (!Array.isArray(value.plugins)) throw new Error(copy.response)
    const rows = value.plugins.map((plugin: unknown) => {
      if (!record(plugin) || typeof plugin.pluginId !== 'string' || typeof plugin.revision !== 'string'
        || (plugin.status !== 'active' && plugin.status !== 'disabled' && plugin.status !== 'activation-failed')) throw new Error(copy.response)
      const row = document.createElement('li')
      row.textContent = `${plugin.pluginId} · ${plugin.status === 'active' ? copy.active : plugin.status === 'disabled' ? copy.disabled : copy.failed} · ${plugin.revision.slice(0, 12)}`
      if (typeof plugin.message === 'string') row.append(document.createTextNode(`\n${plugin.message}`))
      return row
    })
    if (disposed) return
    if (rows.length === 0) {
      const row = document.createElement('li')
      row.textContent = copy.empty
      rows.push(row)
    }
    installed.replaceChildren(...rows)
    target.textContent = `${copy.generation}: ${String(value.generation)}`
  }

  async function mutate(path: string, value: object): Promise<void> {
    let result: Record<string, unknown>
    try { result = await runtime(path, value) } catch (error) {
      if (error instanceof ForgeResponseError) throw error
      throw new Error(`${copy.unknownResult}\n${error instanceof Error ? error.message : String(error)}`)
    }
    if (!['active', 'disabled', 'removed', 'activation-failed'].includes(String(result.status))) throw new Error(copy.unknownResult)
    const status = result.status === 'active' ? copy.active : result.status === 'disabled' ? copy.disabled : result.status === 'removed' ? copy.removed : copy.failed
    outcome.textContent = `${status}\n${copy.revision}: ${String(result.revision)}\n${copy.downloaded}: ${String(result.downloadedFiles)} · ${copy.written}: ${String(result.writtenFiles)}`
    if (typeof result.message === 'string') outcome.textContent += `\n${result.message}`
    if (Array.isArray(result.observerErrors) && result.observerErrors.length > 0) {
      outcome.textContent += `\n${copy.observer}: ${result.observerErrors.map(String).join('; ')}`
    }
    try { await refreshInstalled() } catch (error) {
      outcome.textContent += `\n${copy.statusFailure}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function serverBaseUrl(): string {
    let url: URL
    try { url = new URL(backend.value) } catch (error) {
      throw new Error(copy.address, { cause: error })
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) throw new Error(copy.address)
    return url.href.replace(/\/$/, '')
  }

  async function buildTarget(baseUrl: string): Promise<Record<string, unknown>> {
    await runtime('configure', { baseUrl })
    const hostTarget = await runtime('target')
    const serviceTarget = await readResponse(await request(`${baseUrl}/v1/target`), copy)
    if (typeof hostTarget.generation !== 'string' || hostTarget.generation !== serviceTarget.generation) throw new Error(copy.target)
    for (const field of ['hostPackages', 'clientPackages']) {
      const expected = field === 'clientPackages' ? (hostTarget[field] ?? {}) : hostTarget[field]
      const actual = field === 'clientPackages' ? (serviceTarget[field] ?? {}) : serviceTarget[field]
      if (!record(expected) || !record(actual) || Object.keys(expected).length !== Object.keys(actual).length
        || Object.entries(expected).some(([name, version]) => typeof version !== 'string' || actual[name] !== version)) {
        throw new Error(copy.packageTarget)
      }
    }
    const expectedShared = hostTarget.sharedPackages
    const actualShared = serviceTarget.sharedPackages
    if (!Array.isArray(expectedShared) || !Array.isArray(actualShared)
      || expectedShared.some(name => typeof name !== 'string' || !name)
      || actualShared.some(name => typeof name !== 'string' || !name)
      || new Set(expectedShared).size !== expectedShared.length || new Set(actualShared).size !== actualShared.length
      || expectedShared.length !== actualShared.length || expectedShared.some(name => !actualShared.includes(name))) {
      throw new Error(copy.packageTarget)
    }
    return hostTarget
  }

  async function installPackage(): Promise<void> {
    const baseUrl = serverBaseUrl()
    const hostTarget = await buildTarget(baseUrl)
    const manifest = await readResponse(await request(`${baseUrl}/v1/packages/builds`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, generation: hostTarget.generation, pluginId: id.value.trim(), spec: npmSpec.value.trim() }),
    }), copy)
    await mutate('install', { manifest, baseUrl })
  }

  async function buildAndInstall(): Promise<void> {
    const baseUrl = serverBaseUrl()
    const dependencyMap = dependencies(deps.value, copy)
    const peerMap = dependencies(peers.value, copy)
    const hostTarget = await buildTarget(baseUrl)
    const manifest = await readResponse(await request(`${baseUrl}/v1/builds`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, generation: hostTarget.generation, plugin: {
        id: id.value.trim(), name: name.value.trim(), version: version.value.trim(), entry: entry.value.trim(),
        files: { [entry.value.trim()]: source.value }, dependencies: dependencyMap, peerDependencies: peerMap,
      } }),
    }), copy)
    await mutate('install', { manifest, baseUrl })
  }

  async function removePlugin(): Promise<void> {
    await mutate('remove', { pluginId: id.value.trim() })
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy || disposed) return
    busy = true
    fields.disabled = true
    outcome.textContent = copy.busy
    try {
      await action()
      if (outcome.textContent === copy.busy) outcome.textContent = copy.idle
    } catch (error) {
      outcome.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      fields.disabled = false
      busy = false
    }
  }

  launcher.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal()
    void run(refreshInstalled)
  }, options)
  dialog.addEventListener('keydown', (event) => { event.stopPropagation() }, options)
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect()
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom
      if (outside) dialog.close()
    }
  }, options)
  form.addEventListener('submit', (event) => { event.preventDefault(); void run(buildAndInstall) }, options)
  void run(async () => {
    await runtime('configure', { baseUrl: serverBaseUrl() })
    await refreshInstalled()
  })
  return () => {
    disposed = true
    releaseFetch()
    events.abort()
    dialog.close()
    dialog.remove()
    launcher.remove()
  }
}
