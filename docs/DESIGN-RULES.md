# Electrical and board rule checks

OpenPE provides read-only schematic ERC and Layout DRC for the supported editor data. They inspect physical connectivity and geometry independently of SPICE participation, footprint classification and simulation plugin availability. The checks do not implement KiCad's complete rule system or qualify hardware or manufacturing readiness.

## Running and locating

Open **Rule** from the Error/Warning summary at the left edge of the editor footer. It opens a compact, non-modal **Rule** popup in the lower-left of the editor. Schematic and Source show **ERC**, Layout shows **DRC**, and Model shows its preview checks. Opening ERC or DRC immediately displays any retained report and queues one idle refresh. SPICE Simulation and Layout Thermal appear in their respective editors’ left-aligned Plugins group after the editing tools. ERC targets the active schematic; independent schematic files have no cross-file electrical joins. DRC targets the project's board, which belongs to its primary schematic. Pending Source and a project-close barrier disable Rule; Layout and Model require a PCB to open Rule. Synchronizing or failed board data blocks DRC. Pointer and keyboard activation respect IME composition.

The footer summary uses the same two severity counters in every view: Error and Warning. It shows ERC results for Schematic and Source, DRC results for Layout, and Model preview checks for Model. Core coverage notes remain separate from issues. Only a current report supplies numbers. A complete current report with zero errors replaces the error icon with a distinct green check icon and green zero count; positive errors retain the red error icon. The warning triangle is amber for positive counts and gray for zero or unknown counts. Zero errors in a partial report and unknown error counts use neutral circles. Counts awaiting a refreshed report show em dashes without a status label. First checks and manual checks show their normal Not checked or Checking… states when applicable. Failed checks show Check failed, with known Model preview errors retained as described below. Counts and report state stay within their originating project.

The active workspace runs automatic electrical checks during browser idle time. A check without a retained report queues immediately when input has been quiet for 50 ms or there has been no input. Opening Rule with a retained report waits for 250 ms of settling and quiet input. After an edit, stale Layout DRC waits for 150 ms and stale Schematic or Source ERC waits for 650 ms to combine nearby edits. A held pointer defers the check, and release or cancellation restarts the quiet-input wait. A current report is reused until its basis changes or Rule is reopened. Automatic refreshes of an existing report run without a progress label or spinner, including while Rule is open. Automatic work pauses for pending native Source, project close, another modal or confirmation, and pending or failed PCB synchronization for DRC. Refreshes wait for pending DRC limit drafts in the popup to be resolved. Hidden projects and Home do not start checks. A failed automatic attempt is not repeated for the same kind, revision, sheet or board, and applied rule settings. A new basis or opening Rule in the corresponding view can retry. Model admission and preview retries do not execute DRC.

Clicking the count control opens the current view’s Rule popup. Activating Run/Recheck in the popup header starts a check immediately and consumes any queued opening refresh. Idle and manual checks share the guarded query runner. Actions retain Source, close and IME gates; late results or errors cannot replace a newer project, revision or view.

