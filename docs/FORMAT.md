# KiCad native projects and Source

OpenPE opens and saves `.kicad_pro` settings, `.kicad_sch` schematics, an optional
`.kicad_pcb` board and supporting text files, targeting KiCad 10. Structured
snapshots are private IPC, recovery, fixture and history data; never publish them
as a design format or give them a KiCad extension. See the
[KiCad file documentation](https://dev-docs.kicad.org/en/file-formats/).

Component simulation data retains optional `initialVoltage` and `initialCurrent` strings in the canonical component record, represented natively by `OpenPE.InitialVoltage` and `OpenPE.InitialCurrent`. Unset values remain absent; inspection does not write defaults.

Model selection retains optional canonical `simulation.modelSource` (`basic` or `external`) as native `OpenPE.ModelSource`, independently of the saved external Sim.Library/Sim.Name/Sim.Pins. An absent override follows the current native library binding. Selecting an intrinsic model preserves external settings, and undo/save/recovery retain both. Declaration catalogs and model bodies are not native fields.

Voltage-source and EMC IPULSE current-source waveform selection stores optional canonical simulation.sourceType (DC, PULSE or SIN) as native OpenPE.SourceType. It applies to the active intrinsic source independently of inactive external Device/Type/Pins and uses the existing Sim.Params/Value storage; native symbol IDs, geometry and connectivity stay unchanged.

## Document ownership

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

Source lists regular project folders and files, including empty folders,
`footprints/`, `symbols/`, `circuits/`, `models/`, native `3D/`, `spice/` and
`thermal/`. Native files keep validated editing; fully loaded ordinary text files
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
draft; project Save writes pending text files before saving native content.
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

Generated project `spice/` and `thermal/` directories are excluded from native discovery and file-set validation. Current artifacts are direct `<native-stem>.*` files in those directories, with a project-bound v2 manifest; no project/run/mesh subdirectories are written. Source can edit fully loaded artifact text as ordinary files; solver artifacts/results never enter editable design, native drafts, undo or recovery. Private sibling staging/rollback folders end in `-backups` and remain outside native discovery. Only current v2 manifests and direct result files are read; retired nested records are ignored. Publication contracts are in [Simulation](SIMULATION.md#execution-streaming-and-completed-results) and [Thermal](THERMAL.md#completed-desktop-records).

## Native access and writes

Electron pickers grant bounded file sets through opaque IDs. The renderer cannot
choose arbitrary paths, commands, executables or URLs. Validation rejects
traversal, links, nonregular/oversized files, case-insensitive duplicate names,
file/directory overlap and invalid entry membership. The aggregate file-set
limit is 96 MB. Cached local validation applies only to exact internally owned
immutable records; every file set still receives global checks.

Private PCB snapshot encoding reuses JSON-escaped chunks only from exact owned
merged native syntax, with at most three indentation variants per node. A final
owned file packet lends its encoder once, then releases it; public files remain
ordinary independent string containers. Clean imports retain their original
bytes. These derivations never replace project, native-file or size validation.

Save validates the complete project and prepares verified model/footprint
assets. Its private snapshot carries the current native texts; the host exports
that same backing, retaining explicit simulation flags and native order.
Equivalent supported hidden-field defaults do not rewrite custom positions,
styles, unknown attributes or duplicate records.

Save as chooses `.kicad_pro` and renames matching primary schematic/PCB,
project-bound `.kicad_dru` files, `symbols/<stem>.kicad_sym` files and
`footprints/<stem>.pretty/` directories, including supported native root library locations.
Root library tables update only the corresponding `${KIPRJMOD}` URI values;
logical symbol/footprint library IDs, package filenames, unrelated libraries and
other table text remain unchanged. These auxiliary files belong to native Source,
undo, recovery and history. Preflight every target and protect all other open
projects' source files. Replace files atomically and attempt to restore written
siblings on failure; this is not a filesystem-wide crash-atomic transaction.
Update baseline/grant only after success. Cancellation/failure preserves work.
Valid Source may already have committed before a picker is cancelled; that edit
remains undoable. Invalid Source blocks the picker/write.

Export applies valid Source and writes independent manufacturing/exchange files without
changing the save destination/baseline. Native KiCad project files use Save/Save as.
The requested output is compiled before the picker and published as one atomic
file replacement; archives contain generated files only and are never extracted
into the project. Open project sources and linked destinations are protected.
Gerbers (including drill files) and JLCPCB are ZIP archives; BOM and
CPL are separate CSV outputs. See [manufacturing export](#manufacturing-export).
When the project has a PCB and Model CAD solids, Export also offers an OpenSCAD model. Its millimetre text uses native PCB
X/Y with Z = 0 at the PCB mid-plane. It keeps solids, poses, Boolean cutouts and
recipes, per-body color overrides or material colors, and opacity; circles are faceted with `$fn = 96`.
Fillets and chamfers have no OpenSCAD equivalent, so they reject the export without
writing. Source can edit SCAD as ordinary text; OpenPE does not import it as Model CAD or execute it. Portable `.lib`, footprint and STEP
sidecars travel beside native files. New example assets use `circuits/<component>.lib`,
`models/*.step`, `footprints/<stem>.pretty/*.kicad_mod` and `symbols/*.kicad_sym`.
Simulation model filenames must match the current pinned component registry.
Native STEP references retain their documented KiCad paths;
Save does not reorganize unrelated user files; root `.scad` files are ordinary
editable text outside the native design set.
Home opens original native projects under `examples/` and `recent/` directly,
including host-discovered additions, retaining all disk filenames. History remains
private outside the project; see [Version history](VERSION-HISTORY.md).

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
- Require a closed unambiguous board outline and saved fills for every enabled
  non-keepout zone. Keepouts and disabled fills contribute no plotted area.
  Native board-level via tenting and pad/footprint/board mask/paste margins apply.
- Reject unused-layer removal, nonzero minimum mask web, enabled via covering/
  plugging/capping/filling, margins on chamfered pads, elliptical pad apertures,
  dashed artwork, dimensions, font faces/knockout, formatted/unresolved text
  and characters outside the pinned U+0020–U+03FF stroke glyph subset on
  manufacturing layers. Unsupported output never silently omits geometry.
  Empty mask/paste apertures from negative margins are omitted.
- BOM groups identical value/package/explicit LCSC-number records; CSV fields
  retain quotes, commas and line breaks. DNP and board-only footprints are
  excluded; BOM and position exclusions remain independent. No supplier part
  is guessed. Invalid nonblank LCSC numbers fail explicitly.
- Placement CSV uses native footprint origins, native X and negated native Y
  in millimetres, Top/Bottom and counterclockwise degrees. Gerber/drill share
  that origin and orientation; back-side parts receive no extra reflection.
  Package-specific centroid offsets and supplier rotation corrections are not
  inferred. Review placement against the supplier preview before ordering.
- JLCPCB ZIP includes Gerber/drill plus matching-format BOM/placement CSV and
  coordinate/coverage notes. This is a manufacturing handoff, not an editable
  Altium/EasyEDA project or manufacturing qualification.

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
| `tests/manufacturing-export.test.ts`, `tests/native-export.test.ts`                                          | Gerber/drill/CSV/ZIP geometry and syntax, output bounds, format pickers, source protection and cancellation                       |
| `tests/example-native-libraries.test.ts`                                                                     | Home custom-library Source, project naming, Save as references and edited package preservation                                    |
| `tests/project-directory.test.ts`, `node scripts/check-project-directory-ui.mjs`                             | Grant-bound directory observations, read limits, stale/linked files, empty folders, read-only previews and native draft retention |
| `node scripts/check-native-source-ui.mjs`                                                                    | Isolated native file selection, per-file history, Apply/validation/undo                                                           |
| `node scripts/e2e-project.mjs`, `node scripts/e2e-workspace.mjs`                                             | Desktop native writes, recovery and independent projects                                                                          |
| `node scripts/e2e-schematic-files.mjs`, `node scripts/e2e-history.mjs`                                       | Desktop multiple files and complete native version restore                                                                        |

Desktop checks require explicit authorization and isolated profiles; see
[AGENTS.md](../AGENTS.md). Documentation changes need static checks only.
