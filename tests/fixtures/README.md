# Regression fixtures

These files exercise OpenPE's document, schematic, PCB, simulation and local-service boundaries. They are internal test inputs, separate from the ten curated [Home projects](../../docs/EXAMPLES.md). Fixture availability does not imply general circuit/model support, a general PCB importer, complete KiCad rule parity or production validation. OpenPE's explicit [ERC/DRC checks](../../docs/DESIGN-RULES.md) have their own documented coverage.

| Location                                                                                                                     | Purpose and source                                                                                                         | Generation and checks                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `rc-filter.*`                                                                                                                | Small OpenPE-authored schematic/PCB format fixture from `lib/project-example.ts`                                           | `scripts/examples.ts`; project/PCB tests and `scripts/verify-kicad.mjs`                                               |
| [kicad/](kicad/README.md)                                                                                                    | Nine schematic-only KiCad 10.0.0 simulation demos with hash-pinned originals                                               | `npm run fixtures:generate`; `tests/examples.test.ts`, native connectivity and offline simulation checks              |
| [ti/](ti/README.md)                                                                                                          | Six OpenPE-authored fixed-output LM2596 S/T concepts with official symbols/footprints                                      | `npm run fixtures:generate`; TI pin/model tests, native connectivity and real-solver checks                           |
| [pebench/](pebench/README.md)                                                                                                | Ten source-derived schematic/PCB regressions with EAGLE originals, PEBench-converted boards and individual licenses        | Dedicated local converters; `tests/pebench-pcb.test.ts` and KiCad 10 structural/connectivity checks                   |
| `reference-retired/`                                                                                                         | Six additional current-format reference-circuit regressions and their adjacent pinned schematic/board originals            | Retained fixture inputs; `tests/reference-assets.test.ts` verifies current format, provenance paths and source hashes |
| `switching-stage.ts`, `annotation.ts`                                                                                        | Test-only circuit and Agent annotation builders                                                                            | Imported by the relevant unit/runtime checks; absent from the Home catalog                                            |
| `pcb-point-queries.ts`                                                                                                       | Exhaustive PCB point-selection oracle and interleaved EMC Flyback point shards                                             | Imported by `tests/pcb-point-index*.test.ts`; reads the generated EMC snapshot without changing it                    |
| `agent-cli.mjs`, `plugin-cli.mjs`, `plugin-toggle.mjs`                                                                       | Mock CLI processes for provider protocol, plugin, cancellation and bounded-output tests                                    | Launched by tests in isolated working directories; they are not real provider integrations                            |
| [`agent-capability-cli.mjs`](agent-capability-cli.mjs), [`agent-capability-claude-cli.mjs`](agent-capability-claude-cli.mjs) | Codex dynamic-tool and Claude scoped-MCP protocol mocks for query/execute/observe transport                                | `tests/agent-capabilities.test.ts`; isolated fake providers, not authenticated real CLI verification                  |
| [`agent-pi-cli.mjs`](agent-pi-cli.mjs), [`agent-acp-cli.mjs`](agent-acp-cli.mjs)                                             | Synthetic Pi RPC and DeepSeek ACP processes for bounded model discovery, context/proposals, image support and cancellation | Provider runtime tests in isolated directories; no installed/authenticated CLI or real-model compatibility evidence   |

Structured `.openpe.json` fixture files are private regression snapshots, not user project files. Home private snapshots live in `reference/*.json`; the public examples are native KiCad file sets. Adjacent `.kicad_sch` / `.kicad_pcb` files are native exports. Pinned upstream originals retain their source versions and bytes; they are source evidence, not compatibility readers for retired OpenPE formats. Keep manifests, provenance, source hashes and original notices intact. Generated snapshots and exports are regenerated from their source definitions rather than edited manually. KiCad local UI caches (`.kicad_prl`) are excluded from version control.

Fixtures use ordinary [Core](../../docs/CORE.md) validation, whole-project undo
and Source gates. Runtime revisions, events and reviews stay outside fixture
files. This shared interface adds no model/import support;
[Format](../../docs/FORMAT.md) defines current snapshots and native Source.

