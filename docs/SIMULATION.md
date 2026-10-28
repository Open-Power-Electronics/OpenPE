# SPICE Simulation

OpenPE supports bounded transient simulation of the Home projects, nine retained KiCad fixtures, six fixed-output TI LM2596 variants and a single ideal high-side Buck stage. The local service compiles validated schematic snapshots and runs the bundled Windows x64 ngspice console. Unsupported circuits, pin mappings, custom models and executable directives fail visibly. A completed transient does not establish ERC/DRC, complete losses, junction temperatures, control-loop qualification or production validation. The Thermal FEM plugin can explicitly import the supported dissipative paths described below.

[API.md](API.md#spice-capabilities) defines exact schemas,
[PLUGINS.md](PLUGINS.md) lifecycle, [FORMAT.md](FORMAT.md) native attributes
and [CORE.md](CORE.md) shared validation/review.

## Plugin lifecycle and design inputs

**SPICE Simulation** (`spice-simulation@openpe`) is preinstalled/enabled.
Disable/uninstall cancels owned work, removes resident controls/probes and gates
service routes, while retaining portable models, saved results and runtime files.
The service independently checks lifecycle before detection, model resolution,
lookup or execution; malformed settings fail closed. See [Plugins](PLUGINS.md).

Component Properties exposes **Include in simulation** as a switch on the right of the Simulation heading, independently of plugin availability. It stays visible with the parameter group collapsed or empty, and toggling it does not expand or collapse parameters. The chooser only places components. New `Connector`/`Connector_*` symbols default to excluded; other placements honour upstream defaults, and existing instance flags are preserved. Canonical components store `simulation.excluded`; private editor models use `excludeFromSimulation`, and KiCad exports use the native `exclude_from_sim` attribute. The edit shares whole-project undo/save and leaves physical connectivity and existing PCB bytes unchanged, including copper and package aliases.

Excluded components contribute no stamps, models or probe targets. Their physical pins remain wire anchors without internally joining terminals. Only unwired no-connect markers on excluded terminals may be ignored; wired or participating no-connects fail. Floating wire-only nets are omitted from results. Excluding a required chip/source cannot substitute another model. Inclusion never grants model support. Internal source/probe-terminal fixtures opt those terminals in explicitly.

Simulation participation is independent of physical/virtual styling. A nonblank
Footprint makes an instance physical; ground/power remain markers. Home sources
and loads are explicit virtual components with visible grid-aligned named-rail
connections. Their presentation follows `lib/example-layout.ts`, preserving
connectivity and pinned source geometry.

Value-linked parameters are edited once in component **Value**. Canonical `simulation.valueFormat` contains one literal `${VALUE}` binding; the private model/native export reconstructs `Sim.Params`. Properties hides that redundant row while preserving independent source/model parameters and pin mappings. Properties, Source and Agent edits feed the same validated solver snapshot. Initial voltage, series resistance and coupling belong to the component's Simulation group and canonical `simulation.initialVoltage`, `simulation.seriesResistance` and `simulation.coupling` string settings. They are design content with closed numeric validation, never hidden execution overrides.

## Portable models and bundled solver

Original model bytes live in separate `.lib` files under `circuits/` beside the project. Portable filenames use `circuits/<component>.lib`, with the component or variant name selected from pinned model metadata. Optional canonical `simulationModels` records retain official IDs and extracted-file SHA-256 hashes independently of that readable filename. Only the pinned component filename is accepted; identity/hash-named project files are rejected. Unknown IDs/hashes, arbitrary filenames/paths/URLs, duplicate references and embedded bytes are rejected before state changes or writes. `lib/simulation-models.ts` and `lib/ti-dcdc.ts` generate the service allowlists through `npm run build:format`.

Electron resolves model files beside a native destination through a live opaque grant. Linked model directories, nonregular/oversized files and changed hashes fail. Referenced runs read these files or an existing verified private cache and never download missing models. Unreferenced allowlisted models can be prepared by the bounded model store. Only exact pinned official unencrypted sources are accepted, with verified archives, bounded transport, atomic cache writes and original notices. Electron uses its native network stack and system proxy; transport failures identify model downloads and offer retry guidance.

Build preparation verifies every required Home model and prepares its `circuits/<component>.lib` sidecars. Home opens the complete native example in place, using those colocated model files. `npm run simulation:download-examples` prepares the source-tree Home sidecars and canonical references; `--fixtures` also prepares the internal KiCad/TI fixtures. Shared build copies live in `resources/example-catalog/simulation/models/` and retain identity/hash filenames, as do private cache files; model files remain ignored by Git. The Home model subset is also packaged under `simulation-examples/models`; fixture-only vendor files are not packaged. Preserve original notices and attribution in About OpenPE > Third-party licenses.

Only finite completed runs may add model references, as one whole-project undo edit without invalidating unchanged circuit results. Save/Save as prepares verified sidecars before writing the native file set through the [native writer](FORMAT.md#native-access-and-writes), copying prior-destination files where available. Differing/invalid existing files are preserved on failure. References and immutable files remain available through undo/history. Move the KiCad project files and their referenced `.lib` sidecars together for offline simulation; see [LIBRARIES.md](LIBRARIES.md) for separate footprint/STEP assets.

The solver is pinned **ngspice 47**, under `resources/ngspice/47/Spice64` in a checkout and the corresponding Electron resource root when packaged. Detection/execution never discover a system solver or honour executable/environment overrides such as `OPENPE_NGSPICE`. Missing/damaged resources show repair guidance; other platforms report an unsupported bundled solver.

`npm run simulation:prepare` downloads and verifies the archives in `resources/ngspice-lock.json`, staging the console, DLLs, code models and matching source archives. `npm run simulation:verify` checks prepared resources without downloading. Dev/build/package preparation includes the solver. Keep downloads out of Git; retain locks, notices, replaceable runtime components and LGPL modification/debugging rights. Sources ship under `resources/third-party-source`. Electron/service changes require restarting the native instance to load them; renderer reload alone does not replace those modules.

## Home profiles and verification scope

Home's Example section offers nine curated schematic/Layout projects with distinct controller models from `resources/example-catalog/manifest.json`. Recent is fixed to EMC Flyback during Preview, with its [separate bounded behavioural model](#emc-flyback-behavioural-model). The reference projects' embedded pin signatures, model identities and explicit mappings determine support; reference changes or placement of supported passives do not by themselves remove it. Values, sources, loads and initial conditions follow the current schematic. Source-embedded symbols and loaded PCB packages remain authoritative, including the source WE-DD package; model support does not authorize package substitution.

All Home output resistors are **100 Ω**, including both LM25017 rails and EMC Flyback's external RLOAD. EMC retains its separate 0.5 A current step. LM27761 defaults to **5 ms**; the other eight reference profiles default to **10 ms**. LM5001 uses a **10 ns** maximum step; the other reference profiles use **200 ns**. These settings declare a simulation scenario; they do not establish regulation, component ratings or thermal qualification at the selected load.

| Home project        | Model path                                             | Duration | Max. time step |
| ------------------- | ------------------------------------------------------ | -------- | -------------- |
| LM2596 Buck         | OpenPE-derived `OPENPE_DERIVED_LM2596_ADJ_TRANS`       | 10 ms    | 0.2 µs         |
| TPS61046 Boost      | `TPS61046_TRANS`, `STEADY=1`                           | 10 ms    | 0.2 µs         |
| LM2735 SEPIC        | `LM2735Y_TRANS`                                        | 10 ms    | 0.2 µs         |
| LM25017 Fly-Buck    | `LM25017`                                              | 10 ms    | 0.2 µs         |
| LM5001 Boost        | `LM5001_TRANS`                                         | 10 ms    | 0.01 µs        |
| LM27761 Charge Pump | `LM27761_TRANS`                                        | 5 ms     | 0.2 µs         |
| LMR12010 Buck       | `LMR12010X_TRANS`                                      | 10 ms    | 0.2 µs         |
| LMR70503 Buck-Boost | `LMR70503_TRANS` with scoped event-state approximation | 10 ms    | 0.2 µs         |
| LM2598 Buck         | `LM2598_ADJ_TRANS`                                     | 10 ms    | 0.2 µs         |

Recorded results apply only to matching source, compiler, adapter, settings,
models and solver identities. Reports under `test-results/` are ignored evidence,
not application inputs or shipped results.

LM25017's original PSpice model is timing-sensitive in ngspice 47. Only the
default 10 ms / 0.2 µs scenario is supported; longer runs can fail inside the
model, and smaller steps do not guarantee convergence or extend support.

`scripts/home-simulation-verification.ts` requires completion and a final-2-ms
time-weighted output mean within the expected range, ripple ≤5% of absolute mean
and drift ≤1% between adjacent 1 ms windows. Both Fly-Buck rails must pass.
`npm run simulation:check-examples` records exact source/deck/model/solver
identities and rejects incomplete startup ramps.

### LM2596 derivative boundary

Home uses `LM2596T-ADJ` with `OpenPE:lm2596-adj-derived` / `OPENPE_DERIVED_LM2596_ADJ_TRANS`; `server/spice-lm2596-adj.mjs` implements that scoped private derivative. It is an OpenPE model derived from pinned official bytes, not a TI-issued ADJ model or proof of hardware equivalence. The external E96 divider is R1 = 3.09 kΩ (VOUT–FB), R2 = 1.01 kΩ (FB–GND): 4.993 V with the datasheet's 1.23 V reference, or 5.013 V with the original model's retained 1.235 V reference. The six [fixed-output TI paths](#retained-kicad-and-fixed-output-ti-paths) use a separate model adapter.

The default LM2596 bench uses the declared 5 V output initialization and 100 Ω
load. The actual native file, bundled template and renderer/service decks must
agree before a completed result can apply to this scenario.

`node --import tsx scripts/check-lm2596-adjustable.ts` checks two 10 ms / 200 ns benches:
the default divider and R1 = 1.69 kΩ, R2 = 1.01 kΩ, both with 100 Ω output loads.
These checks target two external-feedback operating points, not general startup
or load stability.

`node --import tsx scripts/check-lm2596-adjustable.ts 5v-discharged-output` checks
an unqualified stress condition, COUT = 0 V with a 10 Ω load for 20 ms, against
the same 5% ripple limit. The derivative does not meet that limit; do not relax
Home timing or tolerances to imply support.

### Electrical assumptions

LM2596, LM2598, LM27761 and LMR70503 generated profiles initialize capacitors explicitly. LM2598 uses a DC input source; TPS61046 uses its official `STEADY` parameter and a DC operating point. The other examples use visible ramped voltage sources. Editable component `simulation.initialVoltage` and `simulation.seriesResistance` settings control initial voltage and capacitor ESR/inductor DCR within compiled chip limits. Properties labels them Initial voltage (V) and Series resistance (Ω) under Simulation; their values retain electrical notation such as 50m.

LM2735 SEPIC uses R2 = 180 kΩ, the 60.4 kΩ lower feedback resistor and a 100 Ω virtual load for a nominal 5 V target. LM2598 Buck uses the official adjustable model with a 24 V DC input, a 100 Ω virtual output load and R1 = 4.7 kΩ for the FLAG pull-up. Its profile initializes soft-start capacitor C3 to +3 V. These completed values and initial condition are recorded in simulation provenance. LM25017 uses C5 = 10 nF and an input-source rise/fall time of 100 µs; its magnetic approximation is 1:1 with 100 µH per winding and coupling 0.99 by default, edited through Value and `simulation.coupling` (the Coupling (unitless) row under Simulation). LM5001's verified 10 ns maximum step preserves oscillator operation. Generic diodes and ideal coupled inductors remain approximations. Keep the existing numerical tolerances and integration settings; changing them requires separate evidence.

The LM2598 10 ms / 200 ns scenario uses the explicit C3 initial voltage and the
original model without a compatibility adapter.

### LMR70503 compatibility and design limits

`server/spice-model-adapters.mjs` accepts only model ID `reference-lmr70503` with SHA-256 `1d661a243a8a44cab8f6e67448dfdafcc96249dea54f35927b25283e01e7aba9`. After verifying original bytes, it creates a private event-state closure for the one-shot feedback while retaining the original timing resistors/capacitors, reset circuit, switch and physical terminals. The profile omits the numerical `cshunt=2f` otherwise used by the shunted Home profiles; other profiles retain their existing options. The derivative uses `psa` parsing, leaves the separate TI file/notices and project/PCB unchanged, and enters the completed-result cache identity.

This is a near-reset approximation, not exact PSpice equivalence. Comparisons
show reset-gap sensitivity. A completed 100 Ω run describes its own observed
switching and output; it does not validate other pulse/reset conditions or
adapter changes.

The model uses constant inductance; simulated current is an observation rather than a hardware measurement or saturation model. Compatibility and a settled voltage do not establish component ratings, thermal margins, hardware safety or production suitability.

## Retained KiCad and fixed-output TI paths

The nine KiCad projects live under `tests/fixtures/kicad/`, outside Home. `lib/spice-examples.ts`, generated `lib/example-simulation.json` and the dedicated IRF540N compiler validate complete pin signatures, model assignments and terminal order. Supported passive/source values and allowlisted numeric parameters follow the current schematic. Power names join matching rails; ground aliases resolve to node zero. Royer retains its six couplings, High-voltage retains the GaN model's repeated source terminal, and Boost/LM317 behavioural resistors use a closed numeric step-expression grammar. Schematic control annotations are never executed.

| KiCad fixture          | Default duration | Max. time step | Model path                                        |
| ---------------------- | ---------------- | -------------- | ------------------------------------------------- |
| Rectifier              | 10 ms            | 1 µs           | Original demo diode                               |
| Buck converter         | 2 ms             | 100 ns         | Bundled IRF540N VDMOS                             |
| Boost converter        | 20 ms            | 1 µs           | Demo PWM, generic opamp and default VDMOS         |
| Royer converter        | 5 ms             | 200 ns         | BC337-25, 1N5818 and coupled inductors            |
| High-voltage converter | 5 ms             | 200 ns         | GS-065-018-2-L and STPSC5H12D                     |
| LM317 power supply     | 500 ms           | 50 µs          | LM317, transformer, bridge and 1N4002             |
| Class-D amplifier      | 2 ms             | 200 ns         | Demo digital driver and default transistor models |
| Laser diode driver     | 150 ns           | 10 ps          | AD8009, FZT1049A and demo laser diode             |
| Op-amp and transistor  | 10 ms            | 1 µs           | KiCad built-in opamp and default NPN              |

These defaults define verification windows. The High-voltage default shows startup and does not cover the upstream 70 ms load change or establish steady state. Original numeric options are compiled from pinned schematics; Class-D raises its transient iteration limit to 1,000. Duration and maximum step remain editable finite positive values, with no interval-count or estimated-output limits.

Fixture-only external models use exact commit-pinned official KiCad repository URLs from `resources/example-models-lock.json`: no redirects, a 128 KB / 30 s download bound, SHA-256 verification, atomic cache writes and preserved notices. The upstream opamp `.sp` value is a matched identifier, never environment expansion or path access. Prepared sidecars support offline runs. `npm run simulation:build-examples` prepares external fixture-model inputs, regenerates profile metadata and rebuilds service formats; it may access the network.

### IRF540N Buck fixture

The retained Buck compiler uses the pinned KiCad VDMOS definition in `resources/spice/IRF-Power-VDMOS.mod`. `npm run simulation:build-models` verifies upstream schematic/model hashes and generates `lib/buck-simulation.json`; renderer/service bundles contain the allowlisted model and pin signatures for offline execution. Attribution is under KiCad demos in Third-party licenses.

The path supports one IRF540N, `Simulation_SPICE:VDC`, `Simulation_SPICE:VPULSE`, `Device:R/C/L`, `Simulation_SPICE:D` and ground. It derives identities, all source/passive parameters and output LC from current connectivity. Setup exposes only Duration and Max. time step; electrical overrides are rejected. The pinned source is 12 V, 20 kHz and 50% duty. Its diode uses the demo's default model.

Explicit `Sim.Pins` mappings remain authoritative: pinned Q1 stores **1=D 2=G 3=S** even though its drawn labels say pin 1 G and pin 2 D. OpenPE preserves this mapping and never silently exchanges connections or substitutes an ideal switch. An explicit user change to **1=G 2=D 3=S** is validated on the next run. The stored-mapping result is not an ideal Buck benchmark. Unknown models, includes, expressions, parameters or changed electrical pins fail.

The six S/T fixed-output LM2596 variants use their separate manufacturer-model adapter, internal controller and package assignments. They remain internal conceptual fixtures; see the [TI fixture contract](../tests/fixtures/ti/README.md).

## Ideal high-side Buck path

This path supports one open-loop high-side switch with unchanged embedded KiCad pins:

| Symbol                             | Model                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `Device:R`, `Device:C`, `Device:L` | Ideal element using its schematic value                                 |
| `Device:D_Schottky`                | Generic diode: Is 1 µA, N 1.05, Rs 20 mΩ, no charge storage/capacitance |
| `Transistor_FET:Q_NMOS_GDS`        | Controlled switch: Ron 20 mΩ, Roff 1 GΩ                                 |
| `Connector_Generic:Conn_01x01`     | Included input, PWM or probe terminal                                   |
| `power:GND`                        | Node zero                                                               |

Setup selects input/PWM terminals, switch and output inductor and exposes input voltage, frequency and duty. Pin 2 is the drain/input, pin 1 the gate, and pin 3 the switching source. The 0–10 V PWM is referenced to that source, with 0.1%-period edges, 10%-period initial delay and a 5 V threshold. A DC operating point precedes the transient. There is no MOSFET body diode, switching-loss, ESR, winding-resistance/saturation, temperature or control-loop model.

Ideal values accept SI prefixes (`m` milli, `M`/`meg` mega), optional units and ratings after `/`, such as `22uH` or `47µF`. Curated SPICE parameters use SPICE suffix rules (`M` milli, `meg` mega). Arbitrary expressions/custom SPICE fields and executable directives are rejected. Geometry determines nets: endpoints, pins, explicit junctions and matching local labels connect; incidental crossings do not. Unsupported/disconnected islands fail before execution.

## Execution, streaming and completed results

The authenticated Run request contains canonical source, validated settings and an optional opaque file ID. The load-only result request can omit settings to discover the latest saved configuration. Neither accepts a renderer deck, executable, native path or adapter flag. The service parses through shared `server/project-format.mjs`, compiles current source through generated `server/spice-format.mjs`, resolves/verifies models and applies allowlisted service-only derivatives before execution/cache identity validation.

One solver runs at a time. Compiler structural bounds are 200 components, 1,000 wires and 1,000 combined labels/junctions. The ideal path also bounds input voltage to 0.01–1,000 V, frequency to 100 Hz–1 MHz and duty to 1–99%; curated models retain their specific electrical limits. Duration and maximum step accept **any finite positive value**. There are no fixed timing ranges, minimum/maximum interval counts, PWM-period checks, estimated-output limits or solver runtime timeout.

Execution uses argument arrays, no shell, private temporary files and `-n` to suppress user `.spiceinit`. Stop, settings close, switching from Schematic to Source/Layout/Model, navigating to Home/Plugins, project deactivation/close, circuit/sheet/pending Source invalidation, plugin removal, client disconnect and shutdown cancel the active run. Cancelling an Agent turn also cancels a run owned by that turn. Interaction/Annotation switches within the active Schematic keep the run alive. Successful desktop runs copy their artifacts into the project's `spice/` directory before temporary-file cleanup; failed/cancelled runs leave no completed record. Logs are truncated without stopping the solver; native/completed file size and sample count do not abort a valid run.

The service reads complete native binary rows serially every 200 ms. Authenticated SSE carries bounded packets with contiguous offsets, backpressure and cancellation. Live previews contain validated finite native samples, are labelled **Live**, and remain provisional. Explicit **Stop** (`simulation.cancel`) retains received validated samples, traces, cursors, zoom and view history as **Stopped · Partial results**. Incomplete streams, failure, automatic cancellation or invalidation discard live previews. Live display is bounded to 200,000 samples / 1.1 million values using actual per-trace extrema/endpoints; appending can stop at that budget while the solver continues.

Completed files are read incrementally and validated through the requested end time, with finite values, expected columns and strictly increasing time. Large completed results are reduced to the same display budget using actual extrema/endpoints. Existing ngspice linearization for curated/vendor paths remains unchanged; display reduction does not change timing, tolerances, saved-current vectors or numerical analysis. Only completed finite results can enter cache or persist model references.

Desktop Run requires a saved project and a live opaque file grant. Electron supplies a narrow result-store adapter; renderer requests cannot choose paths. Completed finite runs write files directly under `spice/` beside the native project, using its stem as a prefix: `<stem>.circuit.cir`, `<stem>.waveforms.raw`, `<stem>.waveforms.txt`, `<stem>.solver.log`, `<stem>.result.json`, `<stem>.manifest.json` and any `<stem>.ti-model.lib` / `<stem>.example-model-N.lib`. Output has no project/run subdirectories or latest pointer. The prefix isolates native projects sharing a directory. Display results retain bounded samples; raw/text waveforms retain full solver output without a size cutoff. The `openpe-spice-v2` manifest binds `project` to the native basename, retains the execution `key`, configuration, result checksum, solver version/compatibility and `identityVersion:2` / `solverSha256`, and maps each logical artifact through `files:[{name,file}]`. Logical deck/model names and execution identities remain unchanged by physical filenames. Unsaved projects must save before Run. Save as selects the new destination's records; existing records stay at their original destination.

Opening Simulation without a resident result first looks for the latest saved result through authenticated POST `/api/simulation/result`, independently of the preliminary solver-status request. Run waits for this lookup, and a pending probe shows the saved-result loading state. Before the user edits setup, the request omits config so saved nondefault Duration/Max. time step can be restored after restart. The service reads the validated saved configuration, recompiles the current source and verifies the bundled solver, existing offline models and complete execution/cache identity. A hit returns `{result,config}`; the renderer validates it against the regenerated deck and restores setup plus the result's original run settings. After setup edits, lookups send the explicit current configuration and require an exact match instead of replacing those edits with saved settings.

Restoring a verified result opens the waveform dock immediately. Retain valid selected vectors; otherwise select one output-voltage trace, falling back to the first voltage trace and then the first available trace. Additional probes and Add waveform remain available. A miss returns `{result:null}`, keeps the idle presentation and never launches a run; an absent record does not require solver detection. Unsaved projects have no stored result. Lookup never downloads models, writes project files or alters native design, undo, recovery or dirty state. Plugin disable/uninstall and shutdown cancel pending lookups. Settings edits, explicit Run and Source/visibility/project changes cancel or supersede renderer lookup requests; late replies cannot replace newer setup or results. Resident completed/stopped results survive settings reopen and setup edits.

Run also reuses matching saved results across application/service restarts. Identity includes the cache format, generated and derived execution decks, timing, ordered waveform vectors/units, bundled executable bytes/version and verified model bytes. Trace labels and clickable probe targets come from the current compiled circuit; adding a wire target on an unchanged electrical net does not invalidate its samples. Every request rechecks solver availability and resolves/verifies referenced files before lookup. Loaded results pass checksum, finite sample, trace and requested-end-time validation before use. Missing/changed models cannot be hidden by a hit; failures and stopped partial results are never persisted as completed runs.

Only current flat records with complete transient settings, `identityVersion:2` and a verified solver checksum can be loaded. Retired nested records are ignored; unsupported manifests fail explicitly. Lookup does not reconstruct other identity versions, try installation paths or recover settings from an execution deck.

Each project retains one current successful flat record. `server/flat-analysis-files.mjs` serializes reads/publications across store instances sharing a result directory. Publication uses private sibling `.spice-pending-<uuid>-backups` and `.spice-previous-<uuid>-backups` folders, verifies previous file identities, atomically replaces individual files and publishes the manifest last. Failed publication or cancellation rolls back written siblings; if external changes prevent restoration, the host preserves remaining backups and reports the failure. This does not provide filesystem-wide crash atomicity. Sharing errors allow up to five attempts with 100 ms delays for `EPERM`, `EBUSY` or `EACCES`, rechecking cancellation, the live grant and protected targets. Unknown sidecars, another project's prefixed artifacts, linked/damaged files and unknown filename conflicts remain protected. Retired `spice/<stem>/<run-hash>/` records and their `latest.json` pointers are ignored and preserved without loading or migration. Settings/probes/cursors/view history remain transient; disk records stay outside native design, recovery, dirty state and circuit undo. Standalone service runs without the Electron adapter retain the process-local completed-result LRU of at most two entries / 16 MiB.

All connected non-ground voltages and supported branch currents are recorded. Numeric R/C/diode currents and generic VDMOS drain currents use native saved vectors. Fixed-output TI fixtures retain their validated series-measurement topology; behavioural resistors, BJTs, the dedicated IRF540N and ideal switch retain their measurement branches. Inductors and voltage sources use native branches. Current directions follow the compiled pins: R/C/L 1 → 2, diode anode 2 → cathode 1, ideal switch 2 → 3; input/PWM currents point into the source. Multi-pin TI regulators have no body-current trace. Internal measurement nodes are not probe targets, and currents are never estimated from reduced voltage curves.

## EMC Flyback behavioural model

The EMC Flyback example retains the native board and schematic from the pinned `AI-PCB-layout` project. `lib/spice-emc-flyback.ts` compiles a bounded application-owned execution derivative of its closed-loop behavioural bench. Original source files, behavioural model library and CC BY 4.0 attribution remain under `resources/example-catalog/sources/emc-flyback/`. `scripts/build-emc-flyback-simulation.ts` generates the reviewed pin/connectivity signatures and compiler model constants; neither native notes nor arbitrary model paths become executable SPICE.

The default transient is **10 ms / 5 ns**. It uses the upstream fitted IRF520N, generic ES2D/SS510C diodes and behavioural UC3845B/TL431/LTV817 models. These are approximate models rather than vendor-issued transistor/controller models. The complete bundled symbol set, electrical pin definitions and physical topology are checked before compilation. Supported R/C values follow the current schematic; changes to unsupported assembly/device values, participation, pin definitions, topology or custom simulation fields fail visibly. Only Duration and Max. time step are exposed as run settings.

The bench applies 24 V at VBUS after the omitted input filter/protection network and represents L78L12 with an ideal 12 V source. RG selects R5; the drain snubber, indicators, output bleeder, auxiliary winding, enclosure and common-mode/Y-capacitor paths are omitted. PGND and SGND share the simulator reference only; native electrical connectivity and PCB copper retain their distinct nets. T1 uses an 8 µH primary, 1.5 turns ratio, coupling 0.9747 and fixed winding/ESR parasitics from the upstream simulation. Initial voltages approximate steady state, including internal ESR nodes. The external load is 100 Ω plus the retained 0.5 A current step, which turns off near 2 ms and back on near 4 ms. At 12 V the resistor draws 0.12 A; the current source adds 0.5 A while enabled. This operating point differs from the upstream 24.4 Ω bench.

Run the offline real-solver check with `node --import tsx scripts/check-emc-flyback-simulation.ts`. It verifies the complete requested duration and output windows before, during and after the load step, retaining circuit/result/identity evidence under `test-results/emc-flyback-simulation/`. This check invokes bundled ngspice without Electron, downloads or providers. It establishes the declared bench behaviour; the model does not predict conducted EMC, full-board losses, enclosure cooling or component junction temperatures.

[EMC Flyback verification](EMC-FLYBACK.md#electrical-comparison) defines the
100 Ω bench checks and retained source/deck evidence. Upstream load-dependent
measurements use different conditions and do not qualify this operating point.
Its `Vds_max` means drain to ground; internal drain-to-source and startup
maxima remain separate measurements.

### Full-resolution dissipative power

Compiler-owned current traces mark only supported resistors, diodes, ideal switches and MOSFET drain-source paths with their terminal-voltage vectors. The service integrates signed instantaneous V·I from **every original accepted binary `waveforms.raw` row**, over the final 20% of the requested duration. The bounded streaming reader verifies the complete header/payload, finite increasing samples and requested endpoint before accepting the summary. Curated/vendor `linearize` and display reduction remain presentation paths; multiplying separately interpolated voltage/current curves cannot supply heat inputs. The bounded optional `SimulationResult.dissipation` summary records the exact interval, original native sample count and mean watts by current vector. The thermal importer rejects negative dissipative averages, missing summaries and stale/mismatched source results.

Heat-summary version and dissipative vector/node metadata participate in completed-run cache identity. A record without a matching full-resolution heat summary stays on disk, and only a new completed Run produces one. Reactive elements, supplies, transformer/core losses, capacitor ESR, controller supply/gate-drive losses and unsupported devices are not inferred as board heat. EMC Q1 uses its fitted drain-source current and internal source voltage, excluding its series 10 nH parasitic; it does not establish accurate vendor losses. Thermal import explicitly assumes all selected supported device power enters its linked footprint pads. See [Thermal simulation](THERMAL.md) for the separate board-temperature assumptions and limits.

## Shared simulation capabilities

Native discovery/file-set validation excludes generated `spice/` records; decks,
model copies and results never enter editable Source, undo or recovery.

SPICE registers its queries and commands in the project's capability host through `lib/simulation-capabilities.ts`. Human settings, Run/Stop, probes and waveform controls invoke the same handlers as Agent commands. The Agent uses `openpe_query`, `openpe_execute` and `openpe_observe`; query `capabilities.list` for current schemas and availability before using a capability. Opening Simulation lazily registers its resident runtime capabilities.

| Capability                            | Contract                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulation.show` / `simulation.hide` | Open settings in the active project and wait for registration, or hide settings and cancel active work while retaining completed or stopped state |
| `simulation.status`                   | Read resident settings, support/errors, probes, every trace, reduced curves, extrema, visible ranges and exact cursor readings                    |
| `simulation.configure`                | Update exposed transient settings or text drafts; the same circuit-specific controls and validation apply to both clients                         |
| `simulation.probes`                   | Set or clear a voltage/current probe by stable object ID, or select current result vectors                                                        |
| `simulation.run`                      | Run current supported settings to completion; a finite completed result may add verified model references through one Core transaction            |
| `simulation.cancel`                   | Stop the active run and retain received validated samples and waveform presentation as partial results                                            |
| `simulation.presentation`             | Set Auto or supported grid layout, cursor linking/visibility/times, per-trace time/value axes, zoom mode or Previous/Next view history            |

Numeric `simulation.configure.config` values use V, Hz, percent and seconds; `stop` and `step` are seconds. Text `drafts` use the visible settings units, including ms for duration and µs for maximum step, and can retain incomplete input without running it. Curated profiles expose only their supported controls. Waveform times use seconds and values use each trace's V/A unit. Unknown targets/vectors, invalid axes and electrical overrides fail; no command accepts a deck, model bytes, native path, executable or arbitrary solver option.

Commands share [Core](CORE.md) review, captured-revision, Source and close
gates. Run waits without a solver runtime deadline; status/cancel remain
available. Observation is a bounded event cursor, not a waveform stream or
background monitor. Re-query status after events or truncation.

## Resident state, probing and Agent context

**Simulation** opens a retained right sidebar in place of the ordinary Schematic Properties dock, sharing its current width and width limits without changing Interaction/Annotation mode or fitting the drawing. Opening and closing settings retain the current zoom and position. A fixed header and Run/Stop footer surround scrolling label/control rows; actionable errors wrap above Run/Stop. Closing settings restores the ordinary sidebar's previous visibility and retained drafts; Toggle right sidebar returns to the ordinary sidebar. Waveforms remain below the schematic drawing, beside the settings column. A verified saved-result restore opens the waveform dock with a selected trace as described above. Without a restored result or prior probe, Run alone selects no trace and leaves the waveform dock hidden. Plain clicks on wires, labels, junctions or pins probe voltage; supported component bodies probe current. Ground reports 0 V; unsupported body currents direct users to connected pins. Dragging, wiring and cancelled gestures do not add probes. DESIGN.md owns dock dimensions, cursor controls, layouts, axis editing and view history.

Settings, probes, waves, cursors, viewport history and diagnostics remain outside design/recovery/dirty state. Switching Interaction/Annotation within the active Schematic preserves settings/results/runs. Settings edits retain completed or explicitly stopped traces, cursors and view history under the previous run parameters; **Run** clears that result before starting again. Ordinary component inspection remains suppressed while probing; explicit Sim.Params inspection closes settings and restores/focuses Properties. Closing settings, switching editor views, navigating to Home/Plugins or deactivating the project hides the panels and automatically cancels active work. Completed or explicitly stopped state survives those visibility changes; automatically cancelled live previews do not become partial results. Circuit/sheet changes and pending Source invalidate results/probe intent. Pending Source must validate before setup opens.

With a probe selected, native samples grow the **Live · Running…** waveform against the requested-duration axis. An untouched end cursor follows the latest sample; moving it preserves its time intent across packets and final resampling. Appends do not reset view history. A new result resets that history. Native convergence failures identify startup or simulated failure time in ms. A curated profile that fails with nondefault timing offers **Use default timing**; this changes setup only and never silently shortens or reruns it. Duration inputs/errors use ms; step inputs/errors use µs with rounded numeric formatting.

Agent submissions capture bounded resident settings, run identity/status,
probes, trace extrema/endpoints, reduced curves and exact cursor observations.
Live `simulation.status`/`workbench.state` reads refresh them; initial context may
be stale. Units are seconds and V/A. Hidden completed/stopped state stays
queryable while enabled; disabled plugins expose no result context. Logs,
model bytes and full native waveforms stay outside context.

## Verification commands

Documentation edits require static content/link/format checks only. The following commands describe maintained coverage; listing them does not imply a fresh run or coverage of an unsynchronized source/generated build.

| Check                                                                                                           | Scope                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                      | Topology, values, participation, shared capabilities, plugin lifecycle, adapters, native-output validation, cache identity, cancellation and bounded transport using controlled runners; the pretest hook regenerates formats, then checks architecture |
| `npm test -- tests/capabilities.test.ts tests/simulation-capabilities.test.ts tests/agent-capabilities.test.ts` | Capability schemas/availability, revision and cancellation boundaries, concurrent status/run/cancel and scoped Agent transport using controlled adapters and CLI fixtures                                                                               |
| `node scripts/check-simulation-ui.mjs`                                                                          | Isolated mocked renderer: probing/cursors, settings retention, footer errors and Source invalidation                                                                                                                                                    |
| `node scripts/check-simulation-stream-ui.mjs`                                                                   | Isolated streaming fixture: live plots, cursor intent, Stop/errors/EOF and finalization                                                                                                                                                                 |
| `node scripts/check-waveform-layout-ui.mjs`                                                                     | Isolated human controls and Agent presentation commands: layouts, axes, cursors, view history, removal and atomic invalid-axis rejection                                                                                                                |
| `node scripts/check-simulation-participation-ui.mjs`                                                            | Isolated inclusion edits, undo/save and solver exclusion                                                                                                                                                                                                |
| `node scripts/check-simulation-value-ui.mjs`                                                                    | Isolated Value binding, no-op blur, undo, invalid drafts and reopening                                                                                                                                                                                  |
| `node scripts/check-example-simulation-ui.mjs`                                                                  | Isolated Home/KiCad setup and voltage-source marks                                                                                                                                                                                                      |
| `node scripts/check-example-text-ui.mjs`                                                                        | Isolated SVG glyph, symbol, pin-text and wire overlap checks for all ten Home entries across Recent and Example; no circuit mutations                                                                                                                   |
| `node scripts/check-agent-tools-ui.mjs`                                                                         | Mocked live Core queries, Review/Apply, stale guards, Auto edits, shared undo/dirty state and pending Source                                                                                                                                            |

Prepare separate Home/fixture models before the offline real-solver sweep:

```sh
npm run simulation:download-examples -- --fixtures
npm run simulation:check-examples
```

Preparation may download models and updates references; the sweep itself never fetches missing files or launches Electron. It checks actual canonical files, round trips, bundled-template/renderer/service deck equality, completed finite results, Home output acceptance, contiguous preview packets, unchanged source files and offline model reuse. An unmatched optional ID filter fails. Reports, hashes, executed derivative decks, solver version/log and summaries are written under ignored `test-results/example-simulations/`.

`OPENPE_TEST_NGSPICE=1` opts `npm test` into two real transient regressions using the prepared bundled solver: the retained native IRF540N Buck in `tests/spice-buck.test.ts`, and the ideal high-side Buck in `tests/spice.test.ts`. Both check the output response to PWM duty changes without editing the original fixture. The ideal case also checks native resistor-current direction/Ohm's law and output-node current balance. These cases do not run the Home/vendor-model sweep. Enable `OPENPE_TEST_THERMAL=1` as well to include the three [real thermal regressions](THERMAL.md#verification).

`node --import tsx scripts/benchmark-simulation.ts [optional-id-filter]` measures offline first/repeated Home runs and verifies reuse, cancellation and model-read failures without Electron/downloads. Reports go to `test-results/simulation-performance/`; compare timings without competing solver/build workloads. `scripts/e2e-simulation.mjs` exercises the desktop and requires an explicit user request. Mocked UI, real solver and desktop results are distinct verification types. Capability transport tests use Codex/Claude CLI fixtures and mocked renderer services; they do not establish compatibility with installed provider releases, authentication or provider-plugin combinations, or add new solver evidence to the recorded cases above.

Compiler commands follow the [ngspice manual](https://ngspice.sourceforge.io/docs.html) and [control-language documentation](https://ngspice.sourceforge.io/ngspice-control-language-tutorial.html).
