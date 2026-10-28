# Thermal FEM

Thermal FEM (`pcb-thermal@openpe`) is a bundled, independently enabled workbench plugin. It computes steady board temperatures from supported two- and four-layer PCB geometry with Gmsh and Elmer. Heat entering the board can be entered manually or imported from supported dissipative paths in a completed SPICE transient. It does not model package junctions, airflow, radiation, heatsinks or transient heating. Its temperatures describe the stated model and assumptions, not hardware qualification.

## Geometry and inputs

`lib/thermal.ts` validates the analysis configuration with the bounded interpreted API schema subset. `lib/thermal-geometry.ts` compiles a detached model using closed board contours/cutouts, actual saved copper fills, tracks, pads, copper artwork and hollow plated-through-hole barrels. Copper text/dimensions and unsupported geometry fail visibly. Enabled copper zones without saved fills block Run; their outlines never substitute for copper. No model preparation edits or refills the PCB.

Copper thickness is provided for each copper layer. The remaining board thickness is divided into equal dielectric gaps; this is an explicit analysis assumption, not an interpretation of a native manufacturing stackup. Materials use constant isotropic conductivity. Plating thickness is specified independently of drill size. Each heat source references a stable footprint ID and applies W into its actual pads on the footprint's board side. Positive source power and at least one positive convection coefficient are required.

Defaults are ambient 25 °C; front/back convection 10 W/(m²·K), edge convection 5 W/(m²·K); copper conductivity 400 W/(m·K), dielectric conductivity 0.3 W/(m·K); copper 0.035 mm per layer and plating 0.025 mm. These are editable assumptions. All initial source powers are zero. Current settings and probes are session data. A completed desktop run saves its original configuration with the verified result beside the native project; thermal data never changes native source, Core revisions, undo, recovery or dirty state.

### SPICE heat inputs

The **SPICE** heat-source option loads a verified completed result for the PCB-linked primary schematic through the same host port used by saved SPICE lookup. Both plugins must be enabled and the native project must be saved. Loading never starts a solver or downloads a model. It requires current-source compilation, verified model/solver identities and the saved finite samples to match. Heat inputs use the final 20% of the completed transient. This interval does not establish steady electrical operation automatically.

Only compiler-declared resistor, diode, switch and MOSFET drain-to-source paths with one stable linked footprint are imported. The SPICE adapter multiplies signed terminal voltage difference by signed branch current and integrates every original accepted binary `waveforms.raw` sample with elapsed-time trapezoidal weighting. Linearized text/display curves never supply heat inputs. The thermal adapter requires this completed summary and its current cache identity; a result without a matching summary requires another SPICE Run. It rejects invalid, incomplete or negative average dissipation instead of rectifying waveforms. Ideal capacitors, inductors, transformer windings, independent sources and unsupported controller losses contribute no inferred heat. MOSFET gate-drive and unmodelled package losses are excluded; narrow switching peaks between native output samples remain unresolved.

Imported watts assume that all supported path power enters the PCB uniformly through its footprint pads. Package-to-air heat division and junction/case temperature remain outside the model. The configuration records the transient settings, averaging interval and a host SHA-256 identity of the verified deck and complete samples. Run and saved-field lookup revalidate the electrical input and imported powers; changed samples or source require reloading the heat sources. Manual mode retains the watts and clears this electrical provenance. Explicit `heatSources` edits without `spiceSource` do the same through the shared command adapter.

## Numerical path

The service recompiles the validated private project snapshot; it accepts neither renderer meshes nor solver inputs. `server/thermal-planar.mjs` constructs a bounded shared planar graph: duplicate contour edges are reused, intersections and collinear overlaps are split, and board-hole loops remain distinct. Coordinates are retained to 1e-9 mm with a 1e-8 mm intersection tolerance. `server/thermal-mesh.mjs` embeds these material/source/barrel edges into one connected board surface through Gmsh's built-in geometry kernel, including holes and cutouts. Disconnected boards fail visibly. Gmsh generates a conforming triangular mesh. The host assigns material regions and extrudes shared nodes into layered prisms, then ElmerGrid converts the generated mesh with 17 significant coordinate digits. The prepared volume is bounded to 200,000 nodes and 250,000 elements. `ElmerSolver` assembles and solves the steady heat equation from the generated SIF. This adapter prepares a mesh; it does not implement a heat-equation solver.

