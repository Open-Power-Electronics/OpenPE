# OpenPE examples

Add a native KiCad project directory under `examples/` or `examples/project/`,
then return to Home or focus the window. Discovery exposes `.kicad_pro` entries
first, then standalone schematics if there is no project file, then standalone
boards if there is no schematic. Each opens through the same native reader as
File Open, using its independent-sheet and primary-board rules.
The [home manifest](../resources/example-catalog/home-manifest.json) supplies
bundled display metadata and stable identities for the nine curated projects and
the default pinned EMC Flyback Recent entry. Desktop Recent keeps this shortcut
alongside actual opening/save history until it is unpinned, as defined in [Design](../DESIGN.md#home-projects-and-recovery).
Other discovered projects appear under Example regardless of their source root.

Discovery inspects directory entries without reading project contents or
creating grants or Git history. It skips links and private/generated
directories and permits up to 1,024 entries per directory, 128 immediate
project directories per root and 256 projects across both roots. A failed
root reports a warning alongside entries from the usable root. A total above
256 projects fails the listing. The host resolves opaque `local-<SHA-256>`
identities through discovery again on open and recovery.

## Catalog

| Home section   | File stem                 | Circuit             | Controller package |
| -------------- | ------------------------- | ------------------- | ------------------ |
| Recent default | `emc-flyback`             | EMC Flyback         | SOIC-8             |
| Example        | `lm2596-to220-5-buck`     | LM2596 Buck         | TO-220-5           |
| Example        | `tps61046-bga6-boost`     | TPS61046 Boost      | BGA-6              |
| Example        | `lm2735-msop8-sepic`      | LM2735 SEPIC        | MSOP-8             |
| Example        | `lm25017-wson8-flybuck`   | LM25017 Fly-Buck    | WSON-8             |
| Example        | `lm5001-soic8-boost`      | LM5001 Boost        | SOIC-8             |
| Example        | `lm27761-wson8-pump`      | LM27761 Charge Pump | WSON-8             |
| Example        | `lmr12010-sot236-buck`    | LMR12010 Buck       | SOT-23-6           |
| Example        | `lmr70503-bga8-buckboost` | LMR70503 Buck-Boost | BGA-8              |
| Example        | `lm2598-to220-7-buck`     | LM2598 Buck         | TO-220-7           |

See [Datasheets](DATASHEETS.md) for the reviewed controller records and optional
local PDFs. [EMC Flyback](EMC-FLYBACK.md) owns that example's native conversion,
testbench and enclosure verification.

## Reference circuit conversion

The [reference manifest](../resources/example-catalog/manifest.json) pins the
nine curated projects' source identities and SHA-256 hashes. The original
`input.kicad_sch` and `expert.kicad_pcb` files live under
`resources/example-catalog/sources/<stem>/`. Private regression snapshots live
in `tests/fixtures/reference/*.json`.

The reference projects ship their curated controller definitions in a local
`Reference` symbol library matching the embedded definitions. Conversion uses
official `PWR_FLAG` symbols to declare the input supply and return, including
the separate LM25017 secondary return. The nine reference schematics and EMC
Flyback align the flags with the virtual sources and loads within the width of
the circuit below. Each flag connects to its rail through a matching net label
at the flag pin. Conversion corrects controller pin types and
keeps the two LM2735 NC pin tips clear of the EN wire. Physical pin numbers,
simulation mappings, package placement, pads, nets, tracks, vias and zone
ownership are retained.
Of the 28 copper-zone outlines, the 20 touching the board edge are clipped to a
rectangle inset 0.5 mm from the board boundary, following the existing saved-copper
margins. Internal split-rail lines and the eight local-zone outlines stay fixed;
holes, wiring, package models and pinned source hashes remain unchanged. Eight
reference boards retain their exact source filled polygons. TPS61046's three
enabled zones use KiCad 10.0.1 during example generation with a 0.25 mm minimum
clearance. Generation transfers the native fill records by zone UUID and keeps
source pads, tracks, vias, nets, placement and the inset boundaries. KiCad removes
the disconnected VIN copper. The native board and regression snapshot retain the
same fills. KiCad writes no fill record for the empty VIN zone. OpenPE reports
that zone as missing saved copper and Layout Thermal requires a completed fill
before Run.

The build-only PCB adapter represents rectangles as exact polygons, splits
multi-layer zones per layer and preserves their filled polygons. Reference
curation clips only copper-zone outer boundaries to the board inset; the
independent KiCad check derives this expected boundary change and compares all
other copper geometry, zone holes and settings exactly. TPS61046's declared fill
and minimum-clearance changes are checked against an independent KiCad 10.0.1
refill by zone UUID, layer, contour coordinates and island flags.
`tests/reference-drc.test.ts` checks the saved copper with the zone clearance
source enabled. The adapter omits
printing settings and ancillary records such as sheet names, source paths, tags
and pin descriptions from private generated snapshots; the pinned originals retain them.
Package model references remain structured footprint data. Unsupported
electrical/geometry features fail conversion. The runtime native adapter validates a bounded PCB subset. Refill and check zones in KiCad before manufacturing.

## Editing and Agent access

Examples use ordinary [Core](CORE.md) validation, Source/revision gates
and undo. Human/Agent commands have the same model and geometry boundaries;
presentation, conversations and simulation results stay outside native designs.

## Original project directories and portable assets

The home manifest's `sourceRoots` maps the logical `examples` and `project`
roots to `examples/` and `examples/project/`. Each catalog entry selects a
logical `root` and `directory` independently of its native `file` stem.
The nine Example projects use `examples/<stem>/<stem>.kicad_pro` and EMC
Flyback uses `examples/project/emc-flyback/emc-flyback.kicad_pro`. Each has
matching KiCad 10 `.kicad_sch` and `.kicad_pcb` files. Both converters publish
through `scripts/example-native-files.ts` using the path rule in
`lib/home-examples.ts`.

The outer `examples` scan reserves its immediate `project` directory for the
dedicated root. Packaging copies the roots into sibling `examples-native/`
and `project-native/` directories and excludes the nested group from
`examples-native/`.
Their matching schematics, PCB, rules, libraries and supporting files retain
their actual filenames. Source displays that same directory, including empty
folders, editable ordinary text and existing PDFs. Packaging includes the
original directory contents while excluding private files, generated solver
results and `.kicad_prl`.

Opening and clean recovery read current disk bytes. Save writes to that
destination and Save as creates a separate personal project. The [opening
contract](VERSION-HISTORY.md#opening-barrier-and-concurrency) owns the
preparation barrier and private Git behavior.

The nine Example projects show simulation source/load components to the right of their connectors. EMC Flyback shows V1, R21, V2, R22 and I1 in a separate framed Simulation testbench area above the original circuit. All use named-rail connections with no Footprint assignment or PCB packages; source and load settings come from those native components.
Unassigned components render as Virtual; physical/virtual classification is
independent of model support and Include in SPICE simulation.

TI simulation models live in ignored `models/` sidecars. Their sources are pinned in
[reference-models-lock.json](../resources/reference-models-lock.json) and, for
LM2596, [lib/reference-models.ts](../lib/reference-models.ts). The prepared Home subset ships as
separate application resources under `simulation-examples/models`. EMC Flyback's
four project-local SPICE libraries are tracked source assets. Preparation verifies
their bytes against [the EMC model lock](../resources/emc-flyback-models-lock.json).
[Simulation](SIMULATION.md#portable-models-and-bundled-solver) defines model
references and resolution.

Keep the KiCad files, library tables and required `models/`,
`footprints/` and `symbols/` assets together when moving a project. Custom
libraries use `footprints/<stem>.pretty/` and `symbols/<stem>.kicad_sym`.
Project rules use `<stem>.kicad_dru`. Save as renames these project-bound paths
and updates library-table URIs while retaining `fp-lib-table`, `sym-lib-table`
and internal library IDs. [Libraries](LIBRARIES.md#step-access-and-previews)
owns pinned package/STEP delivery.

## Regeneration and resource preparation

Run commands from the repository root. Regenerate design files offline from the
checked-in pinned originals and footprint assets:

```sh
npm run examples
npm run build:format
```

This regenerates the nine curated native project sets and EMC Flyback, their
private regression snapshots, `lib/reference-simulation.json`, the shared
conversion audit and notices, followed by the service formats. Set `KICAD_CLI`
to KiCad 10.0.1 for the TPS61046 refill and EMC conversion. Use KiCad 10 and
`npm run examples:emc-flyback` to regenerate only EMC Flyback. Change the
generator or source definitions to change the output.

Prepare solver resources and original simulation sidecars separately; these
commands may download pinned resources:

```sh
npm run simulation:prepare
npm run simulation:download-examples
```

`npm run examples:prepare` generates the two OpenPE analytical STEP bodies
for EMC Flyback L2 and T1, downloads the WE-CMB manufacturer model and shared
simulation libraries, generates service formats, prepares simulation and
portable model sidecars, and verifies the original native file sets, pinned
footprint/STEP assets and notices.
`scripts/prepare-emc-analytical-models.ts` reads the `analyticalModels` entries
in [the EMC manifest](../resources/example-catalog/footprints/emc-flyback/manifest.json).
L2 (`L_8040_Shielded.step`) is an 8.0 × 8.0 × 4.0 mm shielded body with two
terminals on the existing pads. T1 (`T_EFD25_SMD.step`) is the Würth 750311591
datasheet envelope, revision IKK 007.001 (32.31 × 27.03 × 13.69 mm), with twelve
terminals on the existing pads. Both use the bundled Gmsh/OpenCASCADE analytical
STEP path. A missing file is generated and must match the pinned SHA-256 and
size. An existing different file is preserved and preparation fails. No
third-party license applies to these two files. The published placement is Z-up,
with model +Y opposite footprint +Y.
`scripts/download-manufacturer-models.mjs` fetches only Würth WE-CMB, the
pinned rigid alignment of the official KiCad-library source produced by
`scripts/prepare-emc-cmb-model.mjs`. That download allows only the recorded
`approvedHosts`, rejects any other redirect, and must match the pinned SHA-256
and size. An existing different file is preserved and preparation fails.
[MODEL-SOURCES](../resources/example-catalog/footprints/emc-flyback/MODEL-SOURCES.md)
records the substitution and the WE-CMB terms. The Würth KiCad-library terms
allow sharing the marked WE-CMB derivative with attribution. End users do not
download manufacturer models.
Project copies, including `examples/project/emc-flyback/models/D_SMA.step`, are
written from those pinned bytes and are not downloaded again.
`scripts/download-example-models.ts` writes shared Home libraries such as
`resources/example-catalog/simulation/models/lm2596-5-<sha256>.lib` from the
official TI and KiCad URLs already pinned for those models. Both build and
development startup run this step before the renderer starts. Runtime opening
reads those original files without generating, downloading or copying Home
content. Missing or corrupt resources require preparation or installation
repair. Packaging copies the original native projects and existing PDFs into
their respective resource directories described under [Original project directories and portable assets](#original-project-directories-and-portable-assets).
Private destination-bound Git history is initialized on example opening.

Model preparation also updates canonical model references. Vendor model bytes
stay outside Git. Use `npm run simulation:download-examples` to prepare the Home sidecars for
the complete sweep.

## Verification and simulation scope

`npm test -- tests/native-example-portability.test.ts` reads all ten actual native
projects through the ordinary file reader, copies them to a new directory and
filename, and reopens them without Home identity or snapshot factories. It checks
native byte preservation, project-local SPICE model bytes, renderer/service deck
agreement, Source apply/undo, Model CAD retention and thermal geometry with an
explicit 1 W test input. The nine reference controllers also retain their reviewed
model bindings after reference changes or copying the symbol into a project-local
library; altered model identities and electrical pins remain rejected. These
checks do not run solvers or establish support for arbitrary upstream files.
Custom-library preservation and renaming in `tests/example-native-libraries.test.ts`
also use the actual native projects, independently of generated regression snapshots.

The EMC electrical and thermal real-solver checks read
`examples/project/emc-flyback/emc-flyback.kicad_pro` through the ordinary native reader.
Electrical execution reads its colocated model files. Neither check substitutes
the generated regression snapshot or a model download for those inputs.

Use the focused checks below with the
[engineering verification requirements](../AGENTS.md#verification-and-delivery).

| Command                                                            | Scope                                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/check-reference-ui.mjs`                              | All nine reference schematic/Layout views in an isolated headless renderer with mocked services                                                                                   |
| `npm run examples:check-models -- --render`                        | Offline parsing of 46 reference and 31 EMC STEP files and rendering of all ten Home Model views. All 83 EMC component model instances must load, with five mounting-hole notices. |
| `python scripts/check-reference-kicad.py --cli /path/to/kicad-cli` | Actual KiCad 10 connectivity, native geometry and SVG checks; run under KiCad's Python with `pcbnew`                                                                              |
| `npm run simulation:check-examples -- reference`                   | Offline real bundled-ngspice sweep of actual canonical Home files, canonical/renderer/service deck parity, completion and output checks                                           |

[SPICE verification](SIMULATION.md#verification-commands) covers offline sweep
preparation and failure handling. The pinned
[verification.json](../resources/example-catalog/verification.json) records
structural and connectivity checks for the generated files under KiCad 10.0.1.

Example generation requires a complete OpenPE ERC report with zero issues
for the nine schematics under `examples/` and EMC Flyback under `examples/project/`. The native portability test
repeats the check through Core after a native Save as round trip. To check the
same designs with KiCad 10, run `kicad-cli sch erc --exit-code-violations` on
each `.kicad_sch` in its original project directory with the standard KiCad
symbol libraries configured.

[Simulation](SIMULATION.md#home-profiles-and-verification-scope) owns
profile timing, acceptance criteria, controller derivatives and electrical
assumptions. Recorded runs apply to their matching inputs, models and solver.
Use the explicit [ERC/DRC reports](DESIGN-RULES.md) for supported rules.

## Provenance and fixture boundary

The reference circuits retain source author `fleaxiao`, commit
`3e94f7eb08821dcaf3309ac433f530cb56418030`, original file paths and SHA-256 hashes.
The pinned checkout has no top-level dataset license; no additional
license is asserted for these designs. Embedded KiCad data retains its upstream
terms. See [the reference-circuit notice](../public/licenses/reference/NOTICE.txt),
[footprints/LICENSE.md](../resources/example-catalog/footprints/LICENSE.md) and About OpenPE > Third-party
licenses. Preserve original model notices and all pinned source bytes/hashes.

The native projects under `examples/` and its `project/` group are the sole
maintained example collection. Tests use derived snapshots of these same Home
projects and small programmatic fixtures; they do not maintain additional
circuit catalogs. Recovery accepts only current catalog identities; retired
example records are unsupported. Personal projects and their private histories
are preserved.
