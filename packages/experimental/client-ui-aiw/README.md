---
description: "Manage Worker-local plugin projects, files, revision recovery and portable backups from the dsh-aib page."
kind: "package-reference"
---

# `@deepseek-ai/dsh-experimental-client-ui-aiw`

English | [中文](README.zh.md)

## Summary

Open **dsh-aib** below Plugins to edit virtual files, create and build local plugins, recover retained revisions, run limited commands and exchange workspace or plugin backups. Source drafts survive panel navigation. This page belongs to the browser Worker deployment and uses its existing transport, Forge installer and storage provider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

AIB means **All in Browser**. The package name, panel ID `dsh-aiw`, `/__aiw/` routes and `.aiw` data directory retain their existing identifiers; saved projects, revisions and settings use the same storage.

The Worker image includes this marker plugin and discovers its Client entry through `dsh.client`. Open the left sidebar’s **dsh-aib** page. No separate Node application or npm publication is needed for a local project.

| Section | Operations |
|---|---|
| Plugins | Create a source project, build through Forge, inspect installed state, recover or export a retained revision, and temporarily install npm plugins. |
| Files | Browse readable VFS paths, edit text, create files/folders, rename and delete. Existing-file saves require the last-read hash; conflicts keep the draft. |
| Command line | Run the limited Worker shell from the selected directory; inspect stdout, stderr and the exit code or cancel an active call. |
| Backups | Download a file-tree or plugin-revision JSON archive; preview file imports before restoring into an empty directory, or confirm a plugin import through the installer. |
| Settings | Configure the Forge endpoint and inspect the generation, workspace and profile paths. |

To update a source plugin, edit it through **Open source**, use **Save file**, and then **Build project**. **Save file** writes the editor draft to the VFS; building compiles those saved files and applies the plugin update. **Save now** confirms browser persistence after you verify the result; it does not save an open editor draft or rebuild source.

Build results establish Host activation only. Verify a Client component separately in the running page. The official Plugins page retains its installation controls during this transition; the temporary npm form here can be removed after those controls use the Worker installer.

Use **Save now** beside the page title before closing the browser. The workbench shows acknowledged browser-storage status; terminal storage and startup failures also remain visible outside the page. The storage provider owns persistence; the page does not turn an unconfirmed operation into a saved result.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client registers ordinary `sidebar.panellist`, `main` and `shell.overlay` contributions. A plugin-scoped controller owns cancellation, query snapshots, editor drafts and notices; components receive only renderer-bound snapshots and callbacks. Mutations use the Worker-local AIB endpoint, keeping build requests on the configured outbound HTTP provider. Closing a panel retains its draft, while unloading the plugin aborts outstanding requests and prevents late publication.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worker runtime](../webworker-runtime/README.md) — file access, history archives, shell and installer behavior.
- [VFS packer](../webworker-packer/README.md) — Worker deployment composition.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers only browser navigation and controls.

#### KV Cache effect

None directly; request construction and model-visible effects of installed plugins belong to their owning packages.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Backups cover selected readable file trees or complete retained plugin revisions; protected credential files are excluded, and imports do not replace the active profile or Session database.
- The shell is a bounded virtual command table, not an OS terminal. Each invocation starts in its selected directory.
- Local drafts survive navigation in the current page. Use **Save file** to write a draft, then **Save now** before a reload. File conflicts retain the draft rather than overwriting another writer.

-----

<a id="dev-note"></a>
### Dev Note

None.
