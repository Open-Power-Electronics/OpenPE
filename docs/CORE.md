# Core and shared capabilities

Each open project has one framework-independent `ProjectCore`. Human edits and Agent tools share its validation and transaction owner. [Architecture](ARCHITECTURE.md) defines host/storage boundaries; [Format](FORMAT.md) defines native files; [API](API.md) owns capability schemas and transports.

## Document ownership

`core/project-core.ts` owns immutable project state, its canonical private snapshot, Source drafts/errors, revision and bounded whole-project undo/redo. It imports pure domain functions, never React or Node I/O. Workbench subscribes through `useSyncExternalStore` and retains presentation, native/service adapters, CodeMirror histories and the current dirty-comparison baseline. DesktopWorkspace selects open projects and queues recovery writes.

A successful changed design creates one undo step, including PCB, extensions and model references. No-op or rejected commands leave design and history unchanged. Source drafts are separate from accepted content; applying them validates the complete native file set and commits once. Pending Source blocks conflicting edits, undo/redo and Git creation/restoration. Revisions also advance for draft/barrier changes, protecting newer work from stale preparation. [Source transactions](FORMAT.md#source-transactions) defines file editing.

`previewSource()` validates the Source candidate without changing the draft, error, revision or history. Native application retains project identity and unrelated extensions while reading the explicit native project name and recognized Model CAD settings from current native drafts, including removal. Project renaming is one validated whole-project edit behind the Source and close barriers; undo restores its previous name and native bytes.

`lib/create-blank-project.ts` supplies new-project admission with one empty schematic, PCB and Model CAD document. Core validates this complete candidate as the initial clean baseline; opening Layout or Model adds no design transaction. [Format](FORMAT.md#document-ownership) defines the initial native files.

Advanced Model CAD uses a pure admission gate. `previewModelCadCommand()` returns an independent validated `{project,input}` candidate, materializing a Boolean result ID without publishing. The host prepares pending advanced shapes through its fixed CAD kernel and admits exact canonical keys with `acceptPreparedModelCadGeometry()`. The per-Core registry owns cloned geometry and is bounded to 64 entries/two million key characters. Central commit/materialization guards compare candidate shapes with current owned geometry or these proofs; direct commands, Source apply and `project.replace` cannot bypass preparation. Metadata/top-level pose and duplicates reuse unchanged shape keys. Native load is structurally validated, rejects obsolete recipes and clears prior proofs; undo/redo restore internally owned accepted snapshots. Preflight rechecks revision, Source and lifecycle state before the exact command commits once.

Dirty state compares native bytes at the current destination to the open/save baseline plus pending Source; schematic tabs compare per-file canonical fingerprints. Import metadata is not the dirty baseline. The private snapshot is for queries/IPC/recovery, while `source.files` supplies actual native Source. Public queries omit private backing snapshots, host filesystem destinations and grants; legitimate native model paths and portable relative references remain design data.

### Immutable data and bounded caches

Core detaches caller inputs and shares unchanged internally owned subtrees. Caller-supplied freezing establishes no ownership. New preparation results are detached and validated before publication; canvas previews can submit complete private schematic/PCB candidates through this same owner. Undo/redo reuse accepted snapshots and canonical Source.

Caches are private derivations, never alternate document stores:

- Reuse canonical fingerprints, parsed/materialized trees, native chunks, pin transforms and validated file packets only for exact owned immutable inputs and their current context.
- Preserve unchanged schematic/PCB records and fills. Native board bytes also depend on linked captions, schematic title and identity. Changes invalidate affected derivations.
- Properties and participation commands copy only matching component units and changed raw-field containers, retaining unrelated owned libraries and geometry through the normal validation/undo gate.
- Native schematic fingerprints project the canonical sheet directly and normalize equivalent hidden-field syntax in copied field-layout containers; unchanged embedded libraries are never parsed again. Projection and normalization cannot mutate owned or caller data.
- Bound indentation/destination variants to three. Return independent mutable public file wrappers/containers and never expose cached arrays or nested metadata.
- Generated schema functions reuse successful checks only for the exact owned node and schema function. Changed data, project UUID/reference/pin associations, file membership/collisions and aggregate bounds still validate. Failed checks are not cached.
- Validator generation rejects unfamiliar/context-dependent transformations and performs no runtime compilation under renderer CSP.
- Optional preparation failures remain retryable and cannot reject a valid unchanged import. Clean baseline preparation retains original bytes.

Workspace admission hands at most 12 detached validated entries to first Core mount through exact Source-bound identities; registration/removal releases them. Missing/mismatched entries use ordinary import. Recovery still stores Source. Private parsing can certify primitive-source arrays within the same 300,000-node/80-level bounds; certification does not replace schema/semantic validation. Public parsing remains mutable and independent.

The private snapshot limit is 8 MB using exact UTF-8 bytes, including surrogate replacement. File-set validation retains its 96 MB aggregate limit even when exact owned file-local checks are reused.

Official-library resolution is asynchronous host work. Only a still-current result may materialize packages into its originating edit without another undo step. Pending Source, close barriers and newer identities reject stale results. A clean baseline advances only after accepted adoption; loaded PCB authority follows the primary-schematic fingerprint.

## Query, command and event contract

`api/capabilities.ts` owns registration, discovery, interpreted schemas, dispatch, cancellation, ordered events and suspend/dispose. [Host methods](API.md#host-methods) defines signatures/defaults; the catalog is authoritative for live support.

Options identify actor, request, cancellation and optional expected revision. Actors do not bypass validation or permissions. Capability revisions are strings; in-process Core revisions are numeric. Workbench supplies the revision getter: a mismatched command `expectedRevision` fails before its handler, with Core/direct/asynchronous preparation checks as well. The revision does not version every camera or plugin setting.

Inputs/results are independent finite JSON, normally bounded to 32 MiB. Events are small summaries: default retention 256 (configurable 1–2,000), default payload 64 KiB. Query current state after an event or cursor truncation. Observers cannot interrupt a committed edit. Unregistering aborts only that registration's requests.

Every registration explicitly declares `owner` as `core`, `host`, `plugin` or `api`; plugin ownership requires a plugin ID. Missing ownership is rejected. Ownership is independent of mutation/review/permissions. Core design commands classify `level` as `object` or `operation`; queries/infrastructure/view controls omit it. No task-level design automation is registered.

Close approval blocks Core writes and rule checks, suspends commands and aborts active requests before asynchronous recovery/removal. Failed close resumes the host with drafts/history intact. Native IPC already in progress follows its native completion boundary.

Reviewed datasheet JSON is a host reference adapter. `project.datasheet` and submitted `icDatasheet` share catalog/controller matching, outside Core native files/drafts/undo/recovery. Source lists the actual directory's datasheet files separately. See [API](API.md#workbench-and-history-capabilities) and the [datasheet contract](DATASHEETS.md).

## Registered capabilities

`core/register-project.ts` binds document commands/queries/events; `lib/*-capabilities.ts` binds host, library and plugin ports. Exact IDs/schemas/results belong in [API](API.md), avoiding a second catalog here.

| Group                  | Responsibility                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Project/Source/history | Canonical reads/replacement, Source draft/apply/discard and project undo/redo            |
| Schematic              | Sheet management, component/property/connectivity edits, wires/labels/transforms and ERC |
| Layout                 | Board queries, checked routing/vias/transforms/drag, zones/fills/properties and DRC      |
| Model CAD              | Independent solids, analytic sketch Boolean extrusion and prepared edits                 |
| Host/library           | Verified placement/assignment, UI context, native save/export and local Git              |
| Plugin                 | Lifecycle, SPICE settings/results/waveforms and Thermal settings/fields/probes           |

The PCB links to the primary schematic; commands identify sheet/board explicitly. Complete canonical replacement still validates supported bounded content. Native access resolves opaque grants in Electron; no command accepts arbitrary paths, executables or download URLs.

GUI design operations and Agent commands share domain preparation, not only the
final validator. Label placement/Properties and no-connect placement use
`saveLabel`/`placeNoConnect`; text placement and wire simplification use the canvas
functions. Layout pad and track-endpoint Properties use `lib/pcb-properties.ts`;
via edits and footprint side/model changes share its preparation with GUI
Properties. Boundary resizing and official footprint placement reuse the canvas
geometry functions. Discoverable object queries supply retained native metadata.
Generated PCB command schemas reuse canonical format definitions rather than a
second document validator. [API](API.md) owns exact command parameters/results.

`schematic.drag` shares canvas connection-preserving geometry, while `schematic.move` leaves unselected wires. Both use the same revision/Source gates and preserve no-op/rejection atomicity. Track locks, connected drag, collapse handling and automatic copper refresh follow [Layout](LAYOUT.md).

`modelCad.add/update/remove/duplicate`, `modelCad.sketch.extrude` and `modelCad.boolean` are ordinary whole-project Core transactions. Box, cylinder, extrusion and Boolean bodies live in `org.openpe.model-cad`. Validation checks finite bounded geometry and global UUIDs; duplication allocates fresh body IDs. Model CAD permits up to 64 bodies; sketch extrusion accepts up to six ordered analytic contours and shares the prepared Boolean-solid path. Dedicated local-hole fields are rejected. Identical replacements are clean; read-only CAD queries remain available with pending Source. Rendering and analytical STEP share geometry; CAD adds no electrical/thermal simulation. [Format](FORMAT.md#document-ownership) owns native persistence and complete geometry limits.

### Component drawing transactions

Custom component drawings use pure `lib/symbol-drawing.ts` and
`lib/footprint-drawing.ts` through `schematic.symbol.draw` and
`layout.footprint.draw`. GUI and Agent submit the same complete local drawing.
Symbols fork an embedded definition for the edited instance, preserving other
instances, native fields and fixed numbered connected terminals. Footprints
retain package/pad/graphic identities, nets, models and native metadata; new
records receive fresh IDs. Routed contacts and bounded copper collisions reject
the complete drawing. Assignment changes share the originating board edit and
whole-project undo. Accepted fills still refresh through central commit.

## Read-only rule checks

`schematic.erc` and `layout.drc` are Core queries with mutation `false`, review `none` and no level/plugin requirement. They lazily load pure engines, capture immutable identity/revision and recheck cancellation, pending Source and close/edit barriers after loading. Superseded content rejects; synchronous bounded geometry loops are not mid-loop cancellable. Query options do not impose command-style `expectedRevision`.

ERC returns checked revision/sheet; DRC returns revision/board/effective thresholds. Stable object IDs and millimetre positions support locating, while issue IDs belong to that report only. Sheet/document/settings changes require a fresh matching report.

Checks never apply drafts, mutate Core, emit design changes, advance revision, create undo, write files or refill zones. Capability invocation events still occur. Reports/thresholds/markers stay outside Source/recovery/Git/dirty state.

[Design rules](DESIGN-RULES.md) owns coverage: physical connectivity is independent of simulation participation; unsupported pin/geometry coverage is explicit. Reports cap at 1,000 issues and mark truncation incomplete. `complete:true` means the implemented bounded rules completed, not KiCad parity or hardware qualification.

## Agent transport and review

Every submission captures bounded workspace context. After validating the complete capture, `context/agent-prompt-context.ts` derives semantic provider context: sheet identities/counts; active-sheet components, simulation fields, pin definitions and geometry-derived connections; selected-object geometry; PCB/Model counts and view-specific placement/solid summaries. Collections cap at 256 entries with totals and explicit truncation; selected components/connections take priority. Native and Source draft text, duplicate circuit payloads, artwork, copper geometry and preservation metadata are omitted. Source contributes pending/error/draft length; UI, reviewed references and simulation/thermal observations remain available. This is not a writable design document and never mutates Core or query results. Codex/Claude receive scoped `openpe_query`, `openpe_execute` and `openpe_observe` tools; prompts use `core.state` for revision checks and request complete design/native queries only as needed. DeepSeek Harness/Pi use restricted context-only transports and reviewed fenced proposals; Cursor is detection-only. Inactive-project observations cannot capture another project's visible controls. A project switch while references load rejects the observation before visible controls are captured.

Codex uses dynamic app-server tools; Claude uses the application-owned stdio MCP helper. Provider shell/web/unrelated tools stay blocked. Plugin installation does not expand OpenPE permissions. Protocol fixtures establish adapter behaviour, not authentication or every CLI-version compatibility. Unnamed conversations can request a bounded topic title in that same reply. Successful, origin-bound suggestions update only the existing session name; manual names take precedence. Reserved title metadata is hidden in presentation and excluded from later provider context, while raw reply text is retained. This introduces no Core command or additional tool authority.

Each bridge binds run/conversation/origin with per-turn and single-use response tokens. Renderer results require process authentication; the CLI helper gets only its scoped bridge token. Cancellation/disconnect/completion revoke the bridge. [Agent tools](API.md#agent-tools) define the envelope, per-turn call and delivery-deadline limits. Commands retain subsystem deadlines; solver execution has no runtime timeout.

Live requests use the current permissions mode. Explicit expected revisions are preserved; omitted revisions use submission state or the latest `project.snapshot`, `core.state` or `workbench.state` observation. Review captures immutable arguments/revision after envelope validation. Apply performs full registered schema, availability, revision and domain checks; a pending card is not proof of validity. Auto invokes the same handler and never executes previously queued reviews.

Each turn permits 32 reviews; each mounted conversation retains at most 64 records and 32 MiB of arguments, including completed records. Apply has independent cancellation and may remain manually actionable after bridge completion, subject to current validation. Reviews never persist. Fenced schematic proposals require successful completion, matching originating sheet/fingerprint and submission-time mode.

## Plugin boundary

Bundled SPICE/Thermal handlers share the host with human controls, independently gated by installed/enabled state. Disable/uninstall cancels work and releases resident state. Hiding settings cancels active work but retains completed state; SPICE explicit Stop also retains validated partial results.

Simulation attributes and verified portable references are document data, independent of plugin availability. Solver settings/results/probes/waveforms are session data. Completed records persist only through grant-bound host adapters under generated `spice/` / `thermal/` directories excluded from native discovery. Load-only restore validates current inputs/resources without changing Core/Source/undo/dirty state. See [Simulation](SIMULATION.md), [Thermal](THERMAL.md#completed-desktop-records) and [provider management](PLUGINS.md#provider-discovery-and-management).

## Verification

`tests/gui-agent-parity.test.ts` compares the native KiCad files produced by GUI
preparation and Agent commands, including creation identity mapping, project
renaming, labels, text positions, no-connects, wire simplification, pad/via/track
Properties, footprint flips/models, drawings, boundary resizing and official
footprint placement. It checks whole-project undo, invalid/stale inputs, Source
and close barriers, asynchronous placement and public-result isolation. These
checks establish the exercised design operations; provider transport availability
and native file grants retain their separate contracts.

Core/capability/lifecycle/transport tests cover ownership, structural sharing, mutation isolation, revision conflicts, Source/close barriers and cancellation. Owned-validation, native materialization/cache, admission and save tests protect private derivation boundaries. Rule-check capability/ERC/DRC tests cover read-only reports and incomplete coverage.

`scripts/benchmark-project-runtime.ts` measures fresh geometry, Core property/participation commands and unchanged property requests together with native Source/dirty reads, checking revisions, undo and unchanged snapshot identity.

Isolated UI checks include `check-agent-tools-ui.mjs`, `check-project-lifecycle-ui.mjs`, `check-project-admission-ui.mjs`, `check-source-retention-ui.mjs` and `check-render-isolation-ui.mjs`. They use actual renderer/Core integration with fixture services; they do not prove live provider/solver/Electron behaviour. [Architecture verification](ARCHITECTURE.md#verification) and [engineering rules](../AGENTS.md#verification-and-delivery) define broader checks and opt-in limits.
