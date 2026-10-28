# OpenPE

**OpenPE · Electrical Engineering Studio** is a local desktop workbench for power electronics.

![OpenPE Home with the Signal E logo](assets/home.png)

## What you can do

- Edit schematics and native KiCad Source, with shared project undo.
- Manually place and route PCBs, run bounded ERC/DRC and inspect boards in 3D.
- Draw rectangle, circle or polygon sketches on the Model canvas, extrude solids, select edges for fillet or chamfer, combine bodies and export analytical STEP.
- Run supported SPICE transients and steady PCB temperature analysis.
- Work on independent projects, recover pending drafts and compare local Git versions.
- Use Codex or Claude Code with scoped live project tools, or DeepSeek Harness and Pi with reviewed proposals. Cursor supports CLI detection only.

Home contains nine curated projects under Example and a fixed EMC Flyback entry under Recent during Preview. File > Recent / Example opens the same ten native KiCad projects. Keep required `circuits/`, `models/`, `footprints/` and `symbols/` assets with a saved project. Completed solver records remain directly under `spice/` and `thermal/` as `<native-stem>.*` files, separate from design data.

`examples/` contains exactly ten complete project directories using `examples/<circuit-name>/<circuit-name>.kicad_*`, including `examples/emc-flyback/emc-flyback.kicad_pro`. Each keeps its library tables, `.kicad_mod` packages in `footprints/`, `.kicad_sym` libraries in `symbols/`, SPICE `.lib` files named for their fixed component/variant in `circuits/`, STEP files in `models/` and any controller references in `datasheets/`. Available CAD source files such as `.scad` stay in the project root as supporting source files. Shared metadata and pinned originals live in `resources/example-catalog/`.

EMC Flyback's aluminium base, side walls and transparent drilled cover are editable Model CAD solids built with the same box and through-hole tools available to any project. `npm run examples` also regenerates [emc-flyback.scad](examples/emc-flyback/emc-flyback.scad) from the prepared example's enclosure geometry. Source lists the current project directory using its actual filenames and edits ordinary text files, including this supporting source.

