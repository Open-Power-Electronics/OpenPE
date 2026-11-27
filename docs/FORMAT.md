# Native KiCad 10 projects and Source

KiCad 10's native file formats are OpenPE's design storage. A project uses JSON
settings (`.kicad_pro`), S-expression schematics (`.kicad_sch`), an optional
S-expression PCB (`.kicad_pcb`) and supporting files. Source edits those files
directly. Structured snapshots serve private IPC, recovery, fixtures and history.
[KiCad file format reference](https://dev-docs.kicad.org/en/file-formats/)

Desktop **Open project** accepts a `.kicad_pro` or `.kicad_pcb` file. The host
resolves a matching project when present and loads its bounded schematic, PCB and
supporting native file set automatically. A PCB without a matching project opens
without a save destination. Its first Save asks for a `.kicad_pro` destination.

PCB admission accepts the stable KiCad 10 board stamp (`20260206`) or another
date stamp with unambiguous KiCad 10 release metadata from `pcbnew`. Both paths
validate the same geometry and nets. The writer uses KiCad 10's stable board
stamp when compiling board edits. Schematic and supporting files have separate
format checks. [KiCad 10 board format version](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h)

Opening a supported board starts clean and retains its original bytes in Source.
Board edits use the native merge. Save and Save as preserve unchanged PCB bytes.
The native reader and writer run without an installed KiCad application.

Board and footprint groups and board text properties remain native metadata.
PCB captions resolve direct board property references for display while retaining
their native expressions. OpenPE edits individual board items. If a member is
listed in several declarations, its last declared group determines locks and
ownership. Save retains the original living declarations. Deletion removes
their group memberships and removes groups that lose their last owned member.
When a PCB edit splits a multi-layer zone, its group receives the per-layer
instances. Group locks apply to members and protect their owning footprint.
Native Source owns group locks.
Groups with missing or unsupported members reject before admission.
Compact `0-0-0-0-…` PCB UUIDs receive deterministic editor identities, including
their group and route-generator member references. Separately named board zones
with a reused UUID receive independent identities when no member reference is
ambiguous. Copied footprint caption IDs receive the same treatment across
distinct footprint scopes. Zone UUIDs reused across board and footprint scopes
receive distinct editor identities when their kind and ownership are unambiguous.
Clean Save retains the original native IDs and spelling.

Boards retain ordered two- to 32-layer even copper stacks and technical
`User.1` through `User.45` artwork, including native layer names and types.
Native board and footprint reference points display on their recorded layer
and carry no copper. Embedded worksheet, font, model and other file records
retain their native bytes.
Layout does not extract those payloads from the board.

Native compound custom pads retain their anchor, clearance mode and geometric
primitives, including line, arc, circle, rectangle and polygon strokes and fills.
A custom pad with an empty `primitives` record retains its anchor as the pad shape.
Embedded footprint format and generator fields retain their native spelling.
Pad layer membership retains `*.SilkS` for both front and back silkscreen.
Native edge-connector pad type, anonymous footprint identity and absent board-only
captions survive edits and Save. A missing board thickness uses KiCad's 1.6 mm default.
Native SMD offset records shift the land without creating a hole. Round drills
retain a second native dimension when supplied and use the first for the diameter.
Rounded rectangular pads use KiCad's 0.25 corner ratio when the ratio is omitted.
Save preserves the omission while the native default still applies.

PCB text boxes retain their boundary, margins, border, text and font data.
Stored PCB text line spacing scales the baseline advance, including zero spacing.
Explicitly hidden standard footprint captions can use KiCad's default stroke
font without an effects record. Native merge preserves that omission.
Named PCB fonts retain the original face and text. Outline-font caches preserve
their native polygons and coordinate tokens. Each text accepts up to 4,096
polygons with up to 4,096 vertices each and the board allows 200,000 cached
vertices in total. Cache and pose changes use native Source.

Board-level reference images retain their embedded PNG and native placement,
scale, layer, UUID and lock through Source and Save. The reader accepts up to 16
images, each with up to 1,000,000 base64 characters and 4,096 pixels per side.
The board may contain up to 16 million image pixels in total. [Layout](LAYOUT.md)
owns their canvas visibility.

Board-level tables retain their native cells, borders and separators. The
reader accepts up to 32 rectangular-grid tables with up to 256 unmerged cells
each. Supported cells keep their native positions, orientation and text.

Board and placed footprint Bézier artwork (`gr_curve` and `fp_curve`) retains
its two endpoints and two control points in native order, along with its stroke,
layer and identity. [Layout](LAYOUT.md#imported-routing) owns the operation bounds.

QR and Data Matrix records support printable ASCII payloads on the outer
copper, silkscreen and Edge.Cuts layers. Layout shows the encoded payload and
its native size, rotation, layer and knockout. The preview encoder can choose a
different symbol matrix for the same payload. KiCad owns exact barcode
fabrication. Edit native images, tables and barcodes through Source.

Native routed arcs retain their start, midpoint, end, width, copper layer, net,
UUID and lock. Blind, buried and microvia records preserve their layer span.
Via backdrill and tertiary drill records preserve their separate diameters,
entry sides and must-cut copper layers.
Straight and curved tracks retain same-side mask membership and explicit
mask margins, including tracks without a net.
Per-via tenting records retain independent front and back settings. Native
pad/via teardrop options and generated teardrop zones
retain their settings, kind and saved copper. Native length-tuning patterns
retain their bounded parameters and routed member IDs. [Layout](LAYOUT.md#imported-routing)
owns editing, checking and export coverage for these records.
Plated padstacks retain front/inner/back shapes and custom copper-layer shapes
with offsets from the shared drill. Layout uses the recorded shape on each
layer. Circular pads use their native X diameter and retain the stored second
axis in the source. Pad and via layer pruning, end-only via rings and
post-machining retain their native settings. Operations that need unsupported
connectivity or machining require native KiCad.

Board assembly variants and footprint overrides remain native metadata.
Layout displays the base board, and variant-specific assembly export uses
KiCad.

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

Supported notes include horizontal plain/bold/italic text with bounded stroke
thickness and inert HTTP(S) links, and finite unfilled polylines, rectangles
and horizontal text boxes. Outlines and text boxes are read-only on canvas
and editable in Source. Quoted native strings can contain
literal tabs, including in embedded-library descriptions.
Notes can also display up to 16 embedded PNG images per sheet, with dimensions up
to 4,096 pixels on either axis, at most 16 million pixels in total and up to 1 MB
of base64 text per image. Source
retains the native image data and placement. The canvas uses the recorded scale
and image density and edits the image only through Source.
Native footprint, pad, track, via, graphic and zone locks map
to optional `locked: true`; unlocked objects omit it. Serialization synchronizes
the canonical lock state with retained native text. Properties and `layout.lock`
share lock/unlock transactions; locked objects reject ordinary property/geometry
edits and removal. Source remains explicit native editing. See
[object locking](LAYOUT.md#object-locking) for ownership and selection rules.
Pad pin-function/type metadata, native test-point and castellation properties,
non-rendered footprint properties, placement state and unit records survive
edits. Pad and footprint copper clearances and zone-connection modes,
pad thermal gap and spoke width, and zone island area thresholds retain their
native fields. A pad's explicit zero copper clearance stays distinct from an
unset override. Footprint
mask/paste margins are retained; pad mask overrides take precedence over the
footprint default. Up to 256 native `point` records per footprint are retained
with their native identifiers and sizes. They follow footprint movement,
rotation and side changes. Source edits their native values. Manufacturing
output excludes these reference markers.
An unlinked footprint retains an explicitly blank native Reference or Value.
Multi-layer zones have one instance per layer. The first retains the native
UUID when supplied. Instances without a native UUID receive deterministic
editor identities. Clean files retain their exact bytes. A PCB edit writes
per-layer fills and rules with the areas that own them.
Footprint rule areas retain dormant inner-layer membership. Physical views and
checks apply those areas only on active layers in the board stack.
Enabled placement areas retain their sheet, component class or group source.
Layout shows the area and its source on each layer. Edited files keep one
native channel record with its original layer set, UUID and group membership.
Per-layer changes must agree on shared placement geometry and settings.
Use Source for layer membership, differing per-layer changes and placement
assignments. KiCad performs multichannel repeat. [KiCad placement areas](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#_multichannel_design_procedure_board)
Native hatch settings, per-layer hatch position and corner smoothing retain
their parameters and saved native contours. A smoothing style can omit its
radius. An explicit unstroked contour declaration is preserved. Native empty
zones retain their metadata and have no drawable or electrical area. Single
contour native rule areas can have circular outlines or arc edges. Layout
draws their exact arcs. Checked copper operations on boards with curved rule
areas require native Source. Imported boards support up to 400,000 saved fill
vertices. Layout displays large fills directly from the stored contours.
Copper recomputation and analysis retain their separate work
bounds. Solder-mask zones display their saved apertures on the mask layers.
Filled `Edge.Cuts` zones display their saved polygons as technical artwork.
Board outlines and electrical analysis use their own geometry. Edit this
artwork in Source and plot it in KiCad.
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
limit is 96 MB. A native PCB file supports up to 20 MB of UTF-8 text and three
million syntax nodes or atoms. Other native files are limited to 8 MB each.
Cached local validation applies only to exact internally owned
immutable records; every file set still receives global checks.

Private PCB snapshot encoding reuses JSON-escaped chunks only from exact owned
merged native syntax, with at most three indentation variants per node. A final
owned file packet lends its encoder once, then releases it; public files remain
ordinary independent string containers. Clean imports retain their original
bytes. These derivations never replace project, native-file or size validation.

Save validates the complete project and preflights the native destinations before
preparing verified model and footprint assets. Its private snapshot carries the
native texts prepared for the selected destination. The host writes that backing,
retaining explicit simulation flags and native order.
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
  negates native Y to align with Gerber and drill. Lines, circular arcs, circles,
  closed polylines and cubic `SPLINE` entities retain their geometry. Cubic
  splines retain the four native Bézier control points. Curved polygons and
  rounded rectangles use closed polylines with circular segments. The outline
  must enclose a positive area, with exact joins between endpoints. Copper,
  drill hits and other layer artwork are outside the outline file.
  [AutoCAD DXF header reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-A85E8E67-27CD-4C59-BE61-4DC9FADBE74A.htm)
  [AutoCAD DXF polyline reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm)
  [AutoCAD DXF spline reference](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-E1F884F8-AA90-4864-A215-3182D47A9C74.htm)
- OpenSCAD exports Model CAD solids from a project with a PCB. Its millimetre
  text uses native PCB X/Y with Z = 0 at the PCB mid-plane. It retains poses,
  Boolean cutouts and recipes, per-body color overrides or material colors, and
  opacity. Circles are faceted with `$fn = 96`. Fillets and chamfers reject the
  export before writing. Source edits `.scad` files as ordinary text.

## Manufacturing export

`lib/manufacturing-export.ts` compiles the current complete native PCB backing,
including retained assembly flags and setup. It does not run a solver, refill
zones, perform DRC, change geometry or acquire a project destination.

- Gerber X2 uses metric 6.6 coordinates for the ordered copper stack, front/back
  mask, paste and silk, and Edge.Cuts. Lines, arcs, circular/oval/rectangular/
  rounded/chamfered pads, custom polygon pads and saved zone contours are plotted independently of
  view visibility. Circular segments in native polygons and rounded rectangles
  use circular interpolation. Arc direction follows the upward-Y output plane.
  Native cubic Bézier strokes use line segments with a 0.0005 mm chord error
  bound before Gerber coordinate rounding. Separate
  metric Excellon files contain plated and non-plated round through drills and
  straight slots. Slots use a G85 command between the two tool centreline
  endpoints with the slot width as the tool diameter. The coordinates retain
  native drill anchors and pad rotation, including offset drills. KiCad native
  pad anchors locate the hole, and the native drill offset locates the copper
  land relative to that anchor. Native slots use `(drill oval x y)`.
  OpenPE retains mechanical numbers on non-plated slots through Save and
  reopen. KiCad 10 clears those numbers when it reads a pad.
  [KiCad pad numbering](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pad.cpp#L288-L299)
  [KiCad pad parser](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp#L6110-L6115)
- Blind and buried holes and microvias have separate plated Excellon programs
  per layer span, numbered from front copper as L1. Via copper uses its
  declared span, saved per-layer diameters and end-only setting.
  Backdrill and tertiary cuts use separate after-plating Excellon programs with
  native cutter diameters. The file name and header identify each entry and
  inclusive must-cut layer. Copper flashes retain the original lands.
  The fabricator determines machine depths and tolerances from the actual
  stackup. [KiCad Excellon layer attributes](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/exporters/gendrill_writer_base.cpp#L576-L641)
- Full Gerber requires a closed unambiguous board outline with exact endpoint joins and saved fills for
  enabled non-keepout zones on plotted layers. Keepouts and disabled fills
  contribute no plotted area. Saved fills on each layer are combined at the
  Gerber coordinate resolution. Clear regions preserve holes before pads and
  routed copper are plotted. Saved fills on `Edge.Cuts` appear in the separate
  `-edge-cuts-fill.gbr` technical drawing (`OtherDrawing,EdgeCutsFill`). The
  `.gko` profile contains the routed board and footprint outlines.
  Per-via tenting overrides the native board default for the selected side.
  Supported native plated padstacks use their individual layer lands and offsets.
  Mask and paste apertures derive from their matching outer lands. Drill
  programs keep the shared native drill anchors.
  Native compound pads plot their independent anchor and simple primitives as
  dark artwork, including strokes and ring openings. Their plotted mask and
  paste apertures require zero effective margin and supported aperture rules.
  [KiCad 10 custom-pad geometry](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pad.cpp#L3062-L3100)
  Untented via openings use the board mask margin. Paired copper/mask
  tracks, arcs and board or footprint shapes plot on their matching side using
  the local `solder_mask_margin` or the board `pad_to_mask_clearance`.
  Track openings with zero resulting width are omitted. Contracted filled
  circles and rectangles retain their native plot geometry. Straight polygon
  contraction uses rounded offsets with a 0.0005 mm arc tolerance and a
  0.0001 mm clipping grid. Paired artwork with custom mask-expansion rules is
  outside this export subset. Pad, footprint and board mask/paste margins apply.
  [KiCad native shape plotting](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/plot_brditems_plotter.cpp#L844-L1055)
  [KiCad native track and via mask margins](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pcb_track.cpp#L1398-L1433)
  Mask- and paste-only apertures plot their native pad geometry without expansion.
  Pad artwork joins its declared silkscreen layers. Solder-mask subtraction
  from native pad artwork uses KiCad plotting.
  Footprint-owned routed cutouts appear in the Edge.Cuts profile. The
  Excellon files carry pad and via drill operations.
  Straight-chamfered pads support uniform mask and paste margins. Positive
  margins use round polygon offsets with a 0.0005 mm arc tolerance and
  0.0001 mm clipping grid. Negative margins resize the pad dimensions and
  retain the chamfer ratio.
  Simple custom pads use outline clearance and the single outline defined in [Layout](LAYOUT.md).
  Gerber uses the whole outline for
  copper and applies uniform mask or paste expansion or contraction using the
  same tolerance and grid. A relative paste margin uses the native anchor size.
- Reject unused-layer removal, nonzero minimum mask web, enabled via covering/
  plugging/capping/filling, asymmetric margins on chamfered or custom pads, margins on
  pads with both rounded and chamfered corners, elliptical pad apertures,
  dashed artwork, dimensions, font faces/knockout, formatted/unresolved text
  and characters outside the pinned U+0020–U+03FF stroke glyph subset on
  manufacturing layers. Unsupported output never silently omits geometry.
  Empty mask/paste apertures from negative margins are omitted.
- Excellon drill ZIP contains the same separate drill programs as full
  Gerber. It can be exported before completing the outline or
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
UTF-8, uncompressed ZIP entries with CRC-32, bounded to 128 leaf names and 96 MiB.
Each Gerber layer caps saved fill processing at 250,000 input vertices and
output at 32 MiB. No archive paths or imported ZIP contents
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
| `tests/kicad-pcb-version.test.ts`, `tests/kicad-pcb-metadata.test.ts`                                        | KiCad 10 admission, group membership and locks across edits                                                                       |
| `tests/kicad-pcb-native-pads.test.ts`, `tests/kicad-pcb-native-text.test.ts`                                 | Native custom pad primitives, absent captions, outline-font caches and edit barriers                                              |
| `tests/kicad-pcb-arc.test.ts`, `tests/kicad-pcb-teardrops.test.ts`                                           | Native copper round trips, tuning-pattern membership, analytical Gerber arcs and edit barriers                                    |
| `tests/manufacturing-export.test.ts`, `tests/native-export.test.ts`                                          | Gerber/drill/CSV/ZIP geometry and syntax, standalone archive parity, output bounds, format pickers and source protection          |
| `tests/pcb-dxf.test.ts`, `tests/schematic-netlist-export.test.ts`                                            | DXF outline entities and closure, XML metadata and connectivity                                                                   |
| `tests/example-native-libraries.test.ts`                                                                     | Home custom-library Source, project naming, Save as references and edited package preservation                                    |
| `tests/project-directory.test.ts`, `node scripts/check-project-directory-ui.mjs`                             | Grant-bound directory observations, read limits, stale/linked files, empty folders, read-only previews and native draft retention |
| `node scripts/check-native-source-ui.mjs`                                                                    | Isolated native file selection, per-file history, Apply/validation/undo                                                           |
| `node scripts/e2e-project.mjs`, `node scripts/e2e-workspace.mjs`                                             | Desktop native writes, recovery and independent projects                                                                          |
| `node scripts/e2e-schematic-files.mjs`, `node scripts/e2e-history.mjs`                                       | Desktop multiple files and single-file version restore                                                                            |

Desktop checks require explicit authorization and isolated profiles; see
[AGENTS.md](../AGENTS.md). Documentation changes need static checks only.
