# OpenPE engineering contract

Build **OpenPE · Electrical Engineering Studio**, a local desktop workbench with Agent conversation on the left and editable power-electronics design on the right. This file defines shared engineering obligations; the contracts below own detailed behaviour. Read the relevant contracts before editing and verify them against the working tree. Replace obsolete rules rather than appending exceptions, history or plans. Maintained documentation and UI copy are English; preserve electrical symbols, references and units.

## Read by responsibility

<!-- prettier-ignore -->
| Work | Owning contract |
| --- | --- |
| Setup, commands and product scope | [README](README.md) |
| Visual style, controls, gestures, focus and panels | [Design](DESIGN.md) |
| Modules, trust boundaries, execution and storage | [Architecture](docs/ARCHITECTURE.md), [source diagram](assets/architecture.drawio) |
| Document ownership, transactions, revisions and caches | [Core](docs/CORE.md) |
| Capability IDs, schemas, results, routes and bridge lifecycle | [API](docs/API.md) |
| Native files, preservation, Source and Save | [Format](docs/FORMAT.md) |
| PCB/Model geometry and bounded rule coverage | [Layout](docs/LAYOUT.md), [Design rules](docs/DESIGN-RULES.md) |
| Catalog, pinned resources and reference evidence | [Examples](docs/EXAMPLES.md), [Libraries](docs/LIBRARIES.md), [Datasheets](docs/DATASHEETS.md) |
| Solver profiles, execution, artifacts and results | [Simulation](docs/SIMULATION.md), [Thermal](docs/THERMAL.md), [EMC verification](docs/EMC-FLYBACK.md) |
| Bundled features and provider management | [Plugins](docs/PLUGINS.md) |
| Destination-bound local Git history | [Version history](docs/VERSION-HISTORY.md) |

Keep one owning explanation for each mechanism. Update affected contracts and the architecture diagram when ownership, execution paths or supported artifacts change. Document implemented modules and verified limits, not planned capabilities or earlier chat/test outcomes as current evidence.

## Product and current contracts

- Support bounded KiCad 10, manual Layout, Model CAD and documented simulation. Never claim general import/model support, complete KiCad ERC/DRC parity, autorouting or production qualification. PE Layout Skill is fixed bundled guidance.
- Current contracts only: remove retired implementation/tests/docs together. Add no compatibility branches, aliases, migrations, inferred fields or fallback readers. Reject unsupported data and preserve its files without import/rewrite. Stable current protocols and documented KiCad/vendor interoperability remain supported.
- Use OpenPE / `openpe` for product copy and application-owned identities (`window.openpe`, `openpe:` IPC, `X-OpenPE-Token`, `OPENPE_*`, appearance keys, `ai.openpe.desktop`, native properties and resource IDs). Establish data under `OpenPE` or explicit `OPENPE_DATA_DIR` before setting the native name; no former-brand aliases/directory fallback.
- Designs are native `.kicad_pro`, `.kicad_sch`, `.kicad_pcb` and supporting files. Never publish private snapshots as designs, create `.openpe.json` or disguise JSON as KiCad. Use plain circuit filenames with separate provenance/licenses.
- Follow [Design](DESIGN.md). `public/brand/openpe-mark.svg` is the sole transparent Signal E master; regenerate derivatives with `node scripts/brand-assets.mjs`.

## Architecture and ownership