The panel shows a green check and a no-violations message for a complete current report with zero findings. Other reports show Error and Warning counters, compact issue rows with rule IDs and notices for partial reports or truncated findings. Positive counts use their severity colors. The warning triangle stays gray at zero or when its count is unknown. Zero errors in a partial report stay neutral. Stale or unavailable counts show em dashes. Red rule names and leading borders identify errors, muted gray identifies warnings. Rows omit repeated severity labels while their accessible descriptions retain severity; the summary names each count once. Each whole row is one native button, activated by pointer or Enter/Space; there is no separate Locate icon. [Design](../DESIGN.md#rule-and-version-history) owns issue row layout and scrolling. Assistive technology receives the complete message. Unavailable targets remain disabled, and IME composition cannot activate a row. Checked-rule lists and explanatory coverage-note paragraphs are omitted from the panel; Core query results retain `checkedRules` and `notes`, with coverage documented below. Locate keeps Rule open, reveals Schematic for ERC or Layout for DRC through the existing navigation guards, selects supported visible objects and positions a temporary marker beside the panel without editing design data. Locating from Source carries the current ERC report into Schematic. Reopening retains the report and allows locating from current results until the refresh starts. Locating is disabled during the check. The footer toggle, Close Rule and Escape from Rule or its trigger remain available during ERC/DRC checks and cancel the active query; a missing or stale current-view footer check can then resume when eligible. A changed document, active schematic or applied rule setting makes the retained report stale and disables locating until a fresh check completes. Ordinary view, Home and project switches hide the panel and marker and cancel obsolete requests. Opening another dialog or confirmation collapses Rule and cancels its active check. The panel loads when opened. Automatic and manual checks run only while eligible.

Checks and locating are read-only. Reports, quick-field selection and severity overrides belong to the mounted project session. Applied DRC threshold edits update the native project file in one undo transaction and participate in dirty state, recovery, Save and Save as. Settings → Rule edits the active project. Reset to default asks for confirmation before staging the Workbench thresholds and default rule severities in the draft. Done commits the validated settings while Rule is selected. An unapplied Settings draft remains available for editing while checks use the applied settings. Human actions and Agent queries share `schematic.erc` and `layout.drc`. Cancellation and revisions are rechecked before returning a result. [API](API.md)

## Model checks

The Model tab and Model footer use the same two severity categories for the exact current board and primary schematic. Unassigned or unavailable model resources, including mounting-hole models, and limited 3D solder-mask text and dimension omissions are Warnings. Caught model loading or parsing failures, copper rendering exceptions, fatal board-preview failures and CAD geometry failures are Errors. These are preview diagnostics, not electrical DRC or manufacturing qualification. Component rows use concise text such as `MH1: No 3D model`. These categories share the standard counters; there is no separate Model-specific counter or drawing-corner control.

Normal Model loading gathers these observations and shows Checking… with unknown counts until ready. An unopened or changed preview offers Open Model instead of showing a clean result. Ready reports expose their actual Error/Warning counts; only complete current zero-error results use the green check icon. A fatal preview failure retains its known error count with Check failed. The Model tab itself starts no additional ERC/DRC check and does not silently load a hidden 3D scene.

Model preview errors retain their existing Retry actions, and read-only history keeps its component retry control. Reports stay local to the mounted workbench and never enter Core, native files, undo, recovery or Agent rule results. Renderer reports and electrical Core protocols both use error/warning severities; preview reports add no API capability.

Clicking a component row, or pressing Enter/Space, keeps Rule open, reveals Model through the existing navigation guards, centers and zooms to the footprint, selects it and reveals Properties. Camera orientation is retained; holes without a component mesh use their native footprint bounds. Source, project close, changed preview basis, CAD drafts/tools, selection filters, inactive projects and IME composition block inapplicable locating. Issues without a component target remain plain read-only rows. Read-only history retains its own retryable preview Error/Warning summary and camera-only locating.

## Schematic ERC

ERC uses transformed embedded-library pin geometry, physical pin identity and the same net grouping as the editor. Intentional junctions, attached labels, wire endpoints and shared physical pins connect; incidental wire crossings do not. Simulation exclusion and an absent footprint never remove physical ERC participation.

Only the declared LP label names of a fully validated native
[parasitic series group](LAYOUT.md#parasitic-study-schematics) are recognized as
aliases of that group's endpoint networks for name-conflict reporting. The
native wire/pin topology and driver checks remain unchanged. Other conflicting
names, malformed group declarations and ordinary LP-looking labels receive the
usual checks; the naming pattern alone grants no exemption.

| Rule                                                    | Reported condition                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `erc.reference-conflict`                                | Unrelated symbols or repeated units share a reference; valid units of one physical component share identity.      |
| `erc.pin-type-unsupported`                              | An embedded pin has an unrecognized electrical type; pin classification is incomplete.                            |
| `erc.pin-type-inconsistent`                             | Units declare conflicting electrical types for one physical pin; driver classification is incomplete.             |
| `erc.pin-unconnected`                                   | A required pin is physically unconnected and has no valid no-connect marker.                                      |
| `erc.input-undriven`                                    | An input network has no declared signal driver.                                                                   |
| `erc.power-undriven`                                    | A power-input network has no declared power output.                                                               |
| `erc.output-conflict`                                   | The default pin conflict table flags incompatible driver or power pin types sharing a network.                    |
| `erc.pin-conflict`                                      | An unspecified pin shares a network with another electrical pin.                                                  |
| `erc.net-name-conflict`                                 | One physical network has conflicting explicit net names; hidden power defaults apply only without explicit names. |
| `erc.wire-dangling` / `erc.wire-zero-length`            | A wire has an unattached endpoint or zero length.                                                                 |
| `erc.label-dangling`                                    | A net label has no attached wire, pin or other label.                                                             |
| `erc.no-connect-misplaced` / `erc.no-connect-connected` | A no-connect marker misses a pin or label, or a declared no-connect pin or marked pin is connected.               |

Ordinary input nets accept output, power output, bidirectional, tri-state or passive pins. A net with a power input, including a power symbol, requires a power output on that net. A power flag can declare an external supply. ERC reports one driver error per undriven net and reports the first matching driver conflict per net in fixed priority order. An unattached required pin or label is an error. Free pins, declared no-connect pins and pins with valid no-connect markers are exempt from the unconnected-pin check. A misplaced no-connect marker warns. A connected no-connect marker or declared no-connect pin reports an error. Project pin-map overrides, external library comparisons, net-chain drive inference and electrical operating limits are outside this check. [KiCad 10 ERC rules](https://docs.kicad.org/10.0/en/eeschema/eeschema.html)

Work is bounded to 2,000 components, 10,000 wires, 30,000 physical anchors and 30,000 no-connect markers per sheet, with two million additional contact operations and the net grouper's existing bounds. Excessive geometry fails visibly. Reports retain at most 1,000 issues and 64 object links per issue; truncation makes the report incomplete. Unsupported pin types also make it incomplete. A failed or incomplete check is never a clean result.

The Schematic severity selector shows Error, Warning or Off. Output conflicts and connected no-connect findings default to Error. Off suppresses the findings and yields a partial report. Checks still use the same physical connectivity.

## Layout DRC

DRC inspects visible and hidden board copper. Transformed pads, straight and arc tracks, supported vias and copper graphics, and stored zone fills retain their actual copper layers, holes and board cutouts. Same-net contact is permitted. Different copper layers require a physical connection to create a short. Unassigned copper contacts produce warnings and incomplete coverage.

| Rule                              | Reported condition                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pcb.outline`                     | Missing, open, intersecting or otherwise unusable Edge.Cuts prevents board-edge checks.                            |
| `pcb.courtyard-malformed`         | A footprint courtyard contains open, degenerate or intersecting contours.                                          |
| `pcb.courtyard-overlap`           | Two footprint courtyards overlap on the same side of the board.                                                    |
| `pcb.short` / `pcb.clearance`     | Known different-net copper touches or is closer than the chosen clearance on a shared layer.                       |
| `pcb.track-width`                 | A track is narrower than the chosen minimum.                                                                       |
| `pcb.via-drill` / `pcb.pad-drill` | A supported primary drill is smaller than the board minimum or a backdrill cutter cannot remove its barrel.        |
| `pcb.via-diameter`                | A via land diameter is smaller than the chosen minimum.                                                            |
| `pcb.annular-ring`                | A via or plated through-hole pad has insufficient annular ring.                                                    |
| `pcb.copper-edge`                 | Copper extends outside the board, into a cutout or too close to an edge.                                           |
| `pcb.copper-hole`                 | Copper is too close to a non-plated or foreign-net plated hole; legitimate same-net plated contacts are permitted. |
| `pcb.holes-co-located`            | Primary round drills share a centre on overlapping drill spans.                                                    |
| `pcb.keepout`                     | Copper enters a keepout whose track/via/pad/pour flag applies.                                                     |
| `pcb.unrouted`                    | Assigned pads of a net remain in disconnected copper groups.                                                       |

OpenPE assembles closed board and footprint `Edge.Cuts` shapes into material contours for board-edge checks. Saved zone fills on `Edge.Cuts` remain technical artwork and are excluded from the material contour and copper checks. Native curved board edges, including cubic Bézier segments, are subdivided to a maximum 0.0005 mm error. A clearance within 0.0006 mm of a curved outline decision boundary may yield a partial result with `pcb.geometry-limit`. OpenPE runs these checks locally with the stored board geometry. [KiCad 10 outline assembly](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/convert_shape_list_to_polygon.cpp)

The Rule popup exposes board-wide minimum copper clearance, minimum track width, copper-to-board-edge distance, minimum through-hole diameter and minimum via diameter. All thresholds are editable in Settings → Rule and independent of routing tool settings.

| Setting                             | Default, mm |
| ----------------------------------- | ----------: |
| Board-wide minimum copper clearance |        0.15 |
| Minimum track width                 |         0.2 |
| Minimum through-hole diameter       |         0.1 |
| Minimum via diameter                |         0.2 |
| Minimum annular ring                |        0.05 |
| Copper to board edge                |        0.25 |
| Copper to hole                      |        0.25 |
| Hole to hole                        |        0.25 |
| Silkscreen clearance                |           0 |
| Silkscreen text height              |         0.8 |
| Silkscreen text thickness           |        0.08 |

The table lists defaults for thresholds absent from the native project. Enabled unfilled zones still warn. They are not fabrication requirements. Each threshold accepts a finite value from 0 to 1,000 mm. Zero removes that minimum; it does not permit different-net shorts or copper outside the board. Distances use the editor's bounded curve/pad approximation, with exact centered circular pad/via contact and annular-ring calculations. Pour keepouts reject filled-area overlap using the shared bounded polygon geometry. Their boundary allows one 0.0001 mm clipping-grid cell of tolerance so rounding shared sloped edges does not create false violations; copper farther inside remains an error regardless of its area. This tolerance applies only to saved pours, without changing stored geometry or other copper checks.

The Workbench starts with all implemented checks enabled. Off omits a rule's findings and checked rule ID. A disabled check or a query with a subset of groups yields a partial report. See the rule settings tabs and controls in [Design](../DESIGN.md#settings-and-appearance).

An admitted board returns a DRC report even when it has design violations or
uses geometry that some checks cannot measure. A `pcb.coverage` finding explains
skipped rules. Independent track-width, outline, courtyard and silkscreen checks
continue where their own inputs are supported. Design errors remain findings in
the report. The `complete` flag describes coverage of the enabled checks.

Manual and automatic Workbench DRC and direct queries use the project thresholds and supported KiCad net-class and custom clearance rules by default. The board-wide minimum copper clearance is a floor for every applicable pair, including saved zone fills. Direct queries may also enable saved-zone clearance values. With those options enabled, disabling a conditional rule falls through to the next matching rule or the ordinary clearance. Disabling a net-class limit leaves its assignment available to conditions. Source overrides apply to current source keys and leave native files and saved fill geometry intact.

For each foreign-net pair, a positive native pad or inherited footprint clearance takes precedence over the supported conditional rules and net classes. The larger local setting applies when both objects have one. A pad's explicit zero bypasses its footprint setting and falls through to the rules. The editable board minimum and enabled zone clearances remain floors for the local override. Without a positive local override, the last matching supported conditional rule in `.kicad_dru` supplies the clearance, with the board minimum as a floor. Otherwise, DRC takes the maximum of the global limit, participating enabled zone values and enabled net-class values. The diagnostic names the controlling source. The KiCad source supports `.kicad_pro` net-class clearance and exact net-name patterns, and `.kicad_dru` version 1 rules containing a single minimum clearance in millimetres or mils. Supported conditions combine `A` and `B` net-class and object-type comparisons and exact-reference `intersectsCourtyard()` with `&&`, `||` and parentheses. Conditions test both operand orders. Unsupported project rules produce an incomplete clearance report when the KiCad source is enabled. [KiCad 10 custom rules](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html#custom-design-rules)

DRC checks imported circular tracks for width, clearance, edge spacing,
keepouts and connectivity. It checks a via's actual copper spans and land sizes.
It checks a backdrill's bore from the entry through its must-cut layer, where
the retained copper land no longer connects to the plated barrel. Native
backdrill geometry participates in hole spacing and copper-to-hole clearance.
Layer-specific padstacks map each land to its physical copper layers around the
common drill. Native custom pads use the union of their anchor and copper
primitives. Clearance decisions within the custom contour's precision can make
the report partial.

Native net ties retain their independently assigned pad networks. Clearance
between pads in the same declared group is waived within the owning footprint.
Artwork bridges are checked against their physical contacts on each layer.
External copper uses the allowance of an artwork primitive touching its own
network's declared pad. Connectivity requires the route to reach its assigned
pad, and a contact with an undeclared pad or unrelated network remains a short.

Courtyard checks use the native `F.CrtYd` and `B.CrtYd` contours at the footprint's current placement and rotation, regardless of locks or layer visibility. Each side is checked independently. Intersections of positive area are errors, while a shared edge at zero minimum spacing is allowed. Stroke width does not expand the courtyard. Missing courtyards are ignored by default, and invalid contours make coverage incomplete. Locating an overlap selects both footprints where visible and centers the marker at their overlap. Custom courtyard clearances and holes entering another footprint's courtyard are outside this check. [KiCad 10 DRC rules](https://docs.kicad.org/10.0/en/pcbnew/pcbnew.html)

Hole-to-hole clearance measures the gap across all nets on overlapping drill spans. It uses the actual centre for round holes and the full tool centreline for slots, with the tool radius and any pad drill offset applied. Primary round holes whose centres are less than 0.0005 mm apart on overlapping spans report a co-location warning when at least one hole is mechanical. A hole pair is reported once. The co-location rule has independent severity and runs even when the minimum drill spacing is zero. [KiCad 10 hole-to-hole checks](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/drc/drc_test_provider_hole_to_hole.cpp#L233-L292)

Silkscreen clearance compares same-side solid shapes and supported stroke text, excluding shape pairs belonging to the same footprint or the board itself. Visible native text supplies the height and stroke thickness checks. Display-only reference fallbacks are excluded. Native pad artwork, unsupported dashed artwork, dimensions or unresolved stroke text make the relevant silkscreen report partial. Set a positive minimum to run these threshold checks.

`pcb.silk-edge` reports a warning when supported visible silkscreen overlaps or
is too close to a closed board edge or cutout. An item wholly outside the board
is outside this check. The silkscreen clearance setting also sets the edge gap.
At zero gap the rule still checks for clipped ink. Near-threshold curved contours
can leave this rule partial. A broken outline still allows local checks against
measurable `Edge.Cuts` strokes. It leaves material containment and copper-to-edge
coverage incomplete. [KiCad 10.0.1 edge check](https://github.com/KiCad/kicad-source-mirror/blob/10.0.1/pcbnew/drc/drc_test_provider_edge_clearance.cpp)

Minimum copper connection width, microvia dimensions, creepage groove width,
thermal spoke counts, solder-mask clearances, impedance, differential pairs,
isolated copper and footprint-library comparison remain outside the checker.

DRC checks native circular and mixed line-and-arc rule areas on their declared copper layers, including areas owned by rotated footprints. Track, via and pad contact with a simple circle uses its exact radius. Other curved keepout checks use bounded contours and report `pcb.geometry-limit` when the approximation and clipping tolerances leave the result uncertain. Saved pours include the rule area's configured clearance. [Saved zone fills](LAYOUT.md#saved-zone-fills)

Zone outlines are not copper. Enabled unfilled zones produce `pcb.unfilled-zone` when a selected check needs saved fills. [Layout](LAYOUT.md#saved-zone-fills) defines which edits refresh saved fills. Worker-calculated gesture fills and their temporary conservative masks are presentation only and provide no DRC or connectivity evidence. DRC inspects stored fills without regeneration or a blanket freshness warning. A completed empty fill is valid and contains no copper. Disabled pours and keepouts do not need fill data. Copper text/dimensions and footprint occupancy of rule areas report unsupported coverage. Missing fills and unsupported coverage make the report incomplete, even when its inspected geometry has no errors.

For native connection-dependent pads and vias, DRC retains enabled end rings
and saved zone flashes. Other layers retain a land when eligible same-net
copper reaches the drilled section on that layer. Contacts between two
conditionally flashed pads or pads from one footprint do not force a flash.
The checker uses the resolved lands for geometry and connectivity while
retaining the drill span. A contact inside the contour error allowance leaves
coverage partial. [KiCad 10 pad flashing](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pad.cpp#L433-L506)
[KiCad 10 connectivity](https://github.com/KiCad/kicad-source-mirror/blob/10.0.1/pcbnew/connectivity/connectivity_data.cpp#L400-L455)

Layout can display native PCB data beyond the work bounds of copper analysis.
Native pad machining and some native via treatments remain outside the checker.
Native QR artwork leaves selected silkscreen checks partial.
Copper-to-edge clearance on castellated boards leaves OpenPE's report incomplete.

Explicit refill and automatic refresh apply the same accepted native net-class assignments and conditional-rule precedence as the checker, with their [bounded fill coverage](LAYOUT.md#saved-zone-fills). Refill never weakens a DRC limit or changes a check-only override to suppress a finding.

Copper-to-hole checks use a spatial index to find nearby drill candidates, then calculate exact supported clearances in native record order. DRC and connectivity share contours for exact owned pad geometry and unchanged board-level saved fills. Changed contours are decoded again, footprint-local contours use their current placement, and each board rechecks the aggregate saved-fill vertex limit.

DRC bounds include 15,000 copper objects, 120,000 vertices, two million geometry operations and the shared connectivity analyzer's limits. Excessive or invalid geometry returns an incomplete report with an actionable note in the query result. The issue list retains up to 1,000 findings. Checks continue within the geometry bounds after the report fills. The panel shows individual findings and identifies a truncated issue list. A no-issues conclusion requires a complete current report.

## Verification

With `KICAD_CLI` pointing to KiCad 10, run `node --import tsx scripts/check-home-drc-kicad.ts`. It compares minimum-size and copper-clearance findings by rule, severity and object UUID on all ten native Home boards. The comparison applies supported board minima, saved zone and net-class clearances and supported conditional rules. KiCad runs with `--all-track-errors` for a per-pair comparison. Reports and the remaining native finding counts are saved under `test-results/home-kicad-drc/`.

`tests/reference-drc.test.ts` checks all nine curated boards with the shared defaults, requiring zero errors, warnings only for missing fills and unchanged board data. The TPS61046 check also enables the saved-zone clearance source. `tests/pcb-drc.test.ts` checks missing-fill warnings, explicit refilling, shared sloped keepout boundaries, genuine filled-area intrusion and an issue-free native EMC Flyback report with unchanged board data. The native portability test requires complete, issue-free ERC reports for all ten Home examples after a Save as round trip. `tests/pcb-dynamic-fill.test.ts` covers automatic fill refresh as part of accepted Core edits.

The EMC refill regression checks single-zone and all-zone commands, native Save/readback and exact undo/redo against the accepted net classes and conditional clearances. Fill, Worker and dynamic-edit regressions also cover reversed operand order, last-rule precedence, board floors, rule-only edits, unsupported-rule rejection and GUI/Agent native-file parity.

`tests/schematic-erc.test.ts`, `tests/pcb-drc.test.ts` and `tests/rule-check-capabilities.test.ts` cover electrical/geometry rules, boundaries, immutable inputs and shared query lifecycle. `node scripts/check-rule-issue-actions.mjs` checks the real component's rendered actions and event handlers without a browser; it does not establish native keyboard or visual evidence. `node scripts/check-rule-check-panel-ui.mjs` verifies panel input, single-line ERC messages with horizontal keyboard scrolling, wrapped DRC messages, partial report and truncation presentation, the absence of checked-rule lists and explanatory notes, stale-result behavior and Model loading/error/empty states. `node scripts/check-model-checks-ui.mjs` verifies Model preview Error/Warning counts, pointer/keyboard locating, camera orientation, both projections/themes, IME/Source/activity guards, read-only diagnostics and unchanged board data. `node scripts/check-design-rules-ui.mjs` verifies the actual workspace's idle scheduling, footer summary, project actions, lower-left popup placement, locating, repair/recheck, project isolation and read-only behavior in each editor view, using isolated browser fixtures; these scripts open neither Electron nor a user project.
