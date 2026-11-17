# KiCad native projects and Source

OpenPE opens and saves `.kicad_pro` settings, `.kicad_sch` schematics, an optional
`.kicad_pcb` board and supporting text files, targeting KiCad 10. Structured
snapshots are private IPC, recovery, fixture and history data; never publish them
as a design format or give them a KiCad extension. See the
[KiCad file documentation](https://dev-docs.kicad.org/en/file-formats/).

Desktop **Open project** selects one `.kicad_pro` file. The host loads its bounded
schematic, PCB and supporting native file set automatically; those files do not
need to be selected separately.

Component simulation data retains optional `initialVoltage` and `initialCurrent` strings in the canonical component record, represented natively by `OpenPE.InitialVoltage` and `OpenPE.InitialCurrent`. Unset values remain absent; inspection does not write defaults.

Model selection retains optional canonical `simulation.modelSource` (`basic` or `external`) as native `OpenPE.ModelSource`, independently of the saved external Sim.Library/Sim.Name/Sim.Pins. An absent override follows the current native library binding. Selecting an intrinsic model preserves external settings, and undo/save/recovery retain both. An explicit passive choice uses canonical `simulation.passiveModel` (R, C or L) and native `OpenPE.PassiveModel`. It preserves physical pins, Value, stored simulation fields and the participation flag. Clearing an unassigned two-pin connector removes the explicit passive selection. Declaration catalogs and model bodies are not native fields.

Voltage-source and EMC IPULSE current-source waveform selection stores optional canonical simulation.sourceType (DC, PULSE or SIN) as native OpenPE.SourceType. It applies to the active intrinsic source independently of inactive external Device/Type/Pins and uses the existing Sim.Params/Value storage; native symbol IDs, geometry and connectivity stay unchanged.

## Document ownership

Schematic section membership uses Footprint assignment and the native symbol
`on_board` attribute. Components without a Footprint and components with
`on_board no` belong to Virtual; assigned, board-included components belong
to Real. Power and electrical markers use the same rule. This does not replace
`exclude_from_sim` or simulation model fields.
Opening and switching views do not rewrite these flags or infer membership from
a library namespace. Explicit board-inclusion edits update all units of the
component in one Core transaction.
Setting board inclusion without a Footprint leaves the component in Virtual.
Moving to Virtual removes its linked PCB package while retaining copper and
the saved Footprint assignment; returning to Real uses normal package
preparation. [Schematic sections](../DESIGN.md#real-and-virtual-sections)
own view behavior. Save, Source, recovery and history retain the complete sheet.

Custom single-unit symbols are native embedded `.kicad_sch` definitions. Editing
one instance forks its embedded name while preserving its original `lib_id`
through native `lib_name` aliasing where needed. Custom footprints are native
embedded `.kicad_pcb` pads/artwork. These drawing tools do not synthesize reusable
`.kicad_sym`/`.pretty` libraries or modify bundled resources. Existing supporting
library files retain their ordinary native preservation contract.

`ProjectCore` owns validated models, Source drafts, revisions and whole-project
undo. `lib/kicad-project.ts` maps bounded native file sets to those models and
back. Save, recovery and history consume the current validated native texts,
including canvas edits. Unchanged files retain their bytes; edits preserve
supported metadata and ordering. Unsupported electrical or geometry content
fails before commit or write. Native acceptance is not complete KiCad parity,
ERC/DRC or hierarchy simulation.

Up to twelve independent schematics are supported. The primary sheet shares the
project stem when available and owns the optional PCB; sheets have no cross-file
electrical joins. Geometry determines connectivity. UUIDs, embedded libraries,
fields, assignments, copper and model transforms survive round trips.

Explicitly added [parasitic study components](LAYOUT.md#parasitic-study-schematics)
are ordinary content in the selected existing `.kicad_sch`: embedded passive
symbols, endpoint-identifying local labels, hidden native group properties
and wires. A series insertion shortens the end pin's exclusive leaf lead and
adds connection-label copies as part of the same native edit. The edit changes that native file through
Source and Save without adding a sheet, native file or private plugin
format. Other schematics and PCB native bytes are preserved.

Every inserted R/L stores `OpenPE.Parasitics.Connection` as `series`, one shared
UUID in `OpenPE.Parasitics.GroupId`, and its `OpenPE.Parasitics.Role` as
`resistor` or `inductor`. `OpenPE.Parasitics.StartLabel` and
`OpenPE.Parasitics.EndLabel` store the two generated endpoint label names.
`OpenPE.Parasitics.BoardId`, `OpenPE.Parasitics.StartId` and
`OpenPE.Parasitics.EndId` retain the exact board and mapped pad UUIDs;
`OpenPE.Parasitics.Start` and `OpenPE.Parasitics.End` retain readable endpoint
descriptions. These are hidden ordinary native symbol properties retained by
Source, Save, recovery and undo. Only a complete validated series group can
participate in the [PCB-only conductive projection](LAYOUT.md#project-integrity-and-schematic-synchronization);
names or provenance alone do not establish it. SPICE compiles the native
geometry rather than interpreting these fields as an instruction to rewire.

New Untitled project starts with complete empty `untitled.kicad_pro`,
`untitled.kicad_sch` and `untitled.kicad_pcb` native texts. Its empty Model CAD
is stored in `OPENPE_MODEL_CAD` within the project settings, not a separate design
format. These files are the initial clean Core baseline before any view opens.

Local footprint checks may reuse an exact internally owned collection only with
the same owned primary schematic, nets and copper stack. Every validation still
checks its UUIDs against the complete project and includes its fill vertices in
the board total. A failed board validation publishes no new reusable result.

Private snapshot component checks reuse only exact internally owned flattened
components after the complete document check succeeds. Changed, mutable and
caller-frozen data receive fresh checks; schema, network/order, project-wide
identity, pin association, aggregate bounds and native validation remain in force.
The owned schematic certificate also retains its PCB association tuples when
needed; UUIDs are replayed globally and embedded-library identity remains part
of board acceptance. Native validation checks track locks without separate
snapshot compatibility metadata.

Supported notes include horizontal plain/bold/italic text with inert HTTP(S)
links and finite unfilled Notes polylines. Polylines are read-only on canvas and
editable in Source. Native footprint, pad, track, via, graphic and zone locks map
to optional `locked: true`; unlocked objects omit it. Serialization synchronizes
the canonical lock state with retained native text. Properties and `layout.lock`
share lock/unlock transactions; locked objects reject ordinary property/geometry
edits and removal. Source remains explicit native editing. See
[object locking](LAYOUT.md#object-locking) for ownership and selection rules.
Pad pin-function/type metadata, non-rendered footprint properties and unit records
survive edits. Footprint
mask/paste margins are retained; pad mask overrides take precedence over the
footprint default. Multi-layer zones have one editable instance per layer;
the first retains the native UUID and later instances use deterministic UUIDs.
Clean files retain their exact original bytes; a PCB edit writes equivalent
single-layer zones with their original per-layer fills and rules. Disabled
placement-rule metadata is preserved; enabled placement rules remain unsupported.
OpenPE stores the rule area's pour margin in its native `connect_pads`
clearance. KiCad displays the saved contours and uses the rule area's
unexpanded outline when refilling.
Zone names remain metadata. The EMC generator uses the official
KiCad upgrader and exact custom-pad/keepout decomposition; pinned inputs remain
unchanged.

Native `.kicad_pro` text variables retain application-owned project metadata:

| Variable / private extension                | Content                                                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENPE_PROJECT_NAME`                       | Project display name, a string of 1–4096 characters. Absent names use the native entry's filename stem. Rename retains filenames and unrelated settings; Save as controls the destination stem. |
| `OPENPE_MODEL_CAD` / `org.openpe.model-cad` | Version 1; up to 64 identified box/cylinder/extrusion/Boolean bodies with XYZ pose, dimensions, material, optional RGB color, opacity and bounded geometry recipes                              |

Model CAD stores current version-1 boxes/cylinders and bounded analytic recipes. Each body may retain a
`color` override as a six-digit RGB hex string (`#RRGGBB`); absent color uses the
selected material palette. Color is independent of material and opacity, survives
native Save/Source/history and is excluded from geometry recipes and kernel keys. Extrusions use local XY
rectangle/circle profiles or 3–128-point simple implicitly closed polygons;
polygon bounds are centred and match X/Y dimensions. Z is extrusion depth.
Optional chamfer/fillet stores 1–448 unique semantic base-edge IDs; profile rims,
and vertical edges are resolved against the unchanged base geometry.
Retired rim-group strings are rejected. Explicit selections do not infer Boolean
topology or persist mesh/kernel entity tags. Boolean
recipes contain two geometry-only operands with local pose and
union/difference/intersection; operand trees omit document identities/material,
with Boolean depth at most four below the root and at most 32 operations.
Boolean size is a conservative centred envelope, not construction geometry.
Body/face/edge/line selection and Boolean operand roles are presentation state;
only committed solid recipes enter the native CAD variable. Sketch contour Booleans compile equal-depth extrusions into the same bounded Boolean tree; selected-corner sketch fillets/chamfers become existing analytical `side:N` edge treatments on those operands, without persisting the draft-only `cornerTreatment` field; plane, draft contours and drawing state stay local until Apply. Independent curve or surface artifacts are outside this solid document format.

The EMC Flyback example stores two box walls and two sketch-derived Boolean panels, with eight analytical circular cutouts, in `OPENPE_MODEL_CAD`. The MECH1/MECH2 enclosure placeholders are absent from PCB footprints and native footprint-library files. Their original records and static assets remain pinned upstream evidence outside the active footprint catalog. Dedicated `holes` fields, including empty arrays, and retired hole-rim IDs are unsupported and rejected without importing or rewriting their native files. Cylinder/circle X/Y extents are equal diameters.
The complete CAD JSON is at most 256,000 characters. UUIDs remain unique across
the project. Native admission validates current geometry and rejects retired enclosure data.
Source validates the CAD variable against the complete project; new advanced
geometry requires host preflight before one Core commit. CAD-only edits retain
schematic/PCB bytes and unrelated settings. Secondary-sheet
snapshots omit both PCB-owned extensions. Meshes, STEP exports, solver data and
local paths never enter these variables. [Layout and Model](LAYOUT.md) defines
editing and geometry limits.

## Source transactions

Applied DRC minima are native project settings under
`board.design_settings.rules` in `.kicad_pro`. OpenPE reads the saved values,
uses its defaults for absent fields and edits only the changed recognized
threshold keys. The shared minimum drill diameter uses
`min_through_hole_diameter` for both via and pad checks. The ordinary project
transaction carries these edits through Source, recovery, undo, Save and Save as.
See [Design rules](DESIGN-RULES.md#layout-drc) for coverage and precedence.

Source lists regular project folders and files, including empty folders,
`footprints/`, `symbols/`, `models/`, native `3D/`, `spice-simulation/` and
`layout-thermal/`. Native files keep validated editing; fully loaded ordinary text files
are editable through the project file editor, with OpenSCAD highlighting for
`.scad`. PDFs open in an inline viewer.
Refresh project files, returning to Source and window focus reload the listing.
Unsaved projects show native files until they have a granted location. Hidden,
private Git/history/cache entries, credential-key files and links are excluded.
Listings stop at 4,096 inspected entries and twelve nested levels, with a visible
partial-list message. Text previews read at most 1 MiB; large files show a bounded
read-only prefix and other binary files show size metadata. PDFs up to 32 MiB
are read through the same grant and displayed locally. Eight preview buffers/editor
states are retained per Workbench. Ordinary text drafts retain their original text and
encoding across file selection, views and refresh. Save file writes the selected
draft. Project Save validates and applies pending native Source first. It then
writes pending ordinary-file drafts before saving native content.
Changed disk bytes reject the write and retain the draft. Pending text participates
in project close review. These file edits never enter Core, native drafts, undo,
recovery, native save/export sets or automatic Agent context.

Agent `project.files.*` capabilities explicitly access these same ordinary-file
drafts through relative listed names and opaque read revisions. Native files use
`source.*`. Model contents and logs remain unavailable to Agent reads/writes,
including model/circuit/solver/log directories; listing exposes metadata only.
Pending native Source blocks ordinary-file mutations. Destination/draft changes,
stale disk bytes and cancellation reject pending work without discarding drafts.
The [API contract](API.md#ordinary-project-files) defines schemas and results.

Source edits every loaded native text file using bundled CodeMirror
JSON/S-expression/plain-text modes. Copy returns the selected file. UTF-8
primary files and byte-preserved Latin-1 auxiliary files retain their encoding.
Each file keeps drafts, text history, selection and scroll across switches,
including invalid drafts. Hidden clean Source defers native materialization;
reveal and explicit observations read the current Core baseline.

Apply, Save and leaving Source validate all pending files, prepare changed advanced
CAD through the fixed host kernel and commit one whole-project undo edit.
Invalid, failed or stale preparation retains drafts and blocks writes.
Pending Source blocks conflicting canvas/Agent commands, document undo/redo,
sheet creation/switching, history creation/restoration and Model entry. File
selection does not apply drafts. Recovery stores drafts separately from
validated content. Display decorations never change copied/stored text or dirty
state; preserve Save forwarding, IME and Escape then Tab navigation.

Source shows actual local PDFs under the project directory. OpenPE does not
create a separate datasheet JSON file in a native project. There is no synthetic reference group. Reviewed Agent
data remains separately matched to the validated controller; see the
[datasheet contract](DATASHEETS.md).

Project-owned plugin files live in a directory named after their plugin package.
Shared project-root `models/` contains model assets, including portable native `.lib` sidecars, and follows
normal Source/Save/history preservation. Plugin-owned data is excluded from
native discovery and file-set validation, including flat `<native-stem>.*`
SPICE/thermal artifacts and private `.pending-<uuid>-backups` /
`.previous-<uuid>-backups` directories inside the owning plugin folder. Source
can inspect/edit fully loaded artifact text as ordinary files; results never
enter design undo, recovery or dirty state. Only current project-bound v2
manifests are loaded. Unknown files remain untouched. [Project plugin data](PLUGINS.md#project-data-directories)
owns directory identities; [Simulation](SIMULATION.md#execution-streaming-and-completed-results)
and [Layout Thermal](THERMAL.md#completed-desktop-records) own publication.

## Native access and writes

Electron pickers grant bounded file sets through opaque IDs. The renderer cannot
choose arbitrary paths, commands, executables or URLs. A host-established directory
is canonicalized with `realpath` before containment checks, so an ancestor symlink
such as macOS `/var` → `/private/var` is not a link inside the granted tree. A
symbolic link at that directory or anywhere inside it is rejected. Open project
grants compare those canonical paths. Windows grant identity stays case-folded.
On any other platform, `realpath.native` supplies the stored case; a case-insensitive
volume also folds a missing final component, and a case-sensitive volume does not.
Validation rejects
traversal, links, nonregular/oversized files, case-insensitive duplicate names,
file/directory overlap and invalid entry membership. The aggregate file-set
limit is 96 MB. Cached local validation applies only to exact internally owned
immutable records; every file set still receives global checks.

Private PCB snapshot encoding reuses JSON-escaped chunks only from exact owned
merged native syntax, with at most three indentation variants per node. A final
owned file packet lends its encoder once, then releases it; public files remain
ordinary independent string containers. Clean imports retain their original
bytes. These derivations never replace project, native-file or size validation.

Save validates the complete project and preflights the native destinations before
preparing verified model and footprint assets. Its private snapshot carries the
current native texts. The host writes that same backing, retaining explicit
simulation flags and native order.
Equivalent supported hidden-field defaults do not rewrite custom positions,
styles, unknown attributes or duplicate records.

Save and Save as pickers choose a `.kicad_pro` destination outside the host's
example roots. An opened example can still Save to its live granted destination
without a picker. Save as renames the matching primary schematic/PCB,
project-bound `.kicad_dru` files, `symbols/<stem>.kicad_sym` files and
`footprints/<stem>.pretty/` directories, including supported native root library locations.
Root library tables update only the corresponding `${KIPRJMOD}` URI values;
logical symbol/footprint library IDs, package filenames, unrelated libraries and
other table text remain unchanged. These auxiliary files belong to native Source,
undo, recovery and history. Save protects all other open projects' source files
and rechecks native destinations after preparing assets. It replaces individual
native files atomically and attempts to restore written siblings on failure.
Update baseline/grant only after success. Cancellation/failure preserves work.
Valid Source may already have committed before a picker is cancelled; that edit
remains undoable. Invalid Source blocks the picker/write.

Portable `.lib`, footprint and STEP sidecars travel beside native files.
Simulation model filenames must match the current pinned component registry.
Native STEP references retain their KiCad paths. Save leaves unrelated files in
place. See [original project directories and portable assets](EXAMPLES.md#original-project-directories-and-portable-assets)
and [version history](VERSION-HISTORY.md) for example opening and snapshots.

Export applies valid Source and writes independent manufacturing and exchange
files without changing the save destination or baseline. It compiles the output
before opening the picker and publishes one atomic file replacement. The host
rejects linked destinations and protects open project sources. A missing file is
created with `O_NOFOLLOW|O_CREAT|O_EXCL` on POSIX after the parent is lstat'd
again and its realpath still equals the canonical parent. Windows has no
`O_NOFOLLOW`; a junction or other reparse point is rejected when `lstat` reports
a link or that realpath differs. Windows junction behavior is unverified.
Archives contain generated files only.

## Design exchange

- Schematic netlist exports the primary schematic as KiCad intermediate XML
  (`-netlist.xml`, up to 32 MiB).
  It includes component and library pin metadata and uses the same geometric
  connectivity as PCB synchronization. Unconnected pins remain in component
  definitions. Independent supplementary schematics remain separate. A
  schematic-only project can export a netlist. Ambiguous references or nets,
  alternate pin functions, jumper groups and pin maps fail before publication.
  [KiCad netlist documentation](https://docs.kicad.org/10.0/en/eeschema/eeschema.html#_intermediate_netlist_file)
- Board outline exports native `Edge.Cuts` centerlines, including footprint
  cutouts, as ASCII AutoCAD 2000 DXF in millimetres. It retains native X and
  negates native Y to align with Gerber and drill. Lines, circular arcs, circles
  and closed polylines retain their geometry. The outline must enclose a positive
  area and line and arc endpoints must meet exactly. Copper, drill hits and
  other layer artwork are outside the outline file.
  [AutoCAD DXF header reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm)
- OpenSCAD exports Model CAD solids from a project with a PCB. Its millimetre
  text uses native PCB X/Y with Z = 0 at the PCB mid-plane. It retains poses,
  Boolean cutouts and recipes, per-body color overrides or material colors, and
  opacity. Circles are faceted with `$fn = 96`. Fillets and chamfers reject the
  export before writing. Source edits `.scad` files as ordinary text.

## Manufacturing export

`lib/manufacturing-export.ts` compiles the current complete native PCB backing,
including retained assembly flags and setup. It does not run a solver, refill
zones, perform DRC, change geometry or acquire a project destination.

- Gerber X2 uses metric 6.6 coordinates for two/four copper layers, front/back
  mask, paste and silk, and Edge.Cuts. Lines, arcs, circular/oval/rectangular/
  rounded/chamfered pads and saved zone contours are plotted independently of
  view visibility. Arc direction follows the upward-Y output plane. Separate
  metric Excellon files contain plated and non-plated round through drills,
  including via drills and rotated pad drill offsets.
- Full Gerber requires a closed unambiguous board outline and saved fills for every enabled
  non-keepout zone. Keepouts and disabled fills contribute no plotted area.
  Native board-level via tenting and pad/footprint/board mask/paste margins apply.
- Reject unused-layer removal, nonzero minimum mask web, enabled via covering/
  plugging/capping/filling, margins on chamfered pads, elliptical pad apertures,
  dashed artwork, dimensions, font faces/knockout, formatted/unresolved text
  and characters outside the pinned U+0020–U+03FF stroke glyph subset on
  manufacturing layers. Unsupported output never silently omits geometry.
  Empty mask/paste apertures from negative margins are omitted.
- Excellon drill ZIP contains the same separate plated and non-plated drill
  files as full Gerber. It can be exported before completing the outline or
  filling copper zones. [KiCad drill documentation](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#_drill_files)
- Stencil Gerber ZIP contains front paste (`.gtp`), back paste (`.gbp`) and
  the board profile (`.gko`), byte-identical to those files in the full Gerber
  archive. It requires a closed outline and supported paste and profile geometry.
  Copper fills and mask settings are independent of this output.
- BOM groups identical value/package/explicit LCSC-number records; CSV fields
  retain quotes, commas and line breaks. DNP and board-only footprints are
  excluded; BOM and position exclusions remain independent. No supplier part
  is guessed. BOM validates nonblank LCSC numbers on its included rows.
- Placement CSV uses native footprint origins, native X and negated native Y
  in millimetres, Top/Bottom and counterclockwise degrees. Gerber/drill share
  that origin and orientation; back-side parts receive no extra reflection.
  Standalone BOM and placement each validate the references of their own
  included rows.
  Package-specific centroid offsets and supplier rotation corrections are not
  inferred. Review placement against the supplier preview before ordering.
- JLCPCB ZIP includes Gerber/drill plus matching-format BOM/placement CSV and
  coordinate/coverage notes. The included footprints share one unique
  reference set across both CSVs. Output serves as a manufacturing handoff.

The [Gerber specification](https://www.ucamco.com/en/guest/downloads/gerber-format),
[JLCPCB BOM](https://jlcpcb.com/help/article/bill-of-materials-for-pcb-assembly)
and [placement requirements](https://jlcpcb.com/help/article/pick-place-file-for-pcb-assembly)
define the external syntax/column meanings. `lib/export-zip.ts` emits deterministic
UTF-8, uncompressed ZIP entries with CRC-32, bounded to 128 leaf names and 96 MiB;
each Gerber layer is bounded to 32 MiB. No archive paths or imported ZIP contents
are accepted. Browser downloads compile the same output as the desktop adapter.

Newstroke glyph data is derived from the pinned KiCad 10.0.0 source under
`resources/third-party-source/newstroke-10.0.0/`; `scripts/build-manufacturing-font.mjs`
verifies the source SHA-256 before generating `lib/manufacturing-font.json`.
The CC0 font notice is available through Third-party licenses.

## Verification

Source test helpers read selected text through Copy and complete file sets
through the public file list; parse settings as JSON and designs as native
S-expressions. Helpers retain encoding/selection and edit existing files only.

| Check                                                                                                        | Scope                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tests/native-project-files.test.ts`, `tests/native-save.test.ts`, `tests/native-save-participation.test.ts` | File-set bounds, writes, exact backing and simulation flags                                                                       |
| `tests/manufacturing-export.test.ts`, `tests/native-export.test.ts`                                          | Gerber/drill/CSV/ZIP geometry and syntax, standalone archive parity, output bounds, format pickers and source protection          |
| `tests/pcb-dxf.test.ts`, `tests/schematic-netlist-export.test.ts`                                            | DXF outline entities and closure, XML metadata and connectivity                                                                   |
| `tests/example-native-libraries.test.ts`                                                                     | Home custom-library Source, project naming, Save as references and edited package preservation                                    |
| `tests/project-directory.test.ts`, `node scripts/check-project-directory-ui.mjs`                             | Grant-bound directory observations, read limits, stale/linked files, empty folders, read-only previews and native draft retention |
| `node scripts/check-native-source-ui.mjs`                                                                    | Isolated native file selection, per-file history, Apply/validation/undo                                                           |
| `node scripts/e2e-project.mjs`, `node scripts/e2e-workspace.mjs`                                             | Desktop native writes, recovery and independent projects                                                                          |
| `node scripts/e2e-schematic-files.mjs`, `node scripts/e2e-history.mjs`                                       | Desktop multiple files and complete native version restore                                                                        |

Desktop checks require explicit authorization and isolated profiles; see
[AGENTS.md](../AGENTS.md). Documentation changes need static checks only.