The bundled **AI PCB Layout** plugin supplies the [power-pcb-design workflow](https://github.com/ChengminLi/AI-PCB-layout) by Chengmin Li and Xiao Yang, under CC BY 4.0. Enable it in Plugins > Marketplace and ask the Agent to review a board. Guidance and engineering review gates operate within the available OpenPE tools.

The nine Example controllers include offline [reviewed datasheet JSON](docs/DATASHEETS.md). Source shows the actual `datasheets/parameters.json` and local PDFs; reviewed Agent data is matched to the current controller. Optional original PDFs use `npm run datasheets:download` and `npm run datasheets:check`.

## Get started

Use **Windows x64**, **Node.js 24** and npm. Install Git for version history. Agent CLIs require separate installation and configuration; manual editing and simulation work without an Agent.

```sh
npm ci
npm run libraries:download
npm run build
npm start
```

`npm ci` installs the pinned Electron 45 runtime. After installation with `--ignore-scripts`, run `npm run postinstall` before desktop startup.

Build verifies original Home projects, prepares portable assets and verifies bundled solver resources before compiling the renderer; missing resources may require network access. Packaging prepares libraries, then uses this same build sequence for solver verification. Home opens the original `examples/<file>/` directory. **Save as** creates a personal copy.

## Development

```sh
npm run dev                 # Electron with renderer hot reload
npm run dev -- --verbose    # Complete preparation and runtime logs
npm run check:docs          # Documentation names, links, anchors and commands
npm run typecheck           # Architecture boundaries and TypeScript
npm test                    # Data/runtime tests; regenerates service formats
npm run build:format        # Generated schemas, validators and service bundles
npm run examples:prepare    # Verify original Home projects and portable assets
npm run package             # Windows app in release/win-unpacked/
```

`npm run dev` prints concise preparation/renderer/desktop stages, keeps warnings and errors, and hides routine request logs. Preparation failures include recent output; `--verbose` streams complete child output. `dev:web` retains ordinary Next.js logging.

Development reuses successful format/model/Home preparation when content fingerprints of sources, dependency manifests, pinned assets and generated outputs match `.openpe/dev-preparation-v1.json`. Fingerprinting streams at most four files concurrently while retaining deterministic ordering and file-identity checks. Changed, missing or corrupt files rerun the full sequence; failures and cancellation do not publish a reusable result. Solver runtime/source/version verification still runs on every start. Build and package preparation remain complete.

Format generation compares complete output bytes and retains unchanged files and timestamps, preserving incremental build inputs. Changed outputs use atomic file replacement.

`npm test` keeps each test file in its own process. Default file concurrency is the available CPU count minus one, bounded to 1–16 workers. Successful complete runs record file durations in `.openpe/test-timings-v1.json`; subsequent runs start slower files first. Timing records change scheduling only: every test file is discovered and executed again, and missing or invalid records do not block testing. Override the worker count with `npm test -- --test-concurrency=4`.

Run focused regressions with `npm test -- tests/<name>.test.ts`, or `node --import tsx --test tests/<name>.test.ts` after `npm run build:format` when canonical format sources changed. Focused runs do not replace the complete suite's timing record. Runtime/circuit changes also require `npm test`; focused regressions supplement the full suite. Desktop checks require explicit authorization under [AGENTS.md](AGENTS.md#verification-and-delivery).

Restart after Electron or service changes; renderer reload alone does not replace host modules. Preserve unsaved work and use the existing app window for manual checks. Desktop checks and benchmarks require explicit authorization. [AGENTS.md](AGENTS.md#verification-and-delivery) defines required checks and test boundaries.

The isolated `node scripts/check-home-editing-ui.mjs` and `node scripts/check-emc-editing-workflow-ui.mjs` workflows cover real project edits, cross-view undo and native Save/reopen with fixture pickers, without launching Electron or providers. Runtime and presentation checks are indexed in [Architecture](docs/ARCHITECTURE.md#verification).

To enable the five real-solver unit regressions with prepared offline resources:

```powershell
npm run simulation:verify
npm run thermal:verify
$env:OPENPE_TEST_NGSPICE = '1'
$env:OPENPE_TEST_THERMAL = '1'
npm test
```

These cover two Buck transients, an analytical thermal slab, conforming contours and completed thermal artifact retention. Home model sweeps and mesh-refinement benchmarks are separate: see [Simulation](docs/SIMULATION.md#verification-commands) and [Thermal](docs/THERMAL.md#verification).

## Scope

OpenPE is a preview targeting bounded KiCad 10 content. [ERC/DRC coverage](docs/DESIGN-RULES.md), supported circuits and models define the limits; complete KiCad compatibility, arbitrary model import and manufacturing qualification are outside the current scope. Refill and check exported copper in KiCad before manufacturing.

Model CAD supports bounded sketch extrusion, box/cylinder solids, local-Z holes, fillet/chamfer on selected analytic base edges and two-body union/difference/intersection. Retired enclosure data is rejected; EMC Flyback uses editable Model CAD solids. Arbitrary CAD programs, general mesh import, imported/Boolean topology editing and whole-assembly simulation remain outside its scope. Thermal FEM estimates board temperature under its material, pad-heat and cooling assumptions; it does not predict package junction temperature or EMC emissions. [EMC Flyback verification](docs/EMC-FLYBACK.md) describes its behavioural transient, offline models and comparison limits.

Product copy, application-owned protocol and storage identifiers use **OpenPE** / `openpe`. The default application data directory is `%APPDATA%\OpenPE` on Windows; `OPENPE_DATA_DIR` overrides it. User projects remain native KiCad file sets. OpenPE accepts only current names, application formats and host contracts; former-brand aliases, older application records and incomplete settings are unsupported and are not migrated.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) · [Source diagram](assets/architecture.drawio) · [Core](docs/CORE.md) · [API](docs/API.md)
- [Native format](docs/FORMAT.md) · [Layout and Model](docs/LAYOUT.md) · [ERC/DRC](docs/DESIGN-RULES.md) · [Version history](docs/VERSION-HISTORY.md)
- [Simulation](docs/SIMULATION.md) · [Thermal FEM](docs/THERMAL.md) · [Examples](docs/EXAMPLES.md)
- [Libraries and licenses](docs/LIBRARIES.md) · [Plugins](docs/PLUGINS.md) · [Design](DESIGN.md) · [Engineering](AGENTS.md)

## License

[Apache-2.0](LICENSE). Third-party assets retain their licenses and attribution.
