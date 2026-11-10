# KiCad simulation fixtures

Nine schematic-only demos from [KiCad 10.0.0](https://github.com/KiCad/kicad-source-mirror/tree/10.0.0/demos/simulation) are retained as internal format, connectivity and transient-simulation fixtures. These `.openpe.json` files are private regression snapshots. Open adjacent native `.kicad_sch` files with **Open project**. Home has nine curated Examples and the initial EMC Flyback Recent entry; see [Home projects](../../../docs/EXAMPLES.md). KiCad project settings and boards are not included.

[`manifest.json`](manifest.json) pins each original path and SHA-256 to commit `0feeca2a807f428ad2b3fa7c1e39625cb769f02c`. [`upstream/`](upstream/) contains unchanged native schematics. Generated `.openpe.json` documents use the current structured schema, embedded symbols and typed simulation attributes; adjacent `.kicad_sch` files are native KiCad 10 exports. Do not edit pinned originals or generated snapshots manually. Runtime symbol/model resolution uses bundled or explicitly prepared resources, not an installed KiCad library.

Conversion retains embedded symbols, wiring, custom fields and plain schematic annotations, including displayed simulation control text. `lib/example-layout.ts` arranges instance text visibility/positions/reading direction without changing electrical geometry or upstream bytes. Canonical annotations are structured text objects. Value-linked parameters store the electrical value once in `value` with `simulation.valueFormat`; KiCad's `${SIM.PARAMS}` and parameter fields are reconstructed only in private models/native export. Printing-only paper settings are omitted from editable snapshots and exports. Source edits native project text; structured snapshots stay private. See [FORMAT.md](../../../docs/FORMAT.md).

Fixtures share ordinary [Core](../../../docs/CORE.md) transactions, undo and
Source/revision gates. This does not expand model/import support. The
[fixture overview](../README.md#core-and-capability-checks) separates synthetic
transport coverage from native/solver evidence.

All nine fixtures have scoped transient profiles in [SIMULATION.md](../../../docs/SIMULATION.md). The compiler validates supported electrical pins, values and model assignments and generates its own analysis commands; schematic control blocks are never executed. The Buck fixture preserves its original explicit IRF540N D/G mapping rather than silently correcting the drawn labels. Profile support does not grant general model support or production qualification.

KiCad demo contributors license these demos under **CC BY-SA 4.0**. Derived fixture documents and exports retain that license. [Attribution and changes](../../../public/licenses/kicad-demos/NOTICE.txt), [full license](../../../public/licenses/kicad-demos/LICENSE.txt) and [upstream declaration](../../../public/licenses/kicad-demos/UPSTREAM-LICENSE.README) ship with the application. Project extensions also retain source attribution; OpenPE's software license does not replace these hardware-document terms.

| Example                | Official schematic                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rectifier              | [rectifier.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/rectifier/rectifier.kicad_sch)                               |
| Buck converter         | [buck_conv.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/power_supplies/buck_conv/buck_conv.kicad_sch)                |
| Boost converter        | [smps-com.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/power_supplies/boost/smps-com.kicad_sch)                      |
| Royer converter        | [royer1.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/power_supplies/royer/royer1.kicad_sch)                          |
| High-voltage converter | [hv_converter.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/power_supplies/hv_converter/hv_converter.kicad_sch)       |
| LM317 power supply     | [power_supply.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/power_supplies/LM317_power_supply/power_supply.kicad_sch) |
| Class-D amplifier      | [Class-D.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/class-d/Class-D.kicad_sch)                                     |
| Laser diode driver     | [laser_driver.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/laser_driver/laser_driver.kicad_sch)                      |
| Op-amp and transistor  | [generic_opamp_bip.kicad_sch](https://github.com/KiCad/kicad-source-mirror/blob/0feeca2a807f428ad2b3fa7c1e39625cb769f02c/demos/simulation/generic_models/generic_opamp_bip.kicad_sch)          |

## Regeneration and model preparation

From the repository root with installed Node dependencies:

```sh
npm run fixtures:generate
npm run build:format
```

`scripts/build-kicad-examples.ts` checks all source hashes, validates supported imports and regenerates `lib/kicad-examples.json` without paper settings. `scripts/examples.ts` writes the nine canonical documents/native exports here and the root RC fixture. The combined command also generates the six fixed-output TI fixtures; it does not change the Home catalog or upstream files.

For the offline real-solver sweep, prepare solver/model resources explicitly:

```sh
npm run simulation:prepare
npm run simulation:download-examples -- --fixtures
npm run simulation:check-examples
```

Fixture-only external models are pinned by immutable official repository URLs and hashes in `resources/example-models-lock.json`. Keep the prepared [portable sidecars](../README.md#simulation-resources-and-verification) with the fixture JSON. The Buck's allowlisted IRF540N VDMOS definition is bundled separately.

`npm run simulation:build-models` regenerates IRF540N pin/model metadata from pinned sources. `npm run simulation:build-examples` prepares external fixture-model inputs and regenerates profile metadata/service bundles; it may access the network. These metadata-generation commands are distinct from fixture export and offline verification.

## Verification

| Command                                        | Scope                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm test -- tests/examples.test.ts`           | Pinned provenance, embedded symbols, geometry, field/text layout and native-content preservation                           |
| `node scripts/verify-kicad.mjs`                | Actual KiCad 10.x pin-net equality against all nine originals and SVG exports; also checks the RC/switching-stage fixtures |
| `node scripts/check-example-simulation-ui.mjs` | Isolated headless Home/KiCad setup and source-mark rendering with mocked services                                          |
| `npm run simulation:check-examples`            | Offline actual-file Home/KiCad/TI deck and finite-result checks after preparation                                          |

Set `KICAD_CLI` to select an actual 10.x CLI. The native check reports its version and writes outputs under `test-results/`; it is format/connectivity verification, not ERC/DRC or simulation. Solver reports go under `test-results/example-simulations/`. Real-solver checks are explicit verification steps and do not launch Electron/providers. Desktop checks require an explicit user request. Documentation-only edits need static checks rather than regeneration, downloads or native/solver/desktop execution.
