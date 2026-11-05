# Electrical and board rule checks

OpenPE provides explicit, read-only schematic ERC and Layout DRC for the supported editor data. They inspect physical connectivity and geometry independently of SPICE participation, footprint classification and simulation plugin availability. The checks do not implement KiCad's complete rule system or qualify hardware or manufacturing readiness.

## Running and locating

Open **Rule** from the single clipboard-check button before List in the upper-right mode-row project actions. The same button is available in Schematic, Layout, Model and Source and directly opens one independent centered **Rule** window with **ERC** and **DRC** tabs and resizing from all four edges and corners, without a special corner mark. Schematic and Source open on ERC; Layout and Model open on DRC when the project has a PCB, otherwise ERC. Opening or switching tabs runs the selected check immediately without changing the underlying editor view. Simulation and Thermal FEM stay in a separate left-aligned Plugins group after the editing tools. ERC targets the active schematic; independent schematic files have no cross-file electrical joins. DRC targets the project's board, which belongs to its primary schematic. Pending Source and a project-close barrier disable Rule; the DRC tab is disabled without a PCB. Synchronizing or failed board data blocks DRC. Pointer and keyboard activation respect IME composition.

The panel shows error/warning counts, compact issue rows with rule IDs and concise incomplete/truncated status. Red rule names and leading borders identify errors; amber identifies warnings. Rows omit repeated Error/Warning labels while their accessible descriptions retain severity; the summary names each count once. Each whole row is one native button, activated by pointer or Enter/Space; there is no separate Locate icon. Long descriptions wrap, unavailable targets remain readable but disabled, and IME composition cannot activate a row. ERC and DRC tabs use distinct electrical-connection and PCB-clearance outline icons. Checked-rule lists and explanatory coverage-note paragraphs are omitted from the panel; Core query results retain `checkedRules` and `notes`, with coverage documented below. Locate closes the window, reveals Schematic for ERC or Layout for DRC through the existing navigation guards, selects supported visible objects and centers a temporary marker on the issue without editing design data. Reopening retains the report while a fresh check runs; locating is disabled until it settles. A changed document, active schematic or DRC threshold makes the retained report stale and disables locating until Recheck. View, Home and project switches hide the panel/marker and cancel obsolete requests. The panel and engines load only on first use.

Checks, locating, reports and threshold changes create no design revision, undo step, dirty flag, native content or recovery record. Reports and thresholds belong to the mounted project's session. Human actions and Agent queries share `schematic.erc` and `layout.drc`; see [API](API.md). Cancellation and revisions are rechecked after loading an engine, before returning a result.

## Schematic ERC

ERC uses transformed embedded-library pin geometry, physical pin identity and the same net grouping as the editor. Intentional junctions, attached labels, wire endpoints and shared physical pins connect; incidental wire crossings do not. Simulation exclusion and an absent footprint never remove physical ERC participation.

| Rule                                                    | Reported condition                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `erc.reference-conflict`                                | Unrelated symbols or repeated units share a reference; valid units of one physical component share identity.      |
| `erc.pin-type-unsupported`                              | An embedded pin has an unrecognized electrical type; pin classification is incomplete.                            |
| `erc.pin-type-inconsistent`                             | Units declare conflicting electrical types for one physical pin; driver classification is incomplete.             |
| `erc.pin-unconnected`                                   | A required pin is physically unconnected and has no valid no-connect marker.                                      |
| `erc.input-undriven`                                    | An input network has no declared signal driver.                                                                   |
| `erc.power-undriven`                                    | A power-input network has no declared power output.                                                               |
| `erc.output-conflict`                                   | Multiple unconditional outputs or incompatible output drivers share a network.                                    |
| `erc.net-name-conflict`                                 | One physical network has conflicting explicit net names; hidden power defaults apply only without explicit names. |
| `erc.wire-dangling` / `erc.wire-zero-length`            | A wire has an unattached endpoint or zero length.                                                                 |
| `erc.label-dangling`                                    | A net label has no attached wire or pin.                                                                          |
| `erc.no-connect-misplaced` / `erc.no-connect-connected` | A no-connect marker misses a pin or a declared no-connect pin/marked pin is connected.                            |

Driver warnings require interpretation. Passive components and external connectors do not establish a declared driver; power symbols name a supply but do not establish a power output. An appropriate power flag can declare an external supply. ERC does not simulate conditional tri-state or open-collector/open-emitter states, timing, voltage compatibility or component operating limits. Unconnected passive and unspecified pins also warn; free and declared no-connect pins do not require ordinary unconnected-pin warnings. A valid no-connect marker suppresses an intentional unconnected-pin warning.

Work is bounded to 2,000 components, 10,000 wires, 30,000 physical anchors and 30,000 no-connect markers per sheet, with two million additional contact operations and the net grouper's existing bounds. Excessive geometry fails visibly. Reports retain at most 1,000 issues and 64 object links per issue; truncation makes the report incomplete. Unsupported pin types also make it incomplete. A failed or incomplete check is never a clean result.