Classify changes by GUI, Context Management, Agent, Uniform API, Core, Plugin or host infrastructure; [Architecture](docs/ARCHITECTURE.md#repository-management) owns the directory/dependency map.

- Renderer imports no Node APIs. Preserve context isolation, sandboxing, CSP and authenticated bounded loopback requests; reject foreign origins.
- API imports no Core/domain/GUI/platform implementation. Core imports only API contracts/pure domain functions, never framework/native/service I/O. Context is bounded browser-safe observation, never mutation. Document concrete reasons for architecture exceptions.
- `ProjectCore` alone owns validated documents, Source drafts and whole-project undo. Workbench owns presentation/adapters/current dirty baseline; DesktopWorkspace owns selection/recovery; host ports own grants/native writes/Git.
- GUI and Agent design, simulation and project-file operations share Core or bounded host-backed capabilities, preparation, validation and transactions, with native dialogs and Agent model/log access restrictions intact. Expose editable parameters in discovery; verify native-file/undo GUI-Agent parity. Pointer/camera presentation creates no second mutation algorithm. Generate PCB property schemas from canonical definitions. Partial constrained commands require explicit consent and report applied displacement.
- Owner/abstraction metadata is not permission; runtime discovery defines availability. Update [API](docs/API.md) for ID/schema/result/route/bridge/lifecycle changes. Unsupported schema keywords fail explicitly.
- Generate schemas, validators and service bundles atomically with `scripts/build-format.mjs` from TypeScript/generator sources. Never hand-edit generated validators or embed duplicate project validators in consumers.

## Editing and validation

Read [Core](docs/CORE.md), [schematic interaction](DESIGN.md#schematic-canvas), [Layout](docs/LAYOUT.md) and [Design rules](docs/DESIGN-RULES.md) for operation semantics and bounds.

- One validated transaction per edit, behind current revision/Source/close gates. Commit the exact preview once; blocked/cancelled poses cannot commit an older valid preview. Preserve IDs; copies get fresh IDs/references.
- Geometry owns connectivity; presentation never changes design/export geometry. Preserve snapping/exact anchors, connected-drag versus Move and deliberate joins versus crossings. Keyboard/Properties/Agent deletion share `removeSelection` and preserve surviving networks/metadata.
- Properties/Agent edits share `preparePartProperties`, preserving hidden fields/pin mappings. Participation persists through `exclude_from_sim`, independently of model binding and Footprint-derived styling (`lib/symbol-role.ts`). Assignment clearing removes the package in the same undo edit, retaining copper.
- Loaded PCB authority and schematic sync follow [Layout](docs/LAYOUT.md#project-integrity-and-schematic-synchronization): share originating undo, retain unaffected placement/nets/fills/packages and distinguish electrical power-symbol Values from captions. Viewing never refetches packages/refills zones.
- Preview/commit share collision checks, including hidden/fixed geometry; no implicit pad/via/locked-track motion. Preserve exact route geometry. Fill failure rejects the edit without clearing accepted copper; only already-filled enabled zones refresh automatically. Worker previews/masks have no document/connectivity authority. ERC/DRC remain read-only, lazy, plugin-independent and revision/Source/close-gated; incomplete coverage cannot imply clean results.
- Model parameters/preview/analytical STEP must agree; advanced shapes need exact host-prepared keys through pure Core. Preserve PCB bytes/camera/caches and reject unsupported/retired recipes per [Format](docs/FORMAT.md#document-ownership).
- Retain hidden Properties drafts and retryable invalid/stale inputs. Only accepted edits change data. IME composition, including 229, cannot apply/discard/save/trigger tools. Unapplied Model drafts block conflicting tools without expanding Core/Agent authority.

## Native files, Source and host access

Read [Format](docs/FORMAT.md) for preservation/Source/Save/export, [Datasheets](docs/DATASHEETS.md) for reviewed references and [Version history](docs/VERSION-HISTORY.md) for private snapshots.

- Preserve unchanged native bytes and metadata; reject unsupported content before editing/writing and preserve unknown files.
- Source edits actual native text with retained file history/invalid drafts. Apply/Save/leaving Source validate all pending files and commit once. Pending Source blocks conflicting edits, sheet changes, history creation/restoration and Model entry; sidebar visibility remains usable. Recovery stores native drafts separately.
- Ordinary-file drafts survive navigation/refresh/failed writes and count for Save/close, but remain outside native design/Core/undo/recovery/automatic Agent context. Binary/truncated previews stay read-only except bounded PDF display. Native discovery excludes solver results.
- Reviewed datasheets stay validated read-only host references shared by Send/scoped queries, not project data. Local PDF edits cannot replace their internal record; never generate project datasheet JSON.
- Electron keeps grants in memory; dialogs/opaque example keys grant bounded files. Renderer cannot choose arbitrary paths/executables/commands/URLs. Save needs a live grant. Main-frame replacement clears grants; same-document/subframe navigation preserves them.
- Save carries the complete native set. Preserve logical IDs on Save as and native library edits during asset preparation. Preflight targets, reject traversal/links, protect all open sources, atomically replace individual files and roll back siblings on failure; no filesystem-wide crash-atomic claim. Reopening an open destination activates its editor; Save as cannot overwrite another open source.
- Export applies Source and compiles before its picker without changing destination/baseline. Native files belong to Save/Save as; Explorer requires a live grant or activates and Saves first. Cancellation/invalid Source retains drafts. Git restore is one whole-project undo behind Source/close gates; snapshots omit grants/destinations/results.

## Workspace, recovery and performance

[Design](DESIGN.md#home-projects-and-recovery) owns project/tab behaviour; [Architecture](docs/ARCHITECTURE.md#storage-and-build-boundaries) and [API](docs/API.md#local-http-service) own recovery fields/limits.

- Keep inactive Workbenches mounted in detached DOM, global keys active-project-only and views/undo/Source/sessions/streams isolated by origin. Use instance-specific SVG IDs. Tab close removes a view, never schematic data; reopen retains selection/viewport.
- After approved project/last-tab close, block Core and suspend/cancel capabilities before recovery/grant release. Failure resumes drafts/undo; release only that project's grant.
- Dirty state compares destination-native bytes to the current baseline plus Source drafts; tabs use file fingerprints and ordinary-file drafts count for Save/close. Admission starts clean; undo to baseline clears indicators. Viewing/conversations/export cannot dirty or redirect designs.
- Validate complete current recovery without inferred fields or host grants/destinations, appearance or simulation state. Preserve malformed recovery/errors without idle overwrite; delete retired `workspace.json` without migration/backup. Replacement waits for cancellation/grant release. Clean examples reread originals, dirty ones detach destinations; discovered identities are re-resolved by the host.
- Quit reviews all unsaved work, rechecks background changes and pauses ordinary recovery writes. Discard revisions only after every decision succeeds. Failed/cancelled Save or cleanup keeps app/service/documents alive; await recovery before reload/quit.
- Follow [Core cache ownership](docs/CORE.md#immutable-data-and-bounded-caches): only exact internally owned immutable inputs permit reuse; caller freezing does not. Validate new/prepared data/global bounds, return independent containers and keep failures retryable. Preserve unchanged subtrees/fills; invalidate affected native bytes and retain only the current dirty baseline, invalidated on saved Source/destination changes.
- Isolate unrelated renders; defer hidden presentation while explicit observations stay current. Preserve revision guards/navigation/exact previews. Renderer reload cannot replace Electron/service modules. Distinguish disk builds from running instances, preserve unsaved work and never force-close the user's app.

## Examples and resources

Follow [Examples](docs/EXAMPLES.md)'s catalog, provenance, native paths and generation contract and [Libraries](docs/LIBRARIES.md)'s resource/license delivery.

- Open original `examples/` and `recent/` files; package roots independently. Runtime never copies/regenerates/cleans/downloads Home content. Fixed resource IDs are not grants; Recent is not opening history.
- Preserve neutral names, pinned bytes/transforms and provenance/licenses; keep manufacturer supplements separate. Create only populated asset directories, retain `.pretty`, exclude `.kicad_prl`, and never hand-edit snapshots/pinned source, substitute assets or use preview downloads.
- Use `npm run examples` (EMC: KiCad 10 via `KICAD_CLI`), then `npm run build:format` after generated TypeScript changes. Run `npm run examples:prepare` before renderer build/dev. Preserve portable paths/bundled sources; no runtime KiCad CLI or user-library discovery.
- Service/window/Home/new/ordinary recovery stay independent of example preflight. First example open shares the [bounded opening barrier](docs/VERSION-HISTORY.md#opening-barrier-and-concurrency), including clean recovery; unrelated failures/missing Git cannot block a usable project.

## Plugins, simulation and Agents

[Plugins](docs/PLUGINS.md), [Simulation](docs/SIMULATION.md), [Thermal](docs/THERMAL.md), [Core](docs/CORE.md#agent-transport-and-review) and [API](docs/API.md#agent-tools) own lifecycle/execution/transport details.

- Bundled allowlisted plugins add no general loader/tool authority; host lifecycle gates/cancels work. Provider management is separate: verify effective state/managed policies, retain uninstall confirmation and never alter unrelated global config.
- Preserve exact supported model variants/mappings/derivatives. Simulation attributes remain Core data without plugins; immutable allowlisted `.lib` files use grant/link/hash checks and remain portable through Save/history/plugin removal. Only finite completed runs add references, as one undo edit.
- Use verified bundled solvers/resources, argument arrays and private temporary directories. Requests accept validated project/settings/opaque IDs, never decks/scripts/executables/paths/URLs; no system solver discovery/environment overrides. Positive finite SPICE timing has no fixed range/runtime timeout or file/sample-size cutoff. Bound logs/display data. Stop retains validated partial samples; failure/automatic cancellation discards previews.
- Thermal is read-only; missing enabled fills block Run. Distinguish PCB from junction temperature; SPICE heat uses verified full-resolution final-20% terminal power with explicit assumptions.
- Desktop Run requires a saved destination. Results stay outside design/undo/recovery/dirty state. Follow current publication/rollback contracts, preserving unknown/damaged files, other projects and prior success. No cross-file crash-atomic claim. Restore validates without solving/downloading/migrating.
- Keep all five Agents; installation is not authentication/runtime support. Codex/Claude get scoped query/execute/observe only, DeepSeek/Pi restricted context/proposals, Cursor detection only. Never read credentials, fabricate replies, silently switch providers or interpolate user input into shell commands.
- Reviews capture immutable arguments/revision; Apply rechecks schema/availability/domain/revision. Auto uses the same host, never queued reviews. Fenced proposals require successful completion and originating sheet/fingerprint/mode. Bind tools/streams to run/session/project/origin and revoke tokens on cancel/disconnect/completion. Stop retains text/drafts but blocks late proposals.
- Explicit Send captures bounded context; scoped tools observe current state. Never expose other-project UI, credentials, logs, model bytes or disabled results. Annotations remain immutable session presentation behind Source/visibility gates. Preserve raw text; follow [Design](DESIGN.md#agent-conversation)'s bounded lazy Markdown/KaTeX, hidden proposal payloads and no raw HTML/external images/trusted evaluation.

## Verification and delivery

<!-- prettier-ignore -->
| Change or check | Required handling |
| --- | --- |
| Docs/rules only | `npm run check:docs`; content/format review against implementation. |
| Presentation only (spacing/colour/type/labels/icons), with no state/interaction/contract change | Review affected UI/styles/copy; `npm run typecheck` for TS/JSX. Full tests/build only if bundling or asset generation changes. |
| Local renderer menus/dialogs/focus/keys/visibility, without shared state/document/persistence/API/host changes | `npm run typecheck` plus focused regressions or browser check, including affected keyboard/IME behaviour. Add tests only for meaningful new behaviour; no full tests/build required. |
| Core/domain/circuits, shared state/lifecycle, Source/native formats, Save/recovery/history, API/security, service/Electron, dependencies/build config | `npm run typecheck`, full `npm test`, `npm run build` and focused regressions; architecture checks are included. |
| Electron, `npm run test:e2e`, desktop visual/integration checks or benchmarks | Explicit user authorization before launching. |
| Real solvers/providers | Opt-in; mocks are not native/provider/solver evidence. |

- Classify by behaviour/dependencies, not diff size/location; mixed changes use the highest tier. Naming changes affecting native data/recovery require the full tier. Run docs checks whenever maintained docs/rules change; review scoped diffs for formatting/unrelated edits.
- Run focused checks while iterating, then required full checks once stable. Reuse passes for unchanged inputs; repeat after relevant changes/failures/unresolved concerns. Use `npm test -- <test paths>` for focused Node tests. Keep generation/tests/build sequential when sharing outputs.
- Architecture runs before typecheck and after generation in test/build; do not duplicate passed applicable checks. Build/dev/package may prepare/download resources. [Verification index](docs/ARCHITECTURE.md#verification) and feature contracts own focused/opt-in commands. Report actual reviewed-tree passes, focused/full coverage and unverified behaviour.
- Run graphical checks one at a time; stop owned tests on overload without closing the user's app. Solver/CAD flags live in [Simulation](docs/SIMULATION.md#verification-commands), [Thermal](docs/THERMAL.md#verification) and [Layout](docs/LAYOUT.md#examples-and-verification). Home sweeps/mesh refinement are separate; offline sweeps never fetch missing files.
- Source checks use `scripts/source-editor-test-helpers.mjs` on the selected actual native file, never a private snapshot. Parse `.kicad_pro` as JSON and schematic/board text with native parsers. Use `scripts/async-browser-test-helpers.mjs` for asynchronous predicates; desktop fixtures keep designs/profiles in sibling directories.
- Remove dead code instead of suppressing unused errors. Preserve generated artifacts/pinned evidence/notices/sources/current builds. Ignore dependencies/builds/releases/downloads/secrets in Git; ignored files are not disposable. `.openpe/` and `test-results/` may hold recovery/history/offline tools/generation inputs. Resolve workspace-contained paths and reject links before recursive cleanup.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
