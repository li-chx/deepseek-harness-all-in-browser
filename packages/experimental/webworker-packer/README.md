---
description: "Browser-worker VFS image packaging for maintainers building or debugging the experimental preview deployment."
kind: "package-library"
---

# `@deepseek-ai/dsh-experimental-webworker-packer`

English | [中文](README.zh.md)

## Summary

The VFS image packer: turns one shipped profile's bundles and the installation's optional bundles into the gzip-compressed base tar the browser worker mounts as its filesystem, one archive per lazily loaded page chunk, and opaque data trees into ordered overlay tars ([experimental group](../README.md)). Nothing is compiled from source — the base image carries the repository's real build products, so a preview deployment debugs exactly what the served deployment ships. Read this page when packaging a preview image or diagnosing its contents.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The public npm package exposes `packVfsImage` and `packVfsOverlay` through its library entry. Callers supply the profile name, the package roster, the installation manifest, package directories, and the resolution root; no profile layer is installed and no composed configuration is packed — the worker composes the bundle layers at boot. An optional `homePatch` is written to `home/cordis.patch.yml`, the home layer the image's app-boot reads. The runtime's library entry supplies the module-proxy and replacement tables used during packing.

The packer owns the internal `dsh.configTrees` declaration, its validation, and source directory resolution in [`src/repository.ts`](src/repository.ts). This field is not part of the public plugin manifest API.

The pack is a three-layer standard stack:

1. **Roster** — the shipped profile template's bundles and every bundle in app-boot's `OPTIONAL_BUNDLES`, each resolved from the CLI manifest as the launcher resolves it, plus every package their patch files name (insert lists and grouped rows included), plus the rows of every config tree the CLI declares in its `package.json` `dsh.configTrees`, materialized as a Node-style dependency closure. External peer edges never bind the worker; workspace peers stay on the chain. The CLI manifest itself enters the image alone at `node_modules/@deepseek-ai/dsh/package.json`, as the worker's bundle resolution anchor; the manifest records its name and the profile.
2. **Publish view** — each workspace or vendored package contributes its built npm slice (`files` through picomatch) without source or workspace `dist/`. External packages retain published JavaScript under both `src/` and `dist/` because their `main` or `exports` may point there; only generic test, map, declaration, and archive exclusions apply.
3. **Reachability sweep** — the runtime loader's own resolution walks from every non-wildcard workspace runtime export plus the worker assembly's seeds (`IMAGE_ENTRY_SEEDS`), lowering each reached module to the wrapper contract at pack time. Declaration-only condition trees do not seed the sweep; runtime requests for those exports still fail. The transform reports statically named imports, re-exports, and dynamic imports; calls through `require`; and module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named import from `node:module` or `module`, including an import alias. Page assets (`lib/client.js` behind `./client` exports) ship verbatim; an unresolvable request from our own code fails the pack, third-party ones are tolerated to fail loud at require time.
4. **Lazy chunks** — every page chunk a page asset requests as a literal `require.async("./client.<name>.js")`, the only form the dynamic Client build emits, leaves the base image unless a `./client` export names it. Each becomes its own deterministic archive named `lazy/<sha256 of the archive>.tar.gz` beside the base image, and the manifest registers its path, size, and archive for the worker's lazy filesystem. A request for a chunk the package does not publish fails the pack.

`repository.ts` owns the repo-shaped inputs (workspace scan of `vendor/`, `packages/`, `native/system/packages/`, and `apps/`; the profile roster through app-boot's shipped templates, optional-bundle list, and bundle patch readers; the CLI manifest as the installation; the home patch, which sets the runtime's `PLATFORM_ENTRY_CONFIG` fields over each named row's config composed from the template's bundle layers); `pack.ts` owns none of them, so the same library packs a different tree by being called differently. The native scan makes the Landlock entry package an ordinary published-view dependency while its executable remains a Worker platform implementation. The CLI is `dsh-pack-vfs-image --out <file> [--profile web]`; it writes the lazy archives beside the base image, and `apps/web`'s `build:preview` runs it after the preview shell build.

The repository image home patch also installs Worker environment guidance and an HMR watch on the profile’s `plugins/` directory, and disables the Node-checkout `harness-dev-context`. Models can register CommonJS Host plugins and edit their JS to trigger replacement; this path does not compile TS/TSX, build Client assets or provide persistence across page reloads.

The repository adapter also declares the preview-only fixture trees under `webworker-runtime/tests/fixtures/`. The CLI packs each named fixture into a separate deterministic overlay archive plus a browser-readable manifest. Overlay files bypass npm publish-view and module-reachability exclusions, so dot directories and example source files remain intact; their mounts are limited to `home/` and `workspace/`. `packVfsOverlay` treats all files as opaque bytes.

`packPreviewFixture` prepares the newest canonical raw Session generation in each fixture directory through the [Session format catalog](../../session/session-format-catalog/README.md) in Node. It collects direct-child discovery evidence from the same fixture root before completing historical parent catalogs. It strictly restores the source, encodes and strictly validates the current successor, and packs that successor beside unchanged source files. A malformed, unsupported, or future selected generation refuses the build without falling back. Temporary successors are removed after packing. Browser write-open then uses current data without invoking Node's migration-verification Worker. Projection caches remain owner-validated; an older generation cannot supply a current fold checkpoint.

-----

<a id="model-experience"></a>
## Model Experience

### Worker deployment system prompt

#### What the model sees

Repository images install the following guidance through `systemPrompt.personaPrefix` and the standard, PTC and Cordis preset personas, recorded in the Session by the ordinary system-prompt pipeline. The minimal preset keeps its complete persona; Cordis supplies the inspection tools needed for plugin authoring. Paths depend on the image root and profile; this is the default web deployment.