Top/bottom source flux is normalized by the actual selected mesh area to retain the requested W. Board, copper, barrel and source areas are checked against the prepared geometry; embedded contours must be mesh edges, and internal seams cannot become cooling boundaries. Convection applies on the specified exterior surfaces. Elmer writes raw appended Float64 VTU arrays so close, distinct contour nodes retain their identity. The reader validates array offsets, lengths, types, byte order and finite values; every output node must uniquely match the prepared mesh. ASCII VTU fields are rejected; only the configured raw appended Float64 output is accepted. Output includes actual finite-element nodes/boundary triangles, board temperatures, extrema, node/element counts and integrated heat removal. Results are checked for finite values, valid triangle indices, consistent statistics and energy imbalance. Incomplete fields are discarded. Geometry, materials, power, boundaries and mesh settings participate in the result freshness basis; runtime tools are recorded with their versions.

## Runtime and lifecycle

`scripts/prepare-thermal.mjs` prepares pinned Windows x64 Gmsh/Elmer resources and corresponding source archives. `resources/thermal-lock.json` records their identities and hashes. Runtime files live in ignored `resources/thermal/1/`, packaged as `thermal/1`; notices are available in About OpenPE. The host-owned `server/engineering-resources.mjs` validates these shared engineering executables and files; thermal detection/execution remains gated by its plugin lifecycle. It does not search PATH or accept executable/environment overrides. Missing/changed resources report repair guidance. Run never downloads resources.

The authenticated loopback service checks plugin installation/enabled state before detection, compilation, saved-result lookup and execution. Only one thermal run is active per service. A request disconnect, source/project invalidation, hidden/inactive Layout, project close, disable/uninstall or shutdown cancels work. A successful desktop run archives its complete artifacts before removing the private working directory; cancellation, failure and incomplete fields never replace a saved successful result. Thermal cancellation does not cancel SPICE, and vice versa.

