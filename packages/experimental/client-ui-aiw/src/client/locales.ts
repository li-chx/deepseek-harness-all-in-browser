/** Copy owned by the browser workbench. */
export const en = {
  client: 'Client', active: 'Active', disabled: 'Disabled', failed: 'Activation failed',
  unknownOutcome: 'The operation result could not be confirmed. Refresh before retrying. {message}', backupName: 'Name', backupId: 'Plugin ID', backupVersion: 'Version', backupRevision: 'Revision', backupFiles: 'Source files', backupObjects: 'Artifact files', previewHint: 'Metadata preview. The Worker validates artifacts before installation.',
  observerWarning: 'The plugin change was applied, but file observers reported errors. Refresh status before continuing. {message}',
  saveNow: 'Save now', reload: 'Reload', storageSaved: 'Saved in this browser', storagePending: 'Saving locally…', storageDisabled: 'Local saving is disabled for this page', storageFailed: 'Local saving stopped. Recent changes may be unsaved. Reload to reopen saved data.', storageConflict: 'Another tab saved changes. Reload to open the saved version.', storageUnconfirmed: 'Saving could not be confirmed. Reload to reopen saved data.',
  importTooLarge: 'Choose a backup smaller than 48 MiB.',
  title: 'dsh-aiw', subtitle: 'All in web · your files, plugin sources and saved revisions',
  plugins: 'Plugins', files: 'Files', terminal: 'Command line', backups: 'Backups', settings: 'Settings', tabs: 'Workbench sections',
  refresh: 'Refresh', retry: 'Retry', done: 'Completed', close: 'Close', cancel: 'Cancel', loading: 'Loading workbench',
  projects: 'Source projects', projectDirectory: 'Project directory', packageName: 'Package name', includeClient: 'Include Client', createProject: 'Create project', buildProject: 'Build project', openSource: 'Open source', noProjects: 'No source projects yet',
  installed: 'Installed plugins', noPlugins: 'No Forge plugins installed', history: 'History', exportPlugin: 'Export plugin', removePlugin: 'Remove', versions: 'Saved versions', noVersions: 'No saved revisions', restore: 'Restore version', sourceIncluded: 'Source included', artifactsOnly: 'Artifacts only',
  npmPackage: 'npm package', installPackage: 'Install npm package', temporaryInstall: 'Package installation is available here while the Plugins page is being adapted.',
  hostOutcome: 'Build results report Host activation. Verify the page component after a Client build.',
  path: 'Path', openDirectory: 'Open directory', readFile: 'Read file', parent: 'Parent directory', fileContents: 'File contents', saveFile: 'Save file', newFile: 'New file', newFolder: 'New folder', rename: 'Rename', delete: 'Delete', name: 'Name', targetPath: 'Target path', emptyDirectory: 'This directory is empty', readOnly: 'Read only', editing: 'Editing', unsaved: 'Unsaved changes', discardTitle: 'Discard unsaved changes?', discardDetail: 'Your current draft has not been saved.', discard: 'Discard changes', keepEditing: 'Keep editing',
  workingDirectory: 'Working directory', command: 'Command', runCommand: 'Run command', cancelCommand: 'Cancel command', shellHint: 'Each run starts in the selected directory and uses the limited Worker shell. Node, pnpm and OS programs are unavailable.', output: 'Operation output',
  exportDirectory: 'Export directory', exportFiles: 'Export files', importFile: 'Import file', importDirectory: 'Import directory', previewImport: 'Preview import', applyImport: 'Apply import', noImport: 'Choose a JSON backup to inspect before importing.', importHint: 'File backups restore into an empty directory. Plugin backups restore code through the normal installer. Protected credential files are excluded; imports do not restore an active profile or session database.', importPreview: 'Import preview', previewFiles: '{count} files · {bytes} bytes', conflicts: 'Destination conflicts', pluginBackup: 'Plugin backup', filesBackup: 'File backup', downloadReady: 'Backup downloaded', invalidArchive: 'Choose a valid JSON backup.',
  forgeUrl: 'Forge server URL', saveSettings: 'Save settings', generation: 'Build generation', workspace: 'Workspace', profile: 'Profile', storageHint: 'Files and revision history follow this page’s storage provider. Use Save now before closing the page.',
  confirmTitle: 'Confirm operation', deleteDetail: 'Delete {path}? This also deletes its contents when it is a directory.', removeDetail: 'Remove {name}? The source project and saved revisions are retained.', restoreDetail: 'Restore this saved plugin revision? Its saved source, when present, replaces the associated source files.', pluginImportDetail: 'Install this plugin backup into the current profile?',
  folderCreated: 'Folder created', fileSaved: 'File saved', renamed: 'Renamed', deleted: 'Deleted', projectCreated: 'Project created', pluginRemoved: 'Plugin removed', versionRestored: 'Version restored', importComplete: 'Import completed', settingsSaved: 'Settings saved',
}
/** Dictionary keys consumed by the workbench registrations. */
export type AiwKey = keyof typeof en
/** Chinese counterpart with the same typed keys. */
export const zh: Record<AiwKey, string> = {
  client: 'Client', active: '已激活', disabled: '已禁用', failed: '激活失败',
  unknownOutcome: '无法确认操作结果，请先刷新再重试。{message}', backupName: '名称', backupId: '插件 ID', backupVersion: '版本', backupRevision: '修订', backupFiles: '源文件', backupObjects: '产物文件', previewHint: '此处为元数据预览，Worker 会在安装前校验产物',
  observerWarning: '插件更改已应用，但文件观察者报告了错误。请刷新状态后再继续。{message}',
  saveNow: '立即保存', reload: '重新加载', storageSaved: '已保存在此浏览器', storagePending: '正在保存到本地…', storageDisabled: '此页面未启用本地保存', storageFailed: '本地保存已停止，最近的更改可能尚未保存。请重新加载以打开已保存的数据', storageConflict: '另一个标签页已保存更改，请重新加载以打开已保存的版本', storageUnconfirmed: '无法确认保存结果，请重新加载以打开已保存的数据',
  importTooLarge: '请选择小于 48 MiB 的备份',
  title: 'dsh-aiw', subtitle: 'All in web · 文件、插件源码与历史版本', plugins: '插件', files: '文件', terminal: '命令行', backups: '备份', settings: '设置', tabs: '工作台功能',
  refresh: '刷新', retry: '重试', done: '已完成', close: '关闭', cancel: '取消', loading: '正在读取工作台',
  projects: '源码项目', projectDirectory: '项目目录', packageName: '包名', includeClient: '包含 Client', createProject: '创建项目', buildProject: '构建项目', openSource: '打开源码', noProjects: '尚无源码项目',
  installed: '已安装插件', noPlugins: '尚未安装 Forge 插件', history: '历史版本', exportPlugin: '导出插件', removePlugin: '卸载', versions: '已保存版本', noVersions: '尚无历史版本', restore: '恢复版本', sourceIncluded: '包含源码', artifactsOnly: '仅包含产物',
  npmPackage: 'npm 包', installPackage: '安装 npm 包', temporaryInstall: '插件页面适配完成前，可在这里安装 npm 插件', hostOutcome: '构建结果说明 Host 激活状态。构建 Client 后，请验证页面组件',
  path: '路径', openDirectory: '打开目录', readFile: '读取文件', parent: '上级目录', fileContents: '文件内容', saveFile: '保存文件', newFile: '新建文件', newFolder: '新建文件夹', rename: '重命名', delete: '删除', name: '名称', targetPath: '目标路径', emptyDirectory: '此目录为空', readOnly: '只读', editing: '正在编辑', unsaved: '尚未保存', discardTitle: '放弃未保存的更改？', discardDetail: '当前编辑内容尚未保存', discard: '放弃更改', keepEditing: '继续编辑',
  workingDirectory: '工作目录', command: '命令', runCommand: '运行命令', cancelCommand: '取消命令', shellHint: '每次从所选目录开始，在虚拟文件系统中运行精简 Worker shell，不提供 Node、pnpm 或系统程序', output: '操作输出',
  exportDirectory: '导出目录', exportFiles: '导出文件', importFile: '导入文件', importDirectory: '导入目录', previewImport: '预览导入', applyImport: '执行导入', noImport: '请选择 JSON 备份文件，检查后再导入', importHint: '文件备份恢复到空目录。插件备份通过标准安装流程恢复代码。受保护的凭据文件不会导出，导入不会替换运行中的 profile 或会话库', importPreview: '导入预览', previewFiles: '{count} 个文件 · {bytes} 字节', conflicts: '目标路径冲突', pluginBackup: '插件备份', filesBackup: '文件备份', downloadReady: '备份已下载', invalidArchive: '请选择有效的 JSON 备份',
  forgeUrl: 'Forge 服务地址', saveSettings: '保存设置', generation: '构建代际', workspace: '工作区', profile: 'Profile', storageHint: '文件和版本历史使用此页面的存储提供者。关闭页面前，请使用“立即保存”',
  confirmTitle: '确认操作', deleteDetail: '删除 {path}？如果是目录，也会删除其中的内容', removeDetail: '卸载 {name}？源码项目和历史版本会保留', restoreDetail: '恢复这个插件历史版本？若包含源码，将覆盖关联的源文件', pluginImportDetail: '将此插件备份安装到当前 profile？',
  folderCreated: '文件夹已创建', fileSaved: '文件已保存', renamed: '已重命名', deleted: '已删除', projectCreated: '项目已创建', pluginRemoved: '插件已卸载', versionRestored: '版本已恢复', importComplete: '导入已完成', settingsSaved: '设置已保存',
}
