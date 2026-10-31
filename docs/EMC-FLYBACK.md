# EMC Flyback verification

During Preview, EMC Flyback is the fixed entry in Home's Recent section. It is converted from [AI-PCB-layout's EMC Flyback demo](https://github.com/ChengminLi/AI-PCB-layout/tree/e1b9a64ac9ac306647fa30094932fb792d17e373/examples/emc-flyback-demo), pinned at commit `e1b9a64ac9ac306647fa30094932fb792d17e373`. Original design, simulation bench, notices and SHA-256 identities remain under `resources/example-catalog/sources/emc-flyback/`. The editable project is [emc-flyback.kicad_pro](../examples/emc-flyback/emc-flyback.kicad_pro), following the same directory/stem rule as every Home example. Source attribution is CC BY 4.0.

## Native conversion

The official KiCad 10 upgrader converts the schematic and board. The build adapter preserves original UUIDs and deterministically identifies newly explicit fields. Its single custom rectangular pad is represented by two same-number rectangles with the identical copper union. Multi-layer keepouts become individual layer records. Original electrical geometry is retained. The native schematic adds five virtual testbench components without moving the original circuit or changing PCB bytes.

Passive R/C/L Values contain only their nominal value and unit, such as L2 = `10uH` and C4 = `100u`. The original current/voltage/power ratings, dielectric, package and series text are retained in ordinary `Specifications` fields on schematic instances and PCB footprints. Pinned originals and reference notes retain their source text. Simulation signatures use the cleaned native Values.

The Home annotation layout changes only instance Reference/Value placement and alignment. Rendered glyph checks cover the 228 original visible fields; five new virtual testbench components add their own references, Values and named rails in a separate framed area above the original circuit. Panel borders use a common 2.54 mm gap in both directions; the five virtual components use equal horizontal centre spacing. Section 7, the datasheet-link note panel, is removed from the generated schematic; component Datasheet/Product page fields and pinned upstream notes remain available. Regression checks retain embedded libraries, part poses, wires, labels, PCB bytes and the complete compiled SPICE deck.

`scripts/check-emc-flyback-kicad.py` independently uses KiCad 10.0.1 to compare original and converted connectivity, footprint positions/UUIDs, pad copper, all 359 tracks and 155 vias, including 124 locked tracks and 32 locked vias. These are native-conversion checks rather than ERC/DRC or manufacturing approval.

## Electrical comparison

`npm run simulation:check-emc-flyback` runs the bundled ngspice 47 transient for 10 ms with a 5 ns maximum step. The visible native bench uses V1 = 24 V, R21 = 10 mΩ source resistance, V2 = 12 V ideal controller supply, R22 = **100 Ω external load** and I1 = 0.5 A pulse load, with the original 4.7 Ω gate resistor and CTR = 1. These source/load parameters are read from the schematic; missing devices are not synthesized. At 12 V, the resistor draws 0.12 A; the current source adds 0.5 A before 2 ms and after 4 ms. The 2–4 ms interval removes that additional current. These load definitions do not establish the measured operating voltage.

The behavioural controller, fitted MOSFET and generic diodes follow the pinned approximate upstream bench. Its 24.4 Ω external resistor defines a different operating point, so upstream current, loss, ripple and efficiency tolerances do not qualify the 100 Ω Home bench. The original upstream measurements remain in the pinned source files.

The check validates the completed duration, bounded output-voltage windows and final mean rectifier-current balance against the 100 Ω resistor plus current source. It records input/output power, ripple, diode currents, drain-to-ground and internal drain-to-source peaks, all supported signed device losses, and exact source/deck hashes under `test-results/emc-flyback-simulation/`. The upstream measure named `Vds_max` means drain voltage relative to ground; the internal model-pin differential and startup maxima are separate measurements.

Thermal inputs use the final 20% of the original accepted native SPICE samples. The 17 supported paths exclude transformer, controller, gate-drive, input protection and other omitted losses. [Simulation](SIMULATION.md#full-resolution-dissipative-power) defines the sampling and model boundaries. Numerical results apply only to their recorded load, timing, model and source identities.

## Thermal comparison

`npm run thermal:check-emc-flyback` runs bundled Gmsh and Elmer with the matching completed 100 Ω SPICE heat inputs. It records the actual mesh, temperature field, energy balance and area-weighted pad temperatures under `test-results/`. The default mesh setting is 2 mm; `-- --mesh-size-mm=3` requests a separate coarser comparison. Two resolutions alone do not establish mesh convergence.

OpenPE uses constant isotropic FR4 at 0.3 W/(m·K), copper at 400 W/(m·K), 35 µm copper layers, 25 µm plating and prescribed front/back/edge convection of 10/10/5 W/(m²·K). Supported losses enter the PCB through their actual pads. The [upstream design report](https://github.com/ChengminLi/AI-PCB-layout/blob/e1b9a64ac9ac306647fa30094932fb792d17e373/examples/emc-flyback-demo/report/EMC_flyback_design_report.pdf), pages 18–19, includes an aluminium case, Q1 thermal contact, radiation, anisotropic FR4, temperature-dependent cooling/losses and additional prescribed device losses. Its load and thermal assumptions differ from the Home bench.

PCB pad temperatures cannot stand for component junction/case temperatures or establish agreement with that enclosure-coupled model. The editable CAD enclosure adds no thermal coupling to this solver. [Thermal FEM](THERMAL.md) defines the supported board-only analysis. The reference PDF SHA-256 is `d67a002e928b233f77dcb4d43a48ebd78a6bd54956720b65b271e794f894ced3`.

## Enclosure CAD

Model contains four editable CAD boxes forming an aluminium base, two side walls and a transparent PMMA cover. The example starts at 112 × 94 × 33 mm, 3 mm walls, 8 mm board-to-floor clearance and a 3 mm cover. Four base holes follow MH1–MH4; four 3.2 mm cover holes are independent editable parameters. Source, native Save, history and whole-project Undo retain the assembly in the native project settings. Electrical geometry remains unchanged.

STEP export uses verified Gmsh/OpenCASCADE solid operations. `npm run cad:check-model` verifies that the example export contains four independent manifold solids and eight cylindrical through cuts, and reimports the exported STEP to check panel bounds. It writes artifacts under `test-results/model-cad/`. This is enclosure CAD; whole-assembly 3D simulation has no registered capability or plugin.