## Layout DRC

DRC inspects visible and hidden board copper. Transformed pads, straight tracks, through vias, supported copper graphics and stored zone fills retain their actual copper layers, holes and board cutouts. Same-net contact is permitted; different copper layers do not create a short without a physical connection. Unassigned copper contacts produce warnings and incomplete coverage rather than being treated as a known same-net connection.

| Rule                          | Reported condition                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pcb.outline`                 | Missing, open, intersecting or otherwise unusable Edge.Cuts prevents board-edge checks.                            |
| `pcb.short` / `pcb.clearance` | Known different-net copper touches or is closer than the chosen clearance on a shared layer.                       |
| `pcb.track-width`             | A track is narrower than the chosen minimum.                                                                       |
| `pcb.via-drill`               | A through via drill is smaller than the chosen minimum.                                                            |
| `pcb.annular-ring`            | A via or plated through-hole pad has insufficient annular ring.                                                    |
| `pcb.copper-edge`             | Copper extends outside the board, into a cutout or too close to an edge.                                           |
| `pcb.copper-hole`             | Copper is too close to a non-plated or foreign-net plated hole; legitimate same-net plated contacts are permitted. |
| `pcb.keepout`                 | Copper enters a keepout whose track/via/pad/pour flag applies.                                                     |
| `pcb.unrouted`                | Assigned pads of a net remain in disconnected copper groups.                                                       |

Thresholds are independent of routing tool settings and are not imported from KiCad net classes or saved into the project:

| Setting              | Default, mm |
| -------------------- | ----------: |
| Copper clearance     |        0.15 |
| Minimum track width  |         0.2 |
| Minimum via drill    |         0.1 |
| Minimum annular ring |        0.05 |
| Copper to board edge |        0.25 |
| Copper to hole       |        0.25 |

These defaults must accept the dimensions of all nine reference boards without DRC errors; enabled unfilled zones still warn. They are not fabrication requirements. Each threshold accepts a finite value from 0 to 1,000 mm. Zero removes that minimum; it does not permit different-net shorts or copper outside the board. Distances use the editor's bounded curve/pad approximation, with exact centered circular pad/via contact and annular-ring calculations. Pour keepouts reject filled-area overlap using the shared bounded polygon geometry; a saved pour may share a keepout boundary without entering it.

Zone outlines are not copper. Enabled unfilled zones produce `pcb.unfilled-zone`. Copper, boundary and zone-rule edits automatically refresh already-filled enabled zones once in the accepted Core transaction; failed calculation rejects the edit and preserves the accepted geometry and contours. Worker-calculated gesture fills and their temporary conservative masks are presentation only and provide no DRC or connectivity evidence. Unfilled/disabled zones are not automatically filled. DRC itself inspects stored fills without regeneration or a blanket freshness warning. A completed empty fill is valid and contains no copper; disabled pours and keepouts do not need fill data. Copper text/dimensions and footprint keepout/courtyard occupancy report unsupported coverage. Missing fills and unsupported coverage make the report incomplete, even when its inspected geometry has no errors. Solder mask, silkscreen, creepage, impedance, net classes, differential pairs and fabrication rules are outside the checker.

DRC bounds include 15,000 copper objects, 120,000 vertices, two million geometry operations and the shared connectivity analyzer's limits. Excessive or invalid geometry returns an incomplete report with an actionable note in the query result; the issue list is capped at 1,000. The panel retains the incomplete/truncated status, and a no-issues conclusion requires a complete current report. Refill and verify exported boards in KiCad before manufacturing.

## Verification

`tests/reference-drc.test.ts` checks all nine curated boards with the shared defaults, requiring zero errors, warnings only for missing fills and unchanged board data. `tests/pcb-drc.test.ts` checks missing-fill warnings and explicit refilling. `tests/pcb-dynamic-fill.test.ts` covers automatic fill refresh as part of accepted Core edits.

`tests/schematic-erc.test.ts`, `tests/pcb-drc.test.ts` and `tests/rule-check-capabilities.test.ts` cover electrical/geometry rules, boundaries, immutable inputs and shared query lifecycle. `node scripts/check-rule-issue-actions.mjs` checks the real component's rendered actions and event handlers without a browser; it does not establish native keyboard or visual evidence. `node scripts/check-rule-check-panel-ui.mjs` verifies panel input, issue summaries, incomplete/truncated status, the absence of checked-rule lists and explanatory notes, and stale-result behavior. `node scripts/check-design-rules-ui.mjs` verifies the actual workspace's toolbar actions, independent windows, locating, repair/recheck, project isolation and read-only behavior using isolated browser fixtures; neither script opens Electron or a user project.
