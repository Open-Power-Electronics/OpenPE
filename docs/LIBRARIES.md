# KiCad libraries and model delivery

OpenPE uses bundled official KiCad libraries, not an installed KiCad resource
search or runtime CLI conversion. Catalog availability does not imply support
for every feature or simulation model. [FORMAT.md](FORMAT.md) defines native
data, [LAYOUT.md](LAYOUT.md) defines synchronization/Model editing, and
[API.md](API.md#library-capabilities) defines capability schemas.

## Resources and preparation

`resources/kicad.lock.json` pins KiCad 10.0.0 symbol/footprint commits and the
optional model archive. `npm run libraries:download` prepares
`resources/kicad/10.0.0/`, starter symbols/search indexes and parser source
archives. Symbols may be packed `.kicad_sym` or `.kicad_symdir` directories.
Downloads/caches stay outside Git; locks, generators and notices remain tracked.
`npm run package` prepares/includes versioned resources without `.git` metadata.

Default preparation includes these STEP models:

- `Resistor_SMD:R_0805_2012Metric`
- `Capacitor_SMD:C_0805_2012Metric`
- `Package_TO_SOT_SMD:SOT-23`

`npm run libraries:download-models` optionally installs the hash-pinned complete
collection: 7,236 STEP files, no VRML. Originals/notices live in
`resources/kicad/10.0.0/models/`; the archive stays under
`resources/third-party-source/`. Differing existing files are preserved as
conflicts. Packaging includes the collection when present.
`node scripts/download-kicad-models.mjs --verify` checks existing resources
offline; the complete collection is separate from default preparation.

## Symbols and embedded designs

`scripts/build-starter-symbols.mjs` generates
`lib/kicad-starter-symbols.json` from official geometry. Empty sheets embed
symbols when placed; loaded designs retain embedded variants, fields and pin
mappings. The worker resolves inheritance and validates supported geometry
before placement. Multi-unit instances have distinct UUIDs with shared
reference/value/fields; import/round trips check references and units.

New `Connector`/`Connector_*` symbols default to simulation-excluded; other
placements honour upstream defaults. The chooser only places components.
The SPICE settings Components list or `part.participation` edits
`simulation.excluded`, exported as `exclude_from_sim`, independently of model
support. The list requires the enabled plugin; Core/Source edits remain available
independently of plugin state.

A nonblank assigned Footprint determines physical styling and PCB participation
through `lib/symbol-role.ts`. Instance assignment overrides library defaults;
unplaced previews use defaults. Ground/power remain markers. Namespace and
simulation fields never determine physical role.

## Footprint assignment and Layout

The component's Footprint field and linked package share one Core transaction.
`PCBProjectSync` prepares library details/networks; Core validates acceptance.
Reassignment replaces geometry while retaining matching identity/placement;
clearing assignment removes its package and retains copper. Manual Layout
placement updates the schematic assignment.

Loaded boards remain authoritative until relevant primary-sheet inputs change.
Opening, saving and other-sheet edits do not refetch or normalize packages.
Source aliases survive until explicit reassignment. Ordinary Value, simulation
and custom captions retain native nets, fills and packages while refreshing
linked captions; power-symbol Values remain electrical. Participation-only
changes retain PCB bytes. Async preparation cannot replace pending Source,
newer revisions or a closing project. Accepted synchronization joins its
originating undo edit; clean materialization retains its baseline. Detailed
connectivity/copper handling belongs in [Layout](LAYOUT.md#project-integrity-and-schematic-synchronization).

## Catalog service and chooser

Authenticated routes accept bounded IDs/model indices, never renderer paths or
URLs:

| Route                       | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `/api/libraries/symbols`    | Ranked/paged search or detail by ID         |
| `/api/libraries/footprints` | Ranked/paged search or detail by ID         |
| `/api/library-model`        | STEP conversion by footprint ID/model index |

`server/libraries.mjs` owns workers; `server/library-worker.mjs` indexes/resolves
catalogs within the real resource root and file bounds. Shared resolution,
placement and ranking rules in `lib/library.ts` generate
`server/library-format.mjs` through `npm run build:format`; edit sources, not
bundles.

Search ranks all matches before returning pages of at most 100: exact IDs/names,
prefixes and partial names precede keywords/descriptions, with stable ID ties.
Empty queries browse alphabetically. Workers retain the last ranked query per
kind so appending pages avoids repeating a search.

The chooser retains search/filter/selection/preview through appends and errors;
changes reset paging. Confirm only current loaded valid details, ignoring stale,
repeated or composing Enter. Symbols enter a canvas preview before committing;
footprint assignment uses Core. [DESIGN.md](../DESIGN.md) owns presentation.

### Shared library capabilities

| Capability        | Contract                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `library.search`  | Bounded symbol/footprint search; retained `ti-dcdc` subset uses the same ranking locally |
| `library.detail`  | Resolved bundled symbol/footprint                                                        |
| `schematic.place` | Load/validate a symbol unit and place on an explicit sheet                               |
| `part.footprint`  | Verify/assign a catalog footprint or clear an explicit component's assignment            |

Human/Agent placement shares reference allocation, 1.27 mm snapping, multi-unit
and participation rules. Assignment uses Core's property validation. Async
commands recheck cancellation/revision before commit and reject pending Source.
[Core](CORE.md) defines common review/close gates. Chooser gestures are
presentation, not additional typed capabilities; runtime discovery is
authoritative.

## STEP access and previews

Native model paths/transforms/visibility are design metadata, not filesystem
grants. Runtime resolves fixed example identities, official footprint/model indices, or validated component model references through the local STEP asset store. Explicit native STEP selection and Save portability follow [Layout](LAYOUT.md#model-resolution-and-alignment). Without instance links, alignment is permitted only when all numbered
embedded pads share one translation; unsafe alignment errors without rewriting
the board.

Official reads prefer bundled resources, then the private
`OpenPE/library-models/10.0.0/` cache. A miss may download only the STEP linked by
the bundled versioned footprint: 30 MB limit, no redirects, STEP validation,
coalesced requests and atomic verified cache writes. A 404 retains usable 2D
geometry; network failures remain retryable. Custom unsupported pad previews
report limits rather than inventing geometry.

The reference examples bundle 46 hash-verified STEP files and the source-extracted WE-DD
footprint under `resources/example-catalog/footprints/`. EMC separately pins 31 files in
`resources/example-catalog/emc-flyback-assets.json`: 28 upstream and three
[manufacturer supplements](../resources/example-catalog/footprints/emc-flyback/MODEL-SOURCES.md).
T1/L2 retain original official bytes; L1 has a marked reproducible rigid
assembly-frame alignment, retaining topology/colours. Preparation verifies
fixed hashes/notices. Example previews never download. Build preparation, native
Save and PCB export copy required model files beside the destination using
`${KIPRJMOD}/models/<model>.step`. LM25017 and EMC custom libraries/tables are
native Source files under `footprints/<stem>.pretty/` and `symbols/<stem>.kicad_sym`,
retained and renamed by Core on Save
as; asset preparation does not overwrite them or create duplicate libraries.
Project preparation supplies missing pinned package/table sidecars. Native STEP references retain their documented KiCad paths.
Project preparation creates no `NOTICE.txt`, `licenses/` or empty resource
directories. Original license texts and provenance remain in pinned shared
sources and packaged notices. Portable SPICE files follow the
[Simulation](SIMULATION.md) `circuits/<component>.lib` naming. `footprints/` holds `.kicad_mod`
packages, `symbols/` holds `.kicad_sym` libraries and `models/` holds STEP files.
Flat STEP basename collisions use an eight-character content hash
suffix. Stable registry IDs and model bytes are unchanged.
Example generation (`npm run examples`) removes only verified duplicate copies
after the complete native set is published; changed/unknown files and solver
results remain. Reject links and
preserve differing files. Missing manufacturer assets require repair without blocking unrelated usable examples. See [Examples](EXAMPLES.md).

`occt-import-js` 0.0.23 tessellates STEP in workers for Three.js. Conversion is
cancellable with a 45-second timeout, two service jobs and one conversion per
worker. Initialized parsers are reused, then released after 30 idle seconds,
32 jobs or a 128 MiB WASM heap; JavaScript old-generation memory is 256 MiB.
Failure/cancellation/timeout/close terminates the affected worker. Reuse keeps
identical tessellation parameters and never caches failures. Chooser 3D previews
one footprint; Model renders the board and available packages.

### Model lifetime and caches

Lazy editors remain mounted. Each Model retains scene/camera/display state
across navigation; hiding pauses rendering/new requests and defers board rebuilds
until return. Replacement/close cancels obsolete work and disposes GPU resources;
late models never reset the camera.

`lib/pcb-preview-cache.ts` shares CPU definitions/meshes across renderer scenes:
256 footprints, 128 meshes and 12 million numeric values. Board conversions
serialize across projects, reserving service capacity for the chooser; queued
work rechecks cancellation/cache. Failed jobs never poison the queue/cache.
Scene/GPU ownership remains independent, with separate instance/complexity bounds.

## Licenses and replaceable parser

Official libraries and the derived index use CC BY-SA 4.0 with the KiCad
libraries exception. Preserve notices; redistributed collections retain their
attribution/share-alike obligations. OpenPE is not endorsed by KiCad.
About OpenPE displays packaged `public/licenses/` notices. Three.js uses MIT;
`occt-import-js` uses LGPL-2.1, and Open Cascade has its LGPL-2.1 exception.
OpenPE permits modification and reverse engineering needed to debug changes.

The Git glyph adapts Microsoft's VS Code Codicons `source-control.svg` at revision
`ceaa8663a7e63e2bac7f1ecac128ce31404b7487`. The redrawn geometry retains its
three-node branch structure with round nodes, balanced spacing and the shared
2-unit stroke, inheriting the UI color and control size. Its CC BY 4.0 license,
attribution and source URL are bundled in `public/licenses/vscode-codicons.txt`
and listed in About OpenPE.

Wire adapts KiCad 10.0.0 `resources/bitmaps_png/sources/light/add_line.svg`,
the Draw Wires action icon, preserving its diagonal, round caps and 2-unit stroke
while using the UI text color. The adapted artwork remains under CC BY-SA 4.0;
`public/licenses/kicad-icons.txt` bundles attribution, the source URL and license,
also listed in About OpenPE.

`scripts/download-parser-source.mjs` prepares parser source commit
`c2148e54b456b571238d35cac037d304053d64b2` and Open Cascade
`d2abb6d844231cb8f29be6894440874a4700e4a5`. Packages ship corresponding
archives/manifest/instructions under `resources/third-party-source/`. Extract
Open Cascade into `occt/` and follow the included build scripts with Emscripten
3.1.69. Replace JS/WASM under
`resources/app.asar.unpacked/node_modules/occt-import-js/dist/`; the parser is
unpacked to support replacement. Do not package missing notices/source.

## Verification

| Check                                                                                     | Scope                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run libraries:verify`                                                                | Prepared catalogs, symbols, fields and starter models                                                                              |
| `node scripts/download-kicad-models.mjs --verify`                                         | Complete archive/inventory, offline                                                                                                |
| `npm run examples:check-models -- --render`                                               | Real parsing of 46 reference/31 EMC files and all ten Home Model views; 83 visible EMC model instances, five mounting-hole notices |
| `tests/libraries.test.ts`, `tests/core-integration.test.ts`, `tests/project-core.test.ts` | Catalog/access boundaries, placement/assignment and atomic synchronization                                                         |
| `tests/step-parser-pool.test.ts`, `node scripts/check-step-parser-reuse.mjs`              | Worker bounds/recovery and exact 31-file mesh parity                                                                               |
| `node scripts/check-library-scroll-ui.mjs`, `node scripts/check-object-retention-ui.mjs`  | Mocked isolated chooser/state retention                                                                                            |
| `node scripts/check-assignment-preview-ui.mjs` | Opt-in real STEP previews in both assignment dialogs, model-index selection, retry, retained placement scene, IME, narrow layout and native undo |
| `node scripts/e2e-libraries.mjs`                                                          | Opt-in desktop interaction                                                                                                         |

`KICAD_CLI` is test-only for `libraries:verify` and must report KiCad 10.x.
Documentation changes need static checks, without downloads/previews; desktop
checks follow [AGENTS.md](../AGENTS.md).

References: [official libraries](https://www.kicad.org/libraries/download/),
[library exception](https://www.kicad.org/libraries/license/),
[parser source](https://github.com/kovacsv/occt-import-js/tree/0.0.23).
