# SPICE Simulation

OpenPE supports bounded transient simulation of the ten native projects under `examples/` and a programmatically defined ideal high-side Buck stage. The local service compiles validated schematic snapshots and runs the bundled ngspice 47 console on win32-x64, darwin-arm64 or linux-x64. Unsupported circuits, pin mappings, custom models and executable directives fail visibly. A completed transient does not establish ERC/DRC, complete losses, junction temperatures, control-loop qualification or production validation. The Layout Thermal plugin can explicitly import the supported dissipative paths described below.

[API.md](API.md#spice-capabilities) defines exact schemas,
[PLUGINS.md](PLUGINS.md) lifecycle, [FORMAT.md](FORMAT.md) native attributes
and [CORE.md](CORE.md) shared validation/review.

Layout Parasitics can insert editable [labelled R/L series components](LAYOUT.md#parasitic-study-schematics)
between exactly mapped pad endpoints in an existing schematic. The native lead
cut and connection labels place those elements in the actual simulated path,
without an ideal bypass or floating study branch. Run reads that native geometry;
hidden group fields are not solver rewiring instructions. Creation supplies no
source, load, ground or unsupported model and does not expand the supported
compiler profiles. Its optional open-route partial inductance is not a return-loop model.
The terminal-side approximation leaves other schematic branches on the start
side; it does not reconstruct distributed PCB current paths.

## Plugin lifecycle and design inputs

Real / Virtual / All in the Schematic footer are
[native section views](../DESIGN.md#real-and-virtual-sections), not solver
participation controls. Run continues to use the complete accepted circuit and
its explicit `exclude_from_sim` settings. A component can belong to Real
and participate in SPICE; belonging to Virtual because of a missing Footprint
or Simulation-only board inclusion does not grant model support. Viewing retains
existing example source flags. Layout Parasitics adds its study elements to Virtual.

**SPICE Simulation** (`spice-simulation@openpe`) is preinstalled/enabled.
Disable/uninstall cancels owned work, removes resident controls/probes and gates
service routes, while retaining portable models, saved results and runtime files.
The service independently checks lifecycle before detection, model resolution,
lookup or execution; malformed settings fail closed. See [Plugins](PLUGINS.md).

Only Schematic exposes the **SPICE Simulation** toolbar action. The shared component Properties editor exposes model selection and parameters in its **SPICE** tab in Schematic, Layout and Model while the plugin is installed and enabled. Participation switches remain in the Schematic simulation panel. The right settings dock opened by the toolbar action contains a **Components** list with two compact cells per row within each category. Each cell shows only the component reference and an **Include in SPICE simulation** switch. Category headings show only names, with the reference prefix retained in their accessible label. Neutral outlined cells and charcoal switches keep both columns visually aligned. Group rows by reference prefix with category headings, order groups alphabetically and sort references naturally within each group (C1, C2, C10). Unrecognized prefixes retain their own named group. Categories use chevron disclosure headings, start expanded and support pointer, Enter and Space toggling. Expansion state stays with the project while the settings dock is hidden or reopened; collapsing changes no participation settings, native data or undo history. IME composition cannot toggle categories. Grouping and sorting preserve native component order and design state. Component names are independent locate buttons: pointer, Enter and Space select/highlight the corresponding visible schematic symbol and center it without closing settings, probing or changing participation. Source/close/revision, active-project, visibility/filter, overlay and composition gates apply. Ground, power and other electrical markers are omitted; physical and virtual components, including voltage sources, remain listed. These switches commit immediately through `part.participation`; running, pending Source, hidden/inactive settings, stale revisions and project close block edits. Unsupported circuits still show the list so excluded components can be restored. Properties exposes a model section for every selected component, including components without simulation fields, without participation controls. Disabling or uninstalling the plugin hides these controls without clearing saved simulation attributes. The chooser only places components. New `Connector`/`Connector_*` symbols default to excluded; other placements honour upstream defaults, and existing instance flags are preserved. Canonical components store `simulation.excluded`; private editor models use `excludeFromSimulation`, and KiCad exports use the native `exclude_from_sim` attribute. The edit shares whole-project undo/save and leaves physical connectivity and existing PCB bytes unchanged, including copper and package aliases.

Excluded components contribute no stamps, models or probe targets. Their physical pins remain wire anchors without internally joining terminals. Curated profiles check simulation connectivity through their mapped model terminals. An unmapped physical pin, such as an unused LM2735 NC pin, does not form a simulated island. Only unwired no-connect markers on excluded terminals may be ignored; wired or participating no-connects fail. Floating wire-only nets are omitted from results. Excluding a required chip/source cannot substitute another model. Inclusion never grants model support. Internal source/probe-terminal fixtures opt those terminals in explicitly.

Simulation participation is independent of physical/virtual styling. A nonblank
Footprint makes an instance physical; ground/power remain markers. Home sources
and loads are explicit virtual components with visible grid-aligned named-rail
connections. Their presentation follows `lib/example-layout.ts`, preserving
connectivity and pinned source geometry.

Without a library file, supported two-terminal passive symbols offer **ngspice R**, **ngspice C** and **ngspice L**. The two-pin `Connector_Generic:Conn_01x02` also offers **Unassigned**. Model selection leaves participation and physical pins intact. The component Value supplies the value for the chosen model, in its corresponding units. An incompatible value or a required stage probe that no longer has the expected device blocks Run. Fixed profile components retain their documented restrictions.

Intrinsic voltage sources and the EMC IPULSE current source can select DC, PULSE or SIN within their electrical family. Current-source amplitude fields use amperes; time and frequency fields retain their usual units. Native OpenPE.SourceType (canonical simulation.sourceType) records the intrinsic waveform independently of retained external binding metadata. The choice and converted Sim.Params are one Properties/Core transaction, preserving native symbol identity, geometry, pins, connectivity and PCB. DC converts to 0-to-DC pulsed/sinusoidal levels; PULSE and SIN retain their level range, delay and period/frequency where applicable. New pulses use 1 ns edges and 50% width; a DC source begins with a 1 ms period. SIN-to-DC retains the offset, while PULSE-to-DC retains its high level. Existing inactive external model fields remain stored. Unsupported families and invalid drafts fail before mutation. Reference-profile input voltage limits remain enforced; EMC reads its explicit native testbench sources. Selection does not establish support for arbitrary circuits.

Value-linked passive parameters are edited once in component **Value**. Voltage/current-source parameters are edited in the SPICE section: DC exposes Voltage, PULSE exposes its two voltage levels and timing fields, and SIN exposes its supported numeric parameters. While these controls are available, the primary Value is a read-only summary; disabling SPICE restores its ordinary Value editor. Canonical `simulation.valueFormat` contains one literal `${VALUE}` binding; the private model/native export reconstructs `Sim.Params`. Properties hides that redundant row while preserving independent source/model parameters and pin mappings. The SPICE section omits Device, Type and Pins rows while retaining their native fields and keeps the remaining model metadata read-only and provides a model library picker plus the applicable basic-component initial condition. Series resistance and Coupling controls are omitted from Properties; their existing native data and Source/Agent editing remain supported. All two-terminal capacitors expose Initial voltage (V); all two-terminal inductors expose Initial current (A), without requiring pre-existing fields. Implicit numeric displays do not create attributes. Clearing an explicit initial condition removes it through the same undoable Properties transaction. Source inputs and component parameters accept the same closed SPICE numeric grammar and bounds as compilation, including engineering notation such as 50m. Source controls retain native Value/Sim.Params storage, templates, model type, pin mappings and omitted optional parameters; inspection stays clean. Enter/blur submits through Properties with whole-project undo; Escape restores accepted values. Invalid/stale drafts remain retryable and IME composition cannot submit them. Source and Agent edits still feed the same validated solver snapshot. Initial voltage, initial current, series resistance and coupling belong to the component's Simulation group and canonical `simulation.initialVoltage`, `simulation.initialCurrent`, `simulation.seriesResistance` and `simulation.coupling` string settings. Initial current uses native `OpenPE.InitialCurrent`, with the same closed finite SPICE numeric grammar. They are design content with closed numeric validation, never hidden execution overrides.

Explicit capacitor voltages and inductor currents compile as device `IC` values, positive from the first compiled terminal toward the second. Explicit settings enable `uic` so ngspice applies those states; unset circuits retain their existing startup path. Resistor voltages are determined by the connected circuit rather than an independent stored state; coupled/multi-terminal models retain their documented model-specific rules. EMC Flyback supports overrides for its modeled capacitors; its omitted passive devices reject explicit initial conditions rather than ignoring them. Existing profile-specific capacitor voltage limits still apply.

## Portable models and bundled solver

Original model bytes live in separate `.lib` files under `models/` beside the project. Portable filenames use `models/<component>.lib`, with the component or variant name selected from pinned model metadata. Optional canonical `simulationModels` records retain pinned IDs and file SHA-256 hashes independently of that readable filename. Portable model records accept only the pinned component filename; identity/hash-named project files are rejected. Unknown IDs/hashes, arbitrary filenames/paths/URLs, duplicate references and embedded bytes in those records are rejected before state changes or writes. `lib/simulation-models.ts` and `lib/reference-models.ts` generate the service allowlists through `npm run build:format`.

Schematic Properties shows separate File and Model labels, with a read-only library filename and file button above one model dropdown, without a source-mode toggle. The dropdown uses the shared theme-aware Select popup. Native file selection refreshes the compatible declaration choices, keeping the current model first without selecting the first declaration. Intrinsic models show concise names; a library exposes its actual .MODEL/.SUBCKT declarations. Model selection automatically persists canonical `simulation.modelSource` (`basic` or `external`) as native `OpenPE.ModelSource`. An absent override retains current native KiCad binding semantics: a nonblank Sim.Library is external, otherwise intrinsic. Intrinsic selection compiles reviewed primitive Device/Type/Pins while preserving inactive external Library/Name/Device/Type/Pins in the document. Complex ICs without a supported intrinsic model cannot select one. Explicit external selection requires both file and name; incomplete or unsupported bindings fail at Run, never fall back to an intrinsic model. Properties displays only the last library filename above the model selector, retaining the complete saved path in its hover title; the native browser starts at the current library file, or the saved project directory when no library is selected. After explicit file inspection, the selector lists device entry models alongside supported intrinsic choices and hides internal helpers; incompatible device entries remain grey and disabled, with no displayed reason. Exact pinned TI libraries use their reviewed public controller entries keyed by file SHA-256. Other libraries expose unreferenced top-level declarations, hiding subcircuit and primitive-model dependencies with local scope respected. This bounded structural rule does not infer the physical purpose of unreferenced declarations or establish solver support; vendor orphan helpers are excluded only by reviewed exact-byte metadata. Multi-model libraries require an explicit model choice; file selection never silently picks the first declaration. A saved name missing from the inspected device entries is removed from the selectable choices and reported without changing the accepted binding. Reselecting a name rechecks its membership and compatibility. The reviewed LM2596 adjustable derivative retains its exact identity while verifying its pinned 5 V source declaration. This path is only a dialog hint and grants no file access. File selection is independent: cancellation changes nothing, a changed file clears its stale selected name, and selecting the same file preserves reviewed identities such as the LM2596 adjustable derivative. Opening active Properties automatically refreshes project-relative declaration lists through the live project grant without selecting a model, changing native data or adding undo. Saved names remain selected after reopen; catalogs stay transient. Absolute external references still require native selection. Inactive projects and disabled SPICE do not inspect files; errors retain the accepted binding and allow retry through the file button. Matching C/L .MODEL definitions retain capacitor voltage or inductor current controls; external subcircuits omit these intrinsic controls. New model selection validates device family/polarity and symbol terminals; SUBCKT ports use header-order numeric native mappings, while intrinsic .MODEL pins retain electrical roles. Ambiguous mappings require explicit confirmation. These checks grant no support for arbitrary model execution; the documented compiler and hash allowlists still apply. External paths remain saved references through native Save, recovery and history, without copying bytes or following includes.

The **Choose SPICE model** dialog offers local browsing and live Texas Instruments lookup by exact product number. The search field starts with the component Value. The **Model source** dropdown defaults to Texas Instruments. **Search** reads the selected source’s catalog. For TI it reads the official product page and lists the ZIP packages labelled PSpice or SPICE. Search transfers metadata only. TI’s encryption labels and checked official archive identities identify encrypted packages before download. OpenPE labels these results **Encrypted**, disables download and preselects the first reviewed unencrypted result. If TI omits encryption information for an unfamiliar archive, inspection can still identify and disable encryption. **Download** fetches and inspects the chosen archive in the dialog. Reviewed packages reuse verified project or cached bytes or download the pinned archive on demand. The official LM2596 5 V package and the OpenPE adjustable derivative retain distinct identities. Other official packages expose standalone unencrypted text libraries for inspection and binding. ZIP paths are never extracted to disk. The reader verifies each accepted member length and CRC and preserves its bytes and original notices. It recognizes the trailing marker used by some TI packages and scans balanced subcircuit blocks with optional stale end labels. **Use model** binds a compatible library and declaration together through Properties. Ambiguous bindings present the pin mapper before either field changes. Executable simulation remains limited to the existing reviewed profiles.

Electron resolves model files beside a native destination through a live opaque grant. Linked model directories, nonregular/oversized files and changed hashes fail. Referenced runs read these files or an existing verified private cache and never download missing models. Unreferenced allowlisted models can be prepared by the bounded model store. The solver accepts exact pinned official unencrypted sources, with verified archives, bounded transport, atomic cache writes and original notices. Electron uses its native network stack and system proxy; transport failures identify model downloads and offer retry guidance.

Build preparation verifies every required Home model and prepares its `models/<component>.lib` sidecars. Home opens the complete native example in place, using those colocated model files. `npm run simulation:download-examples` prepares the source-tree Home sidecars and canonical references. Downloaded-model shared build copies live in `resources/example-catalog/simulation/models/` and retain identity/hash filenames, as do private cache files; model files remain ignored by Git. The Home model subset is also packaged under `simulation-examples/models`. Preserve original notices and attribution in About OpenPE > Third-party licenses.

Only finite completed runs may add model references, as one whole-project undo edit without invalidating unchanged circuit results. Save/Save as prepares verified sidecars before writing the native file set through the [native writer](FORMAT.md#native-access-and-writes), copying prior-destination files where available. For explicitly bound TI declarations, Save/Save as carries verified library bytes into the native file packet using colocated files or the private cache without network access. An inspected TI import is a native `models/ti/<SHA-256>/<filename>.lib` sidecar. Save validates the hash and preserves the original bytes. Its bound library uses an ordinary project-relative Sim.Library path and adds no solver model reference. Differing/invalid existing files are preserved on failure. References and immutable files remain available through undo/history. Move the KiCad project files and their referenced `.lib` sidecars together for offline simulation; see [LIBRARIES.md](LIBRARIES.md) for separate footprint/STEP assets.

The solver is pinned **ngspice 47**, under `resources/ngspice/47/Spice64` in a checkout and the corresponding Electron resource root when packaged. `resources/ngspice-lock.json` has explicit `win32-x64`, `darwin-arm64` and `linux-x64` sections. Any other host, or a missing section, is an error. Detection/execution never discover a system solver or honour executable/environment overrides such as `OPENPE_NGSPICE`. Missing/damaged resources show repair guidance.

`npm run simulation:prepare` stages the locked host console; `npm run simulation:verify` checks it offline. Windows uses the official `ngspice-47_64.7z`. macOS and Linux use pinned release archives built by `scripts/build-ngspice-macos.sh` and `scripts/build-ngspice-linux.sh`. Shared archive access, rebuild toolchains and publication rules are in [solver bundle maintenance](DEVELOPMENT.md#solver-release-access).

Both POSIX builds enable XSPICE, OSDI, OpenMP, CIDER, KLU, libsndfile 1.2.2 and libsamplerate 0.2.2, without X11, readline or the separate fftw archive. macOS uses LLVM OpenMP 14.0.6. Both reuse Windows `visualc/spinit_all`; pinned patches resolve code models relative to the executable. Mach-O dependencies use bundle-relative loader paths; Linux ELF dependencies use `$ORIGIN`, with glibc supplied by the host.

Corresponding sources ship under `resources/third-party-source`; downloads and built bundles stay ignored. Retain notices, replaceable components and LGPL modification/debugging rights. Dev/build/package preparation verifies the solver. Restart Electron/service modules after changes; renderer reload does not replace them.

Windows reference waveforms are not stored in this repository, so a numeric diff against a Windows run is deferred. After the compared platforms have run the same opt-in checks, compare saved traces at matching times. The reference profiles already use `reltol=0.005`; a platform comparison also accepts a sample when the absolute voltage or current difference is at most the larger of 1 mV / 1 µA and `1e-6` times the larger magnitude. The opt-in checks themselves remain the pass/fail record until a Windows reference archive exists.

## Home profiles and verification scope

Home's Example section offers nine curated schematic/Layout projects with distinct controller models from `resources/example-catalog/manifest.json`. Recent includes EMC Flyback as a default pin alongside native history until explicitly unpinned; it has a [separate bounded behavioural model](#emc-flyback-behavioural-model). The reference projects' embedded pin signatures, model identities and explicit mappings determine support; reference changes or placement of supported passives do not by themselves remove it. A controller copied into a project-local symbol library retains support only with the same reviewed model library/name, electrical pin signature, controller value and simulation mapping. A symbol library name alone cannot grant model support. Values, sources, loads and initial conditions follow the current schematic. Source-embedded symbols and loaded PCB packages remain authoritative, including the source WE-DD package; model support does not authorize package substitution.

TPS61046 uses a visible **1 kΩ** output resistor for approximately 19 mA at 19 V. The other Home output resistors are **100 Ω**, including both LM25017 rails and EMC Flyback's external RLOAD. EMC retains its separate 0.5 A current step. TPS61046 and LM27761 default to **2 ms**, and the other seven reference profiles to **10 ms**. LM5001 uses a **10 ns** maximum step; the other reference profiles use **200 ns**. These settings declare a simulation scenario; they do not establish regulation, component ratings or thermal qualification at the selected load.

All nine reference model bindings share
`itl4=50 reltol=0.005 method=gear`: Gear integration
with an initial 50-iteration transient time-point limit and a 0.5% relative convergence
tolerance. Absolute voltage/current tolerances retain the bundled solver defaults.
Failed time-point iterations remain under ngspice's convergence control; the
limit never accepts unconverged points. On an explicit native convergence failure or collapsed accepted time steps,
`plugins/spice-simulation/host/spice-convergence.mjs` retries once with `itl4=1000`, provided the original
ceiling was lower (or implicit). It changes no duration, step, integration method,
tolerance, initial condition or model. This host policy applies to every compiled
circuit. Step collapse means 100,000 accepted native points advance less than one requested step; it measures numerical work, never wall time. Other failures, cancellation and stream errors are not retried. The
ordered execution plan enters the cache identity; saved circuit/log artifacts
record the successful attempt. Failed previews are cleared through a `retry`
stream event before new samples start at offset zero. Stop retains only samples
from the current attempt; failed attempts cannot supply heat or saved results.
Completed runs do not establish control-loop stability.
This policy follows the supported model binding through ordinary native import,
including renamed files and controller references. No filename, example-opening
route or LM27761-only option selects it. Existing numerical shunts, model bytes,
declared timing and initial conditions retain their documented owners. The
generated deck carries these options into the saved-result identity, invalidating
results computed with different numerical settings.

| Home project        | Model path                                             | Duration | Max. time step |
| ------------------- | ------------------------------------------------------ | -------- | -------------- |
| LM2596 Buck         | OpenPE-derived `OPENPE_DERIVED_LM2596_ADJ_TRANS`       | 10 ms    | 0.2 µs         |
| TPS61046 Boost      | `TPS61046_TRANS`, `STEADY=1`                           | 2 ms     | 0.2 µs         |
| LM2735 SEPIC        | `LM2735Y_TRANS`                                        | 10 ms    | 0.2 µs         |
| LM25017 Fly-Buck    | `LM25017`                                              | 10 ms    | 0.2 µs         |
| LM5001 Boost        | `LM5001_TRANS`                                         | 10 ms    | 0.01 µs        |
| LM27761 Charge Pump | `LM27761_TRANS`                                        | 2 ms     | 0.2 µs         |
| LMR12010 Buck       | `LMR12010X_TRANS`                                      | 10 ms    | 0.2 µs         |
| LMR70503 Buck-Boost | `LMR70503_TRANS` with scoped event-state approximation | 10 ms    | 0.2 µs         |
| LM2598 Buck         | `LM2598_ADJ_TRANS`                                     | 10 ms    | 0.2 µs         |

Recorded results apply only to matching source, compiler, adapter, settings,
models and solver identities. Reports under `test-results/` are ignored evidence,
not application inputs or shipped results.

`scripts/home-simulation-verification.ts` checks the final 20% of the requested
duration, the same interval used for SPICE heat input. The time-weighted output
mean must be in the declared range, peak-to-peak ripple at most 5% of its
absolute mean and drift between the two equal halves at most 1%. Both Fly-Buck
rails must pass. `npm run simulation:check-examples` records source, deck, model
and solver identities and rejects incomplete startup ramps. LM27761's 2 ms
scenario retains the native capacitor initial voltages and checks the last
0.4 ms after modeled enable and soft-start. Its coverage ends with that
preconditioned transient. Startup samples remain in the full waveform, and
user-requested runs retain their requested duration.

LM25017's original PSpice model has an instantaneous cross-coupled NOR latch.
`plugins/spice-simulation/host/spice-lm25017.mjs` verifies the pinned model ID and SHA-256 before deriving
a private controller with explicit event state and 1 ps transitions. It retains
the original set/reset output gates, 1 kΩ / 50 pF timing networks, other model
elements, physical terminals and external circuit. This is an approximation of
the ideal latch, not a vendor-issued model or proof of PSpice equivalence. It is
selected by verified component model identity, independent of project names,
directories and reference designators. Source model bytes remain unchanged and
the executed derivative participates in the result identity. The opt-in native
latch regression checks initialization, set/reset priority and held state.

`node --import tsx scripts/check-native-default-simulations.ts [comma-separated file filters]`
checks the actual bundled native files through ordinary import, unchanged default
SPICE settings and default thermal geometry/material settings with the verified
full-resolution electrical losses. Each real solver has a 600-second acceptance
deadline in this opt-in check; this does not impose a runtime timeout on user
simulations. Input hashes, settings, measured durations and results are retained
under `test-results/native-default-simulations/`. Failed or cancelled runs never
count as completing within the deadline.

### LM2596 derivative boundary

Home uses `LM2596T-ADJ` with `OpenPE:lm2596-adj-derived` / `OPENPE_DERIVED_LM2596_ADJ_TRANS`; `plugins/spice-simulation/host/spice-lm2596-adj.mjs` implements that scoped private derivative. It is an OpenPE model derived from pinned official bytes, not a TI-issued ADJ model or proof of hardware equivalence. The external E96 divider is R1 = 3.09 kΩ (VOUT–FB), R2 = 1.01 kΩ (FB–GND): 4.993 V with the datasheet's 1.23 V reference, or 5.013 V with the original model's retained 1.235 V reference.

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

LM2596, LM2598, LM27761 and LMR70503 generated profiles initialize capacitors explicitly. LM2598 uses a DC input source; TPS61046 uses its official `STEADY` parameter and a DC operating point. The other examples use visible ramped voltage sources. Editable component `simulation.initialVoltage` and `simulation.seriesResistance` settings control initial voltage and capacitor ESR/inductor DCR within compiled chip limits. Properties exposes Initial voltage (V) for capacitors; ESR/DCR settings remain retained native data editable through Source/Agent. Values retain electrical notation such as 50m.

The shared primitive initializer retains capacitor polarity and charge while solving
unspecified model bias. Ground-referenced capacitor constraints compile to `.ic`
node voltages, including compiler-owned grounded ESR/sense nodes; merely setting
a capacitor voltage does not skip the operating point for the entire circuit.
Conflicting grounded voltage constraints fail explicitly. Floating capacitor
constraints, explicit inductor currents and profiles that require skipped bias
retain device `IC` with `uic`; no floating common-mode voltage is invented.
TPS61046's declared input/output capacitor voltages therefore coexist with the
original model's bias solution. Its 2 ms default observes approximately 2000
switching cycles from the declared prebiased operating point; it does not establish cold-start or long-duration
stability. The TI model, 200 ns maximum step and 0.005 relative tolerance remain
unchanged; integration follows the shared reference policy above. User-requested durations are never shortened. This
initialization logic uses compiled connectivity, independent of filenames and references.

The TPS61046 1 kΩ bench is an explicit normal-load scenario, not a solver override.
At 19 V the former 100 Ω bench would demand 190 mA and at least 1.09 A from a
3.3 V supply even at ideal efficiency, exceeding the model's typical 0.9 A peak
switch limit. The [TI datasheet](https://www.ti.com/lit/ds/symlink/tps61046.pdf)
defines peak switch current separately from output current. Original upstream
files and manufacturer model bytes remain unchanged.

LM2735 SEPIC uses R2 = 180 kΩ, the 60.4 kΩ lower feedback resistor and a 100 Ω virtual load for a nominal 5 V target. LM2598 Buck uses the official adjustable model with a 24 V DC input, a 100 Ω virtual output load and R1 = 4.7 kΩ for the FLAG pull-up. Its profile initializes soft-start capacitor C3 to +3 V. These completed values and initial condition are recorded in simulation provenance. LM25017 uses C5 = 10 nF and an input-source rise/fall time of 100 µs; its magnetic approximation is 1:1 with 100 µH per winding and coupling 0.99 by default, edited through Value and `simulation.coupling` (the Coupling (unitless) row under Simulation). LM5001's verified 10 ns maximum step preserves oscillator operation. Generic diodes and ideal coupled inductors remain approximations. Keep the existing numerical tolerances and integration settings; changing them requires separate evidence.

The LM2598 10 ms / 200 ns scenario uses the explicit C3 initial voltage and the
original model without a compatibility adapter.

### LMR70503 compatibility and design limits

`plugins/spice-simulation/host/spice-model-adapters.mjs` accepts only model ID `reference-lmr70503` with SHA-256 `1d661a243a8a44cab8f6e67448dfdafcc96249dea54f35927b25283e01e7aba9`. After verifying original bytes, it creates a private event-state closure for the one-shot feedback while retaining the original timing resistors/capacitors, reset circuit, switch and physical terminals. The profile omits the numerical `cshunt=2f` otherwise used by the shunted Home profiles; other profiles retain their existing options. The derivative uses `psa` parsing, leaves the separate TI file/notices and project/PCB unchanged, and enters the completed-result cache identity.

This is a near-reset approximation, not exact PSpice equivalence. Comparisons
show reset-gap sensitivity. A completed 100 Ω run describes its own observed
switching and output; it does not validate other pulse/reset conditions or
adapter changes.

The model uses constant inductance; simulated current is an observation rather than a hardware measurement or saturation model. Compatibility and a settled voltage do not establish component ratings, thermal margins, hardware safety or production suitability.

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

In browser development, Run streams through the authenticated development
host and accepts supported built-in and prepared allowlisted models. Results
remain in the current renderer session. Browser runs do not publish native
artifacts or add portable model references to the design.

The authenticated Run request contains canonical source, validated settings and an optional opaque file ID. The load-only result request can omit settings to discover the latest saved configuration. Neither accepts a renderer deck, executable, native path or adapter flag. The service parses through shared `server/project-format.mjs`, compiles current source through generated `plugins/spice-simulation/host/spice-format.mjs`, resolves/verifies models and applies allowlisted service-only derivatives before execution/cache identity validation.

One solver runs at a time. Compiler structural bounds are 200 components, 1,000 wires and 1,000 combined labels/junctions. The ideal path also bounds input voltage to 0.01–1,000 V, frequency to 100 Hz–1 MHz and duty to 1–99%; curated models retain their specific electrical limits. Duration and maximum step accept **any finite positive value**. There are no fixed timing ranges, minimum/maximum interval counts, PWM-period checks, estimated-output limits or solver runtime timeout.

Execution uses argument arrays, no shell, private temporary files and `-n` to suppress user `.spiceinit`. Stop, settings close, switching from Schematic to Source/Layout/Model, navigating to Home/Plugins, project deactivation/close, circuit/sheet/pending Source invalidation, plugin removal, client disconnect and shutdown cancel the active run. Cancelling an Agent turn also cancels a run owned by that turn. Interaction/Annotation switches within the active Schematic keep the run alive. Successful desktop runs copy their artifacts into the project's `spice-simulation/` directory before temporary-file cleanup; failed/cancelled runs leave no completed record. Logs are truncated without stopping the solver; native/completed file size and sample count do not abort a valid run.

The service reads complete native binary rows serially every 200 ms. Authenticated SSE carries bounded packets with contiguous offsets, backpressure and cancellation. Live previews contain validated finite native samples, are labelled **Live**, and remain provisional. Explicit **Stop** (`simulation.cancel`) retains received validated samples, traces, cursors, zoom and view history as **Stopped · Partial results**. Incomplete streams, failure, automatic cancellation or invalidation discard live previews. Live display is bounded to 200,000 samples / 1.1 million values using actual per-trace extrema/endpoints; appending can stop at that budget while the solver continues.

Completed files are read incrementally and validated through the requested end time, with finite values, expected columns and strictly increasing time. Large completed results are reduced to the same display budget using actual extrema/endpoints. Existing ngspice linearization for curated/vendor paths remains unchanged; display reduction does not change timing, tolerances, saved-current vectors or numerical analysis. Only completed finite results can enter cache or persist model references.

Desktop Run requires a saved project and a live opaque file grant. Electron supplies a narrow result-store adapter; renderer requests cannot choose paths. Completed finite runs write files directly under `spice-simulation/` beside the native project, using its stem as a prefix: `<stem>.circuit.cir`, `<stem>.waveforms.raw`, `<stem>.waveforms.txt`, `<stem>.solver.log`, `<stem>.result.json`, `<stem>.manifest.json` and any `<stem>.ti-model.lib` / `<stem>.example-model-N.lib`. Output has no project/run subdirectories or latest pointer. The prefix isolates native projects sharing a directory. Display results retain bounded samples; raw/text waveforms retain full solver output without a size cutoff. The `openpe-spice-v2` manifest binds `project` to the native basename, retains the execution `key`, configuration, result checksum, solver version/compatibility and `identityVersion:2` / `solverSha256`, and maps each logical artifact through `files:[{name,file}]`. Logical deck/model names and execution identities remain unchanged by physical filenames. Unsaved projects must save before Run. Save as selects the new destination's records; existing records stay at their original destination.

Opening Simulation without a resident result first looks for the latest saved result through authenticated POST `/api/simulation/result`, independently of the preliminary solver-status request. Run waits for this lookup, and a pending probe shows the saved-result loading state. Before the user edits setup, the request omits config so saved nondefault Duration/Max. time step can be restored after restart. The service reads the validated saved configuration, recompiles the current source and verifies the bundled solver, existing offline models and complete execution/cache identity. A hit returns `{result,config}`; the renderer validates it against the regenerated deck and restores setup plus the result's original run settings. After setup edits, lookups send the explicit current configuration and require an exact match instead of replacing those edits with saved settings.

Restoring a verified result opens the waveform dock immediately. Retain valid selected vectors; otherwise select one output-voltage trace, falling back to the first voltage trace and then the first available trace. Additional probes and Add waveform remain available. A miss returns `{result:null}`, keeps the idle presentation and never launches a run; an absent record does not require solver detection. Unsaved projects have no stored result. Lookup never downloads models, writes project files or alters native design, undo, recovery or dirty state. Plugin disable/uninstall and shutdown cancel pending lookups. Settings edits, explicit Run and Source/visibility/project changes cancel or supersede renderer lookup requests; late replies cannot replace newer setup or results. Resident completed/stopped results survive settings reopen and setup edits.

Run also reuses matching saved results across application/service restarts. Identity includes the cache format, generated and derived execution decks, timing, ordered waveform vectors/units, bundled executable bytes/version and verified model bytes. Trace labels and clickable probe targets come from the current compiled circuit; adding a wire target on an unchanged electrical net does not invalidate its samples. Every request rechecks solver availability and resolves/verifies referenced files before lookup. Loaded results pass checksum, finite sample, trace and requested-end-time validation before use. Missing/changed models cannot be hidden by a hit; failures and stopped partial results are never persisted as completed runs.

Only current flat records with complete transient settings, `identityVersion:2` and a verified solver checksum can be loaded. Retired nested records are ignored; unsupported manifests fail explicitly. Lookup does not reconstruct other identity versions, try installation paths or recover settings from an execution deck.

Each project retains one current successful flat record. `server/flat-analysis-files.mjs` serializes reads/publications across store instances sharing a result directory. Publication uses private `.pending-<uuid>-backups` and `.previous-<uuid>-backups` folders inside `spice-simulation/`, verifies previous file identities, atomically replaces individual files and publishes the manifest last. Failed publication or cancellation rolls back written siblings; if external changes prevent restoration, the host preserves remaining backups and reports the failure. This does not provide filesystem-wide crash atomicity. Sharing errors allow up to five attempts with 100 ms delays for `EPERM`, `EBUSY` or `EACCES`, rechecking cancellation, the live grant and protected targets. Unknown sidecars, another project's prefixed artifacts, linked/damaged files and unknown filename conflicts remain protected. Retired `spice-simulation/<stem>/<run-hash>/` records and their `latest.json` pointers are ignored and preserved without loading or migration. Settings/probes/cursors/view history remain transient; disk records stay outside native design, recovery, dirty state and circuit undo. Standalone service runs without the Electron adapter retain the process-local completed-result LRU of at most two entries / 16 MiB.

All connected non-ground voltages and supported branch currents are recorded. Numeric R/C/diode currents and generic VDMOS drain currents use native saved vectors. Fixed-output TI fixtures retain their validated series-measurement topology; behavioural resistors, BJTs, the dedicated IRF540N and ideal switch retain their measurement branches. Inductors and voltage sources use native branches. Current directions follow the compiled pins: R/C/L 1 → 2, diode anode 2 → cathode 1, ideal switch 2 → 3; input/PWM currents point into the source. Multi-pin TI regulators have no body-current trace. Internal measurement nodes are not probe targets, and currents are never estimated from reduced voltage curves.

## EMC Flyback behavioural model

The EMC Flyback example retains the native board and schematic from the pinned `AI-PCB-layout` project. `plugins/spice-simulation/domain/spice-emc-flyback.ts` compiles a bounded application-owned execution derivative of its closed-loop behavioural bench. Its separate, checked-in libraries live in `examples/project/emc-flyback/models/`: `EMC_flyback_control.lib` retains the upstream UC3845B/TL431/LTV817 behavioural library byte for byte; `EMC_IRF520N.lib`, `EMC_ES2D.lib` and `EMC_SS510C.lib` retain the fitted power-device models, with each single-model filename matching its exact declaration name. The shared control library exposes its three named subcircuits through the same selector. No model bodies are embedded in TypeScript. Original source files and CC BY 4.0 attribution remain under `resources/example-catalog/sources/emc-flyback/`.

Official footprint-free `PWR_FLAG` symbols excluded from simulation declare power for ERC. The EMC compiler checks the same reviewed device and pin connectivity profile and stamps no flag components.

`npm run simulation:build-emc-flyback` regenerates the reviewed pin/connectivity signatures and `resources/emc-flyback-models-lock.json`, rebuilds service formats and publishes native/template model references and the framed native testbench. The lock binds fixed IDs, `models/` filenames and SHA-256 hashes. The host resolves the verified project files through the shared portable-model path, with bundled EMC libraries as an offline source. Save/Save as and history retain these references and libraries; packaged builds include them in `project-native/emc-flyback/models/`. Solver staging and completed records use the existing `example-model-N.lib` logical artifacts. Neither native notes, changed model bytes nor arbitrary model paths become executable SPICE.

The default transient is **10 ms / 5 ns**. It uses the upstream fitted IRF520N, generic ES2D/SS510C diodes and behavioural UC3845B/TL431/LTV817 models. These are approximate models rather than vendor-issued transistor/controller models. The complete bundled symbol set, electrical pin definitions and physical topology are checked before compilation. Supported R/C values and the visible source waveforms follow the current schematic; changes to unsupported assembly/device values, participation, pin definitions, topology or custom simulation fields fail visibly. Only Duration and Max. time step are exposed as run settings.

Q1, D2, D3, D7, U1, U3 and U4 retain explicit native `Sim.Library`, `Sim.Name`, device and pin mappings to those project libraries. Properties therefore displays their assigned declaration and the file picker starts at the actual library. Selecting the same declaration preserves its reviewed terminal mapping, including numeric native SUBCKT mappings for named library ports. Q1 retains the upstream IRF540N symbol identity while explicitly binding the fitted `EMC_IRF520N` model with physical gate pin 1 and drain pin 2. Omitted devices have no external model assignment; this does not add simulation coverage.

The native schematic includes a framed Simulation testbench area above the original circuit with five footprint-free virtual components: V1 (24 V DC), R21 (10 mΩ source resistance), V2 (12 V ideal controller supply), R22 (100 Ω output load) and I1 (0.5 A pulse load, off near 2–4 ms). V1/R21 feed VBUS after the omitted input filter/protection network. V2 connects VCC to PGND instead of simulating L78L12 regulation. R22/I1 connect VOUT to SGND. Leads and named rails are native design content; PGND/SGND remain distinct in the native design. The compiler reads their accepted Values, Sim.Params and active source waveforms, rejects incomplete/rewired benches, and injects no missing input, controller supply or output load. Properties, Source, Save and whole-project undo share these edits. Source/load changes retain PCB bytes. R21/R22 losses stay outside PCB heat; V1/V2 have mapped branch-current traces. The IPULSE component uses the pinned official KiCad symbol and typed current-source controls. The complete original 140-symbol board circuit is retained alongside these five new virtual components.

The original section 7 datasheet-link note panel is removed; component datasheet fields are retained. The isolated browser check `node scripts/check-emc-flyback-testbench-ui.mjs` covers the actual native diagram and voltage/current Properties edits without launching Electron or a solver.

RG selects R5; the drain snubber, indicators, output bleeder, auxiliary winding, enclosure and common-mode/Y-capacitor paths are omitted. PGND and SGND share the simulator reference only; native electrical connectivity and PCB copper retain their distinct nets. T1 uses an 8 µH primary, 1.5 turns ratio, coupling 0.9747 and fixed winding/ESR parasitics from the upstream simulation. Initial voltages approximate steady state, including internal ESR nodes. The external load is 100 Ω plus the retained 0.5 A current step, which turns off near 2 ms and back on near 4 ms. At 12 V the resistor draws 0.12 A; the current source adds 0.5 A while enabled. This operating point differs from the upstream 24.4 Ω bench.

Run the offline real-solver check with `node --import tsx scripts/check-emc-flyback-simulation.ts`. It verifies the complete requested duration and output windows before, during and after the load step, retaining circuit/result/identity evidence under `test-results/emc-flyback-simulation/`. This check invokes bundled ngspice without Electron, downloads or providers. It establishes the declared bench behaviour; the model does not predict conducted EMC, full-board losses, enclosure cooling or component junction temperatures.

[EMC Flyback verification](EMC-FLYBACK.md#electrical-comparison) defines the
100 Ω bench checks and retained source/deck evidence. Upstream load-dependent
measurements use different conditions and do not qualify this operating point.
Its `Vds_max` means drain to ground; internal drain-to-source and startup
maxima remain separate measurements.

### Full-resolution dissipative power

Compiler-owned current traces mark only supported resistors, diodes, ideal switches and MOSFET drain-source paths with their terminal-voltage vectors. The service integrates signed instantaneous V·I from **every original accepted binary `waveforms.raw` row**, over the final 20% of the requested duration. The bounded streaming reader verifies the complete header/payload, finite increasing samples and requested endpoint before accepting the summary. Curated/vendor `linearize` and display reduction remain presentation paths; multiplying separately interpolated voltage/current curves cannot supply heat inputs. The bounded optional `SimulationResult.dissipation` summary records the exact interval, original native sample count and mean watts by current vector. The thermal importer rejects negative dissipative averages, missing summaries and stale/mismatched source results.

Heat-summary version and dissipative vector/node metadata participate in completed-run cache identity. A record without a matching full-resolution heat summary stays on disk, and only a new completed Run produces one. Reactive elements, supplies, transformer/core losses, capacitor ESR, controller supply/gate-drive losses and unsupported devices are not inferred as board heat. EMC Q1 uses its fitted drain-source current and internal source voltage, excluding its series 10 nH parasitic; it does not establish accurate vendor losses. Layout Thermal import explicitly assumes all selected supported device power enters its linked footprint pads. See [Layout Thermal](THERMAL.md) for the separate board-temperature assumptions and limits.

## Shared simulation capabilities

Native discovery/file-set validation excludes generated `spice-simulation/` records while retaining shared project-root `models/` as portable native model files. Source
lists them as ordinary project files, with fully loaded text editable under the
[ordinary-file rules](FORMAT.md#source-transactions). They remain outside native
design, Core undo and recovery; changing an artifact's bytes invalidates its saved-result identity.

SPICE registers its queries and commands in the project's capability host through `plugins/spice-simulation/renderer/simulation-capabilities.ts`. Human settings, Run/Stop, probes and waveform controls invoke the same handlers as Agent commands. The Agent uses `openpe_query`, `openpe_execute` and `openpe_observe`; query `capabilities.list` for current schemas and availability before using a capability. Opening Simulation lazily registers its resident runtime capabilities.

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

Commands share [Core](CORE.md) Source, cancellation and close gates.
Review runs settings, probes, presentation and Stop directly; Run requires
confirmation because it can add native model references and write result files. Run waits without a solver runtime deadline; status/cancel remain
available. Observation is a bounded event cursor, not a waveform stream or
background monitor. Re-query status after events or truncation.

## Resident state, probing and Agent context

Saved-result lookup shows an indeterminate progress bar and separate reading/preparing messages in the settings footer, immediately to the left of Run. The renderer paints the feedback before request serialization and before parsing/validating large saved waveforms. It remains visible until restoration completes, misses, fails or is cancelled; existing Run gates and source/visibility/revision guards still apply.

**Simulation** opens a retained right sidebar in place of the ordinary Schematic Properties dock, sharing its current width and width limits without changing Interaction/Annotation mode or fitting the drawing. Opening and closing settings retain the current zoom and position. A fixed header and Run/Stop footer surround scrolling label/control rows; actionable errors wrap above Run/Stop. Closing settings restores the ordinary sidebar's previous visibility and retained drafts; Toggle right sidebar returns to the ordinary sidebar. Waveforms remain below the schematic drawing, beside the settings column. A verified saved-result restore opens the waveform dock with a selected trace as described above. Without a restored result or prior probe, Run alone selects no trace and leaves the waveform dock hidden. Plain clicks on wires, labels, junctions or pins probe voltage; supported component bodies probe current. Ground reports 0 V; unsupported body currents direct users to connected pins. Dragging, wiring and cancelled gestures do not add probes. DESIGN.md owns dock dimensions, cursor controls, layouts, axis editing and view history.

Settings, probes, waves, cursors, viewport history and diagnostics remain outside design/recovery/dirty state. Switching Interaction/Annotation within the active Schematic preserves settings/results/runs. Settings edits retain completed or explicitly stopped traces, cursors and view history under the previous run parameters; **Run** clears that result before starting again. Ordinary component inspection remains suppressed while probing; explicit Sim.Params inspection closes settings and restores/focuses Properties. Closing settings, switching editor views, navigating to Home/Plugins or deactivating the project hides the panels and automatically cancels active work. Completed or explicitly stopped state survives those visibility changes; automatically cancelled live previews do not become partial results. Circuit/sheet changes and pending Source invalidate results/probe intent. Pending Source must validate before setup opens.

With a probe selected, native samples grow the **Live · Running…** waveform against the requested-duration axis. The initially visible first cursor follows the latest available sample in the visible range; moving it preserves its time intent across packets and final resampling. The second cursor initially targets 0 s, remains fixed across live updates and retains its chosen time when hidden and shown. Appends do not reset view history. A new result resets that history. Native convergence failures identify startup or simulated failure time in ms. A curated profile that fails with nondefault timing offers **Use default timing**; this changes setup only and never silently shortens or reruns it. Duration inputs/errors use ms; step inputs/errors use µs with rounded numeric formatting.

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
| `node scripts/check-quantity-input-ui.mjs`                                                                      | Isolated shared engineering controls: compatible units, display-only conversion, exact untouched values, compact component power fields, invalid drafts, keyboard and IME                                                                               |
| `node scripts/check-simulation-participation-ui.mjs`                                                            | Isolated inclusion edits, undo/save and solver exclusion                                                                                                                                                                                                |
| `node scripts/check-simulation-value-ui.mjs`                                                                    | Isolated Value binding, editable DC/PULSE sources, hidden model metadata preservation, no-op blur, undo, invalid drafts, IME and reopening                                                                                                              |
| `node scripts/check-spice-model-chooser-ui.mjs`                                                                 | Centered local/TI chooser, themed model dropdown, source waveform conversion, hidden library path, current-file browse hint, declaration discovery, retained native identities, atomic edit/undo, cancellation/retry, invalid drafts, IME and stale-result guards |
| `node scripts/check-simulation-properties-ui.mjs`                                                               | Isolated editable simulation parameters, shared numeric limits, invalid retry, IME/Escape, engineering units, compact themes, Core refresh/reopen and field edit/undo                                                                                   |
| `node scripts/check-example-simulation-ui.mjs`                                                                  | Isolated Home setup and voltage-source marks                                                                                                                                                                                                            |
| `node scripts/check-example-text-ui.mjs`                                                                        | Isolated SVG glyph, symbol, pin-text and wire overlap checks for all ten Home entries across Recent and Example; no circuit mutations                                                                                                                   |
| `node scripts/check-agent-tools-ui.mjs`                                                                         | Mocked live Core queries, Review/Apply, stale guards, Auto edits, shared undo/dirty state and pending Source                                                                                                                                            |

Prepare the Home models before the offline real-solver sweep:

```sh
npm run simulation:download-examples
npm run simulation:check-examples
```

Preparation may download models and updates references; the sweep itself never fetches missing files or launches Electron. It checks actual canonical Home files, round trips, bundled-template/renderer/service deck equality, completed finite results, Home output acceptance, contiguous preview packets, unchanged source files and offline model reuse. An unmatched optional ID filter fails. Reports, hashes, executed derivative decks, solver version/log and summaries are written under ignored `test-results/example-simulations/`.

`OPENPE_TEST_NGSPICE=1` opts `npm test` into the ideal high-side Buck regression in `tests/spice.test.ts`. It checks the response to PWM duty changes, native resistor-current direction/Ohm's law and output-node current balance. It does not run the Home/vendor-model sweep. Enable `OPENPE_TEST_THERMAL=1` as well to include the three [real thermal regressions](THERMAL.md#verification).

`node --import tsx scripts/benchmark-simulation.ts [optional-id-filter]` measures offline first/repeated Home runs and verifies reuse, cancellation and model-read failures without Electron/downloads. Reports go to `test-results/simulation-performance/`; compare timings without competing solver/build workloads. `scripts/e2e-simulation.mjs` exercises the desktop and requires an explicit user request. Mocked UI, real solver and desktop results are distinct verification types. Capability transport tests use Codex/Claude CLI fixtures and mocked renderer services; they do not establish compatibility with installed provider releases, authentication or provider-plugin combinations, or add new solver evidence to the recorded cases above.

Compiler commands follow the [ngspice manual](https://ngspice.sourceforge.io/docs.html) and [control-language documentation](https://ngspice.sourceforge.io/ngspice-control-language-tutorial.html).

### Native example result persistence check

With explicit real-solver authorization, run `node --import tsx scripts/check-example-result-persistence.ts` (optional comma-separated project filters). It opens the actual native catalog projects, publishes complete solver artifacts through the production stores beside each project, imports verified SPICE heat provenance and checks both authenticated result routes through a fresh service instance whose solve callbacks reject execution. Reports under `test-results/example-result-persistence/` cover persistence and restoration. Existing matching records are verified and reused. Add `--load-only` for a separate-process audit that fails on missing or mismatched records without running either solver. It writes `load-report.json` separately from publication reports. The separate native default-run check above enforces its own elapsed-time criterion.
