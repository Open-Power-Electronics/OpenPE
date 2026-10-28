# TI DC/DC simulation fixtures

Six OpenPE-authored LM2596 Buck concepts exercise the fixed-output TI adapter. They use official KiCad 10.0.0 symbols and assigned packages, with no PCB included. They are internal fixtures, separate from the ten [Home projects](../../../docs/EXAMPLES.md); the symbol chooser places components only. These are not TI reference designs or production-validated circuits.

| Fixture variants                         | Assigned official footprint                                            | Output           |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| `LM2596S-3.3`, `LM2596S-5`, `LM2596S-12` | `Package_TO_SOT_SMD:TO-263-5_TabPin3`                                  | 3.3 V, 5 V, 12 V |
| `LM2596T-3.3`, `LM2596T-5`, `LM2596T-12` | `Package_TO_SOT_THT:TO-220-5_P3.4x3.7mm_StaggerOdd_Lead3.8mm_Vertical` | 3.3 V, 5 V, 12 V |

The `.openpe.json` files are private regression snapshots; adjacent `.kicad_sch` files are native KiCad 10 exports that can be opened in the workbench. `lib/ti-examples.ts` defines the circuits, `lib/ti-dcdc.ts` defines the allowlisted parts/models, and `scripts/build-starter-symbols.mjs` generates upstream symbol geometry. Do not hand-edit generated fixtures or symbol data. KiCad library data retains its [license and design exception](../../../public/licenses/kicad-libraries.txt); official model notices and terms are recorded in [ti-models.txt](../../../public/licenses/ti-models.txt).

Fixtures share ordinary [Core](../../../docs/CORE.md) transactions, undo and
Source/revision gates. This does not expand model/import support. The
[fixture overview](../README.md#core-and-capability-checks) separates synthetic
transport coverage from native/solver evidence.

The circuits use 24 V input, nominal 1 A resistive loads, explicit output-capacitor ESR and the fixed-output models' internal controller. Physical model order is **1, 4, 2, 3, 5**: VIN, FB, OUT, GND, ON_OFF_N. They retain their validated series-measurement topology. Including an unsupported component or excluding a required regulator/source fails visibly. Supported profiles do not establish losses, thermal margins, ERC/DRC or hardware qualification.

The Home LM2596 profile uses a scoped OpenPE adjustable derivative of pinned official 5 V bytes. It is separate from these six fixed-output fixtures, is not a TI-issued ADJ model and does not add general ADJ/custom-model support. Fixed-output fixture results do not validate that derivative. See the [LM2596 derivative boundary](../../../docs/SIMULATION.md#lm2596-derivative-boundary) and [fixed-output TI paths](../../../docs/SIMULATION.md#retained-kicad-and-fixed-output-ti-paths) for the adapter boundaries, sources, measured evidence and limits.

## Regeneration and model preparation

From the repository root:

```sh
npm run fixtures:generate
npm run build:format
```

`fixtures:generate` includes `scripts/build-ti-examples.ts`, which writes the six JSON/schematic pairs. To run the complete offline Home/KiCad/TI sweep, explicitly prepare the solver and model sidecars first:

```sh
npm run simulation:prepare
npm run simulation:download-examples -- --fixtures
npm run simulation:check-examples
```

Preparation may download hash-pinned official models. Model bytes stay in separate ignored `models/*.lib` files, never in JSON or Git. Canonical projects contain only official IDs, extracted-file hashes and fixed relative references. Keep projects and `models/` together; referenced runs read verified local files or an existing private cache and never download a missing referenced model. Fixture-only models are not packaged. The real-solver sweep requires prepared files and does not fetch or launch Electron/providers. Shared runtime, participation and portability rules are in [SIMULATION.md](../../../docs/SIMULATION.md).

## Verification

| Command                                | Scope                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `npx tsx --test tests/ti-dcdc.test.ts` | Allowlisted identities, pins, packages, archive integrity and download rejection using test fixtures        |
| `node scripts/check-ti-ui.mjs`         | Isolated headless chooser/simulation UI with prepared bundled libraries                                     |
| `npx tsx scripts/check-ti-kicad.ts`    | Actual KiCad 10.x exported connectivity and SVG checks; `KICAD_CLI` selects the CLI                         |
| `npx tsx scripts/check-ti-models.ts`   | Dedicated real bundled-ngspice checks; may download TI models into `test-results/ti-validation/`            |
| `npm run simulation:check-examples`    | Offline file-based Home/KiCad/TI sweep after preparation; reports under `test-results/example-simulations/` |

These checks have distinct scopes; native format/connectivity acceptance is not ERC/DRC. Real-solver checks are explicit verification steps. Desktop checks require an explicit user request. Documentation-only edits need static checks, not resource preparation or native/solver/desktop execution.
