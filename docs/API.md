# OpenPE API reference

OpenPE exposes a per-project Uniform API for Human and Agent adapters, three scoped Agent tools, an authenticated local HTTP service and a narrow Electron bridge. The Uniform API is the application automation interface: discover its live catalog before invoking a command. HTTP and Electron interfaces provide bounded transport, persistence and native services; a capability ID is not an HTTP route or a method on `window.openpe`.

Registrations cover Core, host, built-in features and installed runtime plugin capabilities. A mounted project's catalog depends on plugin and lazy-view lifecycle; runtime discovery is authoritative for its available queries and commands. This reference covers the implemented interfaces in [the architecture](ARCHITECTURE.md); task-level automatic layout, arbitrary FEM inputs, analytical-model execution, OpenSCAD import/execution and runtime Skill loading have no registered API.

GUI/Agent parity covers design, simulation and project-file operations through shared preparation and transactions:

| GUI work                                                                                          | Agent route                                                                        | Shared boundary                                                                                 |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Schematic symbol drawing, placement, Properties, wiring, connected pickup, copy/paste and removal | `schematic.*`, `part.*`, `library.*`                                               | Validated Core edit; original identities/connections retained, copies receive fresh identities  |
| PCB footprint drawing, placement, routing, pickup, Properties, zones and board drawings           | `layout.*`                                                                         | Same geometry preparation, collision checks, fills and single undo result                       |
| Model CAD and component model selection                                                           | `modelCad.*`, `enclosure.exportStep`, `layout.model.*`                             | Exact host-prepared geometry/resource identities, then Core validation                          |
| SPICE and Layout Thermal settings, probes, Run/Stop and supported result operations               | `simulation.*`, `thermal.*`, `part.spiceModel.*`, `part.sourceType`                | Same mounted plugin handlers, saved-destination gates and automatic verified result restoration |
| Native Source, Save/Save as, export and local history                                             | `source.*`, `project.save`, `project.export`, `versions.*`                         | Same Source/revision gates, native grants and history restoration                               |
| New/open/example/close/Explorer and ordinary project text                                         | `project.new/open/openExample/close/reveal`, `project.examples`, `project.files.*` | Origin-bound workspace actions and existing file drafts/native pickers                          |

