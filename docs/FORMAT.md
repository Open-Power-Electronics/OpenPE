# KiCad native projects and Source

OpenPE opens and saves `.kicad_pro` settings, `.kicad_sch` schematics, an optional
`.kicad_pcb` board and supporting text files, targeting KiCad 10. Structured
snapshots are private IPC, recovery, fixture and history data; never publish them
as a design format or give them a KiCad extension. See the
[KiCad file documentation](https://dev-docs.kicad.org/en/file-formats/).

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
editable in Source. Native track locks map to optional `locked: true`; unlocked
tracks omit it. Private snapshots use their explicit canonical lock state;
serialization synchronizes it with retained native text.
Via locks and zone names remain metadata. The EMC generator uses the official
KiCad upgrader and exact custom-pad/keepout decomposition; pinned inputs remain
unchanged.

Native `.kicad_pro` text variables store bounded CAD as JSON strings:

| Variable / private extension                | Content                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENPE_MODEL_CAD` / `org.openpe.model-cad` | Version 1; up to 64 identified box/cylinder/extrusion/Boolean bodies with XYZ pose, dimensions, material, opacity and bounded geometry recipes |

Model CAD retains unchanged version-1 boxes/cylinders. Extrusions use local XY
rectangle/circle profiles or 3–128-point simple implicitly closed polygons;
polygon bounds are centred and match X/Y dimensions. Z is extrusion depth.
Optional chamfer/fillet stores 1–448 unique semantic base-edge IDs; profile rims,
vertical edges and hole rims are resolved against the unchanged base geometry.
Retired rim-group strings are rejected. Explicit selections do not infer Boolean
topology or persist mesh/kernel entity tags. Boolean
recipes contain two geometry-only operands with local pose and
union/difference/intersection; operand trees omit document identities/material,
with Boolean depth at most four below the root and at most 32 operations.
Boolean size is a conservative centred envelope, not construction geometry.
Body/face/edge/line selection and Boolean operand roles are presentation state;
only the committed two-solid recipe enters the native CAD variable. Independent
curve or surface Boolean results are outside this solid document format.

The EMC Flyback example uses four editable box bodies and eight local-Z holes
in `OPENPE_MODEL_CAD`, without an enclosure variable. Its original
MECH1/MECH2 model assignments retain native paths/transforms with `(hide yes)`;
all pinned model assets remain available.

Each shape permits 32 local-Z holes and the model permits 256 across all nested
operands, with 0.5 mm edge/cut clearance. Boolean bodies have no local holes;
subtract a cylinder instead. Cylinder/circle X/Y extents are equal diameters.
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
are editable through the project file editor. PDFs open in an inline viewer.
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

Source shows the actual `datasheets/parameters.json` and any local PDF under
the project directory. There is no synthetic reference group. Reviewed Agent
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

Export applies valid Source and writes a separate native schematic/board without
changing the save destination/baseline. Portable `.lib`, footprint and STEP
sidecars travel beside native files. New example assets use `circuits/<component>.lib`,
`models/*.step`, `footprints/<stem>.pretty/*.kicad_mod` and `symbols/*.kicad_sym`.
Simulation model filenames must match the current pinned component registry.
Native STEP references retain their documented KiCad paths;
Save does not reorganize unrelated user files. Available root CAD sources such
as `.scad` are ordinary editable text files, outside the native design set.
Home examples open the original `examples/<file>/<file>.kicad_pro` directly,
retaining all disk filenames. History remains private outside the project;
see [Version history](VERSION-HISTORY.md).

## Verification

Source test helpers read selected text through Copy and complete file sets
through the public file list; parse settings as JSON and designs as native
S-expressions. Helpers retain encoding/selection and edit existing files only.

| Check                                                                                                        | Scope                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tests/native-project-files.test.ts`, `tests/native-save.test.ts`, `tests/native-save-participation.test.ts` | File-set bounds, writes, exact backing and simulation flags                                                                       |
| `tests/example-native-libraries.test.ts`                                                                     | Home custom-library Source, project naming, Save as references and edited package preservation                                    |
| `tests/project-directory.test.ts`, `node scripts/check-project-directory-ui.mjs`                             | Grant-bound directory observations, read limits, stale/linked files, empty folders, read-only previews and native draft retention |
| `node scripts/check-native-source-ui.mjs`                                                                    | Isolated native file selection, per-file history, Apply/validation/undo                                                           |
| `node scripts/e2e-project.mjs`, `node scripts/e2e-workspace.mjs`                                             | Desktop native writes, recovery and independent projects                                                                          |
| `node scripts/e2e-schematic-files.mjs`, `node scripts/e2e-history.mjs`                                       | Desktop multiple files and complete native version restore                                                                        |

Desktop checks require explicit authorization and isolated profiles; see
[AGENTS.md](../AGENTS.md). Documentation changes need static checks only.
