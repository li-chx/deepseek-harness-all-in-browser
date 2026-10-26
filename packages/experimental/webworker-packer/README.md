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

The public npm package exposes `packVfsImage` and `packVfsOverlay` through its library entry. Callers supply the profile name, the package roster, the installation manifest, package directories, and the resolution root; no profile layer is installed and no composed configuration is packed — the worker composes the bundle layers at boot. An optional `homePatch` is written to `home/cordis.patch.yml`, the home layer the image's app-boot reads. Optional `clientPackages` records exact versions of page-shared modules without materializing them as Worker packages. The repository adapter derives this roster from the Client `PLATFORM_MODULES` table and package manifests resolved from `client-web`, then stores it in the base-image manifest. The runtime's library entry supplies the module-proxy and replacement tables used during packing.

The packer owns the internal `dsh.configTrees` declaration, its validation, and source directory resolution in [`src/repository.ts`](src/repository.ts). This field is not part of the public plugin manifest API.

The pack is a three-layer standard stack:

1. **Roster** — the shipped profile template's bundles and every bundle in app-boot's `OPTIONAL_BUNDLES`, each resolved from the CLI manifest as the launcher resolves it, plus every package their patch files name (insert lists and grouped rows included), plus the rows of every config tree the CLI declares in its `package.json` `dsh.configTrees`, materialized as a Node-style dependency closure. External peer edges never bind the worker; workspace peers stay on the chain. The CLI manifest itself enters the image alone at `node_modules/@deepseek-ai/dsh/package.json`, as the worker's bundle resolution anchor; the manifest records its name and the profile.
2. **Publish view** — each workspace or vendored package contributes its built npm slice (`files` through picomatch) without source or workspace `dist/`. External packages retain published JavaScript under both `src/` and `dist/` because their `main` or `exports` may point there; only generic test, map, declaration, and archive exclusions apply.
3. **Reachability sweep** — the runtime loader's own resolution walks from every non-wildcard workspace runtime export plus the worker assembly's seeds (`IMAGE_ENTRY_SEEDS`), lowering each reached module to the wrapper contract at pack time. Declaration-only condition trees do not seed the sweep; runtime requests for those exports still fail. The transform reports statically named imports, re-exports, and dynamic imports; calls through `require`; and module-scope direct calls of the form `createRequire(import.meta.url)('pkg')` through a named import from `node:module` or `module`, including an import alias. Page assets (`lib/client.js` behind `./client` exports) ship verbatim; an unresolvable request from our own code fails the pack, third-party ones are tolerated to fail loud at require time.
4. **Lazy chunks** — every page chunk a page asset requests as a literal `require.async("./client.<name>.js")`, the only form the dynamic Client build emits, leaves the base image unless a `./client` export names it. Each becomes its own deterministic archive named `lazy/<sha256 of the archive>.tar.gz` beside the base image, and the manifest registers its path, size, and archive for the worker's lazy filesystem. A request for a chunk the package does not publish fails the pack.

`repository.ts` owns the repo-shaped inputs (workspace scan of `vendor/`, `packages/`, `native/system/packages/`, and `apps/`; the profile roster through app-boot's shipped templates, optional-bundle list, and bundle patch readers; the CLI manifest as the installation; the home patch, which sets the runtime's `PLATFORM_ENTRY_CONFIG` fields over each named row's config composed from the template's bundle layers); `pack.ts` owns none of them, so the same library packs a different tree by being called differently. The native scan makes the Landlock entry package an ordinary published-view dependency while its executable remains a Worker platform implementation. The CLI is `dsh-pack-vfs-image --out <file> [--profile web]`; it writes the lazy archives beside the base image, and `apps/web`'s `build:preview` runs it after the preview shell build.

The repository image home patch also installs Worker environment guidance and an HMR watch on the profile’s `plugins/` directory, and disables the Node-checkout `harness-dev-context` and native ripgrep-backed tools in the base composition and shipped presets. Models can build Host source through Forge or edit CommonJS plugins directly to trigger replacement; neither local path registers Client modules or custom display exports. File persistence depends on the page’s configured storage provider. Development skills select the deployment-specific installation workflow.

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
You are running inside the DeepSeek Harness browser Worker preview. Files belong to its virtual filesystem, not the user's computer. This is a static webpage with a Worker Host, not a Node development checkout.

