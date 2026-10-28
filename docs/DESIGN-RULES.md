# Electrical and board rule checks

OpenPE provides explicit, read-only schematic ERC and Layout DRC for the supported editor data. They inspect physical connectivity and geometry independently of SPICE participation, footprint classification and simulation plugin availability. The checks do not implement KiCad's complete rule system or qualify hardware or manufacturing readiness.

## Running and locating

Use **Electrical rules (ERC)** in Schematic or **Design rules (DRC)** in Layout at the upper-right editor toolbar, before Parts list and Version history. Simulation and Thermal FEM stay in a separate left-aligned Plugins group after the editing tools; rule checks stay with the right-aligned window actions. Checks open in an independent centered window with a bottom-right resize grip; opening does not run checks. ERC targets the active schematic; independent schematic files have no cross-file electrical joins. DRC targets the project's board, which belongs to its primary schematic. Pending Source, a project-close barrier and unavailable or synchronizing board data block running through the editor.

The panel shows error/warning counts, issue rows with rule IDs and concise incomplete/truncated status. Checked-rule lists and explanatory coverage-note paragraphs are omitted from the panel; Core query results retain `checkedRules` and `notes`, with coverage documented below. Locate closes the window, selects supported visible objects and centers a temporary marker on the issue without editing design data. Reopening retains the report. A changed document, active schematic or DRC threshold makes the retained report stale and disables locating until Recheck. View, Home and project switches hide the panel/marker and cancel obsolete requests. The panel and engines load only on first use.

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

These defaults must accept the dimensions of all nine reference boards without DRC errors; unfilled or invalidated zones still warn. They are not fabrication requirements. Each threshold accepts a finite value from 0 to 1,000 mm. Zero removes that minimum; it does not permit different-net shorts or copper outside the board. Distances use the editor's bounded curve/pad approximation, with exact centered circular pad/via contact and annular-ring calculations. Pour keepouts reject filled-area overlap using the shared bounded polygon geometry; a saved pour may share a keepout boundary without entering it.

Zone outlines are not copper. Enabled unfilled/invalidated zones produce `pcb.unfilled-zone`. Copper and zone-rule edits invalidate fills by removing their saved contours in the same transaction; refilling restores them. Stored fills are inspected without regeneration or a blanket freshness warning. A completed empty fill is valid and contains no copper; disabled pours and keepouts do not need fill data. Copper text/dimensions and footprint keepout/courtyard occupancy report unsupported coverage. Missing fills and unsupported coverage make the report incomplete, even when its inspected geometry has no errors. Solder mask, silkscreen, creepage, impedance, net classes, differential pairs and fabrication rules are outside the checker.

DRC bounds include 15,000 copper objects, 120,000 vertices, two million geometry operations and the shared connectivity analyzer's limits. Excessive or invalid geometry returns an incomplete report with an actionable note in the query result; the issue list is capped at 1,000. The panel retains the incomplete/truncated status, and a no-issues conclusion requires a complete current report. Refill and verify exported boards in KiCad before manufacturing.

## Verification

`tests/reference-drc.test.ts` checks all nine curated boards with the shared defaults, requiring zero errors, warnings only for missing fills and unchanged board data. `tests/pcb-drc.test.ts` also checks that copper edits invalidate fills and refilling clears the warning.

`tests/schematic-erc.test.ts`, `tests/pcb-drc.test.ts` and `tests/rule-check-capabilities.test.ts` cover electrical/geometry rules, boundaries, immutable inputs and shared query lifecycle. `node scripts/check-rule-check-panel-ui.mjs` verifies panel input, issue summaries, incomplete/truncated status, the absence of checked-rule lists and explanatory notes, and stale-result behavior. `node scripts/check-design-rules-ui.mjs` verifies the actual workspace's toolbar actions, independent windows, locating, repair/recheck, project isolation and read-only behavior using isolated browser fixtures; neither script opens Electron or a user project.