##### Default web image prompt

```markdown
You are running inside the DeepSeek Harness browser Worker preview. The files you can access belong to its in-memory virtual filesystem, not the user's computer. This is a static webpage with a Worker Host, not a Node development checkout. Files and plugin edits survive only this Worker lifetime unless a separate persistence provider is configured; never promise that a page reload will preserve them.

Environment:
- The mounted root is "/dsh". The profile patch is "/dsh/home/profiles/web/cordis.patch.yml". Author local Host plugins under "/dsh/home/profiles/web/plugins". Use pwd to identify the current working directory.
- Prefer the available read, write and edit tools for source and configuration. The shell supports a limited command table: pwd, ls, find, mkdir, cp, mv, rm, cat, head, tail, grep, wc, sort, uniq, cut, tr, printf, echo, tee, sed and which. Options are limited; sed supports substitution only. There is no node, npm, pnpm, npx, tsc, git, python, rg, jq, curl or wget executable. Do not attempt package installation, compilation, a development server or shell loops and heredocs.
- Installed modules can be loaded by require; missing modules cannot be installed here. Host plugins have no window or document. This Host module reload path does not compile TS/TSX or rebuild browser Client bundles. A requested page UI change requires a supported Client registration mechanism; inspect the runtime before promising it.
- The shipped cordis-plugin-development skill's package-installation workflow assumes Node. In this Worker, use the local JS and profile patch workflow below; do not call install_bundle or promise persistence. Normal file permissions still apply; request approval when a write lies outside the session workspace.

When asked to create or update a Host plugin:
1. Use the Cordis agent preset for plugin development. If cordis_inspect_list is unavailable, ask the user to switch to Cordis. Call cordis_inspect_list, then use the advertised cordis_inspect_query methods to read the actual Service and plugin APIs. Inspect the current profile patch before editing it. Do not guess service names or parameters.
2. Write executable CommonJS-style JavaScript: exports.name, exports.inject and exports.apply, with require for imports. Do not write ESM import/export statements, TypeScript, JSX, top-level await or mixed default/named plugin exports. Prefer synchronous registration callbacks; native async/await in newly authored files has not passed through the image's async-context transform.
3. Use lifecycle-owned APIs. ctx.on and systemPrompt.section register their own effects. Wrap other registrations that return a disposer in ctx.effect; register cleanup for timers and external side effects. Declare required services in exports.inject. Optional services use ctx.get.
4. After the JS file is complete, add one uniquely identified Loader row to the existing profile patch. Preserve all existing patch operations. JSON arrays are valid YAML. For an otherwise empty patch, the complete example is:
[{"insert":[{"id":"local-greeting","name":"file:///dsh/home/profiles/web/plugins/local-greeting.js"}]}]
For an existing patch, append an insert operation or add the row to its existing insert list. Use the file URL as the plugin name; a source file alone is not a registered plugin.
5. With HMR active, profile patch changes load new rows, and changes to loaded JS files under the plugin directory replace their affected plugins and importers. The web image enables this directory watch. Keep an existing plugin's id and file URL stable during updates. To remove it, first remove its row and confirm it unloaded, then delete the file. Do not overwrite startup packages or the Worker bundle: protected host dependencies require a new Worker.
6. Verify the runtime entry is active and exercise the new behavior. A successful file write alone does not prove activation. If import or activation fails, inspect the error, fix the file and retry; the old affected plugin may already have stopped. Unrelated plugins continue running. Prompt/tool changes may become visible on the next model request; do not claim the current request already used them.

Minimal Host plugin (file:///dsh/home/profiles/web/plugins/local-greeting.js):
exports.name = 'local-greeting';
exports.inject = ['systemPrompt'];
exports.apply = ctx => {
  ctx.systemPrompt.section({
    name: 'local:greeting', order: 1000, interpolate: false,
    text: 'When the user sends exactly WORKER_HELLO, reply exactly: Hello from plugin v1.'
  });
};

For a first smoke test, register this plugin, ask the user to send WORKER_HELLO, then change v1 to v2 in the same file and test again without refreshing the page. This verifies Host plugin replacement, not browser UI replacement.
```

#### Token effect

Each conversation request containing the deployment prompt carries this fixed text; its length varies only with the root, profile and guidance.

#### KV Cache effect

The deployment text is a stable repeated prefix within one image. Changing the root, profile or guidance replaces tokens in that prefix and may affect subsequent prefix reuse; provider cache availability is outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The rule tables are judgement calls** (`rules.ts`: exclude globs, page-asset patterns, entry seeds) pinned by `tests/`; a new asset class the worker must reach needs a table row, not a scanner change.
- **Reachability infers only exact request forms** — computed `import` and `require` arguments, stored `createRequire` results, CommonJS-obtained `createRequire`, and bases other than `import.meta.url` resolve only at runtime and fail loud if the target was otherwise pruned; a target reachable only through those forms needs an explicit image entry seed.
- **Vendored package sources (`src/*.ts`) are excluded** — nothing resolves them at runtime; a future in-worker source-inspection feature would need a dedicated include rule.
- **The packer assumes built `lib/` artifacts are current**: it never compiles, so a stale workspace build packs stale bytes. Run the repository build first.
- **The CLI requires its original repository location**: `dsh-pack-vfs-image` finds the checkout relative to its own installed file and reads the source CLI, configuration trees, and preview fixtures there. An npm installation supports the parameterized library API; the CLI and repository helpers require a complete, built DeepSeek Harness checkout.
- **Preview Session inputs use raw JSONL** — `packPreviewFixture` rejects compressed and noncanonical Session generation filenames. Generic overlays remain byte-preserving.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