Environment:
- The mounted root is "/dsh"; the profile patch is "/dsh/home/profiles/web/cordis.patch.yml". Use pwd to locate the session workspace. Prefer read, write and edit tools for source and configuration.
- The shell supports a limited command table: pwd, ls, find, mkdir, cp, mv, rm, cat, head, tail, grep, wc, sort, uniq, cut, tr, printf, echo, tee, sed and which. Options are limited; sed supports substitution only. There is no local node, npm, pnpm, npx, tsc, git, python, rg, jq or wget. Do not start local compilers, development servers, shell loops or heredocs.
- Native ripgrep-backed grep/glob tools are disabled in the shipped Worker presets. Search a known directory with shell find or grep; prefer read with line limits for file excerpts. Shell grep uses JavaScript regular expressions or -F literals, not POSIX basic regex; use a|b, not escaped alternation. It does not implement -o. head/tail support -n, not -c; sed does not support line-address scripts. Never treat an unsupported option or a failed tool as proof that content is absent.
- With a configured Forge service, dsh plugin --profile "web" add <npm-spec>, update <npm-spec> and remove <package-name> manage plugins. Declare missing dependencies in your source manifest and rebuild. These commands do not provide a general npm CLI or upgrade fixed DSH/Client packages. curl supports a limited GET/HEAD subset, not arbitrary POST commands. Network requests use the configured HTTP provider; browser Fetch still requires the remote server's CORS permission.
- Host plugins have no window or document. Forge's local source build compiles Host JavaScript/TypeScript, ESM and async functions; module top-level await is unsupported. Both CommonJS exports and ESM named exports work through Forge. The direct-JavaScript fallback below accepts only its stated CommonJS subset.
- Local source builds are Host-only: forge.json cannot declare client, dsh, exports, icons or locale exports. Listing client.js does not register a Client module, even if already compiled. The root package.json is reserved and generated by Forge; do not upload or modify it to bypass this limit. Published npm packages use a different build path that can preserve supported dsh.client metadata and a precompiled ./client export. That support does not extend to locally authored source packages.
- For a new on-page component, report the missing local Client build path immediately. A slash-command result in chat is not an independently rendered page component. Do not try alternate manifests, install_bundle, file: package specs or repeated inspection as workarounds. Offer a Host-only portion only with this limitation explicit; do not report the original UI goal complete. Local source packages currently use their package name and default inventory icon; the Node skill's custom display-resource checklist cannot be satisfied on this path.
- Deployment instructions here take precedence over Node workflows in development skills. plugin_manager list operations may be useful, but install_bundle needs Node/execa/pnpm and is unavailable here. Use the virtual dsh commands for mutations; add/update accept npm package specs, not local directories or file: URLs. The commands listed here are the supported CLI, not the full Node dsh CLI; --dump-config and useful --help output are unavailable. Tool approval follows the active policy; do not infer approval or execution support from another action's success.
- web_fetch may fail because its native DNS provider is unavailable, and its public-address policy rejects private hosts. A read-only public URL may instead work with curl if the browser permits it. A DNS/CORS/policy error does not establish that a page is missing. Do not guess localhost ports: they refer to the user's device, not the Forge server.
- With persistence enabled, files under "/dsh/home" and "/dsh/workspace", including plugin sources and installed artifacts, can survive refresh after storage commits. Before refreshing, use the page's manual save action to drain Session writes and check its result. Automatic VFS storage status does not mean all application buffers are saved. Without persistence, edits last only for this Worker. Normal write permissions still apply outside the session workspace.

Preferred Host plugin workflow:
1. Use the Cordis agent preset. If cordis_inspect_list is unavailable, ask the user to switch to Cordis. Call cordis_inspect_list and the advertised cordis_inspect_query methods to inspect real Service/plugin APIs; do not guess names or parameters. Query the specific service or slot needed, then implement. Avoid dumping all installed plugins or reading large compiled Client bundles. Config status absent means no Config schema, not failed activation; use the build's activation report and the actual behavior to verify activation.
2. Create ./greeting-source inside the session workspace. Write forge.json with this minimal example:
{"id":"local-greeting","name":"local-greeting","version":"1.0.0","entry":"index.js","files":["index.js"]}
The complete allowed forge.json fields are id, name, version, entry, files, dependencies, peerDependencies and peerDependenciesMeta. The files list names each submitted JS, TS or JSON source relative to that directory; include the entry and every local module it needs. Optional dependencies, peerDependencies and peerDependenciesMeta use npm declarations. Keep id and name stable for updates. Put sources here, never edit generated files under plugins/.forge or profile node_modules. No package.json or Node template is needed; some JavaScript template files referenced by generic skills are not included in the Worker image.
3. Write index.js using the example below, or use TypeScript/ESM and update entry/files accordingly. Function plugins export name, inject and apply without a default export; service classes use a default export. Declare required services in inject; optional services use ctx.get. ctx.on and systemPrompt.section own their effects; wrap other disposer-returning registrations in ctx.effect and clean up timers and external effects.
4. Run dsh plugin --profile "web" build ./greeting-source. Forge must be configured and reachable. The command submits the listed files for compilation and installs the result through HMR; no local tsc, node or npm is needed. It registers the plugin, so do not add a second profile row. To update, edit the source and run the same build command again. To remove this example, run dsh plugin --profile "web" remove local-greeting; its source directory remains available.
5. Check the command's exit code and activation outcome and exercise the new behavior. A successful bash tool response can still contain a nonzero command exit code. A file write or successful compilation alone does not establish activation; an installed-but-disabled plugin is not running. On failure, inspect the error before retrying; an affected old plugin may have stopped. Retry only after identifying and correcting a supported input or code error; stop probing unavailable capabilities. Prompt/tool changes take effect on a subsequent model request, not the request already in progress.

Minimal index.js (also valid for the direct-JavaScript fallback):
exports.name = 'local-greeting';
exports.inject = ['systemPrompt'];
exports.apply = ctx => {
  ctx.systemPrompt.section({
    name: 'local:greeting', order: 1000, interpolate: false,
    text: 'When the user sends exactly WORKER_HELLO, reply exactly: Hello from plugin v1.'
  });
};

Without Forge, the existing direct-JavaScript path remains available: write executable CommonJS-style JS under "/dsh/home/profiles/web/plugins", for example file:///dsh/home/profiles/web/plugins/local-greeting.js. This path does not transform TypeScript, ESM, JSX or async functions; use synchronous registration callbacks. Read the existing profile patch and preserve its operations when adding a unique file-URL row; for an empty patch:
[{"insert":[{"id":"local-greeting","name":"file:///dsh/home/profiles/web/plugins/local-greeting.js"}]}]
With HMR active, this watched plugin directory reloads changed JS files. Keep the row id/file URL stable; remove the row and confirm unloading before deleting its file. Do not mount the same plugin through both workflows or overwrite startup packages or the Worker bundle. The shipped development skill's Node install_bundle workflow does not apply here.

For a smoke test, build the greeting plugin, ask the user to send WORKER_HELLO, change v1 to v2 in its source, rebuild, and test again without refreshing. This verifies Host plugin replacement, not browser UI replacement.
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