Model contents and logs remain unavailable to Agents, including explicit project-file reads/writes. Ordinary files are never added automatically to Agent context. Credentials, unrelated projects and arbitrary host paths remain outside these interfaces. Display settings and provider/plugin management are separate from this parity scope. Codex, Claude Code and Cursor have live scoped tools; DeepSeek Harness and Pi use restricted context/proposals. See [Agent tools](#agent-tools) for provider transport limits.

- [Uniform API contract](#uniform-api-contract)
- [Project and Source capabilities](#project-and-source-capabilities)
- [Schematic and component capabilities](#schematic-and-component-capabilities)
- [Layout capabilities](#layout-capabilities)
- [Model CAD capabilities](#model-cad-capabilities)
- [Rule-check queries](#rule-check-queries)
- [Workbench and history capabilities](#workbench-and-history-capabilities)
- [Library capabilities](#library-capabilities)
- [Plugin lifecycle capabilities](#plugin-lifecycle-capabilities)
- [SPICE capabilities](#spice-capabilities)
- [Layout Thermal capabilities](#layout-thermal-capabilities)
- [Layout Parasitics capabilities](#layout-parasitics-capabilities)
- [EMC Analysis capabilities](#emc-analysis-capabilities)
- [Agent tools](#agent-tools)
- [Browser development preview transport](#browser-development-preview-transport)
- [Local HTTP service](#local-http-service)
- [Electron bridge](#electron-bridge)
- [Component STEP models](#component-step-models)
- [Examples](#examples)
- [Sources and maintenance](#sources-and-maintenance)

## Uniform API contract

[`api/capabilities.ts`](../api/capabilities.ts) exports `createCapabilityHost()` and the capability types. Workbench creates one host per project and supplies its Core revision getter. Callers receive JSON copies, not mutable Core objects or reusable native file handles/grants. Native model references can still contain path-like design metadata.

### Host methods

| Method                          | Result and behaviour                                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register(definition)`          | Returns an unregister function. Rejects duplicate/invalid IDs, invalid owner/level combinations and unsupported schemas. Unregister aborts requests owned by that registration. |
| `catalog()`                     | Returns `CapabilityDescription[]` with current availability. Equivalent discovery is `query('capabilities.list')`.                                                              |
| `query(id, input?, options?)`   | Returns `Promise<unknown>` for a registered query after JSON, schema and availability checks. Omitted input becomes `{}`.                                                       |
| `execute(id, input?, options?)` | Returns `Promise<unknown>` for a registered command after revision, JSON, schema and availability checks. The handler performs domain/native checks.                            |
| `emit(type, data)`              | Publishes a bounded JSON event. Type starts with a letter and uses letters, digits, `.`, `_`, `:`, `-`, up to 128 characters.                                                   |
| `subscribe(listener)`           | Returns an unsubscribe function. Receives ordered event copies; observer errors cannot interrupt other observers or committed edits.                                            |
| `observe(after = 0)`            | Returns `{cursor, events, truncated}`. `after` must be a nonnegative safe integer. Truncation requires a fresh state query.                                                     |
| `suspend(reason)`               | Makes commands unavailable and aborts active requests; query handlers retain their own availability gates. Used while closing a project.                                        |
| `resume()`                      | Restores a suspended host after a failed/cancelled close.                                                                                                                       |
| `dispose()`                     | Revokes registrations, aborts requests and clears observers/events.                                                                                                             |

```ts
type CapabilityOptions = {
  signal?: AbortSignal;
  actor?: 'human' | 'agent' | 'system'; // Defaults to human.
  requestId?: string;
  expectedRevision?: string;
  resultDelivery?: Promise<boolean>; // Adapter acknowledgement for deferred lifecycle actions.
  onAfterResult?: (completion: Promise<void>) => void; // Drain accepted lifecycle actions at normal EOF.
  onProgress?: (data: JsonValue) => void; // Receive bounded progress for this Human invocation.
};

type CapabilityDescription = {
  id: string;
  kind: 'query' | 'command';
  description: string;
  inputSchema: Record<string, unknown> | boolean;
  mutation: false | 'document' | 'session' | 'external';
  review: 'none' | 'optional' | 'required';
  revision: 'project' | 'independent';
  owner: 'core' | 'host' | 'plugin' | 'api';
  level?: 'object' | 'operation' | 'task';
  plugin?: string;
  available: boolean;
  reason?: string;
};

type CapabilityEvent = {
  seq: number;
  time: string; // ISO timestamp.
  type: string;
  data: JsonValue;
};
```

Registration additionally supplies `handler(input, context)`, optional `available() => true | false | string`, and required owner and optional mutation/review/revision/level/plugin metadata. Handler context contains `signal`, `actor`, `requestId`, optional `expectedRevision`, `emit` and `afterResult(action)`. A command may defer one workspace lifecycle action until its result is delivered; queries cannot defer actions. Omitted mutation/review/revision default to `false`/`none`/`project`; every registration must declare its owner explicitly. Only session commands may declare `revision: 'independent'`; unknown policies fail registration. Plugin ownership requires a nonblank plugin ID, and other owners cannot declare one. Queries cannot declare a truthy mutation.

`owner` identifies the implementing layer; `level` identifies a domain abstraction. Neither grants permission. `mutation` describes possible effects rather than promising that every call changes a document. A no-op can leave the revision/undo unchanged. The tables below use `O` for object-level, `P` for operation-level and `—` for no level. There are no task-level registrations. Commands that change designs, Source/ordinary-file drafts or external files declare `review: 'optional'`; presentation and other session controls declare `review: 'none'`. Agent Review/Auto behaviour is enforced by its adapter, not by `execute()` itself.

### Validation and lifecycle

The numeric schema subset includes positive finite `multipleOf`, using the document
validators' four-decimal quotient tolerance for binary division noise. PCB
property schemas in [`core/layout-property-schemas.json`](../core/layout-property-schemas.json)
are generated from the canonical definitions in `scripts/build-format.mjs`;
local nonrecursive references are expanded before registration. Complete Core
validation still checks object associations, aggregate limits and native geometry.

Inputs/results must be finite JSON. Defaults are 32 MiB per input/result, nesting depth at most 128, 64 KiB per event and 256 retained events. Host options can change `maxDataBytes`, `maxEventBytes`, `eventLimit` (clamped to 1–2,000), `now` and `revision`. Inputs use the bounded interpreted JSON Schema subset in [`api/capability-schema.ts`](../api/capability-schema.ts); unsupported keywords fail registration. Results are checked as bounded JSON; there is no registered output-schema field.

The mounted host rejects a project-dependent command whose supplied `expectedRevision` differs from the current Core revision, checking again after synchronous availability and start observers before calling the handler. Core checks direct calls too; asynchronous library handlers recheck after loading. `simulation.cancel` declares `revision: 'independent'`: Stop changes only the originating project's simulation session and ignores project revision hints, while retaining schema, review, availability, cancellation and close/disposal gates. Other commands retain the default project policy. Revisions are **strings at this boundary**, including changes to Source drafts and editing barriers. A revision does not version all presentation/plugin state. Actor metadata does not bypass review, Source gates, plugin lifecycle or native grants.

Successful invocation emits `capability.started` and then `capability.completed`; handler failure/cancellation emits `capability.failed`/`capability.cancelled`. These events contain `{id, requestId, actor}` and failure/cancellation adds a bounded `message`. Pre-handler validation failures can reject before `started`. Registration, unregistration, suspension and resumption emit their own events. Cancellation is cooperative: adapters must honour the supplied signal; it is not a rollback of completed external writes.

A Human caller may register `onProgress` for a single invocation. Its handler
can deliver bounded JSON through `context.reportProgress` while that call is
active. Progress stays with the caller and is omitted from observation and
Agent transport.

Unknown IDs, wrong query/command kind, invalid input, stale revisions, unavailable handlers and domain failures reject the promise with an `Error`. Cancellation commonly uses `AbortError`. There is no uniform typed error-code enumeration across all capabilities.

### Common notation and data

In tables, `?` means optional, `{}` means no input fields, `string[]` means an array and unions use `/` to keep cells readable. Except where specified, schemas reject extra properties. Numbers are finite. Geometry uses millimetres, angles degrees and simulation time seconds. Callers should use the intended editor grid (1.27 mm in Schematic). Placement, Properties, wire and annotation handlers apply their shared domain snapping rules; do not assume every movement delta or explicit pivot is snapped by the API. The Layout host does not inject its displayed spacing into command arguments.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Point = { x: number; y: number };
type RevisionResult = { revision: string };
type EditResult = RevisionResult & { selection?: string[] };
type NativeFiles = {
  entry: string;
  files: { name: string; source: string; encoding?: 'latin1' }[];
};
type CoreMetadata = {
  revision: string;
  editingBlocked: string | null;
  sourceDraft: string | null;
  sourceError: string;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
};
type ProjectSnapshot = CoreMetadata & { project: CanonicalProject | null };
```

Canonical component simulation records include optional `modelSource: "basic" | "external"` for the active model choice, optional `passiveModel: "R" | "C" | "L"` (native `OpenPE.PassiveModel`), optional sourceType: "DC" | "PULSE" | "SIN" (native OpenPE.SourceType) for the intrinsic voltage waveform, and optional `initialVoltage` (capacitors) and `initialCurrent` (inductors) string parameters. Properties and Agent field edits retain these through the existing `part.properties` command and native fields; no separate execution permission is added.

`CanonicalProject` means the validated private JSON query/snapshot representation defined by [Format](FORMAT.md) and [`lib/project-document.ts`](../lib/project-document.ts). A single-file query returns a canonical project containing that schematic. It is not a public on-disk design format. Native user projects remain KiCad file sets. `project.source` and `source.get().source` serialize this private representation; `source.files` supplies the actual native text files shown in Source.

Agent observations omit optional native backing from canonical projects and
historical Source; `source.files` excludes model/log bodies. Human GUI reads retain
complete native data. Agent result envelopes report `sourcePending` and
`draftCharacters` with `sourceDraft:null` and generic Source diagnostics, so invalid
aggregate drafts cannot expose private parser excerpts. Explicit native design
text remains available through `source.files`.

Agent project/Source replacements reject explicitly supplied model/log bodies and
retain protected native files internally from accepted Core state when omitted.
This preserves exact bytes without returning them or introducing placeholder data.
Protected GUI Source drafts require review in the editor before Agent commands
can apply/discard them or implicitly apply them through Save/view/export. Known
history restoration and native resource pickers remain bounded host operations.

Core IDs are generally 1–200 characters; Core `Point` coordinates are bounded to ±100,000 mm. Specific operations can impose narrower bounds. Discover the full `inputSchema` for exact lengths, enums and nested limits.

## Project and Source capabilities

Owner is `core`, except `capabilities.list` (`api`). Queries have mutation `false`. Commands in this section have no abstraction level; Source update/updateFile/discard mutate `session`, and the remaining commands declare `document`.

| ID                   | Kind    | Input                                                                                                                           | Result and behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities.list` | query   | `{ids?:string[],prefix?:string,kind?:'query'/'command',includeSchema?:boolean}` | Current matching descriptions, including discovery itself. `includeSchema:false` omits `inputSchema`; default/omitted input returns complete schemas. |
| `project.snapshot`  | query   | `{}`                                                                            | `ProjectSnapshot`.                                                                                                                                    |
| `project.get`       | query   | `{}`                                                                            | `CanonicalProject` or `null`.                                                                                                                         |
| `project.source`    | query   | `{}`                                                                            | Canonical private JSON string.                                                                                                                        |
| `core.state`        | query   | `{}`                                                                            | `CoreMetadata & {hasProject:boolean, sourcePending:boolean}`.                                                                                         |
| `source.get`        | query   | `{}`                                                                            | `{source:string, sourceDraft:string/null, sourceError:string}`.                                                                                       |
| `source.files`      | query   | `{}`                                                                            | `NativeFiles`, including pending native file edits when present.                                                                                      |
| `history.get`       | query   | `{}`                                                                            | `{canUndo, canRedo, undoDepth, redoDepth}`. This is document undo, not Git.                                                                           |
| `project.replace`   | command | `{source:string}`                                                               | `ProjectSnapshot`; validates and replaces the whole project as one undo edit.                                                                         |
| `source.update`     | command | `{draft:string/null}`                                                           | Same result as `source.get`; updates the private aggregate draft without applying it. Prefer `source.updateFile` for native text editing.             |
| `source.updateFile` | command | `{name:string, source:string}`                                                  | `NativeFiles`; changes one loaded native file's draft. `name` comes from `source.files`, not a filesystem path.                                       |
| `source.apply`      | command | `{}`                                                                            | `ProjectSnapshot`; validates all pending files and commits once. Invalid drafts remain pending and the command rejects.                               |
| `source.discard`    | command | `{}`                                                                            | Same result as `source.get`; clears all pending drafts/errors.                                                                                        |
| `history.undo`      | command | `{}`                                                                            | `boolean`; undo one complete project edit. Host availability rejects when no undo is available.                                                       |
| `history.redo`      | command | `{}`                                                                            | `boolean`; redo one complete project edit.                                                                                                            |

Pending Source blocks non-Source document commands, undo/redo, sheet switching and version creation/restoration. Read queries remain usable except `schematic.erc` and `layout.drc`, which require applied Source. File drafts survive file selection; applying them is atomic at the project transaction level. Opaque aggregate `sourceDraft` can contain a native-file envelope; do not assume it equals the currently selected file's text. Per-file text comes from `source.files`.

`project.rename` is a Core object command with input `{name:string}` and result
`ProjectSnapshot`. It trims and validates the GUI's 1–120 character single-line
display name and updates native project settings as one undo edit. Source,
revision and close barriers apply.

## Schematic and component capabilities

`part.section` is a Core object command with closed input
`{schematicId,partId,section:'hardware'|'simulation'}` and `EditResult` output.
It changes the component's native board-inclusion flag across its units, preserving
simulation participation, model fields and Footprint assignment. Setting `simulation`
removes linked PCB packages and retains copper in the same undo transaction;
Setting `hardware` enables native board inclusion; a component without a Footprint
still belongs to Virtual. The UI names are Real for `hardware` and Virtual for
`simulation`. Assigned components use normal package preparation.
Source, close,
revision and validation gates apply. [Native section ownership](FORMAT.md#document-ownership)
and [view behavior](../DESIGN.md#real-and-virtual-sections) are separate
from this document edit.

The following Core commands share canvas/Properties preparation. They return
`EditResult`; creation commands additionally return the created or retained ID
in `selection`. All require `schematicId` and share the normal revision, Source,
validation and undo gates.

| ID                            | Additional input                                         | Behaviour                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schematic.label`         | `{id?,text?,position?,scope?:'global',shape?}` | Create a local/global label or update an existing label. Creation requires position, defaults text to `NET` and global shape to `input`; updates preserve omitted properties and UUID. Positions snap to 1.27 mm. Shape is `input`, `output`, `bidirectional`, `tri_state` or `passive` and requires a global label. Names must be nonblank and at most 4,096 characters. |
| `schematic.noConnect`     | `{position:Point}`                             | Place on an existing component pin; retain an existing marker without an undo edit.                                                                                                                                                                                                                                                                                       |
| `schematic.text.position` | `{id,position:Point}`                          | Set a Reference/Value/Sim.Params field or annotation position through `moveText`. Component field IDs use `field/<component UUID>/<field name>`.                                                                                                                                                                                                                          |
| `schematic.simplify`      | `{}`                                           | Apply the canvas menu's topology-preserving wire simplification once.                                                                                                                                                                                                                                                                                                     |

Owner is `core`; editing commands declare mutation `document`. `schematic.place` and `part.footprint` are host-backed object commands documented under [Library capabilities](#library-capabilities).

| ID                     | Kind / level | Input                                                                                                            | Result and behaviour                                                                                                                                                                                                                   |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schematic.list`       | query / —    | `{}`                                                                                                             | `{id,name,primary}[]` for all project schematics.                                                                                                                                                                                      |
| `schematic.get`        | query / —    | `{schematicId:string}`                                                                                           | Single-file `CanonicalProject`.                                                                                                                                                                                                        |
| `schematic.erc`        | query / —    | `{schematicId:string,settings?:{severities?:SchematicRuleSeverities}}`                                           | `RuleCheckResult & {revision:string, schematicId:string}`; checks one independent schematic. See [Rule-check queries](#rule-check-queries).                                                                                            |
| `schematic.drafting`   | query / —    | `{schematicId:string}`                                                                                           | Read-only `SchematicDraftingReport` with current revision, validated-sheet pin/body geometry and advisory label-linked physical islands. Pending Source is reported, never applied.                                                    |
| `schematic.add`        | command / O  | `{}`                                                                                                             | `{schematicId,revision}`; appends an independent schematic, up to 12 per project.                                                                                                                                                      |
| `schematic.remove`     | command / O  | `{schematicId:string}`                                                                                           | `ProjectSnapshot`; validates primary-board ownership and remaining sheets.                                                                                                                                                             |
| `schematic.operations` | command / P  | `{schematicId, operations:Operation[]}`                                                                          | `EditResult`; 1–100 operations applied atomically.                                                                                                                                                                                     |
| `schematic.move`       | command / O  | `{schematicId, ids:string[], delta:Point}`                                                                       | `EditResult`; leaves unselected wires in place.                                                                                                                                                                                        |
| `schematic.drag`       | command / P  | `{schematicId, ids:string[], delta:Point}`                                                                       | `EditResult`; repositions components with attached wire rerouting and original pin connections in one undo transaction. Use for connected component movement.                                                                          |
| `schematic.transform`  | command / O  | `{schematicId, ids:string[], operation:'rotate'/'rotateReverse'/'mirrorX'/'mirrorY', pivot?:Point}`              | `EditResult`; one transform transaction.                                                                                                                                                                                               |
| `schematic.pose`       | command / P  | `{schematicId,ids:string[],anchor:Point,target:Point,operations:SchematicMoveOperation[],connected:boolean}`     | `EditResult`; applies a complete canvas pickup pose in one undo transaction, including ordered rotations/mirrors and final translation. Connected mode reroutes attached networks; disconnected mode leaves unselected wires in place. |
| `schematic.delete`     | command / P  | `{schematicId, ids:string[]}`                                                                                    | `EditResult`; shared deletion rules remove complete attached leads and orphan annotations while preserving surviving shared networks.                                                                                                  |
| `schematic.duplicate`  | command / O  | `{schematicId, ids:string[], delta?:Point}`                                                                      | `EditResult` with newly created selection IDs; copies receive fresh UUIDs/references. Default delta is `{x:10.16,y:10.16}` mm.                                                                                                         |
| `schematic.paste`      | command / P  | `{schematicId,source:string,ids:string[],delta:Point}`                                                           | `EditResult` with fresh selection IDs; pastes retained objects/native annotations from a validated same-sheet snapshot without replacing current objects. Shares GUI clipboard preparation and reference allocation.                   |
| `schematic.wire`       | command / P  | `{schematicId, points:Point[]}`                                                                                  | `EditResult`; commits all route legs and deliberate segment splits once. 2–30,000 points.                                                                                                                                              |
| `schematic.wires`      | command / P  | `{schematicId, routes:Point[][]}`                                                                                | `EditResult`; 1–100 explicit polylines, each with at least two points, at most 30,000 points in total. Reuses ordered canvas wire preparation and commits once.                                                                        |
| `schematic.annotation` | command / O  | `{schematicId, text:string, position:Point, id?:string}`                                                         | `EditResult`; creates/updates a schematic annotation. This is design text, not an Agent screenshot attachment.                                                                                                                         |
| `part.properties`      | command / O  | `{schematicId, partId, reference?:string, value?:string, fields?:FieldRow[], position?:Point, rotation?:number}` | `EditResult`; resolves stable ID, shares reference/value/fields across units and applies value-linked simulation rules.                                                                                                                |
| `part.participation`   | command / O  | `{schematicId, partId, included:boolean}`                                                                        | `EditResult`; updates Include in SPICE simulation independently of plugin installation and physical connectivity.                                                                                                                      |

```ts
type Operation =
  | { type: 'setValue'; ref: string; value: string }
  | {
      type: 'addPart';
      kind: 'R' | 'C' | 'L' | 'D' | 'NMOS' | 'GND' | 'Port';
      x: number;
      y: number;
      value?: string;
    }
  | { type: 'removePart'; ref: string };
type FieldRow = { name: string; value: string; fresh?: boolean };
type SchematicMoveOperation = 'rotate' | 'rotateReverse' | 'mirrorX' | 'mirrorY';
```

Selection-ID arrays are unique and bounded to 30,000. `Operation` component coordinates are bounded to ±1,000 mm and operation values to 200 characters. Properties accepts up to 200 field rows, with field names/values and text values bounded to 4,096 characters. Part participation does not add solver support. Geometry validates connectivity and preserves shared branches; an edit can fail even when it passes the input schema.

`schematic.wires` uses the same exact coordinates, deliberate splits and junction
rules as repeated `schematic.wire` gestures. Routes are processed in input order
on a private candidate; invalid input or final validation rejects the whole edit.
It does not choose component placement, insert bends or find routes. Supply every
planned bend and retain off-grid imported pin anchors. The batch shares revision,
Source, close, validation and whole-project undo gates with ordinary edits.

`schematic.drafting` reads the accepted schematic, including while native Source
is pending. Its result includes `revision`, `sourcePending`, `editingBlocked`,
`units: 'mm'`, `grid: 1.27`, `advisory: true`, full counts, declared collection
limits and truncation notes. Bounded component entries contain identity, pose,
exact transformed pins, body bounds and Reference/Value annotation positions
with canonical field IDs accepted by `schematic.text.position`;
wires, labels and junctions carry stable IDs and geometry. `labelLinks` describes
ordinary named nets whose component pins occupy separate physical drawing
islands, with per-island pins, wire/label IDs and short single-pin stub evidence.
Physical grouping uses the same geometric joins as electrical grouping, before
label/power names link remote islands. Power notation and intentional remote
links are valid. These observations do not certify text clearance, readability,
ERC, SPICE or hardware correctness and never gate an otherwise supported edit.
Details omitted at the declared bounds remain explicitly truncated; counts do
not imply a complete detailed review. No native backing, resource bytes or host
paths are returned. [`lib/schematic-drafting.ts`](../lib/schematic-drafting.ts)
owns the exact report type and current observation limits.

### Selective discovery

Discovery filters combine with AND. ids accepts 1–64 unique exact IDs; an
unregistered requested ID fails explicitly. prefix is a literal ID prefix,
not fuzzy search. Availability is evaluated live in full and compact results.
Use includeSchema:false for a compact index, then fetch complete schemas only
for the selected IDs before constructing arguments. Omitted input retains full
discovery; catalog() remains the complete in-process method. Filtering changes
neither commands nor execution authority.

Live Agent instructions reuse the discovered index and complete tool definitions
within the current turn, batching schema requests for required IDs not yet known.
Accepted edits, revision changes and an active simulation do not invalidate
argument schemas. Refresh only for an unseen capability, explicit registration
or plugin-lifecycle changes, or a host error reporting a missing, changed or
unavailable capability; scope the refresh to affected IDs or a domain. This is
provider guidance, not a cached catalog or permission: every invocation retains
the host's live availability, schema, revision and lifecycle checks.

`schematic.pose` accepts up to 128 ordered operations around `anchor`, then translates
that anchor to `target`, through `previewSchematicMove`. `schematic.paste.source` is
the canonical JSON string from `source.get().source` or a JSON serialization of
`project.get`/`schematic.get`, bounded to 8 MB of UTF-8 and validated before use. The snapshot must contain the current
schematic ID; conflicting embedded definitions for copied symbols are rejected.
Copied old values and deleted objects remain available, while existing objects,
native annotations and unrelated live data are retained. Both commands use the
ordinary revision, pending Source and close barriers.

### Embedded symbol drawing

`schematic.symbol.get` is a Core query accepting `{schematicId,partId}` and returning
`{schematicId,partId,name,referencePrefix,value,position,drawing:SymbolDrawing}`.
It returns an independent editable drawing for a supported single-unit symbol;
it does not rewrite native data. Multi-unit/alternate bodies, unsupported
primitives and rounded rectangles reject explicitly without discarding their
native records.

`schematic.symbol.draw` is a Core object command accepting
`{schematicId,name,drawing:SymbolDrawing,partId?,referencePrefix?,value?,position?}`.
Omit `partId` to create a component; supply its current identity to edit it.
The result is `EditResult` with `selection:[partId]`. GUI and Agent use
`prepareSymbolDrawing` and the same revision, Source, close and whole-project
transaction gates. An identical drawing adds no undo edit.

```ts
type SymbolDrawingGraphic = (
  | { type: 'rectangle'; start: Point; end: Point }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'polyline'; points: Point[] }
) & { fill?: 'none' | 'background' | 'outline'; width?: number };
type SymbolDrawingPin = Point & {
  number: string;
  name: string;
  rotation: 0 | 90 | 180 | 270;
  length: number;
  type?:
    | 'input'
    | 'output'
    | 'bidirectional'
    | 'tri_state'
    | 'passive'
    | 'free'
    | 'unspecified'
    | 'power_in'
    | 'power_out'
    | 'open_collector'
    | 'open_emitter'
    | 'no_connect';
  shape?:
    | 'line'
    | 'inverted'
    | 'clock'
    | 'inverted_clock'
    | 'input_low'
    | 'clock_low'
    | 'output_low'
    | 'edge_clock_high'
    | 'non_logic';
  hidden?: boolean;
};
type SymbolDrawing = { graphics: SymbolDrawingGraphic[]; pins: SymbolDrawingPin[] };
```

Both arrays are complete replacements, each capped at 256 entries, with at least
one graphic or pin overall. Local millimetres use +X right and +Y down; positions
are within ±100,000 mm. Drawing coordinates, radii, strokes and pin lengths use
0.0001 mm precision. Pin rotation follows KiCad: 0° points right and 90° up.
Pin length is 0–100,000 mm. Pin numbers are unique printable nonblank strings of
1–64 characters, names at most 128. Circles have positive radius ≤100,000 mm;
rectangles need nonzero width/height; polylines have 2–128 points with distinct
geometry. Stroke width is 0–100 mm. Name is 1–80 printable characters without a
colon; `referencePrefix` matches `#?[A-Za-z][A-Za-z0-9_]{0,15}` and value is printable
text of at most 4,096 characters. New position defaults to `{x:0,y:0}` and uses the
schematic placement grid; omitted prefix/value default to `U`/name. New symbols
start excluded from simulation and have no assigned footprint.

Edits retain the component UUID, reference, fields, participation, assignment and
supported hidden native metadata. They create an instance-specific embedded
`OpenPE:<name>_<UUID>` symbol definition, leaving other instances and bundled
libraries unchanged. Pins retain native metadata by number. Wired/labelled/marked
terminal positions cannot move or disappear; disconnect them first. Existing pin
numbers cannot be removed while `Sim.Pins`, `Sim.Device` or `Sim.Library` is
nonblank. Normal project validation and primary-board synchronization still apply.

## Layout capabilities

Owner is `core`; every command declares mutation `document`. Every Layout input includes a current **`boardId`**. The table shows its remaining fields. Queries do not alter the document or regenerate source fills.

```ts
type Layer = 'F.Cu' | 'In1.Cu' | 'In2.Cu' | 'B.Cu';
type BoardObject = {
  kind: 'footprint' | 'track' | 'via' | 'graphic' | 'zone';
  id: string;
};
type ViaSize = { diameter: number; drill: number };
type RouteLeg = { layer: Layer; points: Point[]; via?: ViaSize };
```

| ID                        | Kind / level | Input in addition to `boardId`                                                                                                                                                                                             | Result and behaviour                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.get`              | query / —    | `{}`                                                                                                                                                                                                                       | `{boardId,layers,thickness,counts:{packages,tracks,vias,zones,graphics,nets},project:CanonicalProject}`.                                                                                                                                                                                                                                                                                                                                  |
| `layout.drc`              | query / —    | `{settings?:Partial<PCBDesignRuleConfig>}`                                                                                                                                                                                 | `RuleCheckResult & {revision:string, boardId:string, settings:PCBDesignRuleConfig}`; see [Rule-check queries](#rule-check-queries).                                                                                                                                                                                                                                                                                                       |
| `layout.route.preview`    | query / —    | `{netId, layer:Layer, width, clearance, start:Point, end:Point, mode?:'straight'/'45', posture?:boolean}`                                                                                                                  | `{points:Point[],blocked:boolean,message:string}`; bounded Walk Around planning.                                                                                                                                                                                                                                                                                                                                                          |
| `layout.move`             | command / O  | `{selection:BoardObject[], delta:Point}`                                                                                                                                                                                   | `RevisionResult`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `layout.pose`             | command / P  | `{selection:BoardObject[],anchor:Point,target:Point,operations:('rotate'/'rotateReverse'/'flip')[]}`                                                                                                                       | `RevisionResult`; one canvas pickup transaction with up to 128 ordered quarter-turn rotations/package flips, followed by anchor-to-target translation. Rotations use the shared group pivot; flips change only selected footprints and reflect their origins across the anchor's horizontal axis.                                                                                                                                         |
| `layout.drag`             | command / P  | `{selection:BoardObject[], delta:Point, clearance, pickup?:Point, mode?:'connected'/'corner', endpointTolerance?:number, posture?:boolean, obstacleMode?:'shove'/'walk-around', constrain?:boolean, previousDelta?:Point}` | `{revision,changedIds:string[],requestedDelta:Point,appliedDelta:Point,constrained:boolean,constraintReason?:string}`. Connected mode accepts a footprint-only or track-only selection. Footprints carry attached track ends using Walk Around. Track-only drag defaults to Shove. Corner requires one track and pickup, with a default tolerance of 0.5 mm. Explicit constrain accepts a revalidated boundary and enables previousDelta. |
| `layout.rotate`           | command / O  | `{selection:BoardObject[], degrees?:number, pivot?:Point}`                                                                                                                                                                 | `RevisionResult`; `degrees` defaults to 90.                                                                                                                                                                                                                                                                                                                                                                                               |
| `layout.flip`             | command / O  | `{selection:BoardObject[]}`                                                                                                                                                                                                | `RevisionResult`; flips selected physical packages.                                                                                                                                                                                                                                                                                                                                                                                       |
| `layout.delete`           | command / O  | `{selection:BoardObject[]}`                                                                                                                                                                                                | `RevisionResult`; linked package deletion clears its schematic assignment in the same edit.                                                                                                                                                                                                                                                                                                                                               |
| `layout.duplicate`        | command / O  | `{selection:BoardObject[], delta:Point}`                                                                                                                                                                                   | `{revision,selection:BoardObject[]}`; assigned packages cannot be duplicated.                                                                                                                                                                                                                                                                                                                                                             |
| `layout.route`            | command / P  | `{netId, width, clearance, legs:RouteLeg[]}`                                                                                                                                                                               | `{revision,trackIds:string[],viaIds:string[]}`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `layout.via`              | command / O  | `{netId, position:Point, diameter, drill, clearance}`                                                                                                                                                                      | `{revision,viaId}`; validates all-layer copper, holes and keepouts.                                                                                                                                                                                                                                                                                                                                                                       |
| `layout.zone`             | command / O  | `ZoneChanges`                                                                                                                                                                                                              | `{revision,zoneId}`; creates or updates a typed zone.                                                                                                                                                                                                                                                                                                                                                                                     |
| `layout.fill`             | command / P  | `{zoneId?:string,clearance?:number}`                                                                                                                                                                                       | `RevisionResult`; enables/fills the selected board zone, or all enabled zones when zoneId is absent, with minimum 0.0001–1,000 mm clearance (default 0.25); retains larger rules and saves rules/contours in one undo edit.                                                                                                                                                                                                               |
| `layout.net`              | command / O  | `{name:string}`                                                                                                                                                                                                            | `{revision,netId}`; trimmed name must be nonempty and unique. Does not join schematic networks.                                                                                                                                                                                                                                                                                                                                           |
| `layout.properties`       | command / O  | `{thickness?:number, layers?:['F.Cu','B.Cu']/['F.Cu','In1.Cu','In2.Cu','B.Cu']}`                                                                                                                                           | `RevisionResult`; validates the complete board.                                                                                                                                                                                                                                                                                                                                                                                           |
| `layout.track.properties` | command / O  | `{trackId, netId?:string, layer?:Layer, width?:number, locked?:boolean}`                                                                                                                                                   | `RevisionResult`; explicit `locked:false` unlocks before other copper edits. Canonical tracks store `locked:true` or omit it.                                                                                                                                                                                                                                                                                                             |

```ts
type ZoneChanges = {
  zoneId?: string;
  netId?: string | null;
  layer?: import('../lib/pcb').BoardLayer;
  outline?: Point[];
  holes?: Point[][] | null;
  clearance?: number; // For rule areas, pour exclusion margin; defaults to 0 mm.
  minThickness?: number;
  thermalGap?: number;
  thermalBridge?: number;
  priority?: number | null; // Integer, 0–10,000.
  padConnection?: 'yes' | 'no' | 'thru_hole_only' | null;
  islandRemovalMode?: number | null; // Integer, 0–2.
  fillEnabled?: boolean | null;
  keepout?: {
    tracks: boolean;
    vias: boolean;
    pads: boolean;
    copperpour: boolean;
    footprints: boolean;
  } | null;
};
```

Widths, thickness, via dimensions and zone minimum thickness use `0 < value ≤ 1,000` mm in these schemas. The `via` nested inside a `RouteLeg` has the narrower `0 < diameter/drill ≤ 20` mm schema. Routing/via clearance is 0.05–20 mm; zone clearance and thermal gap/bridge are 0–1,000 mm. Actual board and drill relationships receive domain validation too. Selection arrays are unique and at most 30,000 entries. A new zone requires `outline`, `layer` and an explicit `netId` (`null` for a keepout); `zoneId` updates must resolve an existing zone. Outline/hole rings have at least three points, with schema and complete-board geometry limits.

Routes contain 1–65 legs and at most 15,000 points in total. Each non-final leg must end at the next leg's start, change layer and supply a through via; the final leg cannot contain an unfinished via transition. Blocked routes/drags fail before committing. Copper, boundary and zone-rule edits automatically refresh already-filled enabled zones, including footprint-owned zones, in the same transaction. Unfilled/disabled zones remain unfilled unless explicitly filled. Fill failure rejects the complete edit without clearing accepted contours. Route validation and the separate read-only `layout.drc` query have bounded coverage; neither provides automatic routing, complete KiCad rule parity or manufacturing qualification. Saved fills require final review; Gerber export neither refills nor proves manufacturing readiness. See [Layout](LAYOUT.md).

`layout.lock` is a Core object command taking `{boardId, targets:[{kind,id}], locked:boolean}` and returning `RevisionResult`. Targets cover footprint, pad, track, via, graphic and zone; text/dimensions are graphics and rule areas are zones. It changes all requested locks in one transaction. Unlock a parent footprint before changing a pad lock, or unlock both together. Canonical locks store `locked:true` or omit it. GUI Properties uses the same preparation. Source, revision and close barriers apply.

Move, rotation, deletion and object-property replacements reject changes to locked objects before writes. Connected drag, corner drag and Shove keep locked neighbours fixed. Lock changes have whole-project undo and native persistence; changing only locks retains saved copper fills. Explicit unlocking may share one `layout.track.properties` transaction with a net, layer or width change. Native Source remains an explicit editing path.

### Embedded footprint drawing

`layout.footprint.draw` is a Core object command accepting
`{boardId,name,drawing:FootprintDrawing,footprintId?,partId?,position?,reference?,value?}`.
It returns `{revision,boardId,footprintId,selection:[footprintId]}`. Omit
`footprintId` to create an embedded package, or supply its current identity to
replace its local drawing. Optional `partId` links a new package to an unplaced
primary-sheet component. Existing packages cannot be reassigned by this command.
GUI and Agent share `prepareFootprintDrawing`, complete project validation and
one undo transaction, including required refresh of already-filled enabled zones.

```ts
// Pad and BoardLine are the canonical records in lib/pcb.ts.
type FootprintDrawing = {
  pads: (Omit<Pad, 'id' | 'netId' | 'locked' | 'unconnected'> & { id?: string })[];
  graphics: (Omit<BoardLine, 'id' | 'locked'> & { id?: string })[];
};
```

Supply both complete arrays: at most 2,000 pads and 10,000 graphics. Their schemas
derive from the generated canonical pad/graphic definitions, rather than a second
property schema. `layout.object` supplies the existing footprint; omit pad
`netId`, `locked`, `unconnected` and graphic `locked` from the drawing. Runtime
discovery exposes all supported fabrication, text, layer and corner fields.

Pad types are `smd`, `thru_hole` and `np_thru_hole`. Shapes are `rect`, `circle`,
`oval`, `roundrect` and `custom`. Custom pad outlines use the [Layout
limits](LAYOUT.md#layout-and-model), with `customAnchor:'circle'` for a circular
anchor. Pad dimensions and through-hole drills are 0.0001–1,000 mm, with a
0.000001 mm minimum for circular custom anchors. Circular pads and anchors
require equal dimensions, plated drills must fit
inside the copper, and SMD pads cannot have drills. Rounded pads require a
0–0.5 corner ratio.
Local coordinates use ±100,000 mm at 0.000001 mm precision; pad rotation is within
±360°. Graphics support lines, arcs, circles, polygons and text, using the same
canonical record fields as board graphics. Arcs require `mid`, polygons require
intermediate `points`, text requires `text`, and fill applies only to circles and
polygons. Footprint dimensions are rejected. Full project geometry and aggregate
limits also apply.

New names match `[A-Za-z0-9][A-Za-z0-9_.-]{0,79}` and create an `OpenPE:<name>`
embedded identity. Position defaults to `{x:0,y:0}`, rotation to zero and side to
front. An unlinked package defaults to an unused `FP<number>` reference and value
equal to its name; `reference`/`value` override these creation defaults. Linked
captions come from the schematic. Existing name, position, reference and value
remain unchanged by drawing replacement; their ordinary Properties commands
remain available.

Existing pad IDs preserve identity and nets; omit IDs for new pads/graphics.
Without a pad ID, a unique existing pad number identifies the retained pad;
repeated numbers require explicit existing IDs. IDs from another package reject.
Edits preserve package pose, side, models, fabrication overrides, retained native
metadata and unrelated route geometry. Connected pads cannot be removed,
renumbered or converted to mechanical holes. Pads touching routed copper cannot
move or change type/layer membership. Locks and bounded copper collision checks
reject blocked changes; these checks do not establish complete KiCad DRC parity.
An unchanged drawing adds no undo edit.

### Layout object Properties

Canonical footprint records returned with `layout.get` can include `referencePoints`,
an array of `{id,x,y,size,layer}`. Coordinates are local to the footprint and
`layer` is `F.Fab` or `B.Fab`. These points follow their parent footprint and are
editable through native Source. [Format](FORMAT.md#document-ownership) defines the native limits.

`layout.region.fillet` is a Core object command taking
`{boardId,kind:'zone'|'graphic',id,radius}` and returning `RevisionResult`.
It rounds every corner of one unlocked board zone/rule area or polygon graphic
through the same pure preparation as the GUI preview. Radius must be positive
and at most 1,000 mm. Only simple convex outer rings without collinear vertices
are supported; cutouts remain unchanged and must stay strictly inside the result.
The accepted native polygon has at most 10,000 vertices, six-decimal coordinates
and a maximum 0.01 mm deviation from circular fillets. Excessive radii, precision
collapse and geometry work over two million operations reject unchanged. Source,
revision, close and whole-project undo gates apply; previously filled enabled
zones refresh in the same accepted transaction.

`layout.object` is a read-only Core query taking `{boardId,kind,id}`, where `kind`
is `footprint`, `pad`, `track`, `via`, `graphic` or `zone`. It returns an independent
copy of that complete native board record. No host path permissions or private
project backing are included. Use it before editing to retain unrelated metadata.

A `graphic` selection or query ID also identifies native footprint text.
Its canonical `keepUpright:false` field preserves free rotation with the
package. The field applies only to footprint text.
Move and rotate preserve its parent and edit text geometry in its local frame.
Delete hides footprint fields and removes ordinary footprint text. Duplicate
skips fields and copies ordinary footprint text within its owner.

These Core object commands require `boardId` and return `{revision}`, with
`layout.graphic` additionally returning `graphicId`. Each uses one whole-project
transaction and the same Source/revision/close gates as GUI edits. Copper and
boundary edits refresh already-filled enabled zones; captions/model-only edits retain them.

| ID                            | Additional input                                         | Behaviour                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.pad.properties`       | `{padId,changes}`                                        | Shared `setPCBPadProperties`: position, rotation, size/shape, drill/offset/slot, rounded/chamfered corners, fabrication and thermal overrides. Identity, pin number, net, type and layers cannot change. Custom pads retain their outline and anchor shape, and size describes the anchor. Circles and circular anchors normalize diameter. Shape changes remove inapplicable corner overrides. |
| `layout.via.properties`       | `{viaId,changes}`                                        | Existing via X/Y, net, diameter and drill, with complete Core geometry validation, matching numerical Properties edits.                                                                                                                                                                                                                                                            |
| `layout.footprint.properties` | `{footprintId,changes}`                                  | X/Y, rotation, side, board-only reference/value, complete model array and fabrication margins. Side changes share `flipPCBFootprint`, including local pads/artwork/models. Linked captions require `part.properties`; IDs, assignments, pad nets and geometry arrays cannot change here.                                                                                           |
| `layout.graphic`              | `{graphicId?,graphic}`                                   | Create a board graphic or replace a board graphic or footprint text. `graphic` is the native record without `id`. Updates preserve the UUID and footprint owner. Footprint field identity and Reference/Value content are retained.                                                                                                                                                |
| `layout.rectangle.resize`     | `{selection:BoardObject[],bounds:{minX,minY,maxX,maxY}}` | Shared canvas/Properties boundary resize for an Edge.Cuts rectangle or one zone, including its holes. Preserves object UUIDs and rejects nonrectangular outline selections or degenerate bounds.                                                                                                                                                                                   |
| `layout.rectangle.properties` | `{selection:BoardObject[],width}`                        | Updates every native edge of a rectangular Edge.Cuts outline in one undo transaction through `setPCBRectangleWidth`; width is 0.0001–1,000 mm. One edge or the complete rectangle can identify the group; zones, nonrectangular selections and locked edges are rejected.                                                                                                          |

Property `changes` omit keys to retain them; `null` clears optional pad/footprint
overrides (including the explicit `models` member). Required
geometry cannot be cleared. Runtime discovery contains the exact generated
nested schemas, including model XYZ transforms, opacity and visibility, board
text effects and dimension formatting. Domain validation remains authoritative.

`part.properties` accepts rotation within ±360°, rounds it to four decimals and
normalizes it to [0°, 360°), using the same preparation as GUI numerical Properties.
Component X/Y use the 1.27 mm schematic grid.

`layout.track.properties` also accepts optional exact `start`/`end` points.
It shares `setPCBTrackEndpoints`; a locked track rejects endpoint edits unless
the same transaction explicitly includes `locked:false`. Endpoints retain native
precision independently of display grid. `layout.zone` accepts supported board
layers, priorities up to 10,000 and zero thermal gap/bridge as native Properties do.
Its input shape is generated from canonical zone definitions, excluding identity,
lock and stored fills: outline rings have at most 10,000 points and at most 100
holes. Omitted fields retain their values; `null` clears optional overrides,
including `padConnection:null` to restore default thermal relief. `netId:null`
explicitly means unassigned and remains present. Updates share
`preparePCBZoneProperties`, retain absent defaults and refresh already-filled
enabled zones once in the accepted transaction.

## Model CAD capabilities

`modelCad.get`, `modelCad.add`, `modelCad.update`, `modelCad.remove`,
`modelCad.duplicate`, `modelCad.sketch.extrude` and `modelCad.boolean` are Core-owned and require a current `boardId`. Commands
have mutation `document`, review `optional` and the same revision, pending
Source and close barriers as other document commands. The read query returns
validated document state while Source is pending. These operations retain the
PCB and schematic, and do not depend on simulation plugins.

| ID                        | Kind / level | Input                                                                                      | Result                                                                                                                                  |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `modelCad.get`            | query / —    | `{boardId}`                                                                                | `{boardId,modelCad:ModelCAD/null}`                                                                                                      |
| `modelCad.add`            | command / O  | `{boardId,object:ModelCadObject}`                                                          | `{revision,boardId,modelCad,object}`; rejects reused UUIDs.                                                                             |
| `modelCad.update`         | command / O  | `{boardId,object:ModelCadObject}`                                                          | Same shape as add; replaces an existing object, retaining its UUID.                                                                     |
| `modelCad.remove`         | command / O  | `{boardId,ids:string[]}`                                                                   | `{revision,boardId,modelCad}`; all selected objects must exist.                                                                         |
| `modelCad.duplicate`      | command / P  | `{boardId,ids:string[],offset:{x,y,z}}`                                                    | `{revision,boardId,modelCad,objects:ModelCadObject[]}`; returns the new copies with fresh body UUIDs.                                   |
| `modelCad.sketch.extrude` | command / P  | `{boardId,sketch:ModelCadSketchExtrusion}`                                                 | `{revision,boardId,modelCad,object}`; one prepared solid from ordered planar contours.                                                  |
| `modelCad.boolean`        | command / P  | `{boardId,operation:'union'/'difference'/'intersection',targetId,toolId,resultId?:string}` | `{revision,boardId,modelCad,object}`; removes both operands and inserts the prepared result at the target's position, as one undo edit. |

GUI Boolean roles use ordered canvas body selection, without automatic operands.
Face/edge/line picks remain typed presentation selection until explicit Use owning
solids conversion. This command continues to accept two body IDs; it does not
execute independent curve or surface Booleans.

```ts
type ModelCAD = { version: 1; objects: ModelCadObject[] }; // At most 64.
type ModelCadVector = { x: number; y: number; z: number };
type ModelCadProfile =
  | { kind: 'rectangle' }
  | { kind: 'circle' }
  | { kind: 'polygon'; points: { x: number; y: number }[] };
type ModelCadShape = {
  kind: 'box' | 'cylinder' | 'extrusion' | 'boolean';
  size: ModelCadVector; // 0.5–1,000 mm; Boolean uses a conservative envelope.
  profile?: ModelCadProfile; // Required only for extrusion.
  edgeTreatment?: {
    kind: 'chamfer' | 'fillet';
    distanceMm: number; // 0.01–500 mm, with positive remaining height/area.
    edges: string[]; // Exact semantic base-edge IDs.
  };
  boolean?: {
    // Required only for Boolean.
    operation: 'union' | 'difference' | 'intersection';
    operands: [ModelCadOperand, ModelCadOperand];
  };
};
type ModelCadOperand = { shape: ModelCadShape; position: ModelCadVector; rotation: ModelCadVector };
type ModelCadObject = {
  id: string; // UUID; globally unique across the project.
  name: string; // 1–80 characters, nonblank, no ASCII controls.
  kind: ModelCadShape['kind'];
  position: ModelCadVector; // Native axes, ±100,000 mm.
  rotation: ModelCadVector; // ±360°, intrinsic XYZ: Rx * Ry * Rz.
  size: ModelCadVector;
  material: 'aluminium' | 'pmma' | 'plastic';
  opacity: number; // 0.05–1.
  color?: string; // RGB #RRGGBB; absence uses the selected material color.
  profile?: ModelCadShape['profile'];
  edgeTreatment?: ModelCadShape['edgeTreatment'];
  boolean?: ModelCadShape['boolean'];
};
```

Unmarked object fields remain required; extra keys are rejected. Boxes and
cylinders use their current primitive fields. Rectangle profiles use X/Y dimensions; circle
profiles and cylinders require equal X/Y diameters. Polygon profiles have 3–128
vertices within ±500 mm, implicit closure, positive area, no self-crossing/touching
and centred bounds matching X/Y dimensions. Extrusion depth is Z.

Dedicated local-hole fields are unsupported, including empty `holes` arrays; native files containing them are rejected without rewriting. Openings use sketch contour Difference before extrusion. Edge treatment accepts 1–448 unique IDs: `profile:top:N`, `profile:bottom:N` or `side:N`. Indices address current base-profile segments. Circle profiles have only profile index 0 and no vertical seam. The host requires one exact matching base curve per ID; missing or ambiguous topology rejects the operation. Boolean bodies expose no editable edge catalogue.

Boolean operand trees omit IDs/material and contain at most 32 operations with
Boolean nesting depth four below the root. Operands retain local XYZ poses; the
declared centred envelope must conservatively contain the operation's result
bound. The kernel constructs operands, not the envelope. The entire CAD JSON is
at most 256,000 characters. Selection arrays contain 1–64 unique identities;
duplicate offsets use ±100,000 mm per axis and final positions remain bounded.
Emptying the model removes the native setting; an identical update adds no undo.

`ModelCadSketchExtrusion` requires `{id,name,plane,origin,contours,distance,direction,material,opacity}` with optional `color`. Plane is `XY`/`XZ`/`YZ`; origin uses native XYZ millimetres; direction is `positive`/`negative`/`symmetric`; distance is 0.5–1,000 mm. Each of 1–6 contours is `{operation,profile,size:{x,y},position:{x,y},cornerTreatment?}`, with local workplane coordinates, analytic `ModelCadProfile`, and `union`/`difference`/`intersection`. The first contour must use `union`. Optional `cornerTreatment` is `{kind:'fillet'/'chamfer',distanceMm:0.01–500,corners:number[]}` with 1–128 unique zero-based original rectangle/polygon vertex indices. Circles, reflex/collinear/missing vertices, adjacent overlap and treatments consuming the profile are rejected; the final host kernel also verifies topology. The treatment compiles to analytical `side:N` extrusion edges before Boolean composition. GUI corner edits use shared `prepareModelCadSketchCorners`; clearing a treatment omits it. Shared pure `extrudeModelCadSketch` compiles equal-depth analytic operands; planar Booleans distribute over extrusion, so one contour stores an extrusion and multiple contours store the same bounded immutable Boolean solid recipe. GUI and Agent use the same command, host proof, revision checks, native serialization and one undo transaction. Empty or invalid results cannot commit.

The synchronous Core validates recipes but requires exact host preparation for
new extrusion, Boolean or edge-treatment geometry. `registerProjectCapabilities`
previews the candidate, prepares pending shapes through the fixed kernel, then
rechecks revision/Source/close gates before one commit. Both human and Agent
transports use this wrapper. Source apply and `project.replace` share preflight;
direct Core commits cannot bypass the prepared-key gate. Unchanged top-level
pose, name, material, color or opacity can reuse current geometry. Native admission is
structural to preserve loaded records before lazy preview. No arbitrary CAD
scripts, imported/Boolean edge-topology editing, mechanical-strength checks or whole-assembly
simulation are exposed.

## Rule-check queries

`schematic.erc` and `layout.drc` are Core-owned queries with mutation `false`, review `none` and no abstraction level. The Schematic and Layout controls invoke the same capability handlers available to Agent `openpe_query`; both checks are independent of SPICE Simulation and Layout Thermal. Both schemas reject extra keys. `schematicId` and `boardId` are required current project identities, each 1–200 characters. The human ERC control passes the active schematic ID; the query can check any identified schematic in its originating project without changing the active sheet. Each schematic is independent, with no cross-file electrical joins. DRC targets the project's current PCB, associated with its primary schematic.

`layout.drc.settings` is a Core document command at object level with optional
review. It takes `{boardId, thresholds}`, where `thresholds` is a partial record of
the numeric fields below, each in the range 0–1,000 mm. It returns
`{revision, boardId, settings: PCBDesignRuleConfig}`. Changed values update the
native board minima in one undo transaction behind the Source and close gates.
Equal or omitted values leave the existing fields and undo history intact.
Changed copper-clearance, edge or hole minima refresh already-filled enabled
pours in that transaction, using the [shared native fill rules](LAYOUT.md#saved-zone-fills).
Other board objects stay fixed; queries and check-only overrides never refill.

```ts
type PCBDesignRuleConfig = {
  clearance: number;
  minTrackWidth: number;
  minThroughHole: number;
  minViaDiameter: number;
  minAnnularRing: number;
  copperToEdge: number;
  copperToHole: number;
  holeToHole: number;
  minSilkClearance: number;
  minTextHeight: number;
  minTextThickness: number;
  scopes: (
    | 'dimensions'
    | 'clearance'
    | 'edge'
    | 'holes'
    | 'silkscreen'
    | 'courtyards'
    | 'keepouts'
    | 'connectivity'
  )[];
  useZoneClearance: boolean;
  useKiCadClearance: boolean;
  clearanceOverrides: { key: string; clearance: number; enabled?: boolean }[];
  severities: Partial<Record<PCBDesignRuleId, 'error' | 'warning' | 'ignore'>>;
};

type RuleCheckIssue = {
  id: string;
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  objectIds: string[];
  location?: Point;
};

type RuleCheckResult = {
  kind: 'erc' | 'drc';
  complete: boolean;
  truncated: boolean;
  checkedRules: string[];
  issues: RuleCheckIssue[];
  notes: string[];
};
```

DRC settings are optional per-call overrides. Each supplied threshold is finite and within 0–1,000 mm. Supply at least one distinct supported scope when overriding `scopes`. `severities` accepts rule IDs from the capability schema. An omitted rule uses the engine's default severity. An ignored rule is omitted from `checkedRules` and its findings are suppressed. Ignored rules or a selected subset make coverage partial. The result returns the full settings in canonical scope order. `useZoneClearance` enables saved-zone limits and `useKiCadClearance` enables the supported net-class and conditional limits. When clearance is in scope, `clearanceSources` lists `zones`, `netClasses`, `rules` and coverage `notes`. Each source has a `key`, `label` and original `clearance`. Rule rows also return their `condition`. Supply up to 512 distinct source keys in `clearanceOverrides` to replace limits. Set `enabled:false` to skip an individual source. Only keys present in the current source list affect the check. Omitted fields use the saved board minima and [Layout DRC defaults](DESIGN-RULES.md#layout-drc), which also define source precedence and coverage. Query overrides affect only that check. Use `layout.drc.settings` to commit board minima. ERC accepts optional per-rule severity overrides under `settings.severities`, with type `SchematicRuleSeverities = Partial<Record<SchematicRuleId, 'error' | 'warning' | 'ignore'>>`. Valid IDs are enumerated in discovery. Omitted rules keep their defaults. An ignored ERC rule is omitted from `checkedRules` and its findings are suppressed, with `complete:false`. Issue IDs identify findings within the computed report; rule IDs identify the rule, and object IDs refer to the checked document's objects. A location, when present, uses millimetres. Reports are observations of the returned string `revision`, not saved document objects or persistent issue UUIDs; rerun after a revision or applied rule-settings change.

The two engines load by asynchronous import on demand. Core captures the immutable project and revision, then checks the cancellation signal, editing/close barrier, project identity, revision and pending Source again after loading, before running the synchronous bounded checks. Pending Source, a closing project, a missing target, cancellation or a superseded revision rejects the query instead of returning a report for older content. The host also aborts active requests on suspension, unregistration and disposal. These queries do not use a caller's `expectedRevision` as a command precondition; the returned revision identifies the checked state. CPU geometry work is bounded rather than interruptible mid-loop.

Checks neither apply Source nor commit an edit, advance Core revision, create undo, change selection or modify native files. Results and settings stay outside canonical project content, Source, recovery and Git history; the human adapter retains report/presentation state separately and marks old reports stale. Standard capability lifecycle events can be emitted, but a successful check emits no Core document-change event.

ERC uses physical pin/wire/label/power topology, transformed embedded-library pin geometry and shared multi-unit physical pins. Simulation exclusion does not remove connections; incidental crossings do not join. It checks unconnected pins (including passive/unspecified pins, except free/no-connect pins and power markers), dangling wires/labels, no-connect placement/connections, conflicting references/net names, incompatible outputs and missing declared signal/power drivers. Output conflicts and connected no-connect findings default to Error. Conditional driver states are not simulated. Unknown pin types (`erc.pin-type-unsupported`) or inconsistent declarations for one physical pin (`erc.pin-type-inconsistent`) produce warning coverage findings with `complete:false`; ambiguous electrical types are not resolved by component order.

DRC checks supported pads, tracks, through vias, copper graphics, holes, saved zone fills, closed Edge.Cuts, keepouts, selected silkscreen geometry and assigned-pad connectivity using the requested thresholds. It does not refill zones or establish fill freshness. Unsupported geometry and ambiguous unassigned copper can make coverage partial. [Design rules](DESIGN-RULES.md#layout-drc) owns the detailed coverage, including the KiCad clearance subset and curve approximations.

Both reports cap issues at 1,000 and set `truncated:true` and `complete:false` when truncated. Unsupported geometry or work limits can return an explicitly incomplete report or reject with an actionable failure; an absent report is not a clean result. `checkedRules` lists the implemented rule families, while `notes` and coverage findings describe limitations. Even `complete:true` means completion of those bounded checks only. See [Design rules](DESIGN-RULES.md) for coverage and limits; native format validation and SPICE simulation remain separate.

`pcb.courtyard-overlap` links both footprint IDs and returns a position at their shared area. `pcb.courtyard-malformed` links the affected footprint and leaves the report incomplete. DRC resolves linked footprint references from the primary schematic on the same checked revision.

## Workbench and history capabilities

Owner is `host`, level is absent. All commands have optional review. Mutation is `session` unless the table specifies `document` or `external`.

| ID                        | Kind / mutation    | Input                                                         | Result and behaviour                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workbench.state`                                                   | query / false                          | `{}`                                                 | Originating project's bounded `WorkspaceContext`; without a document returns `ProjectSnapshot`.                                                                                                                                                                   |
| `project.datasheet.page`                                            | query / false                          | `{page:integer,image?:boolean}`                      | One complete pinned PDF page: `{exampleId,projectId,bindings,document,page,pageCount,text,image?:{mimeType:'image/png',data,width,height}}`. One-based page ≤ 1,000 and actual page count; image defaults to true. No URL/path/selectors.                         |
| `project.datasheet`                                                 | query / false                          | `{}`                                                 | `ProjectDatasheetContext` for the current example controller, including reviewed parameter JSON and source locators. No paths, URLs or example selectors are accepted.                                                                                            |
| `workbench.view`                                                    | command / document                     | `{view:'canvas'/'source'/'layout'/'3d'}`             | `{view}`; GUI navigation validates/applies pending Source. Agent navigation has review none; leaving Source requires pending edits to be applied separately, while viewing Source retains drafts. UI names are Schematic, Source, Layout and Model.               |
| `workbench.schematicSection`                                        | command / session                      | `{section:'hardware'/'simulation'/'all'}`            | `{section}`; selects the active schematic's presentation section. Requires Schematic view with applied Source and no conflicting Properties draft or IME composition. Native data, dirty state and undo are unchanged.                                            |
| `workbench.sheet`                                                   | command / session                      | `{id:string}`                                        | `{id}`; selects an existing schematic. Pending Source blocks it.                                                                                                                                                                                                  |
| `workbench.selection`                                               | command / session                      | `{ids:string[]}`                                     | `{ids}`; selects visible schematic objects allowed by current selection filters. Unique IDs, at most 30,000.                                                                                                                                                      |
| `workbench.panel`                                                   | command / session                      | `{panel:'parts'/'layers'/'history'/'settings'/null}` | `{panel}`. `history` opens Git without switching editor mode. `layers` enters Schematic and opens Visualization. The GUI validates pending Source first. Agent calls for either panel require applied Source.                                                     |
| `project.save`                                                      | command / external                     | `{saveAs?:boolean}`                                  | `{status:'saved'/'cancelled'}`; validates and uses the native dialog/live grant. Default `saveAs` is false.                                                                                                                                                       |
| `project.export`                                                    | command / external                     | `{format:ProjectExportFormat}`                       | `{status:'exported'/'cancelled'}`. Applies Source, compiles the requested output, then opens its native picker. Preserves the native save destination and baseline.                                                                                               |
| `enclosure.exportStep`                                              | command / external                     | `{}`                                                 | `{status:'exported',name:string}` or `{status:'cancelled'}`; requires the originating active Model view, applied Source, CAD bodies, and the native bridge. Exports the current validated CAD solids through the STEP destination picker; saving is not required. |
| `versions.list`                                                     | query / false                          | `{offset?:integer}`                                  | `HistoryPage`; offset defaults to 0, range 0–100,000.                                                                                                                                                                                                             |
| `versions.read`                                                     | query / false                          | `{id:string}`                                        | `{source:string}` for a validated reachable Git version. ID is 40–64 lowercase hexadecimal characters.                                                                                                                                                            |
| `versions.create`                                                   | command / external                     | `{message:string}`                                   | `{id:string}`; message length 1–2,000; pending Source and overlapping file operations block creation.                                                                                                                                                             |
| `versions.restore`                                                  | command / document                     | `{id:string}`                                        | `{id,revision}`; reads a reachable version and uses the GUI restoration path for one undo edit, with Source/revision/cancellation guards. Does not save native files.                                                                                             |
| `project.examples`                                                  | query / false                          | `{}`                                                 | Current `{entries:[{id,title,description,section}],warnings}` from the host, without paths/grants.                                                                                                                                                                |
| `project.new` / `project.open` / `project.close` / `project.reveal` | command / session (`reveal`: external) | `{}`                                                 | `{status:'requested'}`; shared new-project flow, native picker, unsaved-work close confirmation or Explorer action.                                                                                                                                               |
| `project.openExample`                                               | command / session                      | `{id:string}`                                        | `{status:'requested'}`; identity must come from `project.examples`; host re-resolves it before admission.                                                                                                                                                         |
| `simulation.show`                                                   | command / document                     | `{}`                                                 | `{visible:true}` after enabled plugin settings/capabilities mount; review none; Agent navigation requires applied Source and the originating project to be active.                                                                                                |
| `simulation.hide`                                                   | command / session                      | `{}`                                                 | `{visible:false}`; cancels active work and retains completed/stopped state.                                                                                                                                                                                       |

```ts
type ProjectExportFormat =
  | 'netlist' // Primary schematic, KiCad intermediate XML
  | 'dxf' // PCB outline, AutoCAD 2000 DXF
  | 'gerber' // Full Gerber X2 and Excellon ZIP
  | 'drill' // Excellon drill ZIP
  | 'stencil' // Gerber paste and profile ZIP
  | 'jlcpcb' // Gerber, drill, BOM and placement ZIP
  | 'bom' // BOM CSV
  | 'placement' // Placement CSV
  | 'scad'; // Model CAD, OpenSCAD

type WorkspaceContext = {
  version: 1;
  capturedAt: string;
  project: CanonicalProject;
  source: { pending: boolean; draft: null; error: string; draftCharacters: number };
  ui: Record<string, unknown>; // Includes revision, view, activeSchematicId and selection.
  icDatasheet?: ProjectDatasheetContext;
  simulation: SimulationContext | { status: 'disabled' | 'not-opened' };
};
type HistoryPage = {
  version: string;
  commits: { id: string; date: string; message: string }[];
  more: boolean;
  needsSave?: boolean;
};
```

`WorkspaceContext` includes bounded layer/grid/viewport, Layout/Model presentation, visible controls/errors and resident simulation observations, scoped to its project. It does not contain credentials, model bytes or solver logs. View/context capture is not a separate editable design model. Full context contracts are in [`context/`](../context/agent-workspace-context.ts).

Layout's routing observation reports fixed `obstacleMode: "walk-around"`,
`angle: "45"`, `clearance: 0.25` mm and `useExistingTrackWidth: false`, alongside
the configured width and current head. `mouseDragTrackBehavior` reports the fixed
`connected` mouse-track behavior; Layout exposes no corresponding selector.
Interactive dragging uses Shove and the fixed 0.25 mm routing clearance. These
observations grant no mutation capability.
Layout's `priorityLayer` reports an explicitly selected active board layer,
including noncopper layers, or `null` when the active layer follows `layer`.
`layer` retains the copper tool layer. `layers` reports the eye settings.
The [Layout selection rules](LAYOUT.md#layers-labels-and-selection) own the
effect of the active layer and non-active layer display mode on picking.

Layout's transient track-drag observation includes `mode`, exact `pickup`, corner `endpointTolerance` or connected `posture`, the requested `delta`, whether it is `blocked` or `constrained`, and the constrained `appliedDelta` when present. Connected and corner gestures can stop at a revalidated boundary between their last displayed valid displacement and the current cursor. These describe the current human preview. The registered `layout.drag` command uses the same connected/corner engine and exact pickup. It requires the exact requested pose by default; explicit `constrain:true` enables the same bounded boundary search and returns its applied displacement.

For connected footprint movement, send `layout.drag` a selection of `{kind:"footprint", id}` objects, a millimetre `delta`, and `clearance`. Use the default Walk Around or set `obstacleMode:"walk-around"` explicitly. The result lists changed footprint IDs and rerouted track IDs, including any new elbow spans. [Layout](LAYOUT.md#connected-footprint-drag) owns the supported geometry and placement limits.

Layout's `boardOutlineResize` observation is null when idle, or contains up to four `graphicIds`, the active `handle`, preview `bounds` and `blocked`. These describe a human preview; only an accepted Core transaction changes native geometry. `zoneResize` provides the same bounded handle/bounds/blocked observation with a single `zoneId` for a board-zone preview.

During gestures, a renderer Worker calculates fill paths with the shared pure geometry preparation. Its bounded queue retains one basis, one in-flight request and the latest pending candidate. Layout displays the newest completed result and temporarily masks it against newer pointer geometry while another result is pending. Request/generation and Source/revision/visibility/cancellation gates discard inapplicable results. Worker previews and masks are excluded from capability results, native geometry and connectivity; airwires use the fill-free candidate on the renderer thread while moving. Accepted fills are calculated independently once for the current geometry in the Core transaction. This renderer execution path adds no capability or document authority.

`ProjectDatasheetContext` is `{version:1, projectId:string|null, exampleId:string|null, basis:'validated-project', status:'available'|'not-example'|'controller-mismatch', bindings:[{schematicId,partId,reference}], record:ICDatasheetRecord|null}`. The full `record` follows the [IC datasheet JSON contract](DATASHEETS.md), which also owns record selection and controller binding. Read queries use validated state while Source is pending; they do not interpret drafts or imply board operating points or model equivalence. The host rechecks revision/cancellation after lazy loading; submission capture additionally rechecks the active sheet. The service rejects forged or cross-project reference observations. `source.files` remains native-only; Source shows actual local PDFs as ordinary project files; OpenPE does not generate a separate datasheet JSON. Internal reviewed records are bundled from `resources/example-catalog/ic-datasheets.json`.

Git operations require the desktop bridge and a live destination grant. `versions.read` only reads; `versions.restore` shares GUI restoration, including exact Model CAD preparation and a whole-project undo edit. Save/export cancellation is a successful result with status `cancelled`, not proof of a write. Save/export/history do not accept paths through these capabilities.

Workspace requests return before dialogs/navigation finish, so `{status:'requested'}` does not claim a completed close/open. The live Agent adapter acknowledges only after a successful tool-result POST; local callers acknowledge automatically. `afterResult` dispatches on the next task after acknowledgement and retains the original cancellation authority until then. Failed delivery, Stop, changed revisions, inactive origins and disposed/suspended registrations prevent dispatch. Once started, native picker cancellation and close decisions follow the GUI flow. Opening another project never transfers the originating run's authority to it; subsequent tools remain scoped to the original project. New/open/close/Explorer requests require the active desktop editor and no conflicting file operation or confirmation.

`onAfterResult` receives only deferred actions whose results have been serialized.
Normal successful Agent completion drains these delivery/dispatch promises before
revoking the run; it never waits for arbitrary unresolved commands or solvers.
Stop/failure abort immediately. Dispatch, cancellation and failed delivery all
settle the deferred promise, preventing normal EOF from losing an accepted close.

Full PDF page access is read-only and uses the same validated controller binding,
with cancellation, close and revision checks after the host read. `document` is
the pinned record's `datasheet` identity. `text` is extracted page text, not a
connectivity interpretation. The host may fetch the verified vendor PDF on
demand; [Datasheets](DATASHEETS.md#complete-pdf-pages) owns source, worker and
resource limits. Codex receives a separate `inputImage` data URL; Claude MCP a
separate `image` block. Their text result retains image dimensions/MIME without
base64. Other query results retain ordinary JSON delivery. Context-only providers
receive the reviewed parameter excerpt and source locators in their initial prompt.

### Ordinary project files

These host capabilities share `useProjectDirectory` drafts and existing native preview/write handlers. They use relative names from the granted directory listing, never arbitrary paths or native grant IDs.

| ID                      | Kind / mutation    | Input                        | Result                                                                                      |
| ----------------------- | ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `project.files.list`    | query / false      | `{}`                         | Bounded filename/kind/byte/pending/access metadata; model/log entries remain metadata-only. |
| `project.files.read`    | query / false      | `{name}`                     | Current text/preview metadata, pending state and opaque `fileRevision`.                     |
| `project.files.update`  | command / session  | `{name,source,fileRevision}` | Stages the same ordinary text draft as GUI Source.                                          |
| `project.files.save`    | command / external | `{name,fileRevision}`        | `{name,status:'saved',pending}` through the existing per-file host writer.                  |
| `project.files.discard` | command / session  | `{name,fileRevision}`        | `{name,status:'discarded'}` after discarding that ordinary-file draft.                      |

Mutations require a fresh read token and fully loaded editable text. Native files use `source.*`; binary/truncated previews stay read-only. Model/log formats and model/circuit/solver/log directories reject content operations. Host credential/link/path restrictions still apply. The bounded observation cache rechecks origin, Core revision, destination, draft revision and cancellation; native Save additionally checks disk bytes before replacement. A newer GUI edit is retained if an earlier save completes. Pending native Source blocks ordinary-file mutations. Ordinary drafts participate in project Save/close while remaining outside Core, design undo, recovery and automatic Agent context.

## Library capabilities

Owner is `host`. Queries have mutation `false`; placement/assignment are object-level commands with mutation `document` and optional review.

| ID                   | Kind    | Input                                                                                                                           | Result and behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.categories` | query   | `{kind:'symbols'/'footprints', source:'KiCad'/'NextPCB'/'JLCPCB'}`                                                              | `{categories:[{id,name,children:Category[]}]}`; KiCad namespaces or the NextPCB and JLCPCB category trees.                                                                                                                                                                                                                                                                                                                                                           |
| `library.search`     | query   | `{kind:'symbols'/'footprints', query?:string, library?:string, category?:string, offset?:integer, includeAssetStatus?:boolean}` | `{entries,total,libraries}`; online and asset-status searches also return `nextOffset` (number or null). Asset status is for symbol searches: verified rows include `footprintPreview:'unavailable'/'2d'/'2d-and-3d'`, omitted when unconfirmed. [Libraries](LIBRARIES.md#catalog-service-and-chooser) owns page bounds. Defaults: empty query/library/category, offset 0, no asset checks. Offset ≤999,999; query/library ≤200 characters; category ≤10 characters. |
| `library.detail`     | query   | `{kind:'symbols'/'footprints', id:string}`                                                                                      | Validated KiCad, NextPCB or JLCPCB detail; symbols include `symbol`, `units` and optional package `warning` and `footprintPreview`. ID length 1–500.                                                                                                                                                                                                                                                                                                                 |
| `schematic.place`    | command | `{schematicId, libraryId, x, y, unit?:integer, rotation?:number, section?:'hardware'/'simulation'}`                             | `{id,reference,revision}`; unit defaults to 1, rotation to 0, requested section to `hardware` (Real). Unit 1–100, coordinates ±100,000 mm, rotation ±360°. A missing Footprint still places the component in Virtual.                                                                                                                                                                                                                                                |
| `part.footprint`     | command | `{schematicId, partId, libraryId:string}`                                                                                       | `RevisionResult`; empty `libraryId` clears assignment and the linked package while retaining copper.                                                                                                                                                                                                                                                                                                                                                                 |

Search entries include `id`, `name`, `library`, `description`, `keywords` and optional footprint information. Online catalog entries may also include `manufacturer` and `package` strings of at most 200 characters from the provider's corresponding fields. Footprint detail includes a `footprint` S-expression, `pads:string[]` and `models:[{path,offset,scale,rotate}]`. Online symbol detail can report `footprintPreview` as `unavailable`, `2d` or `2d-and-3d`. These values describe verified package conversion and the presence of a supported model reference. Model geometry is verified on demand. Temporary package-read failures can return a warning without a confirmed preview state. The authenticated routes accept catalog identities and cancel online requests on disconnect.

Library search and detail HTTP responses use `Cache-Control: no-store`. Recognized package codes such as `query: '0603'` and `query: 'SOT-23'` search package metadata directly. Prefix a query with `package:` to search for a different package label. With no category, a recognized NextPCB package search counts deduplicated matches in the bounded catalog sample. Other online totals count upstream rows before package and footprint filters. Pass `nextOffset` as the next request’s `offset`, even after an empty batch. A null cursor ends the scan. KiCad totals count actual matching entries. [Libraries](LIBRARIES.md#catalog-service-and-chooser)

`schematic.place` prepares and adopts supported online packages with the symbol in one edit, using the existing project library when available. [Libraries](LIBRARIES.md#nextpcb-online-catalog) owns asset preparation and persistence.

- KiCad filters use a namespace ID in `library`. KiCad footprint searches cover official and pinned example entries and accept native footprint IDs and pinned STEP filenames. Bundled searches reject nonempty `category`. Results retain original IDs for detail, placement and model indices. [Libraries](LIBRARIES.md#catalog-service-and-chooser)
- NextPCB uses `library:'NextPCB'` with optional `query` and `category` filters. Category IDs are canonical positive decimal strings from its tree. Empty filters use the verified suggestion category. A keyword without a category searches across the catalog. The host reads up to 50 raw rows per page. The footprint chooser requires an allowlisted native footprint URL, and symbol candidates can lack that URL. Detail validates standalone footprints independently of symbols. Detail IDs use `NextPCB:<manufacturer_id>_<percent-encoded MPN>`. [NextPCB online catalog](LIBRARIES.md#nextpcb-online-catalog)
- JLCPCB uses `library:'JLCPCB'` with optional `query` and `category` filters. Category IDs are canonical positive decimal IDs from its tree. Empty filters browse the entire catalog. The host returns up to 100 catalog rows per page with a declared or verified package. Exact part-number queries can find rows without a package label. Parts already known to lack a convertible footprint are omitted. With `includeAssetStatus`, list results reuse cached verification from component detail. Detail verifies the exact EasyEDA CAD identity and validates footprint geometry independently of symbol artwork. Detail IDs use `JLCPCB:C<digits>`. Supported CAD detail includes `attribution:{source:string,homepages:string[],notice:string}`. [JLCPCB online catalog](LIBRARIES.md#jlcpcb-online-catalog)

A symbol's package `warning` preserves its independently validated schematic geometry and linked Footprint field. Placement and assignment reject pending Source and stale asynchronous results. Core requires valid resolved symbol IDs, units and footprints before committing.

`layout.place` is a host object command taking
`{boardId,partId,libraryId,position:Point,rotation?:number,side?:'front'/'back'}`
and returning `{id,revision}`. It resolves the validated catalog footprint and
shares the Layout chooser's `createPCBFootprint` preparation and assignment
transaction for an unplaced primary-sheet component. NextPCB and JLCPCB adoption
first prepare portable package resources through the same bounded host path as GUI placement.
Rotation defaults to zero;
optional back-side placement flips that prepared footprint. Coordinates are
millimetres within ±100,000; rotation is within ±360°. Existing placements,
unsupported library geometry, pending Source, stale asynchronous results and
closing projects reject without committing.

Component resource selection is also host-backed and shares the GUI preparation helpers in `lib/model-resource-preparation.ts`:

| ID                        | Input                                                                                                                                                                                  | Result and shared behaviour                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout.model.import`     | `{boardId,footprintId,index?}`                                                                                                                                                         | Native STEP picker; prepares a verified resource and appends/replaces one footprint model through `layout.footprint.properties`. Picker cancellation returns `{status:'cancelled'}`.                    |
| `layout.model.library`    | `{boardId,footprintId,index?,libraryId,modelIndex}`                                                                                                                                    | Same append/replace transaction using a fixed library identity and model index.                                                                                                                         |
| `part.spiceModel.choose`  | `{schematicId,partId}`                                                                                                                                                                 | Native library picker and the GUI library-selection transaction; returns declaration metadata and an opaque observation, or cancellation.                                                               |
| `part.spiceModel.inspect` | `{schematicId,partId}`                                                                                                                                                                 | Query the accepted project-relative library through its grant, returning declaration metadata and compatible mappings without model contents.                                                           |
| `part.spiceModel.bind`    | `{schematicId,partId,source:'basic',passiveModel?:'R'/'C'/'L'/null}`, `{schematicId,partId,source:'external'}` or `{schematicId,partId,source:'external',observationId,name,mapping?}` | Select an intrinsic model, clear a no-file passive override with null, select the retained external model, or bind an observed declaration. Ambiguous terminal roles require an explicit valid mapping. |
| `part.sourceType`         | `{schematicId,partId,type:'DC'/'PULSE'/'SIN'}`                                                                                                                                         | Shared intrinsic-source conversion preserving levels/timing and linked native fields.                                                                                                                   |

These commands declare host ownership, object level and document mutation; inspection is a read-only host query. Successful STEP selection returns `{status:'applied',revision,boardId,footprintId,index,models}`. SPICE observations contain `{status:'available',observationId,revision,path,models,issues,bindings}` with declaration names/kinds/device/pins only. The cache holds at most eight observations and invalidates on Core changes; binding rechecks the exact component, revision, library and grant. Native selection, inspection and asynchronous library preparation recheck Source, close, active-origin and cancellation gates. SPICE resource controls require the enabled SPICE plugin. Retained inactive fields survive intrinsic/external switching. No capability accepts model bodies, executable paths or arbitrary library paths.

## Plugin lifecycle capabilities

[`api/plugins.ts`](../api/plugins.ts) defines version-1 manifests and command
contributions. Catalog entries can include `runtime`, `projectDirectory`, `permissions`, `contributes`
and an installed package `sha256`. Local commands register as plugin-owned
read-only queries under `extension.<publisher>.<name>.<command>`, with declared
input schemas. [SDK and execution limits](PLUGINS.md#plugin-packages-and-sdk)

`window.openpe.installPlugin()` takes no arguments. A trusted main-frame IPC
opens the native package picker and approval; it returns `{id}` or `null` and
never exposes source paths. It is absent from Agent capabilities. The internal
authenticated `POST /api/runtime-plugins/run` accepts exactly
`{id,command,input,context,sha256}` (12 MiB maximum), validates installed state,
hash, command/schema and project-read permission, and returns bounded JSON.
Closing the request, disabling/uninstalling or service shutdown cancels its
worker. No HTTP installation/upload endpoint exists.

Owner is `host`; level is absent. List is a query with mutation `false`; change is a command with mutation `external` and optional review.

| ID                         | Input                                                         | Result and behaviour                                                                                                         |
| -------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `workbench.plugins.list`   | `{refresh?:boolean}`                                          | Confirmed `WorkbenchPluginCatalog`; shared cache lasts five minutes.                                                         |
| `workbench.plugins.change` | `{action:PluginAction, id:WorkbenchPluginId}`                 | Updated `WorkbenchPluginCatalog`; reconciles lifecycle across mounted projects.                                              |
| `provider.plugins.list`    | `{provider:'codex'/'claude', refresh?:boolean}`               | Provider catalog with `plugins`, `controlsVersion`, `browse`, `marketplaces`, `actions`, `warning` and optional `updatedAt`. |
| `provider.plugins.change`  | `{provider:'codex'/'claude', action:PluginAction, id:string}` | `{ok:true}` after a supported provider action succeeds.                                                                      |

```ts
type PluginAction = 'install' | 'uninstall' | 'enable' | 'disable';
type WorkbenchPluginId = string; // name@publisher from the confirmed catalog
type WorkbenchPluginCatalog = {
  controlsVersion: 1;
  plugins: {
    id: string;
    scope: string;
    name: string;
    marketplace: string;
    description: string;
    version: string;
    installed: boolean;
    origin: 'agent' | 'openpe' | 'unknown';
    enabled: boolean | null;
    managed: boolean;
    icon?: string;
    detail?: string;
    category?: string;
    author?: string;
    capabilities?: string[];
  }[];
  browse: boolean;
  actions: PluginAction[];
  warning: string;
  updatedAt: number;
};
```

Bundled SPICE installation activates packaged resources. Provider management additionally checks CLI capabilities, qualified plugin identities and confirmed state; a syntactically valid capability input alone does not authorize an operation. These catalogs/lifecycles remain separate from project data and recovery. See [Plugins](PLUGINS.md).

### PCB design guidance

`pcbDesign.guide` is a read-only query owned by plugin `ai-pcb-layout@openpe`, with no Core level or mutation. Input is `{document?:string}` with no extra keys. The enum is `workflow` (default), `analysis-and-measurement`, `behavioral-evaluation`, `cad-and-tools`, `devices`, `electrical-layout`, `electrical-net-table`, `implementation-and-delivery`, `insulation-and-copper`, `regimes-and-standards`, `topologies`.

The result is `{document,source,revision,license,attribution,documents:string[],integration,text}`. `text` is the unchanged pinned upstream document; `integration` bounds its use to currently advertised OpenPE tools and review gates. Each UTF-8 document is bounded to 64 KiB and SHA-256 verified. Availability follows confirmed plugin state, independently rechecked by the service. Disable/uninstall aborts outstanding reads and Agent turns containing injected guidance. No project, undo, native Source or recovery writes occur. See [Plugins](PLUGINS.md#pe-layout-skill).

## SPICE capabilities

`simulation.show`/`simulation.hide` belong to the host. The following six resident capabilities belong to `plugin`, carry `plugin: 'spice-simulation@openpe'` and no abstraction level. They register as settings/waveform views mount; enabled lifecycle and current resident state gate use. Query the catalog again after `simulation.show`.

| ID                        | Kind / mutation    | Input                                                         | Result and behaviour                                                                                                        |
| ------------------------- | ------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `simulation.status`       | query / false      | `{}`                                                          | `SimulationContext`.                                                                                                        |
| `simulation.configure`    | command / session  | `{config?:SimulationConfigChanges, drafts?:SimulationDrafts}` | Updated `SimulationContext`; configuration keys depend on the supported circuit.                                            |
| `simulation.probes`       | command / session  | `{target?:ProbeTarget/null, selected?:string[]}`              | Updated `SimulationContext`; `null` clears the probe. Selected vectors are unique, up to 256.                               |
| `simulation.run`          | command / document | `{}`                                                          | `SimulationContext` after completion/explicit Stop; newly verified model references can enter the project in one undo edit. |
| `simulation.cancel`       | command / session  | `{}`                                                          | `{cancelled:boolean}`; requests Stop and retains validated received samples as stopped partial results.                     |
| `simulation.presentation` | command / session  | `SimulationPresentationChanges`                               | Current `WaveformPresentation`. Requires resident waveform controls and applicable traces/results.                          |

Live Agents await `simulation.run` and reuse its returned state. They query the
already-discovered `simulation.status` only when current progress, errors,
probes or measurements are needed, including a human-started run. Instructions
discourage tight polling, duplicate pending runs and using `capabilities.list`
as a progress check, waiting loop or keepalive.

```ts
type SimulationConfigChanges = {
  voltage?: number;
  frequency?: number;
  duty?: number;
  stop?: number;
  step?: number;
  inputId?: string;
  pwmId?: string;
  outputId?: string;
  switchId?: string;
  currentId?: string;
};
type SimulationDrafts = {
  voltage?: string;
  frequency?: string;
  duty?: string;
  stop?: string;
  step?: string;
};
type ProbeTarget = { kind: 'voltage' | 'current'; id: string; pin?: number };
type Axis = { min: number; max: number; step?: number };
type SimulationPresentationChanges = {
  layout?: 'auto' | string; // String must match [1-3]x[1-4], e.g. 2x2.
  linked?: boolean;
  visibleCursors?: [boolean, boolean];
  cursor?: { vector: string; which: 0 | 1; time: number };
  view?: {
    vector: string;
    range?: 'full' | 'tail';
    time?: Axis | null;
    values?: Axis | null;
    zoomMode?: boolean;
  };
  navigate?: { vector: string; direction: 'back' | 'forward' };
};
type WaveformPresentation = {
  layout: string;
  linked: boolean;
  visibleCursors: [boolean, boolean];
  traces: Record<
    string,
    {
      time: Axis;
      values: Axis;
      cursors: [number, number | null];
    }
  >;
};
```

Numeric config uses V, Hz, percent and seconds; `stop` and `step` accept any finite positive value. Text drafts use the UI card's displayed units and may be incomplete. Configure requires at least one nonempty config/drafts object, disallows the same numeric key in both, and is blocked while running. It preserves existing completed/stopped waveforms and their `resultConfig` until Run. Schema acceptance does not make an unsupported circuit parameter editable.

Presentation requires at least one property. `view` must include `vector` and at least one setting. Axis bounds must be finite/increasing and meaningful for actual samples; optional axis step is positive. Cursor time uses seconds and must be valid for the current result. `view` and `navigate` cannot be combined in one command. Vector/target identities are validated against the active sheet and current result.

`SimulationContext` contains `circuitId`, `basis`, settings/waveform visibility, status, displayed settings, `config`, optional `resultConfig`, errors, probe/selected vectors, presentation and optional result. Status is `idle`, `detecting`, `unavailable`, `blocked`, `running`, `completed`, `stopped` or `failed`. A result has status `live`, `completed` or `partial`, sample count, seconds-based time range and traces with units, native extrema/endpoints, reduced curves and optional visible-window/cursor/delta observations. These curves are not the full native waveform. Exact types and reduction are in [`context/agent-simulation-context.ts`](../context/agent-simulation-context.ts).

Run requires active visible Schematic settings, applied Source, supported inputs,
enabled SPICE, verified models/solver and a saved desktop destination. Stop
retains validated partial samples; automatic cancellation discards live previews.
There is no solver runtime timeout. Load-only restore/settings/waveform behavior
follows [Simulation](SIMULATION.md#execution-streaming-and-completed-results).

## Layout Thermal capabilities

Host commands `thermal.show` and `thermal.hide` take `{}`. Show requires an enabled plugin, an active project with a PCB and applied Source, switches to Layout and waits for the resident capabilities. Hide cancels active work and retains a completed session result.

Seven resident capabilities belong to `plugin: 'pcb-thermal@openpe'`. All measurements describe board temperatures, not package junction temperature. Inputs use finite numbers and reject extra properties; discover the mounted schemas before calling them.

| Capability            | Input                              | Result / effect                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thermal.status`      | `{}`                               | Bounded settings, visibility, solver availability, run state, extrema, statistics, assumptions and selected node; zero-based node indices share the result's 200,000-node limit. No full volume mesh.                                                                       |
| `thermal.configure`   | `{config: Partial<ThermalConfig>}` | Session settings; `heatSources` replaces the complete list of `{footprintId,powerW}`. Required physical values are validated before Run.                                                                                                                                    |
| `thermal.importSpice` | `{}`                               | Load supported signed average V·I heat inputs from full-resolution native SPICE output over the final 20% of a matching completed transient for the PCB-linked primary schematic. Both plugins must be enabled and the project saved. Session mutation; no solver/download. |
| `thermal.run`         | `{}`                               | Refreshes verified completed electrical losses in SPICE heat-input mode, then performs a Gmsh/Elmer steady solve; requires active visible Layout, applied Source, verified resources and a saved desktop project. Archives the complete result; external mutation.          |
| `thermal.cancel`      | `{}`                               | `{cancelled:boolean}`; aborts owned work and discards incomplete fields.                                                                                                                                                                                                    |
| `thermal.probe`       | `{point:{x,y,z?}/null}`            | Nearest actual solver node; omitted z uses the displayed front/back surface. Null clears it.                                                                                                                                                                                |
| `thermal.exportImage` | `{}`                               | Exports the displayed temperature map through the image bridge; external mutation with optional review.                                                                                                                                                                     |

`ThermalConfig` is defined in [`plugins/layout-thermal/domain/thermal.ts`](../plugins/layout-thermal/domain/thermal.ts): ambient °C, front/back/edge convection W/(m²·K), each copper-layer thickness mm, dielectric/copper conductivity W/(m·K), plating and mesh size mm, and per-footprint W into the PCB. Optional `spiceSource:{config:TransientConfig,startS,endS,resultBasis}` records host-verified imported sample provenance. Run and lookup revalidate it; explicit `heatSources` edits without `spiceSource` select manual inputs and clear provenance. Materials, all imported heat into pads and equal dielectric gaps are explicit assumptions. `thermal.changed` events and optional workspace `thermal` context are bounded observations. The result's original settings remain available when current settings change. First opening a saved project's panel restores the latest matching verified field and its configuration through the load-only result route. Results and settings stay outside Core design state, undo, recovery and dirty state. See [Layout Thermal](THERMAL.md) for geometry, persistence, lifecycle and numerical verification.

## Layout Parasitics capabilities

Browser development uses the same bundled catalog and change schema with
process-local state. Provider plugin capabilities use the same provider
adapters and request schemas as desktop.

`parasitics.measure` is a read-only query owned by plugin `layout-parasitics@openpe`.
It has no Core level. Input is
`{boardId:string,startId:string,endId:string,copperThicknessMm?:number,viaPlatingMm?:number}`
with no extra keys. Each ID is 1–200 characters. `boardId` identifies the current
PCB. The terminal IDs identify distinct copper pads or vias on the same assigned
net. Both thickness inputs are in mm and accept finite values from 0.001 to 1
inclusive. See [Layout Parasitics](LAYOUT.md#layout-parasitics) for defaults and
geometry constraints.

The result is
`{boardId,revision,netId,netName,startLayer,endLayer,copperThicknessMm,viaPlatingMm,shortestLengthMm,shortestResistanceOhm,equivalentResistanceOhm,shortestPartialInductanceNh,path}`.
`shortestPartialInductanceNh` is the estimated open-route partial inductance in
nH, or `null` when the bounded calculation cannot resolve a positive value.
`revision` is the numeric Core revision. `startLayer` and `endLayer` are strings
describing the copper layer or layers at each terminal. `path` is the ordered
shortest-route list of `{id,kind:'track'/'via'}` objects, with consecutive spans
of the same via represented by one entry. The query requires confirmed installed
and enabled plugin state, applied Source and an open project. It reads the accepted
PCB revision, including unsaved edits, and checks any supplied capability revision.
Rejected or disconnected measurements return errors. The same query serves the
Layout Parasitics dock and scoped Agent tools.

`parasitics.createStudy` is a plugin-owned document command with operation level
and optional review. Its closed input schema is
`{boardId:string,schematicId:string,startId:string,endId:string,copperThicknessMm?:number,viaPlatingMm?:number}`.
Each ID is 1–200 characters. `schematicId` must identify an existing target
schematic in the current project; board/terminal IDs and thicknesses follow the
measurement constraints above. Callers provide no extracted values, target file
path or prepared schematic. It requires confirmed installed/enabled plugin
state, applied Source and an open project containing the identified PCB and
schematic. Both terminals must map to exact pad pins in that target, with an
exclusive end-pin leaf lead. Unsupported mappings, duplicate pad-number lands, vias, co-located pins,
non-leaf leads and duplicate endpoint pairs reject without editing.
Source, close, cancellation and supplied capability-revision gates apply before
the accepted board is remeasured and committed through Core once. An Agent review
rechecks the current project when applied, using the same path as the GUI button.

Its result is
`{schematicId,labels:{start,end},references:{resistor,inductor},values:{resistanceOhm,partialInductanceNh},omittedInductance,blockIds:string[],revision}`.
The schematic ID is the existing target's ID. `labels.start` and `labels.end`
are distinct local label names identifying the measured pad endpoints,
with collision suffixes when needed. Component references are strings; `inductor`
and `partialInductanceNh` are `null` when inductance is outside the model.
`resistanceOhm` is the full-precision equivalent DC resistance, and
`partialInductanceNh` retains the full-precision measured nH value. These result
values remain independent of the generated component Values, which use the
[two-decimal native notation](LAYOUT.md#parasitic-study-schematics).
`omittedInductance` is a boolean and `revision`
is the resulting Core revision string. The normal Core change observation
reports the edit; this
command adds no separate plugin event. Failed preparation or validation adds no
components or undo step. `blockIds` lists the fresh compact block's parts, wires,
labels and junctions, excluding the anchored circuit connection-label copies.
[Series semantics](LAYOUT.md#parasitic-study-schematics)
define the labelled series circuit, exact endpoint connection and bounded placement,
hidden native endpoint properties, native ownership and numerical limits. GUI success reveals the compact block in the selected existing schematic
and selects `blockIds` for movement while keeping the connection labels anchored. Agent execution returns its ID
without requiring navigation.

## Agent tools

Agent identities are shared by the renderer, recovery and generated service catalog from [`lib/agent-providers.ts`](../lib/agent-providers.ts). Local detection always returns all five entries; missing executables do not remove supported identities from Settings or the picker.

On Windows, Codex detection, model discovery and execution share CLI lookup. The npm installation in the standard per-user prefix takes precedence over the desktop process's inherited PATH. OpenPE launches its native Windows executable directly with the console hidden and owns its stdio and process lifecycle. If the npm installation is incomplete, lookup checks PATH and then the standard standalone installation directory.

| ID         | Display name     | CLI                 | Runtime boundary                                                              |
| ---------- | ---------------- | ------------------- | ----------------------------------------------------------------------------- |
| `codex`    | Codex            | `codex`             | Scoped live OpenPE tools through `app-server`.                                |
| `claude`   | Claude Code      | `claude`            | Scoped live OpenPE tools through the fixed stdio MCP helper.                  |
| `deepseek` | DeepSeek Harness | `dsh`               | Context/proposals over ACP with a required service-owned tool-denial guard.   |
| `pi`       | Pi               | `pi`                | Restricted RPC context and proposals; no live capability tools.               |
| `cursor`   | Cursor           | `@cursor/sdk` local | Scoped live OpenPE tools through the service-hosted SDK and stdio MCP helper. |

`installed` reports executable detection; `available` reports whether the detected integration can run under OpenPE's restrictions. Authentication remains `unknown`. Pi disables built-in tools, discovered/configured extensions, skills, prompt templates, context files and MCP in a private no-session process. The sole explicitly loaded service-owned `pi-questions.mjs` extension is copied to a private temporary directory for external CLI access and removed after the RPC session. It registers `openpe_ask_user` and blocks every other tool. DeepSeek ACP sessions disable client filesystem/terminal capabilities, reject every permission request and require the application-owned tool guard before submission. When a question bridge is present, the guard admits only native `ask_user_question`; the private `deepseek-questions.mjs` patch answers the harness user-question waterfall through that bridge. Protocol incompatibility fails closed. Cursor does not launch `agent` or `cursor-agent`. `server/agent-cursor.mjs` creates one local SDK agent per turn with `tools: ['mcp']`, explicit denies for shell, task, and the MCP resource/auth tools, `settingSources: []`, sandbox disabled, an empty in-memory filesystem, and `cwd` in a private temporary directory. Before `send`, it requires the SDK's resolved `allowedProtoTools` minus `disallowedProtoTools` to be exactly `get_mcp_tools_tool_call` and `mcp_tool_call`, and the inline MCP server's `tools/list` to be exactly `openpe_query`, `openpe_execute`, `openpe_observe`, and `openpe_ask_user`. A missing proof fails the turn. Creation and the proof share one frozen options snapshot and fail closed before `send`. `local.fs` must be that run's `emptyFs()` object. The MCP `env` must be that same object and exactly `ELECTRON_RUN_AS_NODE=1` (the helper command is `process.execPath`, which remains the Electron binary unless this is set), `OPENPE_AGENT_BRIDGE_URL`, `OPENPE_AGENT_BRIDGE_TOKEN`, `OPENPE_QUESTIONS_URL`, and `OPENPE_QUESTIONS_TOKEN`. Both bridge URLs must equal this run's bridges. An extra key such as `NODE_OPTIONS`, or any value containing the API key, fails the turn. Stop races `send` with abort. Text already emitted is kept and later stream output is not read. When the run cannot be cancelled, Stop disposes the local agent and finishes cancelled. The API key comes only from Electron `safeStorage` ciphertext in `cursor-credential.bin` under the OpenPE data directory (`OPENPE_DATA_DIR` or the platform `OpenPE` application-data directory). POSIX creation uses mode 0600. Linux requires a Secret Service or KWallet keyring; the `basic_text` backend is rejected before encrypting or decrypting credentials. On Windows that per-user directory under `%APPDATA%` inherits the profile's user-only ACL; OpenPE does not call `icacls`. Windows ACL inheritance is unverified. A failed rename does not ignore a non-ENOENT error while removing the temporary ciphertext. Provider plugin routes remain limited to `codex`/`claude`.

Codex dynamic tools and the Claude and Cursor stdio MCP helper expose the three OpenPE tools below. Cursor also exposes `openpe_ask_user` on that helper. They are per-turn, session/run/project-bound transports into the same host.

| Tool             | Arguments                         | Result                                                                                                                             |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openpe_query`   | `{name:string, input?:JsonValue}` | Target query's result. Start with `name: 'capabilities.list'`; query current design data as needed.                                |
| `openpe_execute` | `{name:string, input?:JsonValue}` | Command result in Auto or for review:none; otherwise a pending command review in Review. A pending review is not a completed edit. |
| `openpe_observe` | `{after?:integer}`                | `{cursor,events,truncated}`; a bounded immediate read, not a background subscription.                                              |

Tool envelopes accept only the listed fields and reject unknown keys, invalid names/cursors and nonfinite/oversized JSON before dispatch. Names match `^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$`. Agent commands have no `expectedRevision` field or observation requirement; obsolete revision fields are unsupported. Auto execution and manual Apply use the current project state. Review checks the current command discovery metadata and availability before deciding whether confirmation is needed. Queries/observation and commands with review:none execute immediately. File/design changes require confirmation, including Source and ordinary-file drafts and external writes. Agent navigation cannot implicitly apply pending Source; use a separately reviewed source.apply. The transient review card displays the checked discovery description as plain text, separately from the command. The review-required result remains {status,reviewId,command}; display descriptions do not enter arguments or authorize execution. Reviews retain immutable arguments, with schema, availability, target, domain, Source and lifecycle validation at Apply. Workbench serializes Agent document mutations per project, including across conversations, while session/external operations and queries remain independent. Internal Core preparation/transaction guards still reject an operation whose own prepared data became invalid during execution. Prompt/tool guidance asks providers to await each project-changing command before preparing the next.

Bridge input/result budgets are 32 MiB minus 4,096 bytes of envelope headroom, with depth at most 64 and one million JSON nodes. Each turn allows four pending calls and 256 total calls. Query/observe delivery has a 60-second deadline; command execution does not impose that deadline on solver work. Each request carries a single-use response token; completion, disconnect, cancellation or project close revokes its live bridge. Switching to Auto does not execute existing reviews. Review limits and lifecycle details are in [Core](CORE.md#agent-transport-and-review).

## Browser development preview transport

Next.js development serves a same-origin geometry and bundled-plugin proxy at `/api/browser-preview/*`. Its private host binds an ephemeral `127.0.0.1` port and accepts only the exact `http://127.0.0.1:3000` renderer Origin, `Sec-Fetch-Site: same-origin` and `X-OpenPE-Browser: preview`. Foreign/missing origins, foreign hosts and preflights fail without CORS headers. Bootstrap, catalog and preview responses use `Cache-Control: no-store`; SPICE streams use the transient endpoint's no-cache policy.

| Route                               | Request                                                           | Result                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/browser-preview/session` | Empty JSON object, at most 1 KiB                                  | `{token:string}`; a 64-hex process-local preview token, retained only in page memory.                                              |
| `POST /api/browser-preview/cad`     | `{object:ModelCadObject}`, at most 512 KiB, plus `X-OpenPE-Token` | The existing `{shapeKey,meshes}` CAD result, using the same canonical validation, fixed kernel, cache and cancellation as desktop. |

Authenticated `POST /api/browser-preview/footprint` accepts exactly `{id:string}` and returns the existing bounded footprint detail. `POST /api/browser-preview/model` accepts exactly `{id:string,index:number}` and returns the existing `{meshes,model}` library preview. IDs are nonempty and at most 256 characters; model indices are integers 0–99, matching the desktop preview range. Both request bodies are limited to 1 KiB. Only fixed bundled example identities and official KiCad library IDs/model indices resolve resources. The browser library service reads prepared resources without downloads or cache writes; project paths, native grants, model imports and model-copy routes are unavailable. CAD and component previews share a serial STEP parse queue and one bounded parser pool. The token grants only the listed development endpoints. Disconnect aborts preparation. Expired tokens fail visibly and are reacquired on the next explicit retry; failed bootstrap remains retryable. The endpoints exist only in development; packaged static builds retain Electron IPC/service startup.

Authenticated `POST /api/browser-preview/price` uses the [shared price request and result](#local-http-service).

Authenticated `POST /api/browser-preview/plugin/<action>` exposes nine fixed
actions. `catalog`, `guide`, `spice-status`, `thermal-status` and
`provider-list` require an empty JSON object. `guide` accepts the optional
`document` query. `provider-list` accepts the existing provider and refresh
query. `change` and `provider-change` use the existing bundled and provider
lifecycle schemas. These bodies are capped at 1 KiB. `spice-run` and
`thermal-run` accept the corresponding
desktop run schemas with `fileId` excluded and a 24 MiB body limit. They share
existing validation, cancellation, lifecycle gates and output formats. Solver
result publication, restoration, SPICE heat import, Agent chat and native file
grants are unavailable through this proxy.

## Local HTTP service

The service listens on `127.0.0.1` with a dynamic port. `window.openpe.connection()` supplies the base address and per-process token to the renderer; [`lib/bridge.ts`](../lib/bridge.ts) adds `Content-Type: application/json` and `X-OpenPE-Token`. The separate per-turn Agent bridge uses `X-OpenPE-Agent-Token` instead of the service token.

Hosts are restricted to `127.0.0.1`/`localhost`. A supplied Origin must match the service base or configured development Origin. Preflight `OPTIONS` returns 204 before authentication. Except for the scoped Agent tool and question bridges noted below, `/api/*` rejects an invalid/missing service token with 401. Unmatched authenticated API requests return a JSON 404 before the static renderer fallback. Native file access still requires its own live grant after HTTP authentication.

### HTTP routes

The registered method/path pairs are listed below. Inputs listed in braces are JSON bodies unless the row specifies URL/query parameters.

| Method and path                                        | Input                                                                                                                       | Success response and conditions                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/appearance`                                  | None                                                                                                                        | Validated `Appearance`; defaults when absent. Malformed stored settings are preserved and reported.                                                                                                                                                                                                                                      |
| `POST /api/appearance`                                 | `Appearance`                                                                                                                | Validated/persisted `Appearance`; serial atomic settings write.                                                                                                                                                                                                                                                                          |
| `GET /api/agents`                                      | None                                                                                                                        | `{id,installed,available,version?,path?,error?,auth:'unknown',supportsEffort?,supportsCapabilities?}[]`; all five IDs, independent of installation.                                                                                                                                                                                      |
| `GET /api/models`                                      | Query `provider=codex/claude/deepseek/pi/cursor`                                                                            | `{models:[{id,label,description?,...}],defaultModel?}`, with `textInput:false` for Codex and Pi entries that cannot take text and `unavailable:[{id,reason}]` for Cursor. Discovery cancels on disconnect and rejects unavailable runtime adapters.                                                                                      |
| `GET /api/plugins`                                     | Query `provider`, optional `refresh=true`                                                                                   | Provider plugin catalog and supported controls. Only these query keys are accepted.                                                                                                                                                                                                                                                      |
| `POST /api/plugins`                                    | `{provider,action:PluginAction,id}`                                                                                         | `{ok:true}`; qualified `plugin@marketplace` ID and CLI-supported operation required. One active plugin operation per provider.                                                                                                                                                                                                           |
| `GET /api/workbench-plugins`                           | No query parameters                                                                                                         | Built-in and installed local workbench catalog. Malformed lifecycle/package state fails closed.                                                                                                                                                                                                                                          |
| `POST /api/datasheets/page`                            | `{exampleId:string,page:integer,image?:boolean}`                                                                            | Authenticated, origin-checked fixed reference catalog lookup. Returns the PDF-page result above without renderer-added `projectId`/`bindings`. Rejects unknown IDs, extra fields and out-of-range pages before I/O; accepts no URL/path.                                                                                                 |
| `POST /api/workbench-plugins`                          | `{id:WorkbenchPluginId,action:PluginAction}`                                                                                | `{ok:true}` for confirmed catalog identities. Local installation requires native approval. The capability wrapper subsequently reloads the catalog.                                                                                                                                                                                      |
| `GET /api/pcb-design/guide`                            | Optional `document` query from the fixed guidance enum                                                                      | Verified PCB guidance result above; authenticated, origin-checked and plugin-gated. Rejects unknown selectors or extra parameters before file access.                                                                                                                                                                                    |
| `GET /api/libraries/:kind`                             | Path `kind=symbols/footprints`; query `q?`, `library?`, `category?`, `id?`, `offset?`, `categories?`, `includeAssetStatus?` | `categories=KiCad/NextPCB/JLCPCB` returns `{categories}` and cannot combine with nondefault search/detail inputs. A nonempty `id` returns resolved detail; otherwise see the [library search result](#library-capabilities). Only symbol searches accept `includeAssetStatus=1`. Nonempty `category` is a NextPCB or JLCPCB category ID. |
| `GET /api/library-model`                               | Query `id`, `index?`                                                                                                        | `{meshes,model}` for an existing model reference in a bundled official, pinned example or validated NextPCB or JLCPCB footprint. Index defaults to 0.                                                                                                                                                                                    |
| `GET /api/library-price`                               | Query `id` (1–500 characters), `kind=symbols/footprints`, `source=lcsc/huaqiu`                                      | `{source, currency:'USD', checkedAt:number, offers:{sku:string, manufacturer:string\|null, stock?:number, tiers:{quantity:number, unitPrice:number}[]}[]}`. `checkedAt` is Unix time in milliseconds. An empty `offers` array means there is no matched USD offer in the bounded lookup. Authenticated development `POST /api/browser-preview/price` accepts the same fields as JSON (2 KiB maximum). Both routes are cancellable, return no-store responses and resolve the identity in the host. [Component pricing](LIBRARIES.md#component-pricing) owns source details. |
| `POST /api/library-package`                            | `{id:string}`                                                                                                               | Prepared NextPCB or JLCPCB footprint detail with `projectAssets:true` and verified portable model references. At most eight pending requests, serialized STEP imports; disconnect cancels. No project filesystem write or document edit.                                                                                                 |
| `POST /api/model-cad/preview`                          | `{object:ModelCadObject}`                                                                                                   | `{shapeKey:string,meshes}`; validates one local shape, constructs analytical STEP with fixed bundled Gmsh/OpenCASCADE operations and tessellates it with the bundled STEP parser. Disconnect cancels; independent of simulation plugins.                                                                                                 |
| `GET /api/state`                                       | None                                                                                                                        | Stored recovery JSON or `null`; ordered with HTTP and Electron recovery writes. The workspace consumer validates current-format content.                                                                                                                                                                                                 |
| `POST /api/state`                                      | Validated `WorkspaceState` v2                                                                                               | `{ok:true}` after the shared recovery queue atomically writes the validated JSON. Not a design-file Save API.                                                                                                                                                                                                                            |
| `DELETE /api/state`                                    | None                                                                                                                        | `{ok:true}` after the shared recovery queue atomically writes JSON `null` to the current recovery file.                                                                                                                                                                                                                                  |
| `POST /api/chat`                                       | `ChatRequest`                                                                                                               | Chat SSE stream. One request/session, at most four active sessions.                                                                                                                                                                                                                                                                      |
| `POST /api/chat/steer`                                 | `{runId,sessionId,requestId,token,prompt}`                                                                                  | `{ok:true}` after native same-turn acknowledgment. Requires process authentication and the active input bridge's originating Origin/session/token; invalid, expired or unsupported input returns 409.                                                                                                                                    |
| `GET /api/agent-settings` / `POST /api/agent-settings` | No body / exactly `{followUpMode}` (`queue` or `steer`)                                                                     | Read or atomically save shared Agent behavior in `agent-settings-v1.json`, outside recovery/design/provider configuration. Missing files default to Queue; malformed files are preserved with an error.                                                                                                                                  |
| `POST /api/chat/answer`                                | `{runId,sessionId,requestId,token,answers:Record<string,string[]>}`                                                         | `{ok:true}`; process authentication, originating Origin/session and a single-use question token. Invalid, duplicate or expired answers return 409.                                                                                                                                                                                       |
| `POST /api/agent-questions/:bridgeId`                  | `{questions}`                                                                                                               | `{answers:Record<string,string[]>}`; only the originating per-turn `X-OpenPE-Agent-Token`, never the process token. Normalizes against the originating provider, waits for explicit input and returns 422 on rejection/cancellation.                                                                                                     |
| `POST /api/chat/tool-result`                           | `{runId,sessionId,requestId,token,result}` or the same identity fields with `error` instead of `result`                     | `{ok:true}`; exactly one result/error, correct originating session/Origin and a single-use response token required.                                                                                                                                                                                                                      |
| `POST /api/agent-tools/:bridgeId`                      | `{tool,arguments}`                                                                                                          | `{result}`. Requires the active bridge's `X-OpenPE-Agent-Token`; the process token does not replace it.                                                                                                                                                                                                                                  |
| `GET /api/thermal/status`                              | No parameters                                                                                                               | Verified bundled Gmsh/Elmer availability and versions; service-owned thermal plugin gate precedes detection.                                                                                                                                                                                                                             |
| `POST /api/thermal/run`                                | `{source,config:ThermalConfig,fileId?:string}`                                                                              | `{result:ThermalResult}`; one active run, disconnect cancels. Desktop requires a saved grant and publishes complete artifacts before success.                                                                                                                                                                                            |
| `POST /api/thermal/spice-sources`                      | `{source,fileId:string}`                                                                                                    | `{heatSources,spiceSource,losses,assumptions}` from the latest matching saved SPICE settings and verified full-resolution native power summary over the final 20%. Requires both plugins; load-only, no solve/download. Watt sources use stable footprint IDs; `losses` supplies reference, W and compiler method.                       |
| `POST /api/thermal/result`                             | `{source,fileId:string,config?:ThermalConfig}`                                                                              | `{result:ThermalResult,config:ThermalConfig}` or `{result:null}`; load-only latest lookup matching complete PCB input, artifact hashes and verified runtime.                                                                                                                                                                             |
| `GET /api/simulation/status`                           | None                                                                                                                        | `{available:true,version}` or `{available:false,error}`; plugin installed/enabled gate precedes detection.                                                                                                                                                                                                                               |
| `POST /api/simulation/ti-model-search`                 | `{fileId:string,partNumber:string}`                                                                                         | `{partNumber,models}` from a live TI product lookup. Requires a live desktop grant and enabled SPICE.                                                                                                                                                                                                                                    |
| `POST /api/simulation/ti-model`                        | `{fileId:string,archive:string}`                                                                                            | `{libraries:SpiceModelCatalog[]}` from the selected current TI search result. Requires a live desktop grant and enabled SPICE.                                                                                                                                                                                                           |
| `POST /api/simulation/result`                          | `{source,config?:TransientConfig,fileId?:string}`                                                                           | `{result:SimulationResult,config:TransientConfig}` or `{result:null}`; omitted config discovers the latest saved configuration; explicit config requires an exact match. Load-only.                                                                                                                                                      |
| `POST /api/simulation/transient`                       | `{source,config:TransientConfig,fileId?:string}`; optional `Accept: text/event-stream`                                      | JSON `SimulationResult` or simulation SSE; successful response can include `simulationModels` references. One active transient across the service.                                                                                                                                                                                       |

Library query lengths are `q/library ≤ 200`, `id ≤ 500`; offset is 1–6 decimal digits, default 0. Model index is 1–2 decimal digits. Model resolution accepts a catalog ID/index, never a URL; fixed official package/model resources can be downloaded according to [Libraries](LIBRARIES.md). Workspace and appearance structures are defined by [`lib/workspace-state.ts`](../lib/workspace-state.ts) and [`lib/appearance.ts`](../lib/appearance.ts).

For `includeAssetStatus=1`, `Accept: application/x-ndjson` selects a
request-scoped stream on the existing library search route. A nonempty page
starts with `{type:'progress',completed:0,total}` and emits a frame per
confirmed check. The total is the eligible page size, at most 16. The final
line is `{type:'result',result}` with the ordinary result, or
`{type:'error',error,code?}` after a stream starts. Disconnect cancels the
request. Other clients receive the ordinary JSON response.

`Appearance.leftButtonDrag` is `drag-any`, `drag-selected` or `select`, shared by
Schematic and Layout. Saved appearance settings require all current fields; incomplete records and retired values are rejected. It controls pointer selection only and grants no design mutation.

`Appearance.modelGridSpacing` accepts 0.5, 1, 2, 5 or 10 mm, independently of
`gridSpacing` and `layoutGridSpacing`; saved settings must include it. All three drawing views share `schematicLayers.grid` visibility.
Model spacing defaults to 5 mm and controls ground and sketch workplane lines,
independently of CAD snapping.
Workspace UI observations include `modelGridSpacing` alongside the other grid settings.

Workspace recovery accepts the current workspace and per-project envelopes,
bundled Home identities and syntactically valid opaque local example identities.
It retains stable project IDs, complete project Source, required dirty state and
native Source drafts, filenames, conversations, active project/conversation IDs
and shared Agent preferences. Optional active-schematic and closed-tab IDs must
refer to existing sheets, and the active sheet must be open. Each non-null Source
draft is limited to 8,000,000 UTF-8 bytes, separately from the 96 MiB workspace
envelope.

Validation requires every mandatory field and rejects unknown workspace or
per-project fields before writes. Grants, destinations, ordinary-file drafts,
appearance and simulation results stay outside recovery. Example identities
must be explicit and supported. Conversations must use the current record
format. Existing malformed recovery remains on disk and fails validation.

JSON request limits are 8 MiB by default, with route-specific limits: state 96 MiB, TI model search and selection 2 KiB each, simulation result/transient and thermal run/result/spice-sources 24 MiB, chat 32 MiB, chat/tool-result 40 MiB, chat/steer and agent-settings 128 KiB, agent-tools 32 MiB, agent-questions 256 KiB and model-cad/preview 512 KiB. These parser limits do not replace the narrower domain/tool bounds.

CAD preview accepts only the `object` field, never script, path or executable
input. It returns a canonical ordered geometry JSON key excluding top-level
identity/pose/material and local meshes; it has no document mutation authority.
Geometry preparation uses a 60-second bound and verifies a complete regular STEP
artifact at most 30,000,000 bytes. The service permits two active preparations,
checks at most 64 returned meshes/six million numeric values and retains a
retryable 16-entry/64 MiB cache. Core host adapters admit a matching key only for
the exact validated candidate and recheck revision before publication.

TI model search accepts an opaque desktop file grant and an exact TI product number of 2–40 characters. The service reads at most 2 MiB of the fixed English TI product page with a 15-second deadline and no redirects. It returns the uppercase `partNumber` and up to 48 `models` of shape `{archive,title,encryption,modelId?}`. A missing product returns an empty list. The archive filename identifies the displayed revision. `encryption` is `encrypted`, `unencrypted` or `unknown`, classified from TI titles, known archive evidence and current service observations. `modelId` is present only for a matching pinned archive. Search returns metadata without fetching model archives.

TI package inspection accepts a live desktop grant and an uppercase archive code from that project’s latest successful search, retained for ten minutes. Search and inspection share one request per project. Both recheck the grant, destination and plugin state and cancel on disconnect, plugin disable/uninstall or service shutdown. Known encrypted results fail before any archive fetch with `OPENPE_TI_MODEL_ENCRYPTED`. When inspection finds encryption and no usable library, it returns the same code and records that status in the bounded service cache for subsequent searches. The reviewed store verifies pinned archives. Other results allow up to 8 MiB of official ZIP data, 1,024 directory entries, 8 MiB of examined library bytes, 2 MiB per library, 16 accepted libraries and 256 returned declarations. The download has a 30-second deadline and keeps redirects on the fixed TI host. The route returns only project-relative paths, declarations and bounded issues. It caches verified extracted library bytes privately and writes no native files. Agent tools and browser previews cannot invoke these routes.

SPICE saved-result lookup accepts current private project Source and an opaque file ID, with an optional complete `TransientConfig`. Omitted config reads the latest record's validated settings, recompiles the current source and verifies the current bundled solver, offline model bytes and full execution/cache identity before returning `{result,config}`. An absent record or nonmatching identity returns `{result:null}` without a config; an absent record does not require solver detection. Explicit config uses the same exact matching path as Run and never adopts different saved settings. Without a granted saved destination, lookup has no desktop record.

Completed manifests require the complete run configuration separately from native design data. Missing or invalid settings fail validation. Lookup never executes the stored deck, downloads models, writes or migrates saved records, or edits a document. Cancellation returns 409 with `Simulation result lookup cancelled.` while the response remains open; a disconnected response receives no further body. UI settings edits, explicit Run, Source/project/visibility changes and plugin removal cancel or supersede pending restores.

SPICE manifests require complete transient settings, `identityVersion: 2` and the actual executable's `solverSha256`; installation paths and timestamps are excluded from that identity. Ordered vectors/units remain execution inputs, while returned labels and probe targets are rebound to the current compiled circuit. Both explicit Run and automatic lookup require the current complete identity. Other identity versions, installation-path identities and settings reconstructed from execution decks are unsupported.

Saved results use `openpe-spice-v2` / `openpe-thermal-v2` manifests, with `project` bound to the native basename and direct `spice-simulation/<stem>.*` / `layout-thermal/<stem>.*` artifacts. SPICE `files` entries are `{name,file}`; Layout Thermal entries also include `size` and `sha256`. Physical names prefix the logical artifact basename with the native stem; execution keys use logical input identities. Store instances share a per-directory queue, publish individual files with the manifest last and roll back failed writes through private sibling `*-backups` folders. Unknown sidecars and conflicting/damaged files remain protected; this is not filesystem-wide crash atomicity. Retired nested records are ignored without loading or migration. See [SPICE persistence](SIMULATION.md#execution-streaming-and-completed-results) and [Layout Thermal records](THERMAL.md#completed-desktop-records).

Layout Thermal requests accept private validated project Source, settings and an opaque file ID, never meshes, scripts, paths, executables or URLs. Layout Thermal lookup revalidates saved configuration against the current PCB and compares the complete prepared model. SPICE-derived configurations also require matching verified electrical samples and watts through the shared read-only SPICE completed-result port. Only compiler-declared dissipative paths are averaged; reactive energy, sources and unmodelled losses are excluded. An optional caller configuration must also match. Lookup never solves, downloads or edits design data. Electron resolves the opaque file ID and rechecks it before publication/removal. Completed artifacts are direct `layout-thermal/<stem>.*` files; no records enter native Source, undo or recovery. Thermal lookup cancellation returns 409 with `Thermal result lookup cancelled.` while the response remains open. The thermal plugin gate applies before lookup, compilation or resource verification. SPICE is independently gated; disabling it cancels coupled thermal work while manual thermal runs remain independent.

Confirmed unavailable library previews return HTTP 422 with `{error:string,code:"OPENPE_LIBRARY_ASSET_UNAVAILABLE"}` from desktop library detail/model reads or browser library previews. Errors generally return `{error:string}`; some SPICE errors also include `code`, including `OPENPE_SPICE_CONVERGENCE`. Common statuses are 400 for rejected input, 401 for expired authentication, 403 for Origin/plugin restrictions, 409 for conflicts/stale tool replies, 429 for chat concurrency, 422 for library/simulation/Agent-tool failures, 502 for provider/model-discovery failures and 503 for unavailable plugin state/shutdown. Cursor model-list failures are fixed diagnostics. Raw SDK exception text is not returned; an SDK message containing the API key is reported as `Cursor rejected the stored API key.` Stored-data and unhandled errors can return 500. After SSE starts, failures use events rather than a new HTTP error body.

### Chat requests and SSE

```ts
type ChatRequest = {
  provider: 'codex' | 'claude' | 'deepseek' | 'pi' | 'cursor';
  prompt: string; // Nonblank, at most 16,000 characters.
  context: unknown; // Required; optional layout/workspace observations are validated.
  history: unknown[]; // Required.
  effort?: 'none' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  model?: string; // Validated provider model identifier, at most 200 characters.
  parameters?: { id: string; value: string }[]; // Cursor parameters other than the reasoning-effort parameter.
  sessionId: string; // Required; [a-zA-Z0-9-]{1,80}.
  capabilities?: boolean;
  requestTitle?: boolean; // Ask the same CLI response for a suggested conversation title.
  annotations?: AgentAnnotation[];
};
```

At submission the client combines the current accepted project snapshot with the sheet fingerprint and live observations in `WorkspaceContext`. [Core](CORE.md#agent-transport-and-review) owns snapshot preparation. `AgentAnnotation` is the bounded immutable screenshot/selection structure in [`lib/agent-annotations.ts`](../lib/agent-annotations.ts); up to four annotations are accepted per message. Codex/Claude capability support is advertised separately from the context-only DeepSeek/Pi transports. ACP images require the session's advertised image support; unsupported attachments fail visibly. DeepSeek model discovery reads the bounded, grouped ACP session catalog, with no effort selector. Model IDs are opaque ACP select values with a 512-code-unit bound and no control characters. OpenPE preserves them through recovery and chat admission, rechecks membership in the new session and verifies the applied choice in the returned configuration before submitting a prompt. Cursor model discovery calls `Cursor.models.list()` and accepts only returned ids. Each catalog parameter is returned with its id, display name, allowed values, value labels and the value from the single default variant. Display names drop Unicode format characters; a name that is empty after that rejects the model. A parameter whose values are all native reasoning efforts is that model's reasoning-effort parameter; a second such parameter rejects the model. `effort` carries that parameter when it exists. `parameters` carries every other catalog parameter exactly once and is rejected for every other provider. Unknown parameter ids, unknown values and selections that do not equal exactly one catalog variant fail. Validation is per model. A malformed entry, such as an invalid model id or a variant that uses an undeclared parameter, is excluded from selectable models and listed in the discovery result as `unavailable:[{id,reason}]`; the reason is a fixed diagnostic built from catalog ids, never raw SDK text. Requests that select an excluded or unknown model fail. A structurally invalid catalog response, or one with no valid model, fails the whole listing. OpenPE passes `maxMode` from that single variant (`true` only when its `isMaxMode` is true). `@cursor/sdk` 1.3.1 accepts optional `ModelSelection.maxMode` but honors only `maxMode === true`; otherwise it infers max mode when every catalog variant consistent with the parameters has `isMaxMode`. The explicit flag keeps a max-mode variant from depending on that inference, and the exact one-variant match cannot disagree with it. `npm run agent:check-cursor` requires `OPENPE_CURSOR_CHECK_MODEL` to be one of the listed catalog ids and sends that model's catalog-default values. `OPENPE_CURSOR_CHECK_PARAMETER=id=value` replaces one value and fails when the id or value is absent from the catalog. Provider credentials, arbitrary executable paths and shell commands are not request fields.

Model attachments use `target: 'object'` and can include a `solid` element. Its ID is the native Model CAD object UUID. The snapshot records its name, shape, position, rotation, size, material, opacity and any colour override. Its board fingerprint and Model view fingerprint retain their existing meanings. The solid properties describe the capture time. Query current Model state before editing a captured solid.

The host derives the controller reference from the validated project. PDF pages are loaded by explicit page queries. [Datasheets](DATASHEETS.md#submission-and-on-demand-context) owns the reference and page limits.

Reasoning effort values are native provider settings, defined once in
[`lib/agent-providers.ts`](../lib/agent-providers.ts) and generated for the service.
Chat admission rejects values outside the selected provider's protocol: Codex
accepts `none/minimal/low/medium/high/xhigh/max/ultra`, Claude accepts
`low/medium/high/xhigh/max`, and Pi accepts `off/minimal/low/medium/high/xhigh/max`.
DeepSeek accepts no effort field. Cursor accepts `effort` only for its reasoning-effort parameter and rejects `effort` when that parameter is absent. `none` and `off` are distinct values,
never translated aliases. These sets bound the protocols; each model can support
fewer values. Model discovery returns `efforts?: ReasoningEffort[]` per model;
an empty array means no effort control, while an omitted field means its support
is unknown. A selected model with unknown effort support uses the native setting. The composer sends the exact resolved model ID, including a selected catalog default, and queued messages retain that ID. New workspace preferences use `medium`; recovery retains any valid
explicit preference without migration, including one not supported by the
currently selected provider. The composer resolves it against the selected
model as defined in [Design](../DESIGN.md#agent-conversation), and the submitted
native value reaches the provider unchanged.

Codex discovery paginates the installed app-server catalog with
`includeHidden:true` and uses the returned native model IDs. It retains the
recognized values from `supportedReasoningEfforts` without excluding models
that omit effort metadata or offer only unrecognized values. When the effective
configuration reports no model, Codex's `isDefault` recommendation supplies
the default for the picker. A Chat request without `effort` leaves the native
Codex setting in effect. Claude discovery
uses a bounded, initialization-only `--bare` control session with empty tools
and MCP configuration and no session persistence, so hooks, plugins and prompts
cannot run. It reads only returned model metadata and supported effort levels, retaining the Default alias when advertised;
an unsupported CLI fails visibly. This catalog does not establish authentication,
account entitlements, configured alias overrides or managed-policy limits.
Pi derives native levels from each model's `reasoning` and `thinkingLevelMap`,
including explicit `xhigh`/`max` mappings and disabled levels; non-reasoning
models expose only `off`. Codex and Pi verify requested effort against the initialized session. Pi also verifies the selected provider-qualified model ID against session state and reports that same identity in runtime events.
Claude receives an explicit effort through both `--effort` and the spawned
child's `CLAUDE_CODE_EFFORT_LEVEL`, without changing the parent environment or
provider configuration. Its model-only `agent-info` does not claim an effective
effort that the CLI has not reported.

The provider prompt uses the validated workspace. With scoped tools, the initial overview includes sheet identities and counts, active view and selection, selected component identities and values, Source status, PCB and Model counts, analysis status and reviewed datasheet identity. Read the smallest current query for the task, including `core.state` for revisions, `schematic.get` for a sheet, `layout.get` or `modelCad.get` for geometry, and `workbench.state` for current presentation and analysis. Its optional `ui.schematicSection` is `hardware`, `simulation` or `all` for the active schematic's emphasis mode; it does not narrow canonical sheet queries or solver input. Context-only prompts retain the bounded active-sheet components, simulation fields, pin definitions and geometry-derived connections, selected-object geometry, view-specific PCB/Model summaries, reduced analysis observations and reviewed controller parameters. Connection pin tuples are `[reference,pinNumber]`. Bounded collections report `total`, `items` and optional `truncated:true` at 256 entries, with selections taking priority. The layout attachment context carries the board ID, linked sheet ID and fingerprint. Project navigation lists, duplicate design summaries, native and Source draft text, artwork, copper geometry and preservation metadata stay outside both projections. The assembled text limit is 1,048,576 characters.

When `requestTitle` is true, the existing restricted provider prompt asks for one `openpe_session` fenced JSON block containing only `{title:string}` in the same response, using the compact topic-label guidance in [Design](../DESIGN.md#agent-conversation). The renderer accepts one complete block with at most 512 payload characters and a valid single-line title of at most 60 characters, only after successful completion, then compacts the automatic name to at most 24 Unicode characters before adoption. It hides this reserved metadata during streaming and Markdown loading, preserves raw reply text and excludes metadata from subsequent provider history. Missing, malformed or duplicate blocks leave the current provisional title unchanged. No extra CLI process, new tool or naming permission is introduced. Adoption is bound to the originating session/message and cannot overwrite an existing name, including a manual rename made while the turn runs. Accepted names use the existing session `name` recovery field.

Codex app-server input and dynamic-tool item notifications may echo the full submitted images or tool result. The host bounds each raw JSONL record at 33,554,432 UTF-16 code units. Above the ordinary 2,000,000-code-unit event limit, it discards those item echoes and projects the successful turn-start reply and turn-completed notification to their consumed fields before applying the ordinary limit. These echoes never enter Chat SSE. Assistant output and tool or approval requests keep their own existing bounds and permission checks.

Chat frames use `data: <JSON>\n\n`, with comment heartbeats every 15 seconds. The public event union in [`lib/chat-stream.ts`](../lib/chat-stream.ts) includes:

| `type`               | Payload fields                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `status`             | `stage?`, `text`                                                                                               |
| `input-ready`        | `runId`, `sessionId`, `token`; active same-turn text steering is available.                                    |
| `input-accepted`     | `requestId`, `sessionId`, `prompt`; native acknowledgment, emitted before subsequent streamed text/completion. |
| `text`               | `text`                                                                                                         |
| `text-delta`         | `delta`                                                                                                        |
| `text-replace`       | `text`                                                                                                         |
| `error`              | `text`                                                                                                         |
| `timing`             | `timings`                                                                                                      |
| `agent-info`         | `model?`, `reasoningEffort?`                                                                                   |
| `process`            | `id`, `text`, `append?`; provider-supplied progress, separate from final response text.                        |
| `question-request`   | `runId`, `sessionId`, `requestId`, `token`, `questions:AgentQuestion[]`.                                       |
| `question-closed`    | `requestId`, `sessionId`; invalidates an unanswered native request.                                            |
| `capability-request` | `runId`, `sessionId`, `requestId`, `token`, `tool`, `arguments`                                                |
| `done`               | `outcome?: 'completed'/'failed'/'cancelled'`                                                                   |

User questions use the shared `AgentQuestion` shape in `lib/chat-stream.ts`: `{id,header,question,detail?,options:{label,description}[],multiSelect}`. Codex enables `features.default_mode_request_user_input` only in the ephemeral thread configuration, leaving user configuration unchanged. Its `item/tool/requestUserInput` answers preserve question IDs and native `{answers:{[id]:{answers:string[]}}}`. Claude runs bidirectional stream-JSON with only `AskUserQuestion` enabled as a built-in tool; its `can_use_tool` control response passes the original questions plus answers keyed by question text. Every other control permission request is denied. DeepSeek uses its native `userQuestions` seam and canonical selected/custom answer items; Pi uses the single bundled question tool. These transports grant no document, file, shell or arbitrary network authority. Cursor asks through the MCP tool `openpe_ask_user` on the same question bridge.

Each run permits 32 question batches, four pending batches, 1–4 questions per batch and at most eight options per question. Questions have at most 4,000 characters, detail 16,000, headings 100, option labels 200 and descriptions 2,000; each explicit answer has at most 16,000 characters. All questions require an answer; single-select permits one answer and multi-select at most nine unique values including custom text. Secret and permission-intent requests are rejected. No selection is submitted automatically; waiting for the user has no response deadline. Question tokens bind run/session/Origin and are revoked after one accepted response, native cancellation, Stop, disconnect or completion. Pending questions and progress are transient mounted conversation presentation, excluded from recovery, later provider history, design and undo. Only answers delivered to the originating harness become its current-run input.

Runnable Agent turns have no OpenPE wall-clock or inactivity deadline after initialization, including silent model work, streaming, tool execution and user questions. Stop, disconnect, project/plugin lifecycle cancellation and provider failures still end the originating run. Codex/Claude startup and Pi state initialization are bounded to 30 seconds; their timer is cleared before model work proceeds. ACP initialization/session/configuration requests retain individual 30-second deadlines; `session/prompt` has no deadline. Model discovery, query/observe delivery, steering acknowledgment and owned-child cleanup retain their separate bounds. Windows cleanup runs absolute `%SystemRoot%\System32\taskkill.exe /t` and throws when `SystemRoot` is missing or not absolute. A taskkill failure falls back to signaling the owned child handle if exit has yet to be observed. Node delivers direct process errors through the child process error handler. POSIX cleanup spawns that process in its own group and signals the group with `kill(-pid)`. These limits do not grant a runtime override field in Chat requests.

The current runners primarily emit incremental/replacement text; decoders also support `text`. A capability-request response goes to `/api/chat/tool-result`, not to a new document host. Closing the request cancels its originating provider stream and scoped capability bridge.

Steering is text-only, nonblank and bounded to 16,000 characters, with at most 32 distinct request IDs per run. Request IDs match `[a-zA-Z0-9-]{1,80}`. The input bridge rejects extra fields, foreign Origin/session/token, reused IDs with changed text and inactive runs. Identical retries share the original delivery/result and emit one acceptance. The token never grants project tools or native permissions. Codex uses `turn/steer` with the exact `threadId` and `expectedTurnId`; it never starts a replacement turn. Native errors reject only the steering request, while the original response can continue. Explicit native rejection returns `code:'OPENPE_STEER_REJECTED'`, allowing a new identity on a later explicit retry. A 15-second acknowledgment deadline reports uncertain delivery without automatic reinjection; uncertain retries retain their original identity and late acknowledgments may still arrive before the turn ends. A failed queued steering attempt pauses the queue until explicit resumption. Completion, cancellation and disconnect revoke the bridge. Other current adapters do not register same-turn input; their follow-ups use the renderer's normal queued Chat requests. The renderer captures fresh context at queue dispatch; queued entries and tokens never enter recovery. Browser-only Agent settings use `openpe.agent-settings.v1`; desktop settings use the authenticated service independently of workspace recovery.

### Simulation requests and SSE

HTTP simulation `source` is a validated private project snapshot string. It is not a renderer-supplied SPICE deck, executable, filename or filesystem path. `fileId` is an opaque desktop grant; desktop runs require a saved native destination.

```ts
type TransientConfig = {
  inputId: string;
  pwmId: string;
  outputId: string;
  switchId: string;
  currentId: string;
  voltage: number;
  frequency: number;
  duty: number;
  stop: number;
  step: number; // Seconds, finite and positive.
};
type ModelReference = { id: string; sha256: string; file: string };
type SimulationResult = {
  version: string;
  time: number[];
  traces: {
    label: string;
    unit: 'V' | 'A';
    vector: string;
    targets?: ProbeTarget[];
    dissipation?: {
      positivePin: string;
      negativePin: string;
      positiveNode: string;
      negativeNode: string;
      method: 'resistor' | 'diode' | 'switch' | 'mosfet';
    }; // Compiler-owned dissipative path; never accepted as a request override.
    values: number[];
  }[];
  log: string;
  dissipation?: {
    startS: number;
    endS: number;
    sampleCount: number;
    powers: { vector: string; powerW: number }[];
  };
};
```

The optional completed-result `dissipation` summary integrates signed V·I over every full-resolution solver output row before display reduction, over the final 20% of the requested duration. Its exact interval, original row count and ordered current vectors must match the current deck. Layout Thermal import requires this verified summary and rejects negative dissipative averages; live, partial and display-only results without this summary cannot supply heat. Heat-summary version and vector/node metadata participate in completed-run cache identity. See [SPICE Simulation](SIMULATION.md#full-resolution-dissipative-power) for excluded losses and the distinct approximate EMC Flyback model.

With `Accept: text/event-stream`, transient events are:

| `type`    | Payload                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `started` | No additional fields.                                                                                                   |
| `retry`   | No additional fields. Discard the failed attempt preview; the next sample offset restarts at zero.                      |
| `samples` | `{offset:number,time:number[],values:number[][]}`; values are trace-major and offsets are contiguous.                   |
| `result`  | `{result: SimulationResult & {simulationModels?: ModelReference[]}}`; references follow the allowlisted model contract. |
| `error`   | `{message:string,code?:string}`.                                                                                        |

Native output is read every 200 ms. Display reduction retains actual trace extrema/endpoints within 200,000 samples and 1.1 million values. Frames are bounded to 64 MiB and backpressure waits for drain up to five seconds. These are transport/display limits, not solver runtime deadlines. No HTTP cancel route exists: disconnect aborts the request. Explicit user Stop uses the Uniform API's `simulation.cancel`, whose adapter retains the validated partial display state.

### Raw KiCad transport

This desktop-only path is active after `setRawKiCadMode(true)`. The native picker accepts 1–8 explicitly selected regular `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` files with distinct basenames and at most 2 MiB of UTF-8 text in total. It rejects links, unreadable files, NUL bytes and invalid UTF-8 without replacing a previous selection. It returns `null` on cancellation. The service retains the exact text, including BOM, whitespace and line endings. It holds one selection in memory and never sends local paths to the provider.

`POST /api/raw-kicad/chat` is authenticated with `X-OpenPE-Token`. It accepts `{selection, provider, prompt, history, model?, effort?, parameters?}` with the same provider/model selectors as ordinary chat. `selection` is the current picker ID. `prompt` is nonblank and at most 16,000 characters. `history` holds at most 16 `{role:'user'|'assistant', text}` entries totalling at most 128 KiB of encoded JSON. The body limit is 256 KiB. One turn may run at a time. SSE emits `text-delta`, `text-replace`, `error` and `done`. Disconnect, mode exit and frame replacement cancel the turn.

The host frames the original text with filenames and byte lengths. Agent and model discovery stay available while normal workbench HTTP routes and native operations are blocked. Normal chat cannot enable raw mode through its request body. Raw chat does not register tool, question or steering bridges. See [the mode lifecycle](ARCHITECTURE.md#raw-kicad-chat).

## Electron bridge

[`electron/preload.cjs`](../electron/preload.cjs) exposes the required methods below on `window.openpe`, plus readonly `titleBarOverlay:boolean` and `titleBarInset:boolean`. Both are true or false from the desktop bridge: the overlay caption is shown on Windows and macOS, and `titleBarInset` is true only for the macOS traffic-light inset. Renderer and Electron use the same current bridge contract without host feature flags or method fallbacks. Browser presentation has no native bridge. The renderer-facing types are in [`lib/bridge.ts`](../lib/bridge.ts). IPC handlers in [`electron/main.cjs`](../electron/main.cjs) and its adapters validate the originating main frame. Calls return promises except the event-subscription method.

| Method                                      | Input                                                                                    | Result and behaviour                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection()`                              | None                                                                                     | `{base,token}`; authenticated service connection.                                                                                                                                                                                                                                               |
| `writeWorkspaceRecovery(content)`           | Serialized `WorkspaceState` v2 string, or `null` to clear                                | `void` after validated, queued atomic recovery persistence.                                                                                                                                                                                                                                     |
| `open()`                                    | None                                                                                     | Native file picker; `{source,name,native:true,openId}`, an already-open `{fileId}`, or cancellation `null`.                                                                                                                                                                                     |
| `acceptOpen(openId)`                        | The numeric request ID returned by `open()` or `openRecent()`                            | Creates an opaque grant only for the matching verified pending open; stale or missing request IDs fail; returns `fileId:string`.                                                                                                                                                                |
| `newFile()`                                 | None                                                                                     | `fileId:string` for a new project without a native destination.                                                                                                                                                                                                                                 |
| `openDefaultExample(key)`                   | Bundled or discovered opaque example key                                                 | `{id,source,fileId,filename,warning?}` from the original native example directory, retaining actual filenames.                                                                                                                                                                                  |
| `releaseFile(fileId)`                       | Opaque grant ID                                                                          | `void`; releases only that grant.                                                                                                                                                                                                                                                               |
| `revealFile(fileId)`                        | Opaque grant ID                                                                          | `{status:'revealed'/'needs-save'}`.                                                                                                                                                                                                                                                             |
| `projectDirectory(fileId)`                  | Opaque live project grant ID                                                             | `{entries:[{name,kind:'directory'/'file',id?,bytes?}],truncated:boolean}`; relative names, empty folders and opaque file-observation IDs.                                                                                                                                                       |
| `chooseSpiceModel(fileId, currentLibrary?)` | Opaque live project grant ID and optional current library path for native-dialog display | `{path:string, models:SpiceModelDeclaration[], issues:string[]}` or cancellation `null`; selects one local model library and returns bounded declaration metadata, never model bodies or execution permission. Direct project `models/` paths stay relative; other selected paths are absolute. |
| `inspectSpiceModel(fileId, library)`        | Opaque live project grant ID and project-relative SPICE library reference                | `{path,models,issues}` from a fresh bounded project-directory observation, or `null` for an absolute external reference or an unsaved project without a prepared TI library. Returns metadata only.                                                                                                        |
| `projectFilePreview(options)`               | `{fileId,id}` from that grant's latest directory listing                                 | `{source,bytes,binary,truncated,readOnly,encoding?:'latin1',pdf?:true}`; bounded text, PDF marker or binary metadata.                                                                                                                                                                           |
| `projectFileWrite(options)`                 | `{fileId,id,source,expectedSource,encoding?:'latin1'}`                                   | Updated `ProjectFilePreview` after an atomic ordinary-text write; checks original bytes, encoding, grant and frame. Native files use Core Source editing.                                                                                                                                       |
| `projectFilePdf(options)`                   | `{fileId,id}`                                                                            | `{base64,bytes}` for a verified local PDF up to 32 MiB, read through the same current grant and opaque observation.                                                                                                                                                                             |
| `setDirty(value)`                           | `boolean`                                                                                | `void`; native close protection, not a design mutation.                                                                                                                                                                                                                                         |
| `onCloseRequested(callback)`                | Callback                                                                                 | Unsubscribe function for native `openpe:close-requested` events.                                                                                                                                                                                                                                |
| `resolveClose(allow)`                       | `boolean`                                                                                | `void`; answers an already-pending native close request.                                                                                                                                                                                                                                        |
| `save(options)`                             | `{fileId,source,name,saveAs?:boolean}`                                                   | `{name,path,localExample?}` or cancellation `null`.                                                                                                                                                                                                                                             |
| `historyList(options)`                      | `{fileId,offset?:number}`                                                                | `HistoryPage`.                                                                                                                                                                                                                                                                                  |
| `historyRead(options)`                      | `{fileId,id}`                                                                            | Validated complete private snapshot string.                                                                                                                                                                                                                                                     |
| `historyCreate(options)`                    | `{fileId,source,message}`                                                                | `{id:string}`.                                                                                                                                                                                                                                                                                  |
| `exportProject(options)`                    | `{source,name,format:ProjectExportFormat}`                                               | `{name,format:ProjectExportFormat}` or cancellation `null`.                                                                                                                                                                                                                                     |
| `exportImage(options)`                      | `{dataUrl,width,height,name}`                                                            | `{name}` or cancellation `null`.                                                                                                                                                                                                                                                                |
| `exportEnclosure(options)`                  | `{source}` validated complete private snapshot                                           | `{name}` or cancellation `null`; native STEP picker.                                                                                                                                                                                                                                            |

`openLibraryHomepage(site)` invokes `openpe:open-library-homepage` and resolves with
`void` after dispatch to the system browser. The trusted main frame supplies
`jlceda` or `easyeda` to open the corresponding fixed official HTTPS homepage.
The handler accepts only these IDs and rejects direct URL arguments.

`setRawKiCadMode(value: boolean)` invokes `openpe:set-raw-kicad-mode` for the trusted main frame. `chooseRawKiCadFiles()` invokes `openpe:choose-raw-kicad-files` while the mode is active and returns `{ id, names }` or `null`. A caller cannot supply paths or file contents. [Raw KiCad transport](#raw-kicad-transport) owns selection and turn limits.

`listExamples()` invokes `openpe:list-examples` with no path arguments and returns `{entries:[{id,title,description,section}],warnings:string[]}`. Sections identify the logical resource roots, `project` or `examples`. The host scans the roots independently. Local IDs are `local-` followed by a 64-character lowercase SHA-256 digest. Listing creates no grants or histories. `openDefaultExample` resolves local keys against a fresh scan. Unknown, removed and linked entries cannot grant access. Home refreshes on activation and window focus. [Source and packaged root mapping](EXAMPLES.md#original-project-directories-and-portable-assets)

`listRecent()` invokes `openpe:list-recent` without arguments and returns
`{initialized:boolean,entries:[{id,title,description,pinned:boolean}],warnings:string[]}` with pinned entries first, then newest-first native history, at most 32 entries total. Pinned native entries retain pin order; the default EMC shortcut is first while pinned.
For native history, `title` is the native filename and `description` its display-only absolute path. The fixed `emc-flyback-demo` shortcut uses the catalog title and its host-resolved absolute native path, and opens through `openDefaultExample`. Pin/Unpin preserves the displayed address. The shortcut remains alongside real history while pinned, without duplicating its native location. `initialized` reports whether the native-use index exists; entries always contain the complete visible list.
`openRecent(id)` invokes `openpe:open-recent` with a `recent:<64 lowercase hex>`
host-derived ID and returns the same validated source or existing `fileId` shape
as `open()`. New opens use `acceptOpen(openId)` bound to their exact staged request; existing destinations activate their
editor. The host rechecks the existing grant after recording Recent; if close
released it during that write, opening continues with native reading and staged
acceptance. The renderer cannot submit paths. Host resolution precedes the ordinary
bounded native reader, including link and unsupported-content rejection; missing
files stay listed and fail visibly on open. Trusted-main-frame checks surround
asynchronous calls. `onRecentChanged(callback)` subscribes to the payload-free
`openpe:recent-changed` notification and returns an unsubscribe function.

`electron/recent-projects.cjs` stores `{version:1,files:string[]}` at the fixed
app-data `recent-projects.json` path: at most 32 unique absolute native entry
paths, each at most 4,096 characters, and a 1 MiB read bound. Windows paths
deduplicate case-insensitively. Accepted opens, selected examples and successful
Save/Save as move their entry to the front; cancellation, rejected reads and
example preparation never add entries. No grants or document content persist
in this index, and listing grants no file access. Writes are serialized and
atomically replace the index; malformed/linked data is preserved with a
retryable error. Index-write failures surface on listing without failing an
already-completed native open/save. Only an absent index returns `initialized:false`.
The separate app-data `recent-pins.json` stores exactly `{version:1,files:string[],defaultPinned:boolean}` with the same path, uniqueness, link and read bounds. An absent pins file means no pinned native locations and the EMC shortcut pinned. At most 32 pins, including the shortcut, are accepted. Pins survive native history churn; accepted opens retain pinned native locations within the history bound. Unsupported pin data is preserved and fails visibly without migration. These indexes are separate
from workspace recovery, Core/undo, Agent context and project dirty state.

`pinRecent(id,pinned)` invokes `openpe:pin-recent` with a listed native ID or the fixed `default:emc-flyback-demo` selector and an exact boolean. Native paths are host-resolved; renderer paths are rejected. It atomically writes pin preferences and emits `openpe:recent-changed`. Unpinning a native entry first retains it at the front of ordinary history, then publishes the preference; the two files are individually atomic, not crash-atomic together. Unpinning the default removes its shortcut; an accepted native opening remains ordinary history. Re-pinning that native location restores the shortcut. No grant, design data, recovery or dirty state changes.

`removeRecent(id)` invokes `openpe:remove-recent` and atomically removes one
listed unpinned native ID. Pinned entries reject removal until unpinned. Removal touches only the private index, never
native files, grants, open editors or Git history. Errors preserve the list;
success emits `openpe:recent-changed`.

`previewRecent(id)` invokes `openpe:preview-recent` with a listed Recent ID and
returns its validated primary `Circuit` for read-only schematic thumbnails.
The host resolves the ID and uses the ordinary bounded native reader without
allocating a grant or staging an open. It rechecks the entry and trusted frame
after reading, limits the serialized circuit to 8 MB, coalesces concurrent reads
by ID and serializes at most 32 pending preview IDs. It never updates Recent,
Core, native bytes, models, fills or history. Visible Home cards load lazily,
retain only their current thumbnail and refresh on Home/list activation; hidden
or replaced card responses cannot publish. Missing/unsupported files show a
per-card preview error without blocking other cards or opening actions.

`openDefaultExample(key)` starts shared runtime preparation on its first request, including clean recovery, and rechecks the originating main frame before opening the selected example. Home does not request an example preflight.

Inputs never let a renderer choose an arbitrary filesystem path. Returned save paths are display results, not reusable permissions; project export returns only its filename and format. Grants live in Electron memory, remain out of documents/recovery and are revoked on main-document replacement. Save as protects other live project destinations. Native/project writes retain their existing validation, asset preparation and sibling-rollback requirements in [Format](FORMAT.md).

`inspectSpiceModel(fileId, library)` uses `openpe:inspect-spice-model` to inspect a traversal-free project-relative SPICE reference through a live grant. It returns `{path,models,issues}`, or `null` when an unsaved project has no prepared TI library or the path is absolute. A private bounded directory listing supplies an opaque observation to the shared directory reader; hidden/private files, links, missing files, expired grants, changed files, unsupported extensions and files over 2 MiB fail. A hash-matching TI import can be inspected from its private cache until it is saved. Frame and location checks surround the read. It uses the same declaration scanner, returns no model bodies, follows no includes and changes no binding. Both native inspection paths and the TI selection route share the declaration scanner in `plugins/spice-simulation/host/spice-model-declarations.cjs`. Properties invokes it only while active with SPICE available, rejects stale revision/origin results and retains the accepted binding on failure. Absolute references require the native picker.

`chooseSpiceModel` uses `openpe:choose-spice-model` through `plugins/spice-simulation/electron/spice-model-picker.cjs`. The host checks the main frame and live project grant before and after the picker and bounded file inspection, permits one picker at a time and rejects links, nonregular files, changed bytes and paths over 4,096 characters. The optional current-library path only sets the native dialog location: an absolute local library or a traversal-free project-relative library is accepted within the same 4,096-character and extension bounds. Relative hints require a saved project location; unsaved projects ignore them. No hint authorizes inspection, follows includes or grants file access; inspection outside the project directory requires an explicit native selection. No other renderer dialog options are accepted. The selected .lib/.mod/.cir/.sp/.spice file is at most 2 MiB; an ASCII declaration scanner permits opaque vendor 8-bit comment/body text, rejects binary controls and scans at most 256 unambiguous top-level declarations with 64 ports each and returns only device entries. Exact pinned TI file hashes select reviewed public controller names generated from the canonical TI/reference records. Other files expose unreferenced declarations; subcircuit and primitive instance references hide helper dependencies, respecting local model/subcircuit scope and ignoring control blocks. A declaration cycle without an independent entry returns an empty model list. Unreferenced declarations in unreviewed files have no guaranteed physical classification. `SpiceModelDeclaration` is `{name:string, kind:"model"|"subcircuit", device?:string, pins:string[]}`; names/ports are bounded to 128 ASCII characters. Identical definitions deduplicate; conflicting same-name definitions are skipped with bounded issues, and a file with no unambiguous definitions fails. The host never follows includes, reads another file, returns model bodies, copies the file or executes its directives. The renderer applies validated declarations through ordinary Properties transactions with revision/Source/project/plugin guards. Model catalogs do not enter design/recovery/history; only the selected external binding and active source are retained. Runtime compilation and pinned hash checks remain independent.

Directory browsing uses `openpe:project-directory` and
`openpe:project-file-preview`, `openpe:project-file-write` and
`openpe:project-file-pdf` through `electron/project-directory.cjs`. They
check the originating main frame and grant before/after asynchronous work.
Listings include regular project folders/files, exclude hidden/private entries,
keys and links, and are bounded to 4,096 entries and twelve nested levels. File
reads accept only opaque IDs from the latest listing, recheck parent/file
identity and read at most 1 MiB. Replaced/closed grants and main-frame navigation
invalidate observations. Binary files return metadata; truncated text is explicit.
Ordinary text saves compare the expected original bytes, retain encoding and
replace atomically after rechecking the grant and main frame. PDFs are loaded
only when selected and displayed through a local Blob URL, released on hide or
selection change. Source keeps eight preview buffers. Directory files are not Uniform API
capabilities, native Source files, recovery data or automatic Agent context;
`source.files` continues to return Core's validated native set only.

`writeWorkspaceRecovery` uses the fixed `openpe:workspace-recovery-write` channel
and the host-owned recovery filename; it exposes no read or path selection.
[`electron/workspace-recovery.cjs`](../electron/workspace-recovery.cjs) checks the
trusted main frame before forwarding to the service's shared recovery store in
[`server/workspace-storage.mjs`](../server/workspace-storage.mjs). Strings must
contain a complete valid workspace within the 96 MiB UTF-8 envelope; encoded
JSON `null` is invalid, while the argument `null` clears recovery. Full project
Source, draft, session and workspace validation precedes compact JSON storage.
HTTP GET/POST/DELETE and IPC writes use one ordered queue; a failed write leaves
later attempts retryable. DesktopWorkspace writes through the required native
recovery bridge. IPC failures propagate to recovery/quit error
handling, and close waits for the same write acknowledgement.

Native Git history pages contain 50 entries. The host accepts an integer `offset` from 0 to 1,000,000, 40-character lowercase hexadecimal commit IDs and single-line creation messages of 1–240 characters. Capability schemas apply first: `versions.list` narrows `offset` to 0–100,000, while `versions.create` admits messages up to 2,000 characters that the host then limits to 240. Snapshot payloads are bounded to 8,000,000 bytes. Reachability/current validation still apply to reads. [Version history](VERSION-HISTORY.md#git-execution-boundary) owns the Git execution bounds.

Project export uses `openpe:export` with `{source:string,name:string,format:ProjectExportFormat}` and returns `{name:string,format:ProjectExportFormat}` or `null`. The source must be a complete validated snapshot and the name is bounded to 200 characters. Unknown fields and unsupported formats fail before the picker. The host checks the originating main frame after the picker, protects open project sources, rejects linked destinations and rechecks before atomic replacement. Export creates no project grant or baseline. [Format IDs](#workbench-and-history-capabilities) · [Design exchange](FORMAT.md#design-exchange) · [Manufacturing export](FORMAT.md#manufacturing-export)

Image export accepts a verified PNG data URL, at most 48,000,000 characters, with integer dimensions from 1 to 4,096 pixels. It opens a native picker and does not change project dirty state or destination grants.

Model STEP export retains the `exportEnclosure` bridge method and `enclosure.exportStep` capability as current protocol identifiers. It accepts at most 8,000,000 bytes of validated source containing CAD bodies. The host reuses the preview kernel's fixed OpenCASCADE construction with verified packaged Gmsh, a 60-second geometry bound and completed-artifact validation, then opens the native STEP/STP picker and writes atomically to that selection. Renderer input supplies no path, executable or script. Overlapping independent bodies remain separate unless explicitly combined. STEP contains analytical profiles, selected-edge treatments and Boolean cutouts with their XYZ poses, excluding PCB/package shapes and material/color/opacity properties. Export is independent of Layout Thermal plugin state and does not run a solve, edit the project or grant a native project destination.

## Examples

These examples run inside an adapter that already holds the originating project's `CapabilityHost`. They do not create a second document host or bypass Agent review.

### Discover and edit a component

```ts
const catalog = await host.query('capabilities.list');
const snapshot = (await host.query('project.snapshot')) as ProjectSnapshot;
// schematicId and partId come from this project's current query results.
const result = await host.execute(
  'part.properties',
  { schematicId, partId, value: '10k' },
  { actor: 'human', expectedRevision: snapshot.revision },
);
```

### Edit one native Source file

```ts
const files = (await host.query('source.files')) as NativeFiles;
const selected = files.files.find((file) => file.name === selectedNativeName);
if (!selected) throw new Error('Select a loaded native file.');
const before = (await host.query('project.snapshot')) as ProjectSnapshot;
await host.execute(
  'source.updateFile',
  {
    name: selected.name,
    source: editedNativeText,
  },
  { expectedRevision: before.revision },
);

// Draft changes also advance the revision. Read it again before Apply.
const pending = (await host.query('project.snapshot')) as ProjectSnapshot;
await host.execute('source.apply', {}, { expectedRevision: pending.revision });
```

### Submit an Agent command

Invoke `openpe_execute` against the current project state; no revision argument is accepted. Use `schematic.drag` to reposition a component and retain its wired connections; `schematic.move` leaves unselected wires in place. Deltas are millimetres. Placeholder IDs below must be replaced with the queried project identities.

```json
{
  "name": "schematic.drag",
  "input": {
    "schematicId": "<schematic-id>",
    "ids": ["<part-id>"],
    "delta": { "x": 1.27, "y": 0 }
  }
}
```

### Open and configure simulation

```ts
await host.execute('simulation.show');
const catalogAfterMount = await host.query('capabilities.list');
// Confirm simulation.configure/run are registered and currently available.
await host.execute('simulation.configure', {
  config: { stop: 0.01, step: 0.0000002 },
});
// Invoke Run against the current project state after configuration.
```

## EMC Analysis capabilities

`emc.inspectLayout` and `emc.reviewLayout` are read-only queries owned by
`emc-analysis@openpe`, registered per project through
`plugins/emc-analysis/renderer/capabilities.ts`. They require confirmed plugin
availability, an accepted PCB and clear Source/close barriers. Explicit expected
revisions must match; results carry the numeric checked revision. No HTTP route,
native bridge, solver, file write or Core transaction is added.

`emc.inspectLayout` accepts `{netIds:string[],segmentBudgetMm:number}` with 1–32
unique current board net IDs and a positive bounded segment budget. It reads only
the accepted PCB, returning `boardId`, revision, `completeness:"partial"`, the
budget, per-net track lengths/counts, via/pad/zone counts, missing-fill evidence,
over-budget segments with IDs/layers/endpoints, exact evidence counts and
truncation flags, plus `notVerified` coverage notes. It never refills copper or
infers return paths or EMC compliance. GUI and Agent call the same pure
domain function. Unknown fields and invalid/nonfinite budgets fail. Locating a
reported object uses a bounded Layout camera/selection port for tracks, vias,
footprints and pads, with current-board,
Source/close, visibility, selection-filter and draft gates; it adds no capability
or mutation authority. [EMC Analysis](EMC.md) owns coverage, bounds and reference use.

`emc.reviewLayout` accepts exact `{nets,limits,decoupling,edgeConnectorIds}`.
`nets` contains up to 32 unique `{netId,role,referenceNetId?,referenceLayer?}`
records; role is `fast`, `switching`, `sensitive` or `supply`. Reference net and
layer are explicit current native identities. `limits` requires
`maxTrackLengthMm`, `maxVias`, `minEdgeClearanceMm`, `minNetSeparationMm`,
`maxReferenceViaDistanceMm`, `maxDecouplingDistanceMm` and
`maxConnectorEdgeDistanceMm`. Distances are finite positive mm; via count is a
bounded nonnegative integer. `decoupling` holds up to 32 explicit
`{targetPadId,capacitorFootprintId,referenceNetId}` assignments;
`edgeConnectorIds` holds up to 32 unique current footprint IDs. At least one
intent is required. Missing roles are not inferred. Unknown fields, stale IDs,
invalid relationships and work bounds reject without changing data.

The result is `{boardId,revision,result}`. The pure `result` contains
`completeness:"partial"`, exact `input`, `findings`, `checks`, `summary`,
`truncated` and `notes`. Findings retain original check/category identities,
warning/information/not-verified severity, geometric/limited/missing confidence,
textual evidence/remediation, exact net/object IDs and optional location,
measurement/limit quantities. Checks retain checked/not-verified/not-applicable
coverage. At most 500 findings return; summary counts include omitted findings.
No regulatory pass, field solve or implicit document edit is provided.

Manual decisions and justified exceptions belong to the GUI session, not these
queries. Explicit HTML/JSON report downloads use the pure version-1
`openpe-emc-review` contract in `plugins/emc-analysis/domain/report.ts`, including
board/revision, unchanged automatic results, eight explicit manual states/notes
and exceptions naming current findings with required reasons. Strict shared
result validation, JSON bounds and HTML escaping apply. Reports create no native
grant, project file, Source draft, dirty baseline, bridge method or HTTP route.

## Sources and maintenance

| Interface                                            | Implementation source                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host, catalog, JSON bounds and schema interpreter    | [`api/capabilities.ts`](../api/capabilities.ts), [`api/capability-schema.ts`](../api/capability-schema.ts)                                                                                                                                                                                                                                                                                                                                       |
| Core registration, query/command schemas and results | [`core/register-project.ts`](../core/register-project.ts), [`core/project-core.ts`](../core/project-core.ts), [`core/layout-commands.ts`](../core/layout-commands.ts)                                                                                                                                                                                                                                                                            |
| Rule-check results, thresholds and engines           | [`lib/design-rule-checks.ts`](../lib/design-rule-checks.ts), [`lib/schematic-erc.ts`](../lib/schematic-erc.ts), [`lib/pcb-drc.ts`](../lib/pcb-drc.ts)                                                                                                                                                                                                                                                                                            |
| Workspace/native/history ports                       | [`lib/workbench-capabilities.ts`](../lib/workbench-capabilities.ts), [`components/Workbench.tsx`](../components/Workbench.tsx)                                                                                                                                                                                                                                                                                                                   |
| Official libraries                                   | [`lib/library-capabilities.ts`](../lib/library-capabilities.ts), [`lib/library.ts`](../lib/library.ts)                                                                                                                                                                                                                                                                                                                                           |
| Embedded symbol/footprint authoring                  | [`lib/symbol-drawing.ts`](../lib/symbol-drawing.ts), [`lib/footprint-drawing.ts`](../lib/footprint-drawing.ts)                                                                                                                                                                                                                                                                                                                                   |
| Bundled/provider lifecycle                           | [`lib/workbench-plugins.ts`](../lib/workbench-plugins.ts), [`lib/provider-plugin-capabilities.ts`](../lib/provider-plugin-capabilities.ts)                                                                                                                                                                                                                                                                                                       |
| Resident simulation and waveform handlers            | [`plugins/spice-simulation/renderer/simulation-capabilities.ts`](../plugins/spice-simulation/renderer/simulation-capabilities.ts), [`plugins/spice-simulation/renderer/SimulationDialog.tsx`](../plugins/spice-simulation/renderer/SimulationDialog.tsx), [`plugins/spice-simulation/renderer/SimulationWaveforms.tsx`](../plugins/spice-simulation/renderer/SimulationWaveforms.tsx)                                                            |
| Resident Layout Thermal handlers                     | [`plugins/layout-thermal/renderer/thermal-capabilities.ts`](../plugins/layout-thermal/renderer/thermal-capabilities.ts), [`plugins/layout-thermal/renderer/ThermalSimulation.tsx`](../plugins/layout-thermal/renderer/ThermalSimulation.tsx), [`plugins/layout-thermal/domain/thermal.ts`](../plugins/layout-thermal/domain/thermal.ts)                                                                                                          |
| Layout Parasitics                                    | [`plugins/layout-parasitics/renderer/capabilities.ts`](../plugins/layout-parasitics/renderer/capabilities.ts), [`plugins/layout-parasitics/domain/analysis.ts`](../plugins/layout-parasitics/domain/analysis.ts), [`plugins/layout-parasitics/domain/study.ts`](../plugins/layout-parasitics/domain/study.ts), [`plugins/layout-parasitics/renderer/LayoutParasiticsPanel.tsx`](../plugins/layout-parasitics/renderer/LayoutParasiticsPanel.tsx) |
| Agent tool envelopes and review                      | [`server/agent-capabilities.mjs`](../server/agent-capabilities.mjs), [`lib/chat-stream.ts`](../lib/chat-stream.ts)                                                                                                                                                                                                                                                                                                                               |
| Agent identities and connection labels               | [`lib/agent-providers.ts`](../lib/agent-providers.ts); generated [`server/agent-provider-format.mjs`](../server/agent-provider-format.mjs)                                                                                                                                                                                                                                                                                                       |
| Local HTTP and native bridge                         | [`server/index.mjs`](../server/index.mjs), [`electron/preload.cjs`](../electron/preload.cjs), [`lib/bridge.ts`](../lib/bridge.ts)                                                                                                                                                                                                                                                                                                                |

Update this reference when registered IDs, schemas, metadata, results, routes, bridge methods or lifecycle gates change. Runtime `capabilities.list` remains authoritative for an individual mounted project's schema and availability. Architecture diagram nodes describe responsibilities; callable interfaces use the exact registered IDs. No `/api/capabilities` route is registered. Keep [Core](CORE.md), [Architecture](ARCHITECTURE.md) and the relevant subsystem contract aligned with the implementation.

## Component STEP models

`window.openpe.chooseComponentModel(fileId)` invokes `openpe:choose-component-model`. It requires a live project grant and trusted main frame, including for unsaved projects. It selects one local `.step`/`.stp` file, validates at most 32 MiB without links or changed bytes, and tessellates before returning `{path:string}` or `null` on cancellation. Frame and location checks surround asynchronous work. The path is a portable content-addressed `${KIPRJMOD}/models/<SHA-256>.step` reference. Shared Properties commits the assignment through Core after revision, selection and activation checks.

Authenticated `POST /api/component-model` accepts `{source:string,fileId?:string,index:number}` with exactly one selector. `footprintId:string` selects an existing PCB instance. `libraryId:string` (at most 500 characters) selects an exact downloaded NextPCB or JLCPCB footprint in the project's native library. The service parses the current project and resolves the requested model index. Project-relative reads use the granted location or the approved content-addressed cache. A live unsaved grant also permits exact hash-verified bundled portable references for a PCB instance. Bounded official library references use the library service. Invalid or revoked grants and changed locations fail project-relative reads. The STEP worker pool returns bounded `{meshes:MeshData[]}` geometry and disconnect aborts preview. Local relative reads reject traversal, hidden paths, links and changed or oversized bytes. Absolute native references require reselection through the picker.

Authenticated `POST /api/component-model/library` accepts `{id:string,index:number}` from the current library chooser. It resolves only the existing bounded footprint/model catalog, parses the verified STEP bytes and stages an immutable portable component model, returning `{path:string}`. No document edit occurs until Core accepts the assignment.

Authenticated `POST /api/library-package` accepts a NextPCB or JLCPCB ID. The ID suffix
is at most 150 characters so its `.kicad_mod` filename fits the native 160-character
segment limit. It loads the validated native footprint and stages each supported
STEP in the component model store and changes only the native model path to the
returned content-addressed project reference. The result is footprint detail
with `projectAssets:true`; offset, scale, rotation, visibility and opacity are
retained. An EasyEDA STEP response of HTTP 403 or 404 omits only that model from
the prepared package. The renderer shares this preparation across package synchronization,
Properties and GUI/Agent placement. Core adds the package's `.kicad_mod` and
`fp-lib-table` in the same accepted edit. Save/Save as publishes native sidecars
and STEP bytes through existing granted writers. Prepared metadata is no grant
and cannot choose paths, model bodies or URLs. [Libraries](LIBRARIES.md#nextpcb-online-catalog)
owns NextPCB asset matching and limits. [JLCPCB](LIBRARIES.md#jlcpcb-online-catalog)
owns EasyEDA package conversion and attribution.
