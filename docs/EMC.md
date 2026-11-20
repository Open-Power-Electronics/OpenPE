# EMC Analysis

EMC Analysis is an independently implemented, read-only built-in plugin under
`plugins/emc-analysis/`. It provides explicit design intent, geometric PCB
screening, grouped findings, board locating, manual review, justified exceptions
and downloadable reports. It reads the current accepted Layout; it does not
predict emission magnitude or determine regulatory compliance.

## Workflow and ownership

Enable EMC Analysis in Plugins and open it from the Layout toolbar. Setup
declares actual net IDs as fast, switching, sensitive or supply, with optional
reference-net/layer assignments. A single selected track/via net can seed the
opening draft. Roles are never inferred from net names, component references or
library metadata. Explicit connector and decoupling assignments supply context
that native geometry does not contain. Limits are editable user engineering
budgets; original defaults are starting values, not standards limits.

Findings group by check and filter by severity. Each occurrence retains
confidence, measurements, limits, objects, explanation and remediation.
Confidence describes geometric evidence, not a probability of compliance.
Warning, information and not-verified counts remain distinct. Current tracks,
vias, footprints and pads can be selected and centered from a finding. Pads
select their owning footprint and center the transformed pad. Locating keeps
the review open and obeys layer/category/lock filters. It changes no visibility
or copper. Source, close, overlays, PCB synchronization and retained invalid
Properties drafts block it.

The header and Check/Recheck/Retry footer remain fixed around a scrolling body.
Setup, Findings and Checklist share one panel session. Invalid settings remain
editable. Board/revision/intent changes or unmount cancel obsolete queries and
remove inapplicable reports, manual decisions and exceptions. IME composition,
including 229, cannot check, locate, record decisions, export or close. Quantity
fields and Select menus follow the shared equal-width popup contract.

`emc.reviewLayout` returns `{boardId,revision,result}` from the originating
project's scoped capability host; `result` is the exact pure review contract.
`emc.inspectLayout` separately exposes selected-net measurements. Both are
plugin-owned queries behind confirmed installation/enablement, accepted PCB,
Source/close, cancellation and expected-revision gates. Neither adds native
writes, service routes, solvers, network access or document mutation.

Settings, findings, decisions and exceptions remain in the panel session or
Agent response. They never enter native designs, Core revisions, undo, dirty
state, recovery or automatic Agent context. Closing discards the session. No
project plugin directory is created. Disable/uninstall cancels work and closes
the panel without deleting designs or user downloads.

## Geometric screening

The original check set has eight bounded families:

| Check               | Evidence and limit                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routed length       | Sum of selected-net track centerlines, including branches/stubs, against a user length budget; not source-to-load path length or delay.                          |
| Via count           | Native via count against a user budget; not verified layer transitions or return connections.                                                                    |
| Board edge          | Critical-track copper clearance to closed Edge.Cuts/cutouts, including track radius. Missing usable outline is not verified.                                     |
| Net separation      | Same-layer fast/switching versus explicitly sensitive tracks, including widths. Pads, pours and fields are outside this measurement.                             |
| Reference fill      | Exact centerline intervals projected onto canonical saved-fill polygons on the declared reference net/layer, including fill holes; not return-path connectivity. |
| Reference vias      | Critical-net via proximity to declared reference-net vias; proximity/net assignment cannot prove plane contact or return continuity.                             |
| Decoupling          | Explicit target pad/capacitor footprint supply/reference-net evidence and transformed pad-center proximity; no inferred capacitor identity or effectiveness.     |
| Connector placement | Explicitly edge-intended connector pad context relative to the outline; no universal connector-placement, filter or shielding claim.                             |

Every result has `completeness:"partial"`; checks separately report checked,
not verified or not applicable. Missing references, fills, geometry or bindings
cannot imply clean results. Empty saved fills differ from missing fills. Checks
never refill copper or repair data.

Saved-fill normalization uses the shared 0.0001 mm polygon grid; smaller gaps
cannot be resolved. Curved Edge.Cuts follow the canonical bounded polygon
approximation. Interval partitioning is exact within those prepared polygons,
not byte-exact subgrid or analytical curved geometry. Check notes retain these
limits; zero geometric findings do not establish a clean EMC result.