Lifecycle persistence follows [Plugins](PLUGINS.md#bundled-workbench-lifecycle).
Saved records require the complete current catalog with explicit flags; partial,
obsolete, malformed, unknown or duplicate entries are preserved and fail closed.

## Completed desktop records

Desktop Run requires a saved native project. An unsaved desktop project is blocked with Save guidance; Electron resolves its opaque file ID through a live grant. Requests cannot provide a destination path. A successful run writes retained artifacts directly under `thermal/`, prefixing each basename with the native project stem, including `<stem>.mesh.nodes`, `<stem>.thermal_t0001.vtu` and `<stem>.manifest.json`. Saved output has no project, run or mesh subdirectories; the solver's private working layout uses its own `mesh/` directory. The prefix isolates native projects sharing a directory. Explicit Run performs a new solve; saved-result lookup only restores a verified field. Standalone service runs without the native adapter do not persist results.

| Saved artifact                                                                                  | Content                                                                                              |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `<stem>.input.json`                                                                             | Validated private thermal model and original configuration; not native design                        |
| `<stem>.board.geo`                                                                              | Actual Gmsh geometry script                                                                          |
| `<stem>.planar.msh`, `<stem>.board.msh`                                                         | Conforming planar and layered volume meshes                                                          |
| `<stem>.mesh.header`, `.mesh.nodes`, `.mesh.elements`, `.mesh.boundary`, optional `.mesh.names` | Elmer mesh files saved directly under `thermal/` with the same stem prefix                           |
| `<stem>.case.sif`                                                                               | Actual materials, equation, heat flux and convection configuration                                   |
| `<stem>.thermal*.vtu`                                                                           | Completed raw three-dimensional temperature field, with original bytes retained                      |
| `<stem>.gmsh.log`, `.gmsh-output.log`, `.elmer-grid.log`, `.solver.log`                         | Bounded stage diagnostics, each with the same stem prefix                                            |
| `<stem>.result.json`                                                                            | Validated real-node display field, statistics and energy balance                                     |
| `<stem>.manifest.json`                                                                          | Project binding, completion/runtime identity and logical-to-physical file mappings, sizes and hashes |

The `openpe-thermal-v2` manifest binds `project` to the native basename and records each artifact as `{name,file,size,sha256}`. `name` retains its logical working path, while `file` is `<stem>.` plus that path's basename. The run key hashes prepared input, verified runtime and logical artifact names/hashes. Only the current successful flat record is replaced. Shared `server/flat-analysis-files.mjs` queues reads/publications across store instances for each directory, stages files in private sibling `.thermal-pending-<uuid>-backups` / `.thermal-previous-<uuid>-backups` folders and atomically replaces individual files with the manifest last. It rechecks the live grant and file identities, briefly retries sharing errors and restores written siblings on failure/cancellation. If restoration is blocked by external changes, remaining backups are preserved with an actionable failure. This does not provide filesystem-wide crash atomicity. Unknown sidecars, other projects' prefixes, linked/damaged files and unexpected same-name conflicts remain protected. Retired `thermal/<stem>/<run-hash>/` records and latest pointers are ignored and preserved without loading or migration. PNG remains an explicit export.

`POST /api/thermal/result` is an authenticated, load-only lookup. It validates stored file identities, recompiles the current PCB with the saved configuration and requires the complete prepared model and verified runtime identity to match. An optional caller configuration must match too. A match returns the result and its configuration; a miss returns `{result:null}`. Lookup never launches a solve, downloads resources or edits the document. Saved settings are restored only with a matching verified field.

On the first panel opening for a saved project, the renderer looks up the latest matching field and original settings. Source/board changes, configuration edits, Run, hiding/deactivation, project close or plugin teardown cancel or discard stale lookup responses. Reopening the panel retains a completed session field. The generated project `thermal/` directory is excluded from native discovery and file-set validation. Source lists these records as ordinary project files under [Format](FORMAT.md#source-transactions) rules, outside native design content, undo, recovery and dirty state; an edited artifact no longer matches its manifest hash, so lookup rejects it. Copy the directory with its native project to retain saved analysis records; Save as selects a separate destination and does not copy completed analysis history.

## Interface

Layout's thermometer opens the retained panel. Human and Agent operations share `thermal.status`, `thermal.configure`, `thermal.importSpice`, `thermal.run`, `thermal.cancel`, `thermal.probe` and `thermal.exportImage`; host `thermal.show`/`thermal.hide` control visibility. Runtime discovery remains authoritative for registration and availability. Run requires active visible Layout, applied Source and a saved desktop destination. `thermal.run` declares an external mutation because it publishes completed analysis records; it does not save or edit native design data.

The panel docks beside the Layout drawing in place of Appearance/Properties, with a responsive 260–360 px width capped at 48% of the editor. Its settings and result statistics scroll within the column. Closing it restores the ordinary Layout sidebar state. The Thermal plugin retains ownership of the completed field and publishes a renderer-only presentation to Layout; Layout does not own solver state or copy temperatures into the board.

A completed field appears in the existing Layout camera at its actual PCB coordinates in millimetres. The Front/Back selector changes the displayed surface while retaining the camera. Both surfaces use the same complete-result temperature range, with a colour scale and a marker for the hottest real node on the selected surface. The surface raster is reused while that result and surface remain unchanged; pan, zoom and probe markers do not rebuild the temperature field. Board holes and areas outside the surface triangles remain transparent.

**Show temperature in Layout** toggles the field without discarding the result or changing the camera. **Probe Layout temperature** enables canvas probing: a click inside a displayed surface triangle reports the nearest real finite-element node on that surface, its temperature and XYZ coordinates. Clicks outside the solved surface or inside holes are ignored. Escape or starting another Layout tool exits probing; wheel zoom and middle/right-button camera navigation remain available. The panel's statistics and probe readout use the same validated result. The standalone panel retains its compact temperature map; the docked panel retains that map privately for dedicated temperature PNG export through the existing bounded image export bridge.

Field, colour, visibility and probe presentation stay separate from the editable board. Editing settings keeps a completed field with its previous inputs; another Run replaces it. Board/source changes invalidate it, and pending Source suppresses the field. Origin, destination and active/visible Layout guards discard stale presentations and lookup responses. Closing the panel retains completed results for reopening, while disable/uninstall releases plugin UI/capabilities. Agent observations carry bounded settings, statistics, extrema, assumptions and probes, without the full volume mesh or solver logs.

## Verification

- `tests/thermal.test.ts`: geometry/material/source validation and freshness.
- `tests/thermal-service.test.ts`: authenticated routes, lifecycle, saved-field matching and cancellation.
- `tests/project-thermal-files.test.ts`: exact artifact/hash retention, per-file publication with the manifest last, rollback, owned-filename replacement and grant/link guards; opt-in real archive round trip.
- `tests/thermal-planar.test.ts`: repeated/reversed edges, crossing and collinear edge splitting, shared material/hole contours and complete cutout loops.
- `tests/thermal-runtime.test.ts`: SI units, mesh/field integrity, binary Float64 field validation and cancellation; two opt-in real slab/contour cases check energy balance.
- `tests/thermal-capabilities.test.ts`, `tests/thermal-view.test.ts`: shared commands, bounded context, real-node probing and surface mapping.
- `tests/thermal-spice.test.ts`: full-resolution power/provenance, stable footprint mapping, stale-input rejection and independent plugin gates.
- `node scripts/check-thermal-ui.mjs`: isolated mocked settings/result restore and stale-lookup cancellation.
- `node scripts/check-thermal-workbench-ui.mjs`: mocked docked fields/probes, camera retention, Source invalidation and teardown.
- `npm run thermal:check-emc-flyback-ui`: real mounted-workbench solve with Manual powers from a prior EMC SPICE check, field/probe/export/restore/native-byte validation; `-- --restore` reuses matching saved results. Pickers and unrelated providers are isolated.
- `npm run thermal:check-example`: real offline slab and LM2596 PCB mesh-refinement/control checks described below; no measured converter-loss or junction-temperature claim.

Prepare resources with `npm run thermal:prepare`; verify offline installation with `npm run thermal:verify`. Set `OPENPE_TEST_THERMAL=1` in the test process to include all three real Gmsh/Elmer cases in `npm test`. These use the prepared pinned resources without downloads or Electron. They do not run the curated PCB mesh-refinement benchmark below. Real numerical verification is separate from mocked UI tests.

### Reference case

The reproducible LM2596 Buck benchmark prescribes 1 W into U1 pads at ambient 25 °C with the default material/convection assumptions. `npm run thermal:check-example` evaluates 2, 1, 0.5 and 0.4 mm meshes, checks the last temperature-rise refinement against a 5% criterion, verifies energy balance and compares a uniform-conductivity control. Its report records the exact source hashes, mesh sizes, node/element counts, temperatures and assumptions from the current mesh pipeline. The default mesh is a starting point and requires refinement before relying on a hotspot estimate.

### EMC Flyback comparison

`npm run simulation:check-emc-flyback`, then
`npm run thermal:check-emc-flyback`, imports 17 final-20% dissipative paths from
the 100 Ω resistor plus retained 0.5 A load-step bench into PCB pads using the
default material/convection assumptions. Add
`-- --mesh-size-mm=3` for the separate coarser comparison. Reports retain mesh,
solver artifacts, fields and pad temperatures under `test-results/`.

[EMC Flyback verification](EMC-FLYBACK.md#thermal-comparison) defines the current
bench and report evidence. Two mesh sizes check agreement, not convergence.
The upstream load, enclosure, package and radiation model differ from this
board-only analysis. OpenPE pad temperatures cannot stand for its junction
temperatures or establish agreement with its case-coupled result.
