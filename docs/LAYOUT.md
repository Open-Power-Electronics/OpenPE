# Layout and Model

Layout and Model share the native PCB linked to the primary schematic. Opening a
view does not create board data or dirty the project. New projects already contain
an empty PCB and empty Model CAD in their initial native file set. Layout supports bounded
manual editing of two-/four-layer boards, embedded footprints, straight tracks,
through vias, polygon zones and saved fills. Loaded supported artwork, holes,
pads, keepouts, dimensions and model transforms survive round trips. There is no
general importer, autorouter or full KiCad manufacturing-rule implementation.
Use the explicit [DRC report](DESIGN-RULES.md); structural acceptance, airwires,
routing checks and export do not establish manufacturing readiness.

[DESIGN.md](../DESIGN.md) owns visual/interaction conventions,
[FORMAT.md](FORMAT.md) native preservation and Source, and [CORE.md](CORE.md)
shared validation, revision and undo.

Agent object Properties expose the same pad preparation, exact track endpoints,
via edits, footprint flips/model transforms, board drawing records and boundary
resize functions as the GUI. Official footprint placement shares the chooser's
bounded parser and one assignment/board undo transaction. [API](API.md#layout-object-properties)
documents the direct commands and generated property schemas; these do not add
collision checks to numerical Properties beyond their documented Core validation.

## Custom component drawings

Draw component creates or edits a native embedded symbol or footprint through
shared Core commands. Symbol drawing supports one unit with rectangles, circles,
polylines and typed/numbered pins, up to 256 graphics and 256 pins. Unsupported
primitives or multiple units fail before editing; Source retains the original.
Existing connected numbered terminals cannot move or disappear, and assigned
simulation pin numbers remain. Other instances retain their own definitions.

Footprint drawing uses package-local pads and artwork, up to 2,000 pads and
10,000 graphics. Canonical pad/graphic schemas remain authoritative. New packages
can be board-only or linked to an unassigned primary-sheet component. Editing
retains package pose/side/library identity, IDs, net assignments, models, zones
and hidden native properties. Connected pad numbers/removal and routed pad
copper geometry changes are blocked. Changed copper is checked against the
existing bounded DRC engine and default thresholds, including hidden/fixed
geometry; unrelated pre-existing violations do not prevent artwork-only edits.
This does not establish full DRC coverage or manufacturing readiness.

## Project integrity and schematic synchronization

Every edit and accepted synchronization is a complete-project Core transaction.
Entering Layout/Model validates pending Source first; invalid drafts remain
editable and block entry/writes. Navigation alone creates no undo edit.

Loaded boards stay authoritative until relevant primary-sheet inputs change.
Opening, saving, board-only edits and other-sheet changes do not refetch packages
or normalize nets. Ordinary Value, simulation and custom captions retain PCB
network names, fills and packages while updating linked captions.
Participation-only edits retain PCB bytes. Isolated elements marked `on_board no`
and their annotations do not change the physical source. Connectivity shared with
board-included pins, power-symbol rail names, references, assignments, geometry
and embedded libraries of board-included symbols remain synchronization inputs.

Relevant edits automatically synchronize even while Layout is hidden; there is
no Update PCB action. The host resolves catalog footprints with at most three
concurrent requests, then Core validates the prepared complete project.
Unsupported geometry/ambiguous connectivity fails atomically; Source, revisions
and close gates reject stale work. Save/export wait for required synchronization.
Cached success applies only to internally owned immutable inputs; missing results
and mutable inputs retry/revalidate.

Layout and Model expose pending/failed package synchronization. Entering either
view retries a failed preparation, and Model offers explicit Retry without
replacing its retained scene or camera. Pending Source and close gates block
retry. NextPCB package preparation joins its native footprint library and
portable model references to the originating edit; resource delivery and offline
local package reuse follow [Libraries](LIBRARIES.md#nextpcb-online-catalog).

A nonblank assigned Footprint makes an instance physical. Unassigned instances
create no package or missing-package warning. Clearing assignment or deleting a
part removes its linked package and retains copper in the same undo edit.
Layout placement updates the assignment; deleting a linked package clears it.
This classification never changes simulation participation.

Synchronization retains package UUID, placement, rotation and side; replacement
retains matching pad UUIDs. Source aliases keep embedded geometry until explicit
reassignment. New packages appear beside the board. Physical pin numbers, units,
labels and power pins determine nets; incidental crossings remain separate.
Net islands containing only power symbols or `on_board no` symbols do not create
PCB nets. Their connections into board-included pins still determine physical
nets. Pad nets are read-only. Conflicts/no-connect errors require schematic fixes.
Unambiguous net merges/renames carry copper; splits retain previous copper nets
with a review notice. Replacement never moves track endpoints.

Explicit [parasitic series groups](#parasitic-study-schematics) have a bounded
PCB-only conductive equivalence. Core validates their native group fields,
exact board/pad identities and actual series connection before joining the
group's endpoint nets for physical PCB synchronization. On each PCB use, both
declared terminals must still be assigned same-net pads linked by their exact
symbol identities and pin numbers into the group's outer label networks.
Moving an anchored connection label or altering endpoint metadata cannot retain
an invalid physical short. Coordinate-only PCB movement preserves the association
but does not recalculate the stored measurement. Generated LP label names
do not rename the physical net. This preserves the measured board's original
packages, pad nets, tracks, fills and native bytes. Schematic and SPICE topology
still use the actual native wires, labels and R/L terminals; no solver-only
rewiring is inferred from provenance. Invalid or incomplete group data cannot
grant a conductive equivalence. This native rule remains available independently
of the plugin lifecycle.

## Object locking

Properties exposes one Locked control at the right of the object identity/title row for footprints, individual pads, tracks,
vias, graphics, text, dimensions, copper zones, rule areas and mixed selections.
`lib/pcb-lock.ts` prepares the same atomic change for GUI Properties and
`layout.lock`. Canonical `locked:true` is serialized using the native KiCad lock
flag; unlocked objects omit it. Native parsing and retained-source merging keep
unchanged lock spelling while accepting explicit lock/unlock edits.
Locked items gates all supported categories, including point and marquee picks.
Locking the current selection retains its Properties and selection for immediate
unlocking; explicit filter changes still clear ineligible selections. Visible
locked footprints show a constant-screen-size lock marker in Layout, outside
native geometry and image exports.
All supported locked objects use brightness-aware purple canvas paint; footprint
locks also colour their visible artwork, captions, pads and embedded zones.
Selected locked geometry changes contrast within purple. Original layer paint,
drill voids, widths and fill opacity remain intact for image exports.
Locked footprint pads inherit their owner's editing barrier; pad-local locks
protect edits within the footprint without preventing its owner's movement.
Core board replacement and object commands reject locked geometry/property
changes and removal; Source remains explicit native editing. Lock-only changes
retain saved copper fills, identifiers and whole-project undo.
`tests/pcb-object-lock.test.ts` and `tests/gui-agent-parity.test.ts` cover native
reopening, selection, rejected edits, fills and GUI/Agent lock parity.

## Layout tools and navigation

Lazy Layout stays mounted with selection, camera and tool preferences. Hidden
presentation defers rebuilding until reveal, while Core/query/synchronization
state stays current. Leaving cancels gestures; modal input suspension retains
them. Display/navigation state stays outside native content, undo and dirty state.

Model opens a completely empty PCB as an empty editable CAD canvas without
inventing a board outline or surface. Boards with artwork, packages or copper
still require valid closed Edge.Cuts for physical preview.

Equal X/Y millimetre scaling and the current SVG transform govern pointers,
hit geometry, annotations and export. Camera scale uses CSS 96 px/in, independently
of monitor calibration. Resize retains scale. Space/Home and the canvas-menu Fit board action use closed Edge.Cuts;
Ctrl/Cmd+Home fits visible objects. These camera bindings remain available during
thermal probing. Middle/right drag pans; a stationary right click opens canvas actions without changing design geometry.
The drawing reports absolute mm in its status bar and distance through a scale bar. Horizontal-only wheel
input does not zoom; bounded zoom
retains its pointer/centre anchor, and pan retains tool world coordinates.

The canvas menu follows the current selection. Board outline strokes are object
targets and their open interiors remain available for blank-space commands.
Footprint selections offer Flip
and show Drag with tracks when at least one selected footprint has a
net-assigned copper pad. Track-only selections offer Drag tracks and Drag corner.
Select connected applies to track and via selections. Highlight nets requires
net-bearing copper targets. Individual pads offer Properties and Lock/Unlock,
plus Highlight nets when assigned. A single via has no Rotate command. A group
can rotate around its shared pivot. Fillet corners applies to a single polygon
or region. Fill/Refill applies to a single copper zone. Mixed selections show
object actions that apply to the entire group.

The camera updates root SVG/grid/hit bindings independently of drawing trees.
Coordinate-only internally owned track previews retain their committed target
binding. Track identity, ordering, layer or width changes refresh only track
targets; viewport, non-track geometry or copper-parent changes replace the binding.
Pan and wheel update numerical camera state immediately and share one animation
frame callback that presents the latest pose. Pointer mapping rebases the displayed
transform to that numerical pose, preserving wheel anchors and pan coordinates.
Initial application, resize and drawing replays stay synchronous. Straight airwires
and lock-marker world positions remain retained; only coincident-endpoint rings
and nonempty visible overlays subscribe to camera scale.

Within an unchanged, untransformed viewport, bounded transient navigation uses a
root CSS matrix. Pure translation does not collect visible stroke metrics; scaling
queries only visible non-scaling strokes and updates compensation when scale
changes. Transparent picking targets are excluded from that traversal and retain
their native hit padding during transient motion. Native rebasing restores their
exact current padding; native fallback updates it synchronously.

Clipped background, grid and interaction bounds initially reserve twice the native
viewport width and height. Navigation and flushes retain a cover that includes both
native and requested viewports. If needed, it adjusts with at least one CSS pixel
of margin, bounded to four times either viewport's dimensions. Poses that cannot
share that cover rebase the native camera and recentre the reserve. Drawing replays
repair the bounds. Foreign transforms or clipping, viewport changes and disposal restore
exact viewport bounds. Export and annotation clones normalize their background
and grid independently of the live reserve.

Ordinary navigation schedules a native viewBox rebase after 120 ms idle. Only
captured-pan updates with pure translation can pause that timer. Picking, commands,
drawing commits, captures and disposal consume the pending pose and flush the
native camera. Pan release, cancellation, capture loss, blur and deactivation also
flush. One binding owns each SVG; replacement retires its predecessor before
viewport/style capture and discards obsolete queued poses.

Native rebasing checks the physical viewport before camera writes when ownership
permits, using verified positive-scale bounds or restoring owned styles before
measuring the old native viewport. Uncertain bounds retain the settled check and
tolerance. A successful check is reusable only by its matching reserve update;
ordinary native replays still detect resize before ResizeObserver delivery.
Eligibility reads fresh Typed OM values with resolved-style
fallback; foreign transforms/priorities and large jumps use native updates.
Current world transforms and Agent observations remain authoritative.

Selection updates affected records; unchanged geometry/captions/controls retain
their presentation. Ordered zone fills and outlines retain their preparation
through track-only previews; zone, layer, owner and selection changes refresh it.
Nets retains a detached net-membership snapshot when only airwire endpoints
change; drawing still consumes current endpoints. Properties options reuse only
exact internally owned net and layer arrays.
Owned immutable connectivity/fill results may be cached;
mutable/caller-frozen boards revalidate. Public result containers remain
independent. These presentation caches never replace Core electrical validation.
Connectivity, routing and Shove share private pad contours for exact internally
owned footprints. Shove borrows frozen contacts only on an owned board and still
checks the complete anchor bounds.
Raw obstacle outlines retain their solid copper coverage; contact
contours retain drill holes. Each exact owned package array retains only its
latest successful connectivity partition. Unchanged networks reuse private
airwires only for the same layer stack and exact copper/fill inputs; changed
networks recompute all contacts and connections, including splits and removals.
Every analysis checks aggregate pad/body/fill bounds and charges cached networks'
original work against its two-million-operation limit. Exact owned pads also
retain private boundary edges, bounds and trees, with the same construction-work
charge. Tracks and vias retain immutable points, edges and bounds only for the
same owned source and layer stack, publishing after complete successful analysis.
Their Body wrappers and tree work ledgers remain fresh for every analysis.
Connected-drag deduplication reuses normalized copper identity strings only for
exact owned tracks. Each preview retains a fresh candidate set and all exact
collision checks; changed, mutable and caller-frozen tracks recompute their keys.
Failed calculations remain retryable. Public airwire anchors and
track-contact polygons stay independent; mutable and caller-frozen inputs
recompute their geometry and connectivity.
Track and boundary gestures update geometry immediately on the renderer thread
and calculate actual fill paths in a dedicated renderer Worker using the same
pure fill preparation as Core. The worker retains one gesture basis with one
request in flight and only the latest pending candidate. Request IDs and gesture
generations reject obsolete outputs. The newest completed output can advance
the displayed copper while a newer candidate is pending, so continuous motion
does not starve fill updates.
While a result is pending, lightweight conservative SVG masks adapt the latest
solved fill to current geometry. Masks cut clearances around changed foreign
tracks, pads, vias and keepouts and clip to current zone and board outlines.
Mask preparation retains private transformed outlines, comparison keys, paths
and bounds for exact internally owned zone and footprint arrays, with only the
latest footprint variant per zone array. Track poses reuse these derivations;
changed or caller-owned sources rebuild them. Every call returns independent
mask containers and computes blockers from the current pose.
Vacated gaps and expanded areas update with the next completed fill rather than
remaining unchanged throughout the gesture. Worker output and masks are
presentation only: airwires use fill-free candidate geometry on the renderer
thread during motion, and previews never enter native files, connectivity or
capability data. Source, revision, visibility, cancellation and disposal gates
discard inapplicable results. Cancellation restores the original display without
writes. Placement calculates exact fills for the current geometry once and
commits them with the checked geometry in one Core transaction; worker output
has no commit authority. Failure preserves the accepted board. Airwire analysis retains
its two-million-operation bound. Divider resize cursors release on cancellation,
deactivation and unmount.

Manual tools place/move/rotate footprints, route, place vias and draw closed
rectangles or polygons on the selected layer. Properties assigns networks and
fills selected regions. Appearance's Visualization contains Layers, Objects and
Nets. Display choices, layer visibility and selection filters remain presentation
state. See [dock behavior](../DESIGN.md#properties-visualization-and-selection)
and [Layout controls](../DESIGN.md#layout-editor) for the shared panels and controls.

Layer rows, display modes and canvas picking follow the
[active layer and selection rules](#layers-labels-and-selection).

Properties uses shared labelled rows and sections for footprints, pads, tracks,
vias, board graphics/text/dimensions, zones, rule areas and board settings.
Linked footprints share Schematic's symbol identity, editable Reference/Value,
field table and Footprint chooser. SPICE controls belong only to Schematic's
installed and enabled SPICE Simulation plugin; Layout retains their underlying
native attributes without showing a simulation section or participation switch. PCB pose and side follow
the shared form, with Delete in the upper-right action row. Empty inspection uses the same
icon and placeholder layout. Other object fields retain their labelled sections.
Controls share typography, spacing and surfaces with 12 px content insets.
Layers and Objects use the same swatch/name rows and right-aligned eye controls.
Read-only metadata uses plain 30 px rows with muted labels and right-aligned
tabular values rather than separate filled or bordered cards.
Board-only footprints use the same identity strip and insets with their actual
footprint artwork as the thumbnail; they acquire no schematic symbol or link.
Layout chooser assignments preflight the complete replacement before committing
once. Unsupported choices leave both assignment and PCB unchanged. Existing
package identity, pose, side, matching pad identities/nets and unrelated copper
survive replacement; already-filled enabled zones refresh in that same undo edit.
Pads belong to footprints: surface-mount pads, plated through-hole pads and
non-plated mechanical holes are distinct from independent through vias.
Pad number, type, layer membership and schematic-derived net are read-only;
local position/rotation, shape, size, drill/offset and supported fabrication
overrides are editable. Blank mask/paste/thermal overrides retain inheritance.
Circle edits keep equal dimensions; rounded corners retain compatible metadata.
The owning footprint remains directly accessible from pad Properties.

Track endpoint fields edit that segment explicitly and respect its lock.
Footprint side changes use the same mirrored geometry as Flip. Graphic fields
edit native geometry, layer, stroke/fill and text; dimension override edits update
both the native override and stored caption, retaining affixes and unit settings.
Dimension styles expose fields applicable to their type. Zone fields include bounds, fill rules and individual
rule-area exclusions; native corners/cutouts are retained without coordinate lists. These fields retain UUIDs, pin/net associations and
unrelated records. Geometry/copper edits refresh already-filled enabled zones in the same Core undo;
readouts, unchanged fields and viewing create no transaction. Dimension metadata
is preserved in native output; the bounded preview does not render all native
dimension decorations or recalculate its stored caption from formatting rules.

Selection independently gates footprints, tracks, vias, pads, text,
graphics, dimensions, zones and rule areas. These supported categories default
checked, so All items starts checked and reports a mixed state only when their
eligibility differs. Locked items defaults unchecked, independently gates picking
locked footprints, pads, tracks, vias, graphics, text, dimensions, zones and rule areas without unlocking them, and is excluded from All items. Unsupported
Points stays disabled and unchecked. Point picking works through disabled
categories and footprint overlays. Explicit inspection reveals a collapsed dock.

Place footprint opens an independent centered component/library chooser with
2D/3D previews. Its confirmation starts placement; the edit commits only on canvas
after rechecking that the target exists and is unplaced. Cancelling a reopened
chooser retains the preview.
Library placement retains coordinates through six decimal places and supports
rectangular, circular, oval and rounded rectangular pads with an explicit
0–0.5 corner ratio. Pad positions, corner ratios and straight artwork remain
exact through native Save and reopening; unsupported geometry is rejected.
Placement creates native Reference and Value fields with stable IDs so the
captions are selectable immediately.
Route tracks uses a compact nonmodal horizontal panel 8 px below the drawing top
and 12 px from its left edge. Its width follows the content up to 720 px, with a
Track width prefix, three inline numeric fields and pinned Close. The width, via
diameter and via drill remain available before a via transition. The Net-prefixed
via strip follows the same content-sized layout, exposing net, diameter and
smaller drill. The rectangle and polygon strips share Net and Layer selectors with only a pinned × close action. Net defaults to Unassigned and remains optional on copper; it is disabled on other layers. The layer starts from the selected display priority or retained copper layer. Selecting a layer in the strip reveals it and sets its display priority. Both tools retain the presets. Width is edited afterward in Properties; new copper regions use 0.2 mm minimum thickness and other regions use 0.05 mm line width. Parameters scroll horizontally within the drawing width. Activation reveals the drawing layer. Rectangle uses two opposite corners; polygon uses at least three corners. First-corner closure, Enter and double-click publish one closed region without duplicate vertices. Copper output is a native zone with the chosen net and fill disabled; other output is an unfilled native polygon. Both select the accepted region and restore canvas focus. Properties subsequently edits net, layer, width and fill.

Net/layer changes, unrelated board revisions and cancellation discard the complete preview without partial writes. Escape clears a draft before idle Escape exits. Polygon Backspace removes one corner. Rejection retains its exact draft for retry. Same-layer endpoints attract within eight screen pixels; Shift bypasses attraction and Ctrl/Cmd bypasses grid snapping. Preview and native output use the same layer/coordinates; hidden-layer drafts cannot commit. Edge.Cuts uses a 0.05 mm display floor, retaining native widths. Number-field Escape restores accepted input/canvas focus. Selector Escape closes options first; IME composition, including code 229, cannot apply or cancel.

Closed-region interiors are fallback point targets behind precise copper and strokes, respecting visible outlines, filters and cutouts. See [Object Properties](../DESIGN.md#object-properties) for field grouping, draft retention and actions. Pad inspection remains distinct from object selection and does not expose owner deletion.

### Rectangular outline editing

Selected axis-aligned rectangular Edge.Cuts polygons and closed four-line frames
expose eight corner/edge resize handles and X/Y/Width/Height Properties. Resizing
retains native object UUIDs, ordering, widths and metadata, and moves only the
frame vertices. Fixed opposite edges retain exact coordinates; dragged axes use
the selected grid (Ctrl/Cmd bypasses it). Four-pixel jitter remains clean and
crossing an opposite edge clamps to a positive size. Pointer preview does not
write; release commits its exact checked bounds and refreshed enabled fills once
in that undo. Escape, pointer cancellation, layer/tool/board changes and deactivation
cancel without writes. Source and Core revision gates still reject publication.
Nonrectangular/open/branched outlines retain ordinary graphic editing.

Selected board copper zones and rule areas use the same handles and numeric
bounds. Resize their polygon and hole vertices together within the new bounding
rectangle, preserving shape proportions on each axis, UUID, net, layer and rules.
Board edges, components and other copper do not scale. Existing vertex fields
remain available. Worker-prepared fills follow the resized area; temporary masks
clip the latest solved fill while newer geometry is pending. Placement validates
and fills the exact current area. Unfilled/disabled zones stay
unfilled. Embedded footprint zones retain
footprint ownership rather than acquiring independent box handles.

`tests/pcb-outline-resize.test.ts` covers geometry, metadata and Core undo;
`node scripts/check-layout-outline-resize-ui.mjs` checks actual LM2596 native
Source, both frame representations, zones, handles, numeric sizing and cancellation
in an isolated renderer.

### Thermal result presentation

[Layout Thermal](THERMAL.md) owns analysis/results and replaces the ordinary dock
while open. Layout consumes a generic field/readout at actual PCB coordinates
using its existing camera. Front/Back share one complete-result scale; probes
pick real solved surface nodes and ignore holes/outside clicks. Escape/another
tool exits probing; camera navigation remains available. Pending Source and stale
origin/destination/visibility suppress the field. Temperature display never edits
the PCB.

### Grid and placement

Spacing defaults to 0.5 mm, with 0.1/0.2/0.25/0.5/1 mm and Off. Off hides dots
but retains snapping. Layout, Schematic and Model share grid visibility with separate
persisted spacing; Schematic snapping stays at 1.27 mm. Layout/Schematic display dots thin to power-of-two
multiples at least 6 px apart, retaining origin/snap interval and a half-pixel
minimum radius. Export clones derive density from their own scale. Retired
0.05 mm preferences are rejected.

Placement/coordinates/arrows use selected spacing; Shift arrows use ten steps.
Exact pad centres/track projections take precedence for routing. Properties
shows accepted snapped coordinates after commit while untouched off-grid native
coordinates remain exact. Invalid/rejected drafts remain retryable. Grid changes
never move existing objects.

### Layers, labels and selection

Layout starts in All with the physical paint order and no prioritized layer.
F.Cu is the initial routing layer. Selecting a layer row prioritizes its layer.
Selecting the highlighted row again or choosing **All** restores the default
view and preserves the current routing layer, layer visibility and object selection.
Each visible layer paints its copper, pads,
artwork and captions together. Prioritizing a layer moves its side's layers
above unrelated layers and places that layer on top. Through pads and vias paint
once at the highest visible copper pass, with drill voids above artwork. Airwires remain an
overlay. Layer eyes control visibility independently of the active layer.

The **Non-active layers** selector immediately left of **Grid** in the Layout footer
offers **All**, **Dim** and **Solo**. Ctrl+H cycles the modes
with canvas focus. All allows point, containment, crossing and
Select all picks on any visible layer. Dim fades inactive layers and
Solo removes their artwork from the canvas. Both focus the explicitly chosen
layer or the routing layer if none has been chosen. They restrict new picks to
visible geometry on the focused layer, including its body geometry
of footprints and the copper span of through pads and vias. Category filters
and selection modifiers still
apply. Select all adds eligible objects to the existing selection. Selection
and the eye settings survive mode changes. Explicit
report navigation remains independent of the selection mode. Hidden geometry
still obstructs electrical routing.

Point selection collects eligible copper and artwork within three screen pixels.
With either silkscreen layer active, eligible independent silk on either side
takes precedence. In Dim and Solo, an active courtyard prefers
footprints.
Keep hits within one pixel of the best surface hit, then
retain the smallest coverage group up to the first adjacent 1.5× size gap.
Track coverage uses width squared, pad coverage uses its shape area, and
supported silk text uses the bundled stroke glyphs. An explicit layer choice
or Dim/Solo focus breaks ties after those comparisons. Remaining competing
objects offer choices on click. Track-tool pickup retains its nearest-segment ordering. Broad footprint,
unfilled region and saved-fill interiors are fallback targets behind precise
hits. Fill contours stay lazy until needed. Footprint priority follows local
body geometry. Non-plated holes are represented on Edge.Cuts.

Copper row selection also chooses the routing layer. A noncopper row
retains the copper tool layer and exits active copper drawing
so its artwork can be selected. Opening copper tools or refilling zones retains
the active layer. New zones require an active copper layer. An explicit routing
anchor or via transition may activate its actual copper layer.

Native footprint Reference, Value and user text are independent Text targets.
Their hits use the displayed caption and its own layer, including when
Footprints is unchecked. Rendered text hits supplement geometric candidate
collection. Marquees include eligible text whose owner is outside the selection.
Hidden or locked captions follow the corresponding visibility and selection
gates, including the owning footprint's lock. Selection highlights the caption
alone. Move and Rotate edit its local geometry through the shared board
transaction, preserving the owner, pads and tracks. Delete hides native fields
and removes ordinary user text. In Properties, **Text content** on a Reference
or Value field edits the owning schematic component or board-only footprint
through its property command, retaining the text's native geometry and identity.
Editing a linked Reference changes the component designator in both views.
Pad numbers/net names have independent switches, fitted labels and full-name
inspection. Source-hidden fields remain hidden. Selection preserves layer hues,
uses theme-aware contrast and retains widths/geometry; exports omit selected
paint. Properties and locked-track changes use ordinary Core undo. Native locked
tracks stay fixed during canvas edits/Shove until explicitly unlocked.

### Airwires and copper display

Airwires are bounded geometric connectivity observations, not DRC. The Filled zones
control shows saved fills independently of zone outlines; selected fills retain their
layer hues. Display/highlight changes never refill, rewrite nets or dirty data.

## Routing and copper zones

### Bounded Walk Around routing

Source copper supplies a route's net; Appearance and layer keys select the active
copper layer. Routes start from assigned pads/tracks/vias or a selected net.
Walk Around checks H/V/45 detours against foreign/netless copper, supported
artwork/dimension strokes, holes, keepouts and closed edges/cutouts, including
hidden geometry. Same-net contact respects SMD layers/through-hole anchors.
Standalone copper text/dimension captions are omitted from new-track checks;
via/drag checks retain conservative lettering envelopes. Saved pours do not
obstruct routes; accepted copper changes refresh already-filled enabled zones.
Manual routing uses Walk Around with H/V/45 segments and a fixed 0.25 mm clearance
plus half track width. Colliding drafts cannot commit. New-track Shove is
unsupported; interactive connected track drag uses Shove independently.
Absent outlines permit early routing,
broken outlines fail.

Routers capture obstacle support planes during construction. Private detour
hulls are clipped from that numeric snapshot only when search needs them;
direct checks retain their exact geometry and work bounds. Successful hints
stay local to that router, and failed preparation remains retryable.

Click locks waypoints; Backspace removes one; `/` changes bend posture. Connecting
same-net copper or Finish commits all legs once. Blocked heads cannot commit.
Enter uses the current live head and retains a blocked draft. X starts from
hovered visible assigned copper at its exact anchor/net/layer, even beneath
artwork; empty/Shift-bypassed targets only select Route. Repeating X retains a
route. Net/different Priority changes cancel without partial writes.

Every manual route starts with the configured track width, including starts from
existing tracks. Editing width revalidates the current route without rewriting
existing copper. Track width and via sizes survive completion and cancellation.

Anchor preparation is independent of SVG stacking/selection filters. Magnetic
attraction is eight screen pixels, prioritizing compatible net/layer targets;
foreign/netless/wrong-layer targets error. Shift disables object attraction;
Ctrl/Cmd disables grid snapping. Exact off-grid anchors survive. Preview, click,
Enter and double-click share checks; unchanged resolved heads retain previews.

Obstacle searches use up to 32 nearby records, expanding to 56 plus up to 64
checked intersections from 128 local corners. Exact collision checks remain
authoritative; complex passages may need shorter waypoints. Bounds are 15,000
copper objects, 120,000 pad vertices, 512 nearby anchors and two million work
units. Drafts allow 15,000 points and 64 layer transitions.

V previews a through via at the head; V again cancels that via.
PageUp/PageDown or +/− selects destination. Click/Enter locks it and continues
on that layer; finishing commits all tracks/vias once. Backspace can undo the
transition; Escape cancels all. Existing legs/vias revalidate current
width/clearance. Locked vias retain their size; changed sizes affect future ones.
Through vias check full diameter/clearance across every copper layer and
via-specific keepouts; track-only keepouts do not block them. Standalone vias
share checks. With a closed board outline, standalone and route-transition via circles hide outside the board material, including cutouts; placement remains blocked there. Inside-board collisions retain their blocked preview. Manual routes leave existing tracks fixed.

### Connected footprint drag

Drag a footprint with the pointer in Select mode, press D with footprints
selected, or choose **Drag with tracks** in the canvas menu. In the default
left-button mode, pressing on the footprint body, a pad, silkscreen or courtyard
and moving more than four screen pixels drags that footprint. A stationary
ambiguous click still opens Choose layout object. Selection-only mode does not
press-drag. M
translates the selected objects independently. A footprint-only selection moves
as a group. Affected native track ends follow their pad offsets on the connected
copper layers. A track with both ends on moved pads translates with them.
Single-ended leads reconnect with checked 45-degree Walk Around geometry. The
original track keeps its ID, layer, width and net, and new elbows receive fresh
IDs. Unselected footprints, vias, locked tracks and remote endpoints stay
fixed. A contact through the middle of a track must remain connected.

The planner checks the moved pad and drill envelopes and the rerouted tracks
against hidden and visible copper, artwork, board edges, cutouts and applicable
keepouts. It rejects poses that split a routed group or join a previously
separate same-net island. Saved pours refresh on commit under the same rules as
track drag. Footprints that own copper artwork, board edges or rule areas use M.
Preparation is bounded to 256 footprints, 256 attached tracks, 15,000 copper
objects, 120,000 anchor vertices and two million geometry work units.

The canvas and `layout.drag` share preparation through
`createPCBInteractiveDrag`. Preview, posture, cancellation, boundary placement
and single-transaction commit follow the connected track rules below. For a
footprint selection, omit `obstacleMode` or supply `walk-around`. Agent placement
defaults to the exact displacement and requires explicit `constrain:true` to
accept a legal boundary. One gesture keeps a private router session. The first
preparation of each clearance key stores the stationary obstacle tree, board
outline and successful stationary segment results. Later poses rebuild obstacles
only for the moved footprints and replacement tracks, and recheck clearance only
for pairs that involve those records. A moved-copper partition starts from the
stationary groups and unions only the moved pads and replacement tracks. Both
results match a full rebuild of the same pose. The eight-pose boundary search is
unchanged: it still revalidates the last displayed displacement and probes
toward the cursor, then commits that one validated pose. Walk-around remains the
per-probe cost when a direct span is blocked. The session ends with the gesture.

During the gesture the static board drawing stays on the committed documents.
The dragged footprint is a translated preview of that same package, and
replacement tracks plus ratsnest endpoints on its pads are redrawn from the
validated preview. Pointer release commits that preview once. Saved pours stay
on the committed copper until that transaction refreshes them. The refresh
matches a full refill contour for contour. Every pour subtracts the complete
clip set. Clipper rounding can turn a floating-point miss into a shared
integer edge, and the following opening follows that exact difference, so
every clip path stays in the operation. A repeated refresh reuses stored
contours only when the exact inputs of the pour are unchanged: zone geometry
and rules, net, layer, clearance, thickness, thermal relief, pad connection,
island removal, priority, board outline, keepouts, and every track, via and
pad. The comparison is that full record, not a hash. Any change recalculates
the pours. Fill failure rejects the edit and leaves the accepted copper in
place.

### Connected track drag

D starts selected/hovered track drag; pointer track-only selection uses the same
connected 45-degree engine after its threshold. Layout exposes no separate
left-button, track-drag behavior, obstacle-mode or drag-clearance controls. It
retains the shared left-button preference configured in Schematic; drag
clearance is fixed at 0.25 mm. Mixed selections fail. M is independent move; G is
free-angle corner editing. D/G resolves visible eligible tracks through footprint
overlays. Connected pickup projects onto the exact native track before movement;
subsequent destinations use the selected grid, with Ctrl/Cmd bypass. An off-grid
pickup must not offset the requested line from the current cursor.

Interactive D/mouse drag assembles an unbranched, same-net/layer/width H/V/45
chain up to its fixed terminals, branch contacts or locked copper. A single
leader slides normal to its original line, reconfiguring adjacent leads when
old bends contract. Multiple selected spans in the same chain share one leader
nearest the pickup; its cursor point remains a vertex when reconnecting a terminal.
Other supported groups retain bounded rigid translation. Interior branches and
width contacts use the existing selected-span planner. Pads/vias, locked tracks
and remote chain endpoints stay fixed; hidden copper supplies contacts and
obstacles, while other-layer SMD pads are unrelated.

Current-cursor paths first retain the neighbouring line directions. Checked
H/V/45 departure alternatives handle contracted leads. Local hull walks preserve
the requested spine before and after an obstruction instead of moving a long
straight run away from it. Hull intersections may cross an existing elbow; both
walk directions are checked against the complete board. Search is bounded to
64 candidates and 32 wraps per path. Clear original portions remain in place;
colliding or exhausted paths cannot authorize a preview. Original track UUIDs,
array order, widths and metadata survive. When a bend disappears, a surviving
straight span may be split to retain its original UUIDs without zero-length
copper; additional spans append fresh IDs.

Shove may reroute unlocked neighbouring tracks while preserving terminals and
contacts. When fixed copper blocks it, the same chain is replanned against the
complete stationary board. Both paths share final clearance and copper-partition
checks, rejecting lost contacts or new joins to unrelated same-net islands.
Retained leads must touch annular copper even when ending at drill centres.
Gesture caches reuse only unchanged stationary geometry and retain exact checks
for moved/added copper. Track drag opens no floating card or Selection settings.
The retained stationary partition indexes X intervals for nets with more than
64 bodies in their existing contact order; smaller nets retain the ordered scan.
Queries skip disjoint ranges while preserving the same inclusive
epsilon comparisons, exact contact candidates, visit order and geometry-work
charges. A changed stationary body set rebuilds this private broad phase; it
cannot certify connectivity or authorize an edit.

GUI and Agent `layout.drag` share `createPCBInteractiveDrag` for connected
chain reshaping, local avoidance, picked corners, posture and full-board
checks. Connected track mode defaults to Shove. Walk Around replans against stationary
copper. The command accepts the exact pickup and a corner endpoint tolerance
(default 0.5 mm); corner mode requires one track and pickup. Exact placement is
the default. Explicit `constrain:true` uses the canvas boundary planner with an
optional revalidated `previousDelta`, and returns requested/applied displacements,
constraint status/reason and changed IDs. No blocked or stale preview can commit.
Routing checks include hidden copper, holes, artwork, closed edges/cutouts and
keepouts; selected nets also check each other. A failed reconnect blocks the edit.

Pointer motion publishes the first pose in a frame immediately and any later
pose in that frame on the next animation frame. Arrows update immediately.
Release and click revalidate the pointer's exact pose, including a pose not yet
published, and commit that result once. Enter commits the published preview.
A blocked request cannot commit an older valid preview.
`/` changes reconnect posture;
click/Enter commits once. Re-selecting the current copper layer preserves the
gesture while setting its display priority. Escape, tool/layer/filter changes, replacement or
deactivation cancels without writes. If current-cursor replanning cannot produce
a valid route, interactive D/G and mouse track drags stop at a validated
**Stopped at obstacle** boundary for collisions, collapse/reversal and lost
contacts. Revalidate the last displayed valid displacement, then test
up to eight poses toward the current cursor; without a valid prior displacement,
start from the original pose. Never rebound past that valid displacement just
because a far cursor exhausts the probes. Rerouting may be nonmonotone, so this
bounded search does not promise a globally nearest legal point. Release/click/
Enter commits the exact displayed, revalidated boundary once. Engine, posture,
project or gesture replacement cannot reuse old displacement history. Setup,
range and budget failures remain blocked; `layout.drag` rejects an invalid
exact requested pose unless the caller explicitly requests a constrained result.

Pours are neither obstacles nor fixed contacts; accepted edits refresh already-filled
enabled zones in the same transaction. Bounds: 256 selected tracks, 15,000 copper objects, 512 reconnect sites,
120,000 anchor vertices and two million work units. Shove additionally limits
256 displaced tracks/512 fixed sites and eight directional attempts per span.
Interactive chain assembly retains at most 512 spans; each planner uses its own
two-million-unit work bound.

### Free-angle track corners

G picks the nearest selected/hovered track. Within six screen pixels of an
endpoint it moves the shared same-net/layer joint, including hidden incident
tracks; an interior pickup splits a new bend. Remote/fixed contacts remain
anchored through direct checked reconnects. Arms may use arbitrary angles,
without Walk Around/Shove. Coincidence tolerance is 0.000001 mm, retaining exact
native coordinates on zero displacement.

Connected-drag clearance, preview/commit/cancellation and bounds apply, including
256 incident tracks/512 sites. Widths/UUID/order survive and fresh arms append.
No-op stays clean; collapsed/blocked arms use the same interactive boundary
preview and exact commit checks. `/` posture belongs only to D.

### Saved zone fills

Round corners accepts one unlocked board zone, rule area or polygon graphic.
The outer ring must be simple and convex, with no collinear corners; cutouts
remain unchanged and must stay strictly inside the rounded ring. One positive
radius up to 1,000 mm applies to every corner. Overlapping fillets, precision
collapse, more than 10,000 resulting vertices or two million geometry operations
reject the edit without changing accepted geometry. Preview and
`layout.region.fillet` share `lib/pcb-region-fillet.ts`: native straight polygon
vertices approximate circular fillets within 0.01 mm, including six-decimal
coordinate rounding. This is polygonal rounding, not native analytical arcs.
Object IDs, layers, rules and unrelated records survive. Core refreshes previously
filled enabled zones in the same undo edit; fill failure rejects the complete edit.

Zone completion by Enter/double-click/closed polygon commits once and
restores canvas focus; rejection retains the draft/focus for retry. Properties
edits net/layer, clearance, minimum width, thermals, priority and bounds.

Enabling unfilled copper zones is explicit and undoable. Already-filled enabled
zones refresh automatically when copper geometry, board boundaries or effective
zone rules change, including footprint-owned zones. Geometry and refreshed contours
share one Core validation, revision and undo transaction for human and Agent edits.
Interactive motion uses the worker-prepared fills and temporary conservative
masks described above; accepted contours are calculated independently once for
placement. For internally owned snapshots,
track-only changes recalculate affected copper layers and retain other-layer
contours and rules, including when an intermediate candidate cleared its fills.
Unrelated captions, models, locks, viewing, opening and saving retain native fills;
Source applies the entered native contours without automatic refill.
Bounded Clipper geometry clips closed
edges/cutouts, subtracts foreign copper and drill exclusions, resolves priority
and creates solid/thermal contacts. Same-net plated drills remain separate
from the stored zone contours. Each rule area's **Pour clearance (mm)** in
**Fill** extends its copper-pour exclusion on the same layer by 0–1,000 mm.
At 0 mm the exclusion follows the rule area outline. The setting applies when
**Keep out copper pours** is enabled and is independent of zone-to-copper
spacing and the other rule-area flags. Changing it refreshes existing enabled
fills as part of the same undo edit, and temporary masks use the same margin.
Curves use nominal 0.01 mm tessellation within caps. Copper avoidance uses
finer round offsets and expands the exclusion polygons to cover chord and
coordinate rounding. Circular pads and vias use enclosing polygons. Minimum-width
pruning also removes short remnants before the surviving copper expands. For
zones with an Always or Never island rule, a bounded same-net copper
partition finds pieces connected to pads through tracks, plated pads, vias and
other pours. When a zone has a connected piece, Always drops its disconnected
pieces and Never keeps them with native island markers. An omitted native
island rule defaults to Always. A wholly disconnected
zone retains its pieces. Area-based island pruning and exact KiCad contour
generation are outside the editor's fill operation. Invalid, open or excessive
geometry fails.

Right-click blank space in idle Layout to access **Fill all zones** when at least one copper pour is enabled. The keyboard context menu offers it with an empty selection. It fills every enabled pour across layers in one undo edit, including enabled pours without saved contours. There is no standalone fill toolbar button or settings strip. The Properties Fill/Refill icon enables and fills the selected zone as one transaction. Its hover title and accessible name distinguish Fill from Refill; it disables during calculation and normal edit barriers. The zone header has no Filled checkbox; unfilled contours use the Fill action above the fields. The explicit Fill default minimum clearance is 0.25 mm; each enabled zone retains the larger existing rule, measured from copper edges. Automatic refresh retains positive zone clearances down to the supported 0.0001 mm minimum; native zero uses the 0.25 mm default on recalculated layers. Selected-zone fill respects the complete board's priorities, obstacles and enabled zones. It solves previously filled same-layer neighbours with the selected zone so new copper cannot intrude into their accepted clearances. Enabling a target or changing effective zone rules refreshes previously filled affected pours in the same transaction. Unfilled peers remain unfilled. Adding, removing, assigning or reshaping fill-disabled zone outlines preserves existing pours, including overlaps and embedded zones. Rule areas remain obstacles regardless of their fill flag. Failed calculation leaves all design data unchanged and the edit remains retryable. The `layout.fill` command accepts an optional board zone ID; omitting it explicitly fills all enabled zones. Valid command minima remain 0.0001–1,000 mm. Viewing and Properties disclosure never calculate fills.

Manual fill, automatic Core refresh and renderer Worker previews share native board copper/edge/hole minima and the supported net-class/custom clearance sources described in [Design rules](DESIGN-RULES.md#layout-drc). Each foreign-net pair uses the last matching conditional clearance in either operand order, otherwise the larger participating net-class clearance, with board and requested zone minima as floors. Pair limits affect generated contours without replacing the native zone's own clearance setting. Rule-text, net-name and relevant courtyard-reference changes invalidate prepared fills; unrelated project metadata does not. The bounded fill rejects unsupported rule sources and courtyard predicates evaluated on Zone operands before publication. Courtyard predicates on pad, track and via operands use their current geometry. Check-only source overrides and disabled checks do not alter native fill constraints.

`filledPolygons` allows 60,000 saved vertices per board: absent is unfilled;
empty is a completed empty fill. Native contours retain holes through doubled
bridges. Viewing/saving/display never recomputes fills. Copper/rule edits replace
stale contours with refreshed fills in the same transaction. Refill/check in KiCad before manufacturing.
Dense refreshed contours can exceed the separate airwire-analysis operation limit;
Layout retains their copper and reports unavailable connectivity without clearing fills.

## Distance measurement

Layout and Model share the bounded two-point presentation store in
`lib/canvas-measurement.ts`. It reports Euclidean distance and signed native-axis
deltas in millimetres, copies endpoints and rejects nonfinite/coincident completion.
An invalid surface hit clears the pending endpoint so Enter cannot fix an older
preview. Two clicks complete a measurement; a new click replaces the prior result.
Escape clears first and exits when empty, with composition barriers on canvas.
Layout places the ruler in its own Measurement group before Edit/history; Model keeps it immediately before Undo. Its status-bar readout directly shows
distance, signed ΔX/ΔY and angle from native +X toward +Y. Model also shows ΔZ,
XY angle and elevation from the XY plane; undefined angles show an em dash.
Estimated bodies retain an Estimated suffix. The readout wraps in narrow editors.
Measurement never calls Core or changes native data/history.

Layout converts through the exact current camera transform. It reuses the visible
copper anchor resolver and prepares visible native component placement centers
and exact drawing anchors with
`lib/pcb-measurement.ts`; candidates within eight screen pixels attract endpoints,
otherwise the selected grid applies. The nearest candidate wins across centers,
copper and drawing anchors. Hidden component bodies provide no center. Model
attracts to the visible rendered component body bounds center within eight screen
pixels before trying the hit triangle's visible vertices. A center's projection must
hit that same component first; vertices recheck surface visibility at the candidate.
Alt bypasses attraction and grid snapping. A dashed ring previews the candidate
before either endpoint is fixed. World-space SVG markers retain screen-size paint during
camera changes and are excluded from exports. Both overlays draw perpendicular
unnumbered equal-length graduations. `canvasScaleLength` selects the same length
as the lower-left Layout scale bar (the largest supported length within 100 px).
Each tick interval equals one scale-bar length, without minor subdivisions. Model uses the same selection with
the camera-target units per pixel and projects interpolated XYZ points, retaining
true spatial spacing. Very long offscreen rulers thin intervals by powers of
ten to at most 201 ticks. Model's `lib/model-measurement.ts`
uses the same displayed scene ray, rejecting hidden ancestors, helper geometry
and CAD previews. Text-plane alpha samples reject transparent background pixels.
Points use native XYZ axes; measurements of estimated component
bodies are explicitly labelled. They describe rendered mesh surfaces, not analytical
CAD tolerances. A projected SVG overlay follows camera changes without entering
scene picking, physical bounds, screenshots exported from WebGL or saved annotations.
Navigation remains available. Display/document changes and deactivation clear the
readout; other tools remain exclusive, and unapplied CAD property drafts block entry.

## Model rendering and lifetime

Browser development connects CAD preview through the same-origin authenticated preview transport described in [API](API.md#browser-development-preview-transport). The existing kernel prepares exact Boolean/extrusion geometry for EMC Flyback's base and cover as well as other supported CAD solids. Preview meshes remain presentation data; native project parameters and undo retain their existing ownership. Missing/changed bundled resources produce retryable errors rather than substitute geometry.

### Exploded presentation

Model Visualization has an independent Explosion tab beside Views and Display.
Distance defaults to 0 mm (assembled) and accepts 0–1,000 mm
through the shared quantity control. Positive distance explodes the stack without a separate toggle. Vertical and Radial change assembly spread.
Component separation automatically evaluates transformed STEP triangles in the assembled PCB frame, including nested rotation, offset, positive scale and back-side flipping. There is no component-side setting. Triangle surface area is clipped against the two laminate surfaces, avoiding vertex-density bias. More than 10% of total surface area must lie outside the laminate and one side must exceed the other by more than 3:1 before geometry determines the side. Otherwise, missing, balanced, embedded or estimated bodies automatically retain the native footprint side. This is a bounded side estimate, not semantic body/pin recognition, collision checking or validated disassembly.
All real model instances of one footprint contribute to the same side decision. Their assembled surface-area centre supplies radial XY displacement, while radial Z retains the resolved side. Geometry summaries are cached per immutable scene instance; newly loaded instances update the combined decision. Every instance returns to its exact assembly pose before the decision is applied, so repeated settings and late model loading cannot feed exploded coordinates into classification. Hidden estimates do not vote. No board, reference or package names determine direction.
PCB copper layers always separate along native Z in physical front-to-back order,
with front/back solder mask and silkscreen outside the copper. Tracks, pad/via
annuli and saved pours on one copper layer share one displacement. Four-layer
boards include both internal copper layers; their assembled display Z positions
are evenly spaced within the board thickness, not a material stackup calculation.
Exploded solder mask retains the assembled transparent multiply-blended lacquer over a dedicated opaque backing using the same laminate color, roughness and lighting as the board. The backing shares the coating geometry and transform, including pad/drill apertures, supplies its own depth, and is hidden at zero distance. Detaching the coating cannot expose unrelated layers or substitute the brighter raw lacquer color. Both material identities and shader settings remain stable; no geometry is rebuilt or repeatedly recompiled. The coating owns picking; the backing is paint only.
The existing laminate core remains fixed. Components separate toward their resolved
side beyond the corresponding layer stack. CAD solids, including the EMC Flyback enclosure base, walls and cover,
retain their original assembly poses, geometry and visibility in both directions.
Radial spreads components away from the board center while retaining the PCB's Z stack.

`lib/model-exploded-view.ts` owns only scene-local offsets. Reapplying settings
cannot accumulate movement; late STEP instances follow their footprint and
zero distance restores exact current assembly poses. Category visibility,
selection highlighting, edge picking, measurement, Fit, clipping, image export
and annotation capture use the displayed positions. Changing the explosion clears
measurements and updates annotation fingerprints without moving the camera.
Settings survive hidden views in the mounted project, outside native data, undo
and recovery. Board thickness remains editable during exploded inspection through the same validated PCB transaction as assembled editing; project Undo/Redo stays available without collapsing the explosion. Source, stale-board, close, active-tool and Properties-draft barriers still apply. The refreshed scene recalculates laminate, copper/coating depths and component bases from the new thickness, reapplies the current explosion distance/direction and restores the retained camera. Other geometry editing is disabled during exploded inspection; camera, visibility, selection and measurement remain available. Pending CAD drafts or
active tools block changing the settings. No Core edit or STEP output is changed.
`tests/model-exploded-view.test.ts` covers restoration, physical layer order,
transformed geometry, opposite-side bodies, fine-tessellated leads, ambiguous/estimated bodies, combined late models, radial centres, scene bounds, picking and stationary CAD edge identities.

### Scene lifetime and rendering

Model uses bounded STEP parsing/Three.js without installed KiCad. It renders
board thickness, closed edges/cutouts, drills, two-/four-layer copper, pads, silk and
available packages in mm. Clicking visible laminate, copper, mask or silk selects the board in Model and exposes its thickness field; Layout empty Properties has no thickness setting. Component/CAD occlusion and the body filter govern board picking. The field uses the existing validated PCB replacement transaction with the exact current board and Source/close guards, retaining its draft while hidden. Native thickness, 3D geometry and whole-project undo stay in agreement. Neutral fallback bodies are estimates; late real
models replace them without camera movement. Filled silk and mask artwork retain
their native stroke as well as their interior; closed strokes keep their inner
clearance. Supported silkscreen text uses the same pinned Newstroke stroke
layout as Gerber. Model clips the ink geometry to the board and drill holes,
using the resolved caption, placement, justification and stroke width. The
vector pass processes up to 8,192 UTF-16 code units and 8,192 stroke segments
per side. Other captions retain the bounded local-font texture presentation.
Orthographic projection/silk default on. Fit includes visible world geometry,
including transparent covers, and excludes hidden groups; empty scenes retain
a finite fallback.
Fit shares the Isometric preset's equal-axis direction and native-Z up vector;
both discard orbit inertia before applying the exact orientation. Fit centres
and scales visible bounds while view presets retain their target and zoom.
Space on the active canvas invokes this same Fit action without changing
projection, selection, drafts or undo. Modified/repeated/composing keys, inputs,
overlays and held pointer gestures cannot trigger it.

Native model links retain offsets/scales/rotations/hidden state and optional
opacity 0–1. Per-instance material copies preserve templates, other instances,
geometry and opacity through selection/export. CAD uses outward-facing surfaces
to avoid touching transparent cover/wall flicker without changing solid geometry.
PCB coatings and text composite before transparent component and CAD
assemblies, which retain depth sorting among themselves. Camera clipping follows
cached visible physical bounds so perspective views resolve the thin copper,
mask and silk layers without clipping the assembly during orbit or zoom.

Click selects visible eligible models; Shift adds, Ctrl/Cmd toggles and both
subtract. Empty/Escape clears. Camera drags do not select. Ordinary picking uses
one depth-ordered scene ray for CAD/components with distinct visibility
and occlusion rules; drills/annotations use their own current rays. Selection
uses hue-preserving contrast without boxes or native edits; export restores
original paint.

Visualization uses Layout-styled Views, Display and Explosion tabs, initially Views.
Views offers Top, Bottom, Front, Back, Left, Right and Isometric presets in a
compact two-column grid, with Isometric spanning the final row. Orthographic
projection and Render toggles follow a soft divider. Controls retain visible labels and
aligned icon/text columns. All view icons are 14 px; the first column shares the
12 px leading inset and 34 px text alignment of disclosure headers, visibility
rows and Selection. The toggle retains its pressed state and accessible name. View presets
retain the orbit target, zoom and projection mode and explicitly redraw the
current scene, including after view or project restoration.

Render enables progressive, multi-bounce GPU path tracing. A separate presentation
scene copies the current visible physical meshes into render-only PBR materials,
with studio softboxes, a procedural HDR environment and a matte floor below the
assembly. Reflections, indirect illumination and soft shadows are sampled from
that scene; no native Blender process or downloaded environment is used. Material
interpretation is a display approximation, not measured optical data or a promise
of matching Blender/Cycles output. Component colours, maps and authored opacity
remain represented without inventing a measured glass or metal classification.
The camera-visible floor keeps its full shading and contact shadows within one
assembly span of the centre. It fades to the studio background by three spans,
well inside the geometry boundary. Direct camera rays beyond the fade skip
floor shading. The responsive raster preview shares the fade distance and keeps
the private floor visible through the assembly camera's far clip.
Render owns independent geometry, material and texture-state copies; only image
bytes are shared read-only with the ordinary preview. Authored face groups are
partitioned into single-material render meshes before tracing, preserving STEP
face colours and material indices through the tracer's geometry merge. Explicit PMMA CAD material
uses a display-only acrylic interpretation with transmission 0.92 and refractive
index 1.49. Generic translucent STEP surfaces retain alpha without inferring an
optical medium.
Enabling Render while component or advanced CAD models are importing retains
the request and shows import progress. Scene copying, BVH generation, texture
uploads and shader compilation begin only after those imports finish. Assigned
models that fail to import block Render with the existing retry actions;
intentionally unassigned component estimates remain supported. PNG export can
wait through import publication, then through convergence. Disabling Render,
hiding the view or changing the view/design basis cancels that export. Hidden
views do not start a queued Render until reactivated.
Board copper, laminate, silkscreen and multiply-painted solder mask receive
render-only physical shading. The current visible native tracks, pads, vias and pours
remain in the render scene as opaque copper. The mask is a thin pigmented
dielectric with transmission 0.26, refractive index 1.55, zero modelled thickness
and clearcoat, so covered copper remains visible through the coating. Existing
native mask apertures expose bare pads; opaque FR4 blocks internal and underside
layers. These bounded optical approximations do not change authored material records.
Vector silkscreen enters Render as physical geometry, so small ink strokes and
letter counters are sampled directly along with the surrounding board surface.

`components/model-copper-relief.ts` derives owned mask normal and clearcoat-normal
maps from the union of actual visible outer-copper triangles. Pairing requires
explicit `F.Mask`/`F.Cu` or `B.Mask`/`B.Cu` tags. The 35 µm shading height is a
display assumption, not native copper thickness or a measured stackup. It changes
normals only; vertex positions, UVs, native content and STEP geometry stay unchanged.
Each mask's optional refinement is bounded to 1,024 px longest side, 250,000
triangles, one million scanlines and 96 million filled pixels. Unsupported UVs or
layer tags and excessive work omit that normal-map refinement while preserving
the full physical geometry for path tracing.

Still views accumulate 64 samples with a three-bounce path budget, three
transmission traversals and geometry-guided denoising. A private raster pass
caches first-surface view normals, depth, albedo and optical strength at working
resolution. Its materials retain native apertures, alpha tests, texture/vertex
colours and mapped normals; the physical tracing materials are restored after
the pass. Camera, scene and working-size changes invalidate these guides; accumulation
and selection reuse them.
Three 5×5 spatial passes at strides 1, 4 and 1 reconstruct linear radiance using
normal, tangent-plane distance, albedo and perceptual-colour weights. The first
and final passes mix adjacent pixels to reduce fine grain. Their 75 kernel taps
span a 12-pixel radius, with weights rejecting incompatible surfaces. Four
immediate-neighbour probes per pass retain the original traced
pixels along guide boundaries, preserving their sampled subpixel coverage.
Filtering never feeds back into the accumulated samples or clips HDR reflections.
Raster guides describe only the nearest surface; transmission/alpha retain a
tighter original-colour guard, but refracted detail and low-contrast shadows
can still soften. This is bounded spatial denoising, not an optical reference.
Multiple importance sampling retains direct studio-light sampling to limit noise.
The working image supersamples up to 1.5× the drawing-buffer and CSS dimensions,
with a 1,920 px longest-side limit. When the tracing grid is larger than the
drawing buffer, a cached area-weighted resolve averages its subpixel coverage
in linear light before tone mapping. This smooths component silhouettes and
board edges in both the viewport and PNG, which retain their original sizes.
Selection outlines compose over the same resolved image. Sampling begins with three
tiles per animation frame and adapts up to 27 tiles as the preceding GPU batch
finishes. A nonblocking fence after presentation keeps one tracing batch in
flight; busy GPUs reduce the batch toward one tile. Tile submission checks an
eight-millisecond CPU deadline between tiles. This is not a GPU execution-time
guarantee. A 50 ms grace period accommodates asynchronous fence visibility;
only a sustained wait reduces the batch. If fencing is unavailable, batches stay at three tiles. Camera, scene
and size changes reset the batch, and disposing Render releases its fence.
The first four samples provide early filtered feedback; subsequent filtering
and presentation advance in four-sample intervals. Larger batches can skip
intermediate intervals. Every sample is still traced, and completion always
filters the full 64-sample image for display and export.
Accumulation-only continuation frames retain the composited raster image while
shaders compile, and the current denoised image while the GPU is busy or only a
partial presentation interval advances. Camera, scene, size and selection changes invalidate
that presentation. A drawing-buffer resize repaints even when the working
size and accumulated samples are retained. Explicit view updates and captures
always repaint, including after reactivation; failed draws remain retryable. Sampling and
the nonblocking GPU fence continue independently of duplicate presentation.
These settings favour responsiveness over fine shadow, reflection and transmission
detail. Camera motion uses a responsive preview and resets path
accumulation once per continuous motion interval. Projection changes update the
tracer camera without reuploading unchanged geometry, textures or lights; the
camera-type shader define still changes through the pinned tracer. Current
geometry, display, projection, explosion and viewport changes
also restart the image. This temporary raster preview, also used during preparation
and before the first sample, omits optical transmission on private materials;
the path-traced scene retains its full transmission values. Hidden Model views
pause work. The engineering reference plane and editing
overlays are omitted from the path-traced image, while their ordinary-view settings
and the editable scene remain retained. Render is available only without an active
CAD tool or unapplied CAD geometry draft. Starting a tool or creating such a draft
switches Render off so the editing preview remains visible. Camera, visibility,
projection and explosion remain interactive. Render defaults off and belongs only to
the mounted project's presentation through navigation. It changes no native
geometry, material records, revision, undo or recovery data. Preparation, sampling,
export and retryable errors share the center of the drawing's bottom
status row, independent of the selected Visualization tab. Completion clears the
render status text while retaining the rendered image and active mode. The Render button
retains its busy and pressed states. Read-only previews without that footer keep
inline feedback. Disabling Render or disposing the view releases its GPU resources.

Render shader preparation has a 120-second deadline and can be cancelled by
disabling Render. Before compiling the pinned shader, the renderer removes
unused sheen, iridescence, fog and nonrectangular-light calculations; its scene
and material adapters never enable those features. Metal, clearcoat, transmission and direct-light sampling
remain active. Studio softboxes and the HDR environment share one shadow and
material-evaluation path. Material records carry a packed texture-transform
index instead of sixteen eagerly decoded matrices; each active texture sampler
reads its original transform on demand. A scene-wide union of the ten supported
map types specializes absent map indices to -1 before compilation. Every scene
upload refreshes that union, so adding a previously absent map recompiles its
original sampling path. Packed material offsets and authored UV transforms remain
unchanged. The BVH traversal stack is sized from the deepest generated tree
plus two entries, rounded up to four-entry buckets; no geometry or tree depth is
truncated. Shader specialization rejects a mismatched pinned source explicitly.
Graphics-driver compilation latency varies. The deadline bounds preparation,
not total rendering time; compilation failure remains visible and retryable.

The renderer directly owns one pinned path-tracing renderer and scene generator.
It creates no unused low-resolution renderer, timed fade or empty-scene upload.
The Model component and Render implementation load together when Model is first
opened. Render creates its scene and GPU resources only when enabled and model
imports have completed; retained callbacks never start a dynamic import across
a development hot update.
The retained scene also tracks its component implementation and view-ref identity,
so a hot update disposes old native callbacks and rebuilds presentation without
resetting the mounted component's drafts or external camera state.
`components/model-render-environment.ts` prepares the generated studio map with
current Three texture sources. Its half-float radiance and inverse importance
distributions retain the pinned sampler's values; it does not recolour or
downsample the environment. These preparation optimizations retain the sampling,
working resolution, lighting, optical materials and denoising settings above.

Tabs support arrow keys and Home/End and retain
their selection across drawer, view and project switches. Only the active panel
is exposed. Display ends with a Reference plane eye control and a 14 px grid icon,
using the same row spacing without a separate divider and defaulting to visible.
The fixed XY plane stays below the PCB. This per-project presentation setting retains
the camera, native bytes, undo and model resources through tab/view/sidebar
switches. Display uses the shared compact visibility rows, colour swatches and
eye controls for CAD solids, components, board body, copper, solder mask and
silkscreen. Copper jointly controls tracks, pads, vias and filled zones on all
copper layers. Each category controls both board sides
and defaults visible. `lib/model-board-display.ts` defines the board material
palette and scene-local groups; swatches share the rendered material colours.
CAD swatches reflect current solid colours (the material palette when empty);
component models uses the neutral fallback-body colour without recolouring
loaded packages. Visibility updates existing groups without rebuilding geometry,
refetching assets, changing the camera or editing native content. Hidden surfaces
cannot occlude picks or contribute to Fit; annotation display fingerprints include
every board category. Mask and silk groups preserve their compositing order before
transparent assemblies. View,
projection and visibility actions keep Visualization expanded. Selection uses the shared two-column
checkbox grid with 14 px checkboxes, 30 px rows and 8 px label gaps: All items,
Solids, Faces, Edges and Lines. All items occupies the first cell, followed by the
geometry categories in row order, matching Schematic and Layout. It reports the mixed state of all four
geometry filters. Solids permits whole CAD bodies and component
instances; faces/edges/straight lines use the bounded native CAD
topology catalogue. Component Properties uses the same `layout.delete` command
as Agent/Layout to remove the selected footprint, clear its linked assignment and
retain copper in one undo edit. PCB surfaces and CAD subentities do not delete
their owner implicitly. CAD body deletion uses `modelCad.remove`; all three
Properties views share the Delete object button. Model components place it beside the tabs when available, and solid Properties pins Apply and Delete above the fields.
Automatic picking prefers eligible edges/lines, then solids,
then faces when solids are disabled. These checkboxes are the sole user-facing
selection controls; there is no separate type mode. Active edge-treatment and
Boolean tools restrict picking to their eligible operands only while active.
Filtering clears only ineligible selections, exits Pan and cancels conflicting gestures/tools
without hiding geometry or changing native data. Whole-solid and subentity
operations require eligible selection; creating geometry remains independent and
does not enable filters or select an ineligible result. Unapplied Properties
drafts and busy commits disable filter changes so input remains retryable.
Visibility and selection eligibility remain independent; filtering retains the
same depth and transparent-cover occlusion rules.

See [conversation and right docks](../DESIGN.md#conversation-and-right-docks)
and [independent windows and status](../DESIGN.md#independent-windows-and-status)
for the shared editor layout and Model's footer controls.

### Retained scenes and requests

Model retains each project's scene/camera/projection/visibility across
navigation. Hiding pauses rendering/new requests and defers rebuilds; reveal
reads current board/captions/CAD/Source/revision guards. Unrelated schematic
poses retain geometry. Solid pose/name changes retain meshes; changed shape,
holes or appearance replace only affected resources. Commit/preview groups own
separate resources. Replacement/close aborts obsolete work and disposes WebGL
resources. Missing models show warnings without blocking the board or offering a
retry action. Editable preview diagnostics appear in Rule and the footer
Error/Warning summary. Read-only history retains a lower-right expandable
Error/Warning summary with a height-bounded scrollable list inside the drawing bounds. The lower-left 3D ruler shows native
X/Y/Z axes with rounded strokes and one circular labelled endpoint per axis,
following camera orientation and scaling around a fixed overlay origin.
The overlay sits 4 px above the drawing bottom. Its 112 × 116 px area uses
preferred engineering lengths to retain 28–42 px arms before camera projection
at all camera scales, matching Model measurement tick intervals. Axis strokes
are 1.25 px with 5.5 px radius endpoint markers. Its
number uses the same font size, family and weight as the Layout scale. Its millimetre label stays centered below the axes, 18 px above the drawing bottom.
Camera-target-plane units per pixel follow zoom, projection and resize through
an isolated readout, outside scene geometry, picking and image
export. Failed 3D preview initialization retains its retry action.

Initialization yields between bounded geometry/mesh batches; hidden views pause
checkpoints and cancellation disposes partial work. Shader preparation precedes
readiness/model requests; failure or ten-second timeout disposes the renderer
and rejects late completion. These boundaries do not promise graphics-driver
latency. Shared CPU caches/worker limits belong in
[Libraries](LIBRARIES.md#model-lifetime-and-caches).

### Model CAD

The toolbar separates direct 3D primitives, 2D drawing and 2D-to-3D conversion,
with solid modifications kept in their own group. Extrude sketch stays visible
and enables only for a completed valid profile; [Design](../DESIGN.md#toolbar-and-retained-view)
owns the category layout and contextual drawing controls.

Model shows a finite XY reference plane in ordinary 3D, finished
profiles and extrusion, 0.05 mm below the PCB bottom face. Its frame uses native
axes, including reflected native Y. Its position is independent of CAD/component
bounds and board visibility. Minor/major
lines, a boundary and thicker colored axis strips follow the current theme: X
is red and Y green. There are no letter annotations on the plane. Axis strips use flat meshes
for real WebGL width rather than platform-dependent line widths. The ground
grid and axis intersection are centered on the PCB outline bounds. Plane size
comes from those same bounds; its exact symmetric world-space edges remain
fixed through zoom and grid-density changes, independent of component/CAD bounds. This display reference
does not change native coordinates. Ground resources are retained outside the
physical scene group, so they cannot affect picking, measurement or
Fit. Finite ground display bounds extend camera clipping separately; PNG export
includes the visible ground. Plane setup replaces the ground with its translucent
workplane surface and boundary/axes. Sketch drawing uses intersecting lines
aligned and anchored to that workplane, excluding its transient grid from exports.
The footer Grid selector remains available throughout Model and uses independently
saved 0.5/1/2/5/10 mm spacing, default 5 mm, and the shared Off setting. Off hides
reference grid lines while retaining its surface/axes, or hides the sketch grid
while drawing. Reference plane visibility independently hides its complete
surface, grid and axes. Visibility enters annotation fingerprints
and stays outside project recovery. Visibility changes reuse retained grid resources. Lines coarsen by powers of two for
the current camera scale; bounded geometry is retained between unchanged updates.
Grid visibility/density never changes CAD's 0.5 mm snap, native files or undo.
The finite workplane boundary extends camera clipping only during setup/drawing.

Model adds independent boxes/cylinders and rectangle, circle or polygon sketch
extrusions. Sketch first previews an XY, XZ or YZ workplane with an editable
Offset in millimetres along the plane normal from the model origin, defaulting to
0 mm for every plane in a new sketch. Each valid
input updates its surface and status
bar plane/coordinate readout without blur or confirmation; invalid input hides the
preview and disables Start sketch. The one-row strip exposes Plane, Offset,
an icon-only Start sketch checkmark and Close, preserving the 3D camera until drawing begins.
Start sketch aligns the retained camera orthographically
to that exact plane; contextual drawing tools operate on the shared Model PCB
canvas. The plane remains fixed while drawing. The status bar's isolated
`ModelSketchCoordinates` subscriber displays the exact snapped local preview
cursor with X/Y, X/Z or Y/Z axes for the selected workplane; no pointer updates
are routed through Workbench state. Leaving drawing clears the readout, and
finished profiles and extrusion retain distinct mode labels.
Finish sketch restores the previous 3D camera/projection and retains
the outline. Extrude is a separate 3D action: its distance/direction preview
commits only on Apply, as one `modelCad.sketch.extrude` transaction. Cancel extrusion
returns to the outline; Edit sketch returns to drawing without losing the profile.
Profile validation does not depend on a hidden extrusion distance.
Sketch Boolean operation selects Union, Difference or Intersection for each next closed contour, with Union required for the first. Up to six ordered contours share the workplane. Drawing-tool changes retain completed contours; Undo sketch edit restores the previous local contour/edit state (up to 32 states), or cancels an unfinished stroke. Clear sketch is also undoable. The region outline is a bounded tessellation for display. Pure `lib/model-cad-sketch.ts` distributes extrusion over planar Booleans and retains analytic circle/polygon operands in the existing solid recipe. GUI and Agent call `modelCad.sketch.extrude`; host preparation verifies the exact result before one undo edit. Empty and invalid results remain retryable. There is no dedicated Hole tool, local-hole parameter or hole-rim topology.
The sketch toolbar also exposes Fillet sketch corners, Chamfer sketch corners and Sketch Boolean operations. Each operation selects an existing contour through the canvas (eight-pixel tolerance) or the contour selector. Corner tools accept one/all original indexed convex, non-collinear vertices with a positive radius/distance. Circles, unavailable corners, adjacent overlap and treatments consuming the profile are rejected. The selected contour/corners highlight independently of the combined region. A bounded outline previews the proposed change; Apply sketch operation accepts the exact valid contour draft, Cancel leaves accepted draft contours intact, and invalid/unapplied operations block Finish sketch. Remove corner treatment restores original corners. IME composition and key code 229 cannot apply/cancel fields or tools.

`cornerTreatment` on a sketch contour compiles to the existing analytical extrusion `edgeTreatment` on its selected `side:N` edges before ordered Booleans. Fillet arcs are tessellated only for planar outline display. Host preview/STEP still uses analytical OCC edge treatment and the same prepared-key admission gate; no new native sketch artifact or polygonal fillet approximation is stored. Native OpenSCAD export rejects these treated solids through its existing explicit limit.

Rectangle and Circle support drag-and-release or two-click drawing with a live
anchored preview. Coincident points and zero-area rectangles remain incomplete
without validating a zero-size solid. Escape clears an unfinished gesture;
completed profiles remain available. Plane setup,
finished profiles and extrusion allow 3D orbit; only drawing captures sketch
pointers. Workplanes and finished profiles remain local tool drafts, outside
native files, undo and recovery until extrusion Apply. A polygon has 3–128 vertices, implicit closure, no crossing or
touching edges, and a centred local XY envelope matching its dimensions.
Extrusion follows local Z; the selected workplane maps that axis into world space.
[Format](FORMAT.md#document-ownership) defines native variables and aggregate
bounds. Properties edits XYZ pose/intrinsic rotations, dimensions, material,
RGB color and opacity. Properties Color previews an optional
per-body `#RRGGBB` override; Use material color returns to the material palette.
Apply saves one validated undo edit, independently of opacity and physical material.
Native reopening, duplication and OpenSCAD retain custom color; STEP remains geometry-only. Pick a visible analytic edge directly, or
select a solid and then pick its edges before starting Fillet/Chamfer; further edges can be picked while the tool
is open. Ordinary click selects one edge; modifiers add/toggle edges. Selected
edges have their own Properties readout and highlight; tool clicks toggle the
selection. Set radius/distance and Apply the exact prepared preview once.
Edge selection disables whole-solid move/rotate/copy/delete actions and their
shortcuts; select the solid interior to inspect and edit the whole body again.
Boxes expose twelve edges; polygon/rectangle extrusions expose profile and
vertical edges; cylinders/circle extrusions expose circular rims. Edge picking uses a bounded pixel tolerance and rejects
occluded/back edges. Boolean results have no editable edge topology catalogue;
their edge tools remain unavailable. Edge treatments require explicit semantic edge IDs.
Field drafts/previews remain local until Apply; stale drafts require Reload.
Source/revision/deactivation cancels tools without stealing external focus.

Union, Difference and Intersection consume two selected bodies and retain an
immutable geometry-only operand recipe. Selection filters permit solids,
analytic faces, edges or straight edges as lines on the canvas; ordinary
Interaction picks among the enabled categories. Modifiers add/toggle entities
and the Properties readout names the selected type. Selection is presentation
state and cannot mutate a parent body through a face/edge shortcut. Untreated
primitives/extrusions expose analytic faces; treated and Boolean
results remain selectable as whole solids.

Boolean operands come from ordered canvas body selection, before or during the
tool. No second operand is selected automatically and no target/tool dropdown
exists. The first body is Target and the second is Tool; Swap operands and each
role's Remove control change selection only. A third new canvas body replaces
Tool. Face/edge/line selections cannot Apply a solid Boolean until the user
explicitly chooses Use owning solids; repeated subentities of one solid still
yield one operand. This conversion does not perform curve/surface Booleans.
While a Boolean preview replaces its operands, exact source geometry remains
visible as selectable wireframe ghosts. These own only temporary paint, remain
bound to the original bodies and are excluded from captures/exports and Fit.
Difference uses the first body as its
target. The result occupies the target's list position, receives a fresh UUID and
replaces both inputs in one undo edit. Its dimensions are a read-only conservative
envelope; nested operand transforms construct the actual result. Boolean bodies
retain cutouts through Boolean operand recipes. Recipes have bounded depth
and operation counts, not arbitrary executable CAD programs.

Advanced draft meshes come from authenticated `/api/model-cad/preview`: the host
validates parameters, generates fixed Gmsh/OpenCASCADE operations, creates STEP
and tessellates that STEP through the bundled parser. The kernel is the same
hash-pinned Gmsh 4.15.2 used by Layout Thermal: the official Windows x64 build
or, on darwin-arm64, the official MacOSARM SDK whose `gmsh -info` reports
OpenCASCADE 7.8.1. STEP export uses the same
shape construction. An empty, invalid or failed rim/Boolean result remains
retryable and cannot commit an earlier mesh. The pure Core accepts changed
advanced geometry only after the host prepares its exact canonical shape key;
human/Agent commands, whole-project replacement and Source apply share this gate.
Pose/material/name changes can reuse unchanged geometry. Save and navigation
apply pending Source through the same preflight and revision checks. No thermal
or electrical solve runs for CAD preparation.

M moves a selected solid; R/Shift+R rotates local Z by ±90°; Enter commits a valid
placement/move once, retaining dimensions. Numeric X/Y replaces pointer
placement in Move/Properties with exact entered coordinates, retained during camera navigation;
pointer placement uses 0.5 mm snapping. Wheel/middle/right navigation remains
available during placement without committing, with current camera/
bounds refreshing pointer previews. IME, text drafts, dialogs and active gestures
block conflicting shortcuts. Field Escape restores only edits since focus;
composing Enter/Escape/code 229 does nothing. Explicit Cancel/Close restores
Properties/canvas focus. Box and Cylinder placement expose only dimensions and
Close, omitting a title/name prefix. Fields fit without horizontal scrolling and
wrap only on narrow canvases. Name, position, rotation, material and opacity
remain in Properties after placement. Docked Properties retains its disclosures.

Pan retains inspection and unapplied Properties drafts/previews while cancelling
an active tool. Placement/duplication reveals the new solid's Properties without
stealing action/canvas focus and replaces component inspection. Tool start/cancel
retains component inspection. Unapplied solid drafts block conflicting toolbar and canvas edits. CAD/component visibility and scene resources remain
independent; hidden Model defers rebuilds.

EMC Flyback builds its enclosure with four CAD bodies: an
aluminium base, two side walls and a transparent PMMA cover. Base/cover holes
use sketch contour Difference before extrusion, retaining analytical circles in the shared solid recipe. The example stores these
bodies in `OPENPE_MODEL_CAD`. MECH1/MECH2 model-only placeholders are absent from Layout, the PCB footprint collection and project footprint libraries. Their upstream source files and static models remain pinned evidence outside the active footprint catalog. Editing or deleting CAD bodies therefore does not reveal a duplicate static enclosure. Independent
panels stay separate in STEP until explicitly united.

Model's toolbar has no STEP export button. Host `enclosure.exportStep` exports current independent CAD
solids from active Model through a native picker. Applied Source is required;
a saved destination is not. It uses fixed validated OpenCASCADE operations,
retains rotated analytical profiles/holes/selected-edge treatments/Boolean results and
keeps independent overlapping bodies separate unless explicitly combined.
It accepts no renderer path. STEP carries geometry only. See
[design exchange](FORMAT.md#design-exchange) for OpenSCAD export.
Arbitrary mesh imports, executable geometry programs, SCAD import/execution and
whole-assembly simulation are unsupported. The Layout Thermal solver models the
PCB geometry independently of CAD bodies.

### Model resolution and alignment

Model paths are metadata, not grants. Component Properties share the same field editor across Schematic, Layout and Model. Model appears directly after Footprint; its browser opens the secondary Component models dialog. File/library selection, multiple assignments, placement, visibility and opacity are edited there through one validated PCB transaction per accepted change. Component reference/value/Footprint edits use the same shared part transaction. Schematic symbol placement remains distinct from PCB placement.

Local STEP selection requires a saved project and an explicit native picker. The host validates regular unlinked STEP files up to 32 MiB and tessellates them before accepting the choice. Approved bytes enter an immutable content-addressed private cache; native PCB references use `${KIPRJMOD}/models/<SHA-256>.step`. Save/Save as prepares verified model sidecars without replacing changed files. Reopening can read verified relative STEP files through the project grant; arbitrary absolute paths do not grant access. Official KiCad paths use the bounded library resource resolver. Component STEP import adds preview geometry only; it does not import editable CAD topology.

Requests use fixed bundled identities, official footprint/model indices or the current validated project with component/model indices. Explicit assignments, including empty ones,
remain authoritative. Without links, all numbered embedded pads must support
one common origin translation, including back-side mirroring; otherwise retain
estimates/notices without editing data. Home models stay offline. Official files
may be downloaded under [Libraries](LIBRARIES.md#step-access-and-previews).
Transport gets one retry within 60 seconds; 404 means unavailable, not substitution.

### Projection and coating

Orthographic/perspective switches retain camera direction/target/target-plane
scale without rebuilding. Picking, zoom and capture use the active camera;
100% is CSS 96 px/in. Solder-mask preview uses existing mask layers/margins and
transformed artwork, clipped to edges/cutouts/drills. SMD defaults to its side,
through holes to both; vias stay open because tenting is unsupported. Mask
text/dimensions remain source data with a notice, not invented apertures.

## Annotations and PNG export

Comments/screenshots belong to their originating conversation, outside design
and undo. Layout marks use board/world fingerprints; Model marks also bind
camera/display and hide when stale. They never appear in another view. Model
camera gestures pause during annotation. Agent observations are bounded;
component proposals remain schematic-only.

New Layout annotation element picks and object membership follow Selection
eligibility. Element picks use Interaction's point ranking and three-screen-pixel
surface tolerance. Element marquees share its directional geometry and layer eligibility.
The element tool creates no annotation when a click or marquee
finds no eligible objects. Filter changes clear ineligible live highlights and
reject captures started with older eligibility. Saved screenshots/comments
remain immutable and previewable. Explicit rectangle/freehand tools may capture
regions without eligible objects.

Element annotations share Interaction's geometry colour, contrast, widths and
opacity, without an extra blue bounds box. Their drag rectangles share the
directional selection paint. Numbered pins and comments remain available;
explicit rectangle/freehand annotations retain their blue region marks.

The canvas context menu exposes Export image in Schematic, Layout and Model.
See [visibility, grid and export](../DESIGN.md#visibility-grid-and-export) for menu and gesture rules.

Native PNG export preserves live selection/camera/destination and omits controls,
selection paint, annotations and gestures. Longest side is capped at 4096 px:

- Schematic: complete visible content/text plus 4 mm, with theme/layers/grid.
- Layout: closed board bounds, up to 20 px/mm, with layers/grid/airwires.
- Model: current camera at canvas resolution with transparency in the standard
  view; Render waits asynchronously for all 64 samples of the current image before
  capturing the same studio appearance and background. Hiding the view, disabling
  Render or changing its captured scene/camera cancels a pending render export.
  Export omits editing previews and retains the live camera and design destination.

Electron validates PNG/decoded dimensions before the picker and writes atomically;
renderer paths are rejected. Cancellation is silent; errors remain actionable.

## Shared Layout capabilities

`core/layout-commands.ts` registers board reads/route previews and typed move,
drag, rotate, flip, delete, duplicate, route, via, zone, fill, net and property
commands. `layout.get` returns canonical board content/counts; `workbench.state`
adds bounded presentation. Human/Agent operations share Core geometry, validation
and one undo transaction. Runtime discovery defines exact IDs/schemas;
[API.md](API.md#layout-capabilities) is the reference. Camera/filters/gestures are
not generic automation commands. Native writes still require grants/pickers.

## Layout Parasitics

The bundled Layout Parasitics plugin estimates two-terminal DC resistance on the
current accepted PCB. Select two distinct copper pads or through vias on the same
assigned net. The measurement treats pads as ideal conductors, including the
layer connections within a plated through-hole pad, on their enabled copper
layers. A selected via uses its front copper layer as the terminal.

The bounded network uses straight track centerlines with shared endpoints within
1 nm. Pad and via contacts require positive-area track-copper overlap with their
conductive land on an enabled layer, retaining drill holes. Proven contacts
connect through ordered, clamped projections onto the native centerline; virtual
cuts subdivide the graph without moving or splitting the native track. Intervals
retain native centerline lengths, without trimming to pad boundaries or guessing
new route geometry. Returned paths name the original tracks. Tracks sharing a
junction share its contact. Two tracks may contact the same terminal when their
copper overlap lies entirely within that proven conductive land. A track capsule
provably contained wholly inside one eligible drill hole contributes no physical
copper and is omitted without creating graph edges or joins. Each track interval contributes
`R = ρL/(wt)` for length `L`, width `w` and uniform copper thickness `t`. Each
via interval contributes `R = ρL/[πp(d+p)]` for drill diameter `d` and barrel
plating `p`. Use `ρ = 1.724 × 10⁻⁸ Ω·m` at 20 °C with formula dimensions in
meters. The defaults are 0.035 mm copper and 0.025 mm plating. Copper layers are
spaced evenly across the board thickness and plating must fit inside each modeled
annulus. These are explicit material and stackup assumptions.

Equivalent resistance includes the parallel routes in the network. The shortest
route is measured by total track length and vertical via distance. Its series
resistance is reported separately. The same shortest route has a quasi-static
partial-inductance estimate in nH. It sums self and signed mutual contributions
from the directed track centerlines and traversed via spans using a regularized
Neumann integral. The effective radii are `exp(-1.5) × (width + thickness)` for
tracks and half the sum of drill diameter and plating thickness for via barrels.
For a segment pair, the squared softening distance is the mean of the squared
radii. The mutual term integrates one segment analytically and uses bounded
adaptive quadrature along the other. The calculation omits pad inductance,
parallel current sharing, the return path and other conductors. A nonpositive or
unresolved estimate is reported as outside the model while preserving DC and
distance results. The model excludes capacitance, shorts to other nets,
frequency-dependent losses and fabrication tolerances.
[Ruehli, 1972](https://doi.org/10.1147/rd.165.0470) describes partial inductance.

Unsupported contacts, including pad/via contact without a proven eligible land,
general track-body or parallel joins outside a proven shared land, overlapping
same-net pads/vias, nonempty same-net saved fills and copper artwork anywhere on
the board, reject the measurement. Unfilled zones, empty fills and keepouts
contribute no copper. The graph, including projected subdivision nodes, is
limited to 256 nodes and 512 native tracks on the selected net, with at most
2,000,000 contact operations and 120,000 anchor contour
vertices. Disconnected terminals also return an error. OpenPE implements the
two-terminal workflow independently. [KiCad-Parasitics](https://github.com/Steffen-W/KiCad-Parasitics)

### Parasitic study schematics

Add parasitic components captures the current terminal pair and thickness inputs
as an actual series insertion in an existing schematic. The GUI targets the schematic selected
before entering Layout; the shared command explicitly identifies that existing
schematic. It recomputes the accepted PCB before preparing the edit, without
importing rounded panel readouts or caller-supplied resistance/inductance values.
The compact block is placed in clear space near the corresponding schematic
terminals, with both terminal labels and the series elements on one straight line.
Both selected terminals must be PCB pads mapped through their exact linked
native symbol identities and unique pin/pad numbers into that target. Vias, duplicate
pad-number lands, unmapped or
co-located pins, a nonexclusive end lead and an already inserted endpoint pair
reject without editing. Matching a reference, net or label name alone cannot
establish the connection. The end pin must have one eligible leaf wire; that
wire retains its identity and is shortened by 1.27 mm at the pin. Native copies
of the endpoint LP labels connect the separated original nets through the new
R/L chain, with no remaining ideal bypass. Other native circuit geometry and
embedded symbol definitions are retained.
Nearby placement checks at most 2,401 snapped positions and two million obstacle
comparisons. It considers accepted geometry and visible native field bounds,
reserving hidden field anchors independently of the current view. Repeated
additions avoid earlier blocks. If no supported clear position is available,
preparation rejects without changing the design.
Its native `on_board no` components belong to the Schematic Virtual section;
GUI success switches to that section before revealing and selecting the block.
This is one Core
transaction and one whole-project undo, with no additional schematic, tab or
native file. Other schematics, PCB placement, connectivity, copper and PCB native
bytes are preserved.

The added block uses fresh identities and project-wide unused component
references. It contains a footprint-free resistor for the equivalent DC
resistance. When the shortest-route partial inductance is positive and finite,
a footprint-free inductor follows in series. Their native Values use SI-prefixed
ohms or henries with exactly two decimal places, such as `7.14mΩ` and `3.89nH`.
Prefix selection keeps small positive parameters from rounding to zero; values
outside the supported SI-prefix range use a scientific mantissa with two decimal
places. These stored design parameters are rounded, while the command result
retains the original full-precision measurement. An outside-model
inductance produces only the resistor, with `omittedInductance` reported in the
command result; no zero or guessed inductor is added. Nonpositive or
unrepresentable resistance rejects the entire edit. Existing project geometry
and size bounds apply to the complete edit.
Existing embedded R/L definitions are reused. Unsupported custom pin geometry,
oversized bodies or library simulation defaults reject the addition while
preserving the original definitions and design.

Two distinct local net labels identify the actual measured endpoints. Pad labels
use the component reference and pad number, such as `LP_J3.1` and `LP_C7.1`, so
the schematic shows which physical terminals the series model spans. Ambiguous or
missing reference/pad names, normalized whitespace and duplicate endpoint names
include a terminal UUID qualifier, using the shortest unique hyphen-free prefix
of at least eight hexadecimal characters. A shared study suffix such as `_S2`
or `_S3` is added to both label names
when needed to avoid existing schematic labels, power and hidden power-pin
names, and PCB net names. Repeated creation for the same endpoint pair rejects;
other supported insertions receive distinct labels.
Wires join the compact block's two labels through the prepared series elements;
connection-label copies remain on the start pin, shortened lead's cut anchor
and end pin.
The generated content consists of the series
components, their fields, labels and joining wires, without an explanatory
text annotation. Measurement assumptions and model limits remain in the plugin
panel and this contract.

Each added R/L stores the hidden [native group and endpoint properties](FORMAT.md#document-ownership).
Source, Save, reopen, recovery and undo preserve them without adding canvas text
or a private plugin file. Provenance alone grants no mutation authority; the
physical equivalence above requires a fully validated group and native topology.

The resistor represents equivalent DC current sharing, while the optional
inductor represents only the shortest route's partial inductance. Their series
combination is a deterministic terminal-side approximation: other schematic
branches remain on the start side. It does not reconstruct a distributed PCB
network from the equivalent resistance and shortest-route partial inductance.
The combination is an editable study snapshot, not a validated broadband or closed
return-loop equivalent. It includes no capacitance, frequency-dependent loss,
automatic excitation, load or ground. The existing circuit must already be a
supported simulation testbench; creation does not expand the bounded
[SPICE compiler scope](SIMULATION.md). Later PCB changes do not update an
existing study automatically.

The block is ordinary native content in the target schematic, covered by Source,
Save, recovery and Git history. It remains editable after plugin disable/uninstall;
no plugin-specific JSON or private result store is created. GUI and Agent use
the same [creation capability](API.md#layout-parasitics-capabilities).

## Examples and verification

Home has nine curated projects under Example and fixed EMC Flyback Recent. Their original
geometry, source attribution and model identities remain pinned; support does
not establish hardware qualification. [Examples](EXAMPLES.md) owns
regeneration/assets and [EMC verification](EMC-FLYBACK.md) owns recorded numerical
comparisons.

To compare OpenPE's all-zone refill with KiCad 10 on LM25017, copy the bundled
`.kicad_pcb` and matching `.kicad_pro` into a scratch directory. Run
`kicad-cli pcb drc --refill-zones --save-board -o <report> <scratch-board>`
with KiCad 10.0.1, then run
`node --import tsx scripts/check-lm25017-fill-parity.ts <scratch-board>`.
The read-only check compares each enabled copper zone by UUID and layer. It
requires exact contour segments and island flags, ignoring polygon order,
starting vertices and winding. It exits unsuccessfully on any difference.
Passing the bundled PCB directly compares against its saved contours.

| Check                                                                                                                                                                                                                            | Scope                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/pcb-project-sync.test.ts`, `tests/pcb-layout.test.ts`, `tests/pcb-routing.test.ts`, `tests/pcb-fill.test.ts`, `tests/pcb-fill-incremental.test.ts`, `tests/pcb-footprint-press.test.ts`, `tests/pcb-dynamic-fill.test.ts` | Synchronization, geometry, routing, dynamic fill transactions, incremental refill parity and footprint press-drag targeting                                                                                                                       |
| `tests/pcb-properties.test.ts`, `node scripts/check-layout-properties-ui.mjs`                                                                                                                                                    | Unified object fields, pad/via classification, native geometry/rules, undo and rejected drafts                                                                                                                                                    |
| `node scripts/check-layout-editing-ui.mjs 'properties actions'`                                                                                                                                                                  | Upper-right actions for selected objects and groups, icon-only fill, rejection and IME guards                                                                                                                                                     |
| `tests/pcb-track-chain-drag.test.ts`, `tests/fixtures/emc-track-drag-kicad10.json`                                                                                                                                               | Ten installed KiCad 10.0.1 EMC references, tested in Shove/Walk Around through GUI and Agent paths; sampled centerlines, same-chain selection, native roundtrip and undo                                                                          |
| `tests/layout-drag-capabilities.test.ts`                                                                                                                                                                                         | Agent discovery, picked corners, explicit constrained placement, GUI result parity, revision/Source barriers and native undo                                                                                                                      |
| `tests/layout-parasitics.test.ts`, `tests/layout-parasitics-study.test.ts`                                                                                                                                                       | Analytical DC networks and via spans; same-schematic additions, endpoint identity and native-property preservation, precision, one-step undo and rejected inputs                                                                                  |
| `node scripts/check-thermal-workbench-ui.mjs --parasitics-study`                                                                                                                                                                 | Real Workbench terminal picks and endpoint-labelled study, hidden native endpoint fields, unchanged PCB/other native files and one GUI undo; mocked host services, no Electron or solver                                                          |
| `node scripts/check-thermal-workbench-ui.mjs --parasitics-contact`                                                                                                                                                               | Actual LM25017 D1.2/C8.1 /VOUT1 pad picks, finite contact measurement, thickness reactivity, Add availability and unchanged native files; mocked host services, no Electron or solver                                                             |
| `node scripts/check-component-delete-ui.mjs`, `node scripts/check-model-cad-ui.mjs --delete-actions`                                                                                                                             | Shared upper-right actions; Model component/CAD removal, Agent parity, IME/Source/draft gates and native undo                                                                                                                                     |
| `node scripts/check-copper-fill-ui.mjs`                                                                                                                                                                                          | Properties fill, selected-zone Core/native clearance, Source and undo                                                                                                                                                                             |
| `tests/pcb-fill-preview.test.ts`, `tests/pcb-fill-worker.test.ts`, `tests/pcb-fill-worker-client.test.ts`, `tests/layout-copper-retention.test.ts`                                                                               | Bounded real copper preview, continuous Worker progress, stale/cancelled results, temporary gap masks and retained drawing frames                                                                                                                 |
| `node --import tsx scripts/check-pcb-fill-worker-bundle.mjs` after `npm run build`                                                                                                                                               | Emitted production Worker bootstrap and chunks calculate changed copper and SVG paths in an isolated Node worker; no Electron, host service or native solver                                                                                      |
| `tests/pcb-track-drag.test.ts`, `tests/pcb-track-drag-copper-key.test.ts`, `tests/pcb-track-shove.test.ts`, `tests/pcb-track-joint-drag.test.ts`                                                                                 | Connected/free-angle geometry, contacts, owned-key reuse and bounds                                                                                                                                                                               |
| `tests/layout-camera-frame-reserve.test.ts`, `node scripts/check-layout-compositor-ui.mjs`, `node scripts/check-layout-frame-reserve-ui.mjs`                                                                                     | Camera scheduling, finite frame coverage, exact rebase, picking, captures and pixels                                                                                                                                                              |
| `tests/model-camera-clipping.test.ts`, `node scripts/check-model-compositing-ui.mjs`                                                                                                                                             | Model depth precision, transparent assembly compositing and native opacity preservation                                                                                                                                                           |
| `tests/model-cad.test.ts`, `tests/model-cad-emc.test.ts`, `tests/model-cad-step.test.ts`, `tests/model-cad-kernel.test.ts`, `tests/model-cad-host.test.ts`, `tests/model-cad-scene.test.ts`, `tests/model-picking.test.ts`       | CAD schemas/proof gates/EMC construction/native round trips/STEP/kernel transport/retained meshes/picking                                                                                                                                         |
| `$env:OPENPE_TEST_MODEL_CAD = '1'; npm test -- tests/model-cad-kernel-native.test.ts`                                                                                                                                            | Opt-in real bundled CAD kernel preview/STEP agreement and empty-result rejection                                                                                                                                                                  |
| `tests/model-cad-selection.test.ts`, `tests/model-cad-faces.test.ts`, `tests/model-cad-operand-ghosts.test.ts`                                                                                                                   | Typed selection, analytic face hits/paint and selectable operand resource ownership                                                                                                                                                               |
| `node scripts/check-layout-ui.mjs`, `node scripts/check-layout-routing-ui.mjs`, `node scripts/check-layout-track-drag-ui.mjs`                                                                                                    | Isolated Layout editing/preview integration                                                                                                                                                                                                       |
| `node scripts/check-model-cad-ui.mjs`, `node scripts/check-object-retention-ui.mjs`                                                                                                                                              | Isolated CAD focus/drafts and retained scenes                                                                                                                                                                                                     |
| `node scripts/check-object-retention-ui.mjs --status-layout`                                                                                                                                                                     | Three drawing/inspector regions, drawing-only footers, aligned actions, mode header, sidebar resize/visibility, retained cameras and Grid keyboard/IME focus                                                                                      |
| `node scripts/check-model-cad-ui.mjs --ground`, `tests/model-ground-scene.test.ts`                                                                                                                                               | Fixed XY reference frame, independent visibility/Grid Off, retained resources/camera, keyboard/IME, zoom-stable centered extents and bounded compact ruler scaling without native edits                                                           |
| `node scripts/check-model-cad-ui.mjs --sketch-plane`, `tests/model-cad-sketch-scene.test.ts`                                                                                                                                     | Live workplane coordinates/surfaces, distant-plane clipping/start alignment, draft/IME guards, camera restoration and preview resource disposal                                                                                                   |
| `node scripts/check-model-cad-ui.mjs --color`, `tests/model-cad-mesh.test.ts`, `tests/model-cad-scad.test.ts`                                                                                                                    | Solid color drafts/preview, material reset, undo, native persistence, appearance rendering and OpenSCAD color                                                                                                                                     |
| `node scripts/check-model-cad-ui.mjs --sketch-boolean`, `tests/model-cad-sketch.test.ts`                                                                                                                                         | Contour picking, placement and dimensions, local cancellation and undo, planar Difference before extrusion, shared human/Agent command, native round trips, IME and lifecycle barriers. Native cut/volume evidence is in the opt-in kernel suite. |
| `node scripts/check-model-cad-ui.mjs --sketch-input`                                                                                                                                                                             | Zero-offset rectangle/circle click and drag gestures, incomplete previews, Escape/IME guards, extrusion Apply and native-file undo                                                                                                                |
| `node scripts/check-emc-editing-workflow-ui.mjs`                                                                                                                                                                                 | Offline real native Save/reopen, CAD/STEP and cross-view undo                                                                                                                                                                                     |
| `node scripts/e2e-new-project.mjs`                                                                                                                                                                                               | Opt-in desktop: blank-project wiring, package placement, copper routing, board outline and Model edits; native Save/Save as and reopening in a fresh process                                                                                      |
| `npm run examples:check-models -- --render`                                                                                                                                                                                      | Verified offline STEP assets and all ten Home Model views                                                                                                                                                                                         |

`tests/pcb-contact-intervals.test.ts` compares ordered broad-phase candidates with
exhaustive interval filtering, including inclusive epsilon boundaries. The Shove
suite compares both small and indexed stationary nets with exhaustive drilled,
rotated and multilayer copper contacts.

Model display groups, hidden-surface picking/Fit and material preservation are also
covered by `tests/model-board-display.test.ts`. Plane-aware live readouts, independent
project snapshots and unchanged-pointer notification suppression are covered by
`tests/model-sketch-coordinates.test.ts`.
Render scene/material isolation is covered by `tests/model-render-scene.test.ts`;
bounded outer-copper normal maps and unchanged native geometry/UVs are covered by
`tests/model-copper-relief.test.ts`. Renderer lifecycle handling is covered by
`tests/model-studio-renderer.test.ts`. The browser-only
`node scripts/check-model-render-ui.mjs` exercises the GPU path tracer and PNG
output, camera/material preservation, IME, retained display state and release
across toggles. Its fixed-seed fixture checks floor grain, 1/4/8-pixel residuals
on metal/translucent/PCB surfaces, authored colour-edge contrast and the
contrast between the counter and fine strokes of a 1 mm silkscreen glyph;
`--high-dpi` checks the same fixture at 2× device scale. Both variants check
the bounded supersampled tracing target and unchanged export dimensions. Holding
publication of the real linked shader verifies unchanged visible pixels and
no repeated raster scene draws during preparation continuations.
Delayed component/CAD fixtures verify import progress, no premature Render
allocation, failed-import retry, hidden completion, export cancellation on view
or document changes and successful export after import and convergence.
Its fixed STEP fixture does not validate native model parsing,
desktop integration or equivalence to a Blender render.
`node scripts/check-model-render-guides-ui.mjs` separately checks real GPU guide
depth/albedo through alpha-test apertures, preserved narrow HDR marks under
first-surface optical guidance, synthetic-noise reduction and GPU release. Its
synthetic radiance is functional filter coverage, not path-tracing quality evidence.
`node scripts/check-model-render-hmr-ui.mjs` exercises real Next/Turbopack hot
updates in a private source copy, including retired callbacks, Render toggles,
preparation, hidden views and retained drafts/camera/native data. It never edits
or reloads the running development app. Its two-sample fixture checks lifecycle,
not image quality.
Two-point measurement state, finite/invalid picks, visible signed deltas/angles,
unnumbered scale-bar-aligned graduations, visible component centers and
surface/estimated-body picking, snap candidates and visible drawing anchors are
covered by `tests/canvas-measurement.test.ts`, `tests/model-measurement.test.ts`
and `tests/pcb-measurement.test.ts`.

### Interaction latency measurements

Desktop measurements require [explicit authorization](../AGENTS.md#verification-and-delivery)
and isolated profiles. [benchmark-editor-experience.mjs](../scripts/benchmark-editor-experience.mjs)
owns the executable input plans, clock pairing, budgets and report fields. Measured
inputs wait for acknowledgement one at a time, with a 200 ms overload threshold,
750 ms acknowledgement timeout and owned-process shutdown on failure. Latency
samples wait 250 ms after each acknowledgement, outside the measured interval.
Full Layout acceptance uses the built renderer and EMC Flyback:

```powershell
$env:OPENPE_EXPERIENCE_OPERATIONS = 'layout-navigation,track-paced'
$env:OPENPE_EXPERIENCE_TARGET_MS = '50'
node scripts/benchmark-editor-experience.mjs layout-50ms
```

The target defaults to 100 ms and accepts positive finite values. Acceptance
requires the complete navigation and paced-track plans, cold pickups, both pinned
track cases, exact preview/commit geometry, native-file equality and undo. Each
paired event and calibrated API-invocation upper bound through the second animation
frame must be strictly below the target. Missing or unpaired evidence cannot pass
`layoutInteractionTarget.goalWithinTarget`; D/Enter keydown and keyup use separate
API clocks.

`OPENPE_EXPERIENCE_OPERATIONS=layout-navigation-latency` compares eight captured-pan
moves with eight wheel zooms at the same pacing. Fit, positioning and capture
pickup/release stay outside the samples. Ordered original inputs and expected
camera poses must match. The report retains raw events and calibrated API timings,
separating input queue, observed-event-to-camera-DOM and second-animation-frame
intervals. Each expected pose must appear by the first RAF checkpoint registered
at window bubble after the application handles that same event. Ordinary wheel
idle rebasing and captured-pan lifetimes remain active.

`OPENPE_EXPERIENCE_OPERATIONS=layout-zoom-frames` instead sends 24 wheel inputs
(12 in, 12 out) with 16 ms idle after each acknowledgement. `zoomFrameCadence`
retains bounded RAF timestamps and complete intervals between the first and last
delivered wheel events, excluding setup and the idle tail. It reports average
callback frequency, P95/maximum frame interval and counts above 33.3/50 ms.
Camera restoration, unchanged dirty state and native-file equality are checked.

Connected footprint drag geometry, without painted frames, is
[benchmark-footprint-drag.mjs](../scripts/benchmark-footprint-drag.mjs). It warms one
gesture, then records preview and blocked-boundary time on EMC Flyback and
LMR12010. It does not launch Electron and does not replace the acceptance plan
above. Painted pointer frames, dropped frames, input-to-paint duration, React
commit time and release-to-commit time are
[benchmark-footprint-drag-frames.mjs](../scripts/benchmark-footprint-drag-frames.mjs).
It fits the board, then presses a screen point taken from the rendered footprint
bounds, in the default left-button mode. It uses an isolated data directory and
does not replace the acceptance plan above.

DOM markers, second RAF and callback cadence are separate renderer measurements,
not physical-device latency or GPU/display presentation. The bundled Chromium's
[CDP input route](https://github.com/chromium/chromium/blob/156.0.8078.48/content/browser/devtools/protocol/input_handler.cc)
waits for compositor synchronization before forwarding each wheel event; pointer
moves skip that barrier. Synthetic queue differences cannot establish physical
mouse latency. Neither optional sample replaces the complete acceptance plan,
and acknowledgement pacing does not measure a fixed-rate continuous input stream.

| Mode                    | Setting                                            | Evidence and limits                                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current built renderer  | Default                                            | Copies and hashes `out` into a private profile; unchanged source/copy manifests and original Electron main identity are required. Host resources remain current.                                                                                                                                                         |
| Retained renderer A/B   | `OPENPE_EXPERIENCE_RENDERER_SNAPSHOT`              | Accepts only unlinked workspace `test-results/editor-experience-*/renderer/1` or `/2` snapshots with a matching prior artifact record and manifest. Reports retain source/record hashes.                                                                                                                                 |
| Development renderer    | `OPENPE_DEV_URL`                                   | Uses an already-running `npm run dev:web` server; cannot accompany a retained snapshot and makes no fixed-build claim.                                                                                                                                                                                                   |
| Node diagnostics        | `OPENPE_PROFILE_NODE=1`                            | Bounded CPU/thread/event-loop observations of the benchmark process; excludes Electron CPU and changes no acceptance clock or threshold. Compare diagnostic runs separately.                                                                                                                                             |
| Input trace             | `OPENPE_PROFILE_TRACE=input` with Node diagnostics | Probes a fixed category allowlist once and records explicit renderer/trace clock anchors. Missing critical categories, anchors or threads yield `inconclusive`; trace coverage cannot establish a latency pass.                                                                                                          |
| Native wheel diagnostic | `OPENPE_EXPERIENCE_OPERATIONS=layout-native-wheel` | Injects one guarded Windows pointer move and four alternating wheel ticks through an owned worker. Requires verified process/window/profile identity, foreground focus, unchanged viewport/DPI and released buttons/modifiers before every input. Interference aborts; no activation or cursor restoration is attempted. |

Formal accessibility runs additionally set `OPENPE_EXPERIENCE_NATIVE_AX=1`;
otherwise the natural accessibility environment remains unchanged. Native wheel
QPC timestamps and exact ordered DOM wheel events use the same second-RAF endpoint,
but remain separate from CDP acceptance and goal status. Profiles retain bounded
partial evidence on failure. Diagnostics preserve the existing failure/overload
guards and input budgets. Unset diagnostic/snapshot variables before an ordinary run.

These helper checks verify the measurement mechanisms without launching Electron:

| Browser-free check                                           | Responsibility                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `node scripts/editor-experience-clock.mjs --test`            | Clock calibration, paired event/API intervals and acceptance completeness.       |
| `node scripts/editor-experience-artifact.mjs --test`         | Bounded renderer copying, manifests, retry and native-module identity.           |
| `node scripts/editor-experience-node-diagnostics.mjs --test` | Bounded process diagnostics, lifecycle and unavailable counters.                 |
| `node scripts/editor-experience-trace.mjs --test`            | Trace modes, category selection, clock anchors and metadata.                     |
| `node scripts/editor-experience-native-input.mjs --test`     | Native-input parser and compiled C# guards; no Win32 observation or input calls. |