Review accepts up to 32 unique net intents, 32 decoupling assignments and 32
edge-intended connectors, with at least one explicit intent. Distance budgets
are positive finite mm; via budgets are bounded nonnegative integers. Current
IDs, board layers and assignment relationships validate before measurement.
Work is bounded to 100,000 records, 10,000 nets, 20,000 geometry vertices, 500
outline graphics and two million geometric operations. Excess work fails
explicitly. At most 500 findings return, with exact summary counts and explicit
truncation.

`emc.inspectLayout` accepts 1–32 net IDs and an individual straight-segment
budget. It returns lengths, tracks/vias/pads, fill counts and capped segment/
missing-fill details. Its 256-detail cap is explicit. Splitting a native track
can change segment findings without changing the review's total routed length.

## Manual review, exceptions and reports

Eight original manual prompts cover switching loops, return continuity,
decoupling connections, cables/filters/shields, stack-up, differential paths,
transient/protection review and the measurement plan. Each has an explicit
unreviewed, reviewed or needs-work state and bounded notes. Manual completion
never upgrades automated missing evidence or implies compliance.

An exception requires a nonempty reason for an existing finding in the current
report. It annotates that occurrence without removing it, reducing counts or
hiding missing coverage. New report bases clear old exceptions and decisions.
There is no silent approval or native-project persistence.

Explicit HTML/JSON download creates an `openpe-emc-review` version-1 report with
board/revision, intent/limits, coverage, retained findings, counts/truncation,
manual states/notes and exception reasons. Reports are artifacts, not native
designs or private snapshots. Fixed download filenames carry no project grant,
destination, baseline or solver store. JSON is bounded to 2 MiB, HTML to 8 MiB.
Export validates exact schemas and detached finite data, rejects unknown fields
and duplicates, escapes dynamic HTML and includes no scripts/external assets.
Notes remain plain text; downloading cannot dirty designs.

## Coverage and reference boundaries

Return-current connectivity, electrical loop area, dielectric stack-up and
impedance, differential source-to-load matching, filter performance, isolation,
shielding, cable/enclosure coupling and measured emissions require separate
evidence. Native total board thickness/layer names are not a dielectric stack-up.
This is neither complete KiCad DRC nor an electromagnetic solver. No regulatory
limit tables, compliance score or pass are provided.

The reference is the public
[EMClytics workflow](https://github.com/renanbuzetti/EMClytics/blob/84d65d47b63040cb259ca0b95193816599469103/README.md),
reviewed at commit `84d65d47b63040cb259ca0b95193816599469103`. It advertises 39
automatic checks and 288 layout rules; those are upstream claims, not OpenPE
coverage. OpenPE independently implements the workflow and bounded checks
above, with no rule-by-rule equivalence or affiliation claim.

EMClytics provides documentation/releases rather than open-source implementation.
Its [controlling Portuguese license](https://github.com/renanbuzetti/EMClytics/blob/84d65d47b63040cb259ca0b95193816599469103/LICENSE.pt-BR.md)
and [English translation](https://github.com/renanbuzetti/EMClytics/blob/84d65d47b63040cb259ca0b95193816599469103/LICENSE.md)
restrict redistribution and reverse engineering/rule-base extraction. OpenPE
does not distribute its program, rules, artwork, screenshots or branding and
adds no dependency on it. No binary/rule-base extraction is used.

Public engineering context includes TI's
[AN-643 EMI/RFI Board Design / SNLA016B](https://www.ti.com/lit/an/snla016b/snla016b.pdf)
and [SWRA834A](https://www.ti.com/lit/an/swra834a/swra834a.pdf) on current loops,
return conductors and decoupling. They are linked, not bundled or reproduced
as rule tables. Context-specific recommendations are not universal thresholds
in this tool. Geometry and manual review do not qualify hardware.

## Verification

`tests/emc-layout.test.ts` verifies measurements/bounds/immutability.
`tests/emc-review.test.ts` covers geometric checks, intent, missing evidence,
transforms and capped work/results. `tests/emc-report.test.ts` checks strict
states, counts, detachment/bounds, HTML escaping and format.
`tests/emc-capabilities.test.ts` verifies GUI/Agent parity, schemas/lifecycle/
Source/revision/close gates and unchanged native bytes/undo.

`node scripts/check-emc-panel-ui.mjs` exercises review, delayed/stale results,
filters, locating, manual decisions, exceptions, downloads, IME and narrow menus.
`node scripts/check-emc-layout-locate-ui.mjs` exercises actual Layout locating,
camera/selection, hidden/filtered targets, retained drafts and zero design writes
with mocked host services. These are not desktop integration, native solver or
real EMC measurement evidence.