## Core and capability checks

These checks cover the shared engine and adapters with bounded authored inputs and mocks. They complement the fixture-specific preservation/native/solver checks below; they do not imply that every fixture test runs through every capability.

| Check                                                                                                                                                                    | Scope                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`tests/project-core.test.ts`](../project-core.test.ts)                                                                                                                  | Immutable/canonical query ownership, atomic edits, shared whole-project undo, Source/revision gates, Layout operations, loaded-board preservation and close barriers |
| [`tests/core-integration.test.ts`](../core-integration.test.ts)                                                                                                          | Human/Agent state and event sharing, mocked official-library placement, native/view command revision gates and CSP-safe execution                                    |
| [`tests/capabilities.test.ts`](../capabilities.test.ts)                                                                                                                  | Shared handlers, JSON isolation, live catalog availability, bounded event cursors and cancellation                                                                   |
| [`tests/agent-capabilities.test.ts`](../agent-capabilities.test.ts)                                                                                                      | Scoped query/execute/observe transport, review/Auto handling, current-state dispatch, token/origin/session isolation and both mock CLI protocols                     |
| [`tests/simulation-capabilities.test.ts`](../simulation-capabilities.test.ts), [`tests/workbench-plugin-capabilities.test.ts`](../workbench-plugin-capabilities.test.ts) | Shared plugin lifecycle and simulation command adapters with mocked state/execution; no actual solver/model validation                                               |

Codex/Claude fixtures exercise scoped dynamic-tool/stdio-MCP transport and
restricted launch arguments. Pi/ACP fixtures exercise bounded context/proposals,
model metadata, replies, advertised images and cancellation. These synthetic
protocols do not authenticate installed providers or establish current real-model
compatibility. Cursor checks detect an executable without starting chat.

Real provider, solver and native checks have separate evidence. Desktop checks
require explicit authorization; see [AGENTS.md](../../AGENTS.md).

## Regeneration

Run from the repository root with installed Node dependencies:

```sh
npm run fixtures:generate
npm run build:format
```

`fixtures:generate` refreshes the KiCad snapshot in `lib/kicad-examples.json`, the root RC JSON/schematic/PCB, nine KiCad JSON/schematic pairs and six TI JSON/schematic pairs. It does not regenerate PEBench or `reference-retired/`, change the Home catalog or collect upstream sources. PEBench's dedicated local conversion steps are documented in its README. `npm run examples` regenerates the nine curated Home projects and EMC Flyback with their generated metadata.

## Simulation resources and verification

Only the nine KiCad and six fixed-output TI fixtures have the retained fixture profiles described in [SIMULATION.md](../../docs/SIMULATION.md#retained-kicad-and-fixed-output-ti-paths) and the [TI fixture contract](ti/README.md). The RC, PEBench and retired reference-circuit files are not additional entries in that real-solver sweep. The Home LM2596 adjustable derivative is distinct from the six fixed-output TI fixtures.

Prepare solver/model resources explicitly before an offline sweep:

```sh
npm run simulation:prepare
npm run simulation:download-examples -- --fixtures
npm run simulation:check-examples
```

Preparation may download the pinned solver and allowlisted original models. The model command prepares both Home and KiCad/TI projects, updates their canonical model references and writes separate ignored `circuits/<component>.lib` sidecars. Keep each fixture's JSON beside its `circuits/` directory for offline use. See [portable model storage](../../docs/SIMULATION.md#portable-models-and-bundled-solver) for verification, offline reads and packaging.

The sweep reads actual canonical Home/KiCad/TI files, checks template/renderer/service deck agreement and validates finite completed output. It launches the bundled solver without Electron or providers. Real-solver and native KiCad checks are deliberate verification steps with separate evidence from mocked tests. Desktop checks require an explicit user request and use isolated profiles. Documentation-only edits need static format/link/command checks, not fixture regeneration, downloads or solver/desktop runs. See [AGENTS.md](../../AGENTS.md) for the full verification boundaries.
