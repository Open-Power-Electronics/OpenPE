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

## Project integrity and schematic synchronization

Every edit and accepted synchronization is a complete-project Core transaction.
Entering Layout/Model validates pending Source first; invalid drafts remain
editable and block entry/writes. Navigation alone creates no undo edit.

Loaded boards stay authoritative until relevant primary-sheet inputs change.
Opening, saving, board-only edits and other-sheet changes do not refetch packages
or normalize nets. Ordinary Value, simulation and custom captions retain PCB
network names, fills and packages while updating linked captions.
Participation-only edits retain PCB bytes. Power-symbol Values, references,
assignments, geometry and libraries remain electrical synchronization inputs.

Relevant edits automatically synchronize even while Layout is hidden; there is
no Update PCB action. The host resolves bundled footprints with at most three
concurrent requests, then Core validates the prepared complete project.
Unsupported geometry/ambiguous connectivity fails atomically; Source, revisions
and close gates reject stale work. Save/export wait for required synchronization.
Cached success applies only to internally owned immutable inputs; missing results
and mutable inputs retry/revalidate.

A nonblank assigned Footprint makes an instance physical. Unassigned instances
create no package or missing-package warning. Clearing assignment or deleting a
part removes its linked package and retains copper in the same undo edit.
Layout placement updates the assignment; deleting a linked package clears it.
This classification never changes simulation participation.

Synchronization retains package UUID, placement, rotation and side; replacement
retains matching pad UUIDs. Source aliases keep embedded geometry until explicit
reassignment. New packages appear beside the board. Physical pin numbers, units,
labels and power pins determine nets; incidental crossings remain separate.
Pad nets are read-only. Conflicts/no-connect errors require schematic fixes.
Unambiguous net merges/renames carry copper; splits retain previous copper nets
with a review notice. Replacement never moves track endpoints.

## Layout tools and navigation

Lazy Layout stays mounted with selection, camera and tool preferences. Hidden
presentation defers rebuilding until reveal, while Core/query/synchronization
state stays current. Leaving cancels gestures; modal input suspension retains
them. Display/navigation state stays outside native content, undo and dirty state.

Model opens a completely empty PCB as an empty editable CAD canvas without
inventing a board outline or surface. Boards with artwork, packages or copper
still require valid closed Edge.Cuts for physical preview.

Equal X/Y millimetre scaling and the current SVG transform govern pointers,
hit geometry, annotations and export. 100% uses CSS 96 px/in, not monitor
calibration. Resize retains scale. Space/Home and Fit board use closed Edge.Cuts;
Ctrl/Cmd+Home fits visible objects. These camera bindings remain available during
thermal probing. Middle/right drag pans; a stationary right click opens canvas actions without changing design geometry.
The status bar reports absolute mm, zoom and a scale bar. Horizontal-only wheel
input does not zoom; bounded zoom
retains its pointer/centre anchor, and pan retains tool world coordinates.

The camera updates root SVG/grid/hit bindings independently of drawing trees.
Coordinate-only internally owned track previews retain their committed target
binding. Track identity, ordering, layer or width changes refresh only track
targets; viewport, non-track geometry or copper-parent changes replace the binding.
Within an unchanged, untransformed viewport, bounded transient pan/zoom uses a
root CSS matrix with compensated visible non-scaling strokes. Transparent hit
padding becomes exact before picking. Numerical camera state updates immediately;
navigation presents only its latest pose once per animation frame. Pointer
mapping rebases the displayed transform to the latest numerical pose, preserving
continuous wheel anchors and pan coordinates. Picking and captures first consume
any pending pose. Initial application and drawing replays stay synchronous;
rebinding/disposal cancels the old frame. Ordinary navigation rebases the native
viewBox after at most 120 ms idle. Only actual captured-pan updates can pause idle
rebasing, and only for pure translation. Picking, commands, drawing commits,
captures and binding disposal always consume and flush the latest native pose.
Captured-pan release, cancellation, capture loss, blur and deactivation also
flush it. Wheel, Fit, resize and drawing replays keep ordinary rebasing.
Committed camera bindings reserve clipped background, grid and interaction bounds
at twice the native viewport width and height. Navigation, idle rebasing and public
camera flushes retain covered bounds. Coverage loss or a reserve exceeding four
times either current or native viewport dimension first rebases the exact camera
and recentres a finite reserve. Drawing replays repair those committed bounds;
foreign transforms or clipping, viewport changes and binding disposal restore
exact viewport bounds. Export and annotation clones normalize their background
and grid independently, without changing the live reserve.
Native rebasing measures the physical viewport before camera writes when its
owned positive scale is verified; uncertain scaled bounds retain the settled
measurement and its original tolerance. Restored clipping remains authoritative.
Initial application, resize, ancestor
transforms and large camera jumps use native updates. Current world transforms
and Agent observations remain authoritative; camera state never enters native design.
One binding owns each SVG: replacement retires its predecessor before viewport
and style capture, discards obsolete queued poses and preserves the new owner.
Camera eligibility reads fresh Typed OM computed values where supported, with
resolved-style fallback; foreign transforms and priorities retain native updates.
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
Track previews hide saved fills after displacement, restore them on cancellation
and invalidate them only on committed copper changes. Repeated track poses from
one owned basis retain its fill-free stationary zone/package owners after normal
invalidation; changed owners prepare independently. Each pose remains a distinct
board and receives complete Core validation before commit. Airwire analysis retains
its two-million-operation bound. Divider resize cursors release on cancellation,
deactivation and unmount.

Manual tools place/move/rotate footprints, route, place vias and draw closed
rectangles or polygons on the selected layer. Properties assigns networks and
fills selected regions. The right dock combines Properties and Appearance.
Its full-height left edge resizes the complete sidebar from 224 px up to 480 px,
retaining at least 160 px of drawing space. The default is 280 px; Arrow keys
resize by 16 px, Home/double-click resets and Escape cancels a drag. Width remains
view-local presentation through hiding and project navigation, preserving scale,
drafts and native content.
Properties retains the same object's drafts through sidebar hiding/deactivation,
with inactive controls; closing it/changing subject resets drafts. Appearance's
Visualization contains Layers, Objects and Nets tabs with retained display choices. Properties, Visualization and Selection share contrasting collapsible headers and default open above their independently scrolling content. Their order stays fixed through every expansion/collapse combination. Visualization and Selection each fit their own content without stretching, capped at 60% with internal scrolling when constrained. Their combined height is the sum of those sections, with Properties filling the remaining space above. Each collapsed section reserves only its header in place; the complete section stack stays at the bottom when Properties is collapsed. Collapsing Properties retains its mounted drafts. The right toolbar actions use 4 px gaps. The sidebar toggle follows Parts list at the far right, separated by one centered 18 px soft divider with an 8 px inset and 4 px outer gap. Toolbar padding remains 6 px vertically, 8 px left and 15 px right at compact and wide widths. File tabs and New file stay at the document bar's left; the view tabs stay at its far right with 44 px minimum widths, 6 px gaps and a 12 px inset without another vertical rule. File/view tabs and New file use 36 px profiles in a document row that grows from 44 px; file close/action targets are at least 34 px. Both tab types use rounded top corners and square bottoms, with the selected surface joined to the toolbar below. The selected view keeps its label visible with soft side borders and a transparent top border; inactive views rest as transparent icons and retain animated label expansion on hover/focus, immediate under reduced motion. Neither display section has a toolbar button. Nets keeps search and
independent search/highlight clearing accessible while scrolling; clearing search
restores its focus. Layers/filters never edit design data.

The initial top view has no display-priority layer. It paints complete layer
passes in physical order from the back side through the native copper stack to
the front side; front copper covers inner/back copper and front artwork covers
front copper. Technical guides and annotations remain presentation overlays.
An explicitly selected layer moves its complete visible pass to the top.
Clicking its row again clears the priority, restoring the physical stack while
retaining the copper tool layer, gestures and pending drafts. Through pads and
vias paint once; drill voids remain above physical artwork. Default marquees include all visible layers; explicit priority
restricts them to that layer. Equal-distance point picks follow the visible stack.

Properties uses shared labelled rows and sections for footprints, pads, tracks,
vias, board graphics/text/dimensions, zones, rule areas and board settings.
Linked footprints share Schematic's symbol identity, editable Reference/Value,
field table and Footprint chooser. SPICE controls belong only to Schematic's
installed and enabled SPICE Simulation plugin; Layout retains their underlying
native attributes without showing a simulation section or participation switch. PCB pose and side follow
the shared form, with a fixed deletion footer. Empty inspection uses the same
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
survive replacement; affected saved fills are invalidated in that same undo edit.
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
unrelated records. Geometry/copper edits invalidate fills in the same Core undo;
readouts, unchanged fields and viewing create no transaction. Dimension metadata
is preserved in native output; the bounded preview does not render all native
dimension decorations or recalculate its stored caption from formatting rules.

Selection independently gates footprints, tracks, vias, pads, text,
graphics, dimensions, zones and rule areas. These supported categories default
checked, so All items starts checked and reports a mixed state only when their
eligibility differs. Locked items defaults unchecked, independently gates picking
locked tracks without unlocking them, and is excluded from All items. Unsupported
Points stays disabled and unchecked. Direct nearest-geometry picking works through disabled
categories and footprint overlays. Explicit inspection reveals a collapsed dock.

Place footprint opens an independent centered component/library chooser with
2D/3D previews. Its confirmation starts placement; the edit commits only on canvas
after rechecking that the target exists and is unplaced. Cancelling a reopened
chooser retains the preview.
Library placement retains coordinates through six decimal places and supports
rectangular, circular, oval and rounded rectangular pads with an explicit
0–0.5 corner ratio. Pad positions, corner ratios and straight artwork remain
exact through native Save and reopening; unsupported geometry is rejected.
Route tracks uses a compact nonmodal horizontal panel 8 px below the drawing top
and 12 px from its left edge. Its width follows the content up to 720 px, with a
Track width prefix, three inline numeric fields and pinned Close. The width, via
diameter and via drill remain available before a via transition. The Net-prefixed
via strip follows the same content-sized layout, exposing net, diameter and
smaller drill. The rectangle and polygon strips share Net and Layer selectors with only a pinned × close action. Net defaults to Unassigned and remains optional on copper; it is disabled on other layers. The layer starts from the selected display priority or retained copper layer. Selecting a layer in the strip reveals it and sets its display priority. Both tools retain the presets. Width is edited afterward in Properties; new copper regions use 0.2 mm minimum thickness and other regions use 0.05 mm line width. Parameters scroll horizontally within the drawing width. Activation reveals the drawing layer. Rectangle uses two opposite corners; polygon uses at least three corners. First-corner closure, Enter and double-click publish one closed region without duplicate vertices. Copper output is a native zone with the chosen net and fill disabled; other output is an unfilled native polygon. Both select the accepted region and restore canvas focus. Properties subsequently edits net, layer, width and fill.

Net/layer changes, unrelated board revisions and cancellation discard the complete preview without partial writes. Escape clears a draft before idle Escape exits. Polygon Backspace removes one corner. Rejection retains its exact draft for retry. Same-layer endpoints attract within eight screen pixels; Shift bypasses attraction and Ctrl/Cmd bypasses grid snapping. Preview and native output use the same layer/coordinates; hidden-layer drafts cannot commit. Edge.Cuts uses a 0.05 mm display floor, retaining native widths. Number-field Escape restores accepted input/canvas focus. Selector Escape closes options first; IME composition, including code 229, cannot apply or cancel.

Closed-region interiors are fallback point targets behind precise copper and strokes, respecting visible outlines, filters and cutouts. Properties groups net/layer, clearance/minimum width and bounds into paired rows. Zone bounds and the following Fill rules are collapsed until requested; zone-corner and cutout coordinate lists are omitted without changing native geometry. Retained drafts survive disclosure and dock visibility changes. A fixed footer outside the scrolling fields keeps Delete object at the bottom right for every selected object or group. Copper zones also show a neutral paint-bucket Fill/Refill icon immediately before Delete. Pad inspection remains distinct from object selection and does not expose owner deletion.

### Rectangular outline editing

Selected axis-aligned rectangular Edge.Cuts polygons and closed four-line frames
expose eight corner/edge resize handles and X/Y/Width/Height Properties. Resizing
retains native object UUIDs, ordering, widths and metadata, and moves only the
frame vertices. Fixed opposite edges retain exact coordinates; dragged axes use
the selected grid (Ctrl/Cmd bypasses it). Four-pixel jitter remains clean and
crossing an opposite edge clamps to a positive size. Pointer preview does not
write; release commits its exact checked bounds once and invalidates fills in
that undo. Escape, pointer cancellation, layer/tool/board changes and deactivation
cancel without writes. Source and Core revision gates still reject publication.
Nonrectangular/open/branched outlines retain ordinary graphic editing.

Selected board copper zones and rule areas use the same handles and numeric
bounds. Resize their polygon and hole vertices together within the new bounding
rectangle, preserving shape proportions on each axis, UUID, net, layer and rules.
Board edges, components and other copper do not scale. Existing vertex fields
remain available. Saved fills become stale only in the committed transaction;
explicit refill uses the resized boundaries. Embedded footprint zones retain
footprint ownership rather than acquiring independent box handles.

`tests/pcb-outline-resize.test.ts` covers geometry, metadata and Core undo;
`node scripts/check-layout-outline-resize-ui.mjs` checks actual LM2596 native
Source, both frame representations, zones, handles, numeric sizing and cancellation
in an isolated renderer.

### Thermal result presentation

[Thermal FEM](THERMAL.md) owns analysis/results and replaces the ordinary dock
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

Click a layer row to prioritize that copper, silkscreen, fabrication, courtyard,
mask/paste or edge layer; clicking the same row again restores the physical
stack. Each visible layer's copper, pads, footprint/board artwork and captions
share one pass. Shared through pads and vias belong to the highest visible
copper pass, with drill voids above artwork. Airwires remain an observation
overlay. Layer eye controls retain independent visibility;
selecting a hidden layer never reveals it. Hidden geometry still obstructs
electrical routing.

Containment and crossing marquees cover all visible layers in the default view;
explicit priority restricts them to that layer, retaining category filters and
selection modifiers. Through pads/vias participate on each physical copper
layer; restricted footprint bounds use only that layer's body geometry. Point
ties follow explicit priority or the default physical stack.
Select all and explicit report navigation still cover all eligible visible
layers. Copper row selection also chooses the routing layer; a noncopper row
retains the copper tool layer and exits active copper drawing
so its artwork can be selected. Opening copper tools or refilling zones never
silently changes the priority row. New zones use the retained copper layer in
the default view and reject an explicitly prioritized noncopper layer;
an explicit routing anchor or via transition may select its actual copper layer.

Captions retain source anchors/rotation/mirroring while resolving linked values.
Pad numbers/net names have independent switches, fitted labels and full-name
inspection. Source-hidden fields remain hidden. Selection preserves layer hues,
uses theme-aware contrast and retains widths/geometry; exports omit selected
paint. Properties and locked-track changes use ordinary Core undo. Native locked
tracks stay fixed during canvas edits/Shove until explicitly unlocked.

### Airwires and copper display

Airwires are bounded geometric connectivity observations, not DRC. Copper preview
shows saved fills independently of zone outlines; selected fills retain their
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
obstruct routes; committed changes invalidate them for explicit refilling.
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
share checks. With a closed board outline, standalone and route-transition via circles hide outside the board material, including cutouts; placement remains blocked there. Inside-board collisions retain their blocked preview. Routes never push tracks or reroute when footprints move.

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

GUI and Agent `layout.drag` share `createPCBInteractiveTrackDrag`: connected
chain reshaping/local avoidance, picked corner/joint drag, posture and full-board
checks. Connected mode defaults to Shove; Walk Around replans against stationary
copper. The command accepts the exact pickup and a corner endpoint tolerance
(default 0.5 mm); corner mode requires one track and pickup. Exact placement is
the default. Explicit `constrain:true` uses the canvas boundary planner with an
optional revalidated `previousDelta`, and returns requested/applied displacements,
constraint status/reason and changed IDs. No blocked or stale preview can commit.
Routing checks include hidden copper, holes, artwork, closed edges/cutouts and
keepouts; selected nets also check each other. A failed reconnect blocks the edit.

Pointer/arrows update the exact preview; `/` changes reconnect posture;
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

Pours are neither obstacles nor fixed contacts; accepted edits invalidate fills
once. Bounds: 256 selected tracks, 15,000 copper objects, 512 reconnect sites,
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

Zone completion by Enter/double-click/closed polygon commits once and
restores canvas focus; rejection retains the draft/focus for retry. Properties
edits net/layer, clearance, minimum width, thermals, priority and bounds.

Fill copper zones is explicit and undoable. Bounded Clipper geometry clips closed
edges/cutouts, subtracts foreign copper/holes/keepouts, resolves priority and
creates solid/thermal contacts. Curves use nominal 0.01 mm tessellation within
caps. Invalid/open/excessive geometry fails. Islands remain; complete KiCad
island/fabrication rules are unsupported.

There is no standalone fill toolbar button or settings strip. The Properties footer Fill/Refill icon enables and fills the selected zone as one transaction. Its hover title and accessible name distinguish Fill from Refill; it disables during calculation and normal edit barriers. The Filled switch can also enable fill; disabling it removes the fill. Unfilled/stale contours show the switch off and the footer offers Fill. The default minimum clearance is 0.25 mm; each enabled zone retains the larger existing rule, measured from copper edges. Selected-zone fill respects the complete board's priorities, obstacles and enabled zones but publishes contours only for its target. Adding, removing, assigning or reshaping fill-disabled zone outlines preserves existing pours, including overlaps and embedded zones. Rule areas remain obstacles regardless of their fill flag. Enabling a zone or changing effective copper rules invalidates other affected fills once. Failed calculation leaves all design data unchanged. The `layout.fill` command accepts an optional board zone ID; omitting it explicitly fills all enabled zones. Valid command minima remain 0.0001–1,000 mm. Native zero clearance cannot supply inherited KiCad board/net-class rules, so filling applies the explicit minimum. Viewing and Properties disclosure never calculate fills.

`filledPolygons` allows 60,000 saved vertices per board: absent is unfilled;
empty is a completed empty fill. Native contours retain holes through doubled
bridges. Viewing/saving/display never recomputes fills. Copper/rule edits clear
stale fills in the same transaction. Refill/check in KiCad before manufacturing.

## Model rendering and lifetime

Model uses bounded STEP parsing/Three.js without installed KiCad. It renders
board thickness, closed edges/cutouts, drills, outer copper, pads, silk and
available packages in mm. Clicking visible laminate, copper, mask or silk selects the board in Model and exposes its thickness field; Layout empty Properties has no thickness setting. Component/CAD occlusion and the body filter govern board picking. The field uses the existing validated PCB replacement transaction with the exact current board and Source/close guards, retaining its draft while hidden. Native thickness, 3D geometry and whole-project undo stay in agreement. Neutral fallback bodies are estimates; late real
models replace them without camera movement. Filled silk and mask artwork retain
their native stroke as well as their interior; closed strokes keep their inner
clearance. Text retains linked values and transforms using bounded textures with
the shared local UI font, without Newstroke parity.
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

Visualization uses Layout-styled Views and Display tabs, initially Views.
Views offers Top, Bottom, Front, Back, Left, Right and Isometric presets in a
compact two-column grid, with Isometric spanning the final row. An Orthographic
projection toggle follows a soft divider. Controls retain visible labels and
aligned icon/text columns. All view icons are 14 px; the first column shares the
12 px leading inset and 34 px text alignment of disclosure headers, visibility
rows and Selection. The toggle retains its pressed state and accessible name. View presets
retain the orbit target, zoom and projection mode and explicitly redraw the
current scene, including after view or project restoration.
Tabs support arrow keys and Home/End and retain
their selection across drawer, view and project switches. Only the active panel
is exposed. Display uses the shared compact visibility rows, colour swatches and
eye controls for CAD solids, component models and silkscreen. View,
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
Properties views share the Delete object button and fixed footer style.
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

### Retained scenes and requests

Model retains each project's scene/camera/projection/visibility across
navigation. Hiding pauses rendering/new requests and defers rebuilds; reveal
reads current board/captions/CAD/Source/revision guards. Unrelated schematic
poses retain geometry. Solid pose/name changes retain meshes; changed shape,
holes or appearance replace only affected resources. Commit/preview groups own
separate resources. Replacement/close aborts obsolete work and disposes WebGL
resources. Missing models show notices without blocking the board or offering a
retry action. Failed 3D preview initialization retains its retry action.

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

Model shows intersecting grid lines only during sketch drawing, aligned and
anchored to the selected workplane. Plane setup shows a translucent surface with
its boundary/axes; normal 3D, finished profiles and extrusion have no grid. The Grid selector uses
independently saved 0.5/1/2/5/10 mm spacing, default 0.5 mm, and the shared Off
setting. Lines coarsen by powers of two for the current camera scale; bounded
display geometry is retained between unchanged updates. Grid visibility/density
never changes CAD's 0.5 mm snap, native files or undo, and the grid is excluded
from picking, Fit, physical clipping bounds and exports with the transient sketch.
The finite plane boundary extends camera clipping only while setting up or drawing
a sketch, keeping distant planes visible without adding the grid to physical bounds.

Model adds independent boxes/cylinders and rectangle, circle or polygon sketch
extrusions. Sketch first previews an XY, XZ or YZ workplane with an editable
Offset in millimetres along the plane normal from the model origin, defaulting to
0 mm for every plane in a new sketch. Each valid
input updates its surface and status
bar plane/coordinate readout without blur or confirmation; invalid input hides the
preview and disables Start sketch. The one-row strip exposes Plane, Offset,
Start sketch and Close, preserving the 3D camera until drawing begins.
Start sketch aligns the retained camera orthographically
to that exact plane; contextual drawing tools operate on the shared Model PCB
canvas. Finish sketch restores the previous 3D camera/projection and retains
the outline. Extrude is a separate 3D action: its distance/direction preview
commits only on Apply, as one existing solid-add transaction. Cancel extrusion
returns to the outline; Edit sketch returns to drawing without losing the profile.
Profile validation does not depend on a hidden extrusion distance.
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
RGB color, opacity and local-Z through holes. Properties Color previews an optional
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
vertical edges; cylinders/circle extrusions expose circular rims. Hole rims are
individually selectable. Edge picking uses a bounded pixel tolerance and rejects
occluded/back edges. Boolean results have no editable edge topology catalogue;
their edge tools remain unavailable. Edge treatments require explicit semantic edge IDs.
Canvas drilling
transforms hits into body-local coordinates and validates material clearance.
Field drafts/previews remain local until Apply; stale drafts require Reload.
Source/revision/deactivation cancels tools without stealing external focus.

Union, Difference and Intersection consume two selected bodies and retain an
immutable geometry-only operand recipe. Selection filters permit solids,
analytic faces, edges or straight edges as lines on the canvas; ordinary
Interaction picks among the enabled categories. Modifiers add/toggle entities
and the Properties readout names the selected type. Selection is presentation
state and cannot mutate a parent body through a face/edge shortcut. Untreated
primitives/extrusions expose analytic faces with holes; treated and Boolean
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
use subtractive solids instead of local through holes. Recipes have bounded depth
and operation counts, not arbitrary executable CAD programs.

Advanced draft meshes come from authenticated `/api/model-cad/preview`: the host
validates parameters, generates fixed Gmsh/OpenCASCADE operations, creates STEP
and tessellates that STEP through the bundled parser. STEP export uses the same
shape construction. An empty, invalid or failed rim/Boolean result remains
retryable and cannot commit an earlier mesh. The pure Core accepts changed
advanced geometry only after the host prepares its exact canonical shape key;
human/Agent commands, whole-project replacement and Source apply share this gate.
Pose/material/name changes can reuse unchanged geometry. Save and navigation
apply pending Source through the same preflight and revision checks. No thermal
or electrical solve runs for CAD preparation.

M moves a selected solid; R/Shift+R rotates local Z by ±90°; Enter commits a valid
placement/move once, retaining dimensions/holes. Numeric X/Y replaces pointer
placement in Move/Properties with exact entered coordinates, retained during camera navigation;
pointer placement uses 0.5 mm snapping. Wheel/middle/right navigation remains
available during placement/drilling without committing, with current camera/
bounds refreshing pointer previews. IME, text drafts, dialogs and active gestures
block conflicting shortcuts. Field Escape restores only edits since focus;
composing Enter/Escape/code 229 does nothing. Explicit Cancel/Close restores
Properties/canvas focus. Box and Cylinder placement expose only dimensions and
Close, omitting a title/name prefix. Fields fit without horizontal scrolling and
wrap only on narrow canvases. Name, position, rotation, material, opacity and holes
remain in Properties after placement. Docked Properties retains its disclosures.

Pan retains inspection and unapplied Properties drafts/previews while cancelling
an active tool. Placement/duplication reveals the new solid's Properties without
stealing action/canvas focus and replaces component inspection. Tool start/cancel
retains component inspection. Unapplied solid drafts block drilling at toolbar,
start and commit. CAD/component visibility and scene resources remain
independent; hidden Model defers rebuilds.

EMC Flyback builds its enclosure with four ordinary editable CAD boxes: an
aluminium base, two side walls and a transparent PMMA cover. Base/cover holes
use the same local-Z cuts as manually placed solids. The example stores these
bodies in `OPENPE_MODEL_CAD`; its original MECH1/MECH2 STEP assignments retain
their paths and transforms with native visibility disabled. Editing or deleting
CAD bodies therefore does not reveal a duplicate static enclosure. Independent
panels stay separate in STEP until explicitly united.

Model's toolbar has no STEP export button. Host `enclosure.exportStep` exports current independent CAD
solids from active Model through a native picker. Applied Source is required;
a saved destination is not. It uses fixed validated OpenCASCADE operations,
retains rotated analytical profiles/holes/selected-edge treatments/Boolean results and
keeps independent overlapping bodies separate unless explicitly combined.
It accepts no renderer path. Appearance is not STEP material metadata. File Export's
OpenSCAD model carries the same solids, poses, holes and Boolean recipes with faceted
circles, material colours and opacity, and rejects fillets/chamfers without writing.
Arbitrary mesh imports, executable geometry programs, SCAD import/execution and
whole-assembly simulation are unsupported. CAD does not couple into board Thermal FEM.

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
eligibility. Element picks use Interaction's nearest-geometry ranking and three-screen-pixel
surface tolerance; element marquees share its directional geometry and layer-priority rules.
The element tool creates no annotation when a click or marquee
finds no eligible objects. Filter changes clear ineligible live highlights and
reject captures started with older eligibility. Saved screenshots/comments
remain immutable and previewable. Explicit rectangle/freehand tools may capture
regions without eligible objects.

Element annotations share Interaction's geometry colour, contrast, widths and
opacity, without an extra blue bounds box. Their drag rectangles share the
directional selection paint. Numbered pins and comments remain available;
explicit rectangle/freehand annotations retain their blue region marks.

Schematic, Layout and Model expose Export image through the canvas context menu, alongside view-specific camera and selection commands. The bottom-right controls retain zoom; Schematic and Layout also retain Fit, while Model exposes Fit through its context menu and Space. Right dragging never opens the menu; stale/deactivated menus cannot execute.

Native PNG export preserves live selection/camera/destination and omits controls,
selection paint, annotations and gestures. Longest side is capped at 4096 px:

- Schematic: complete visible content/text plus 4 mm, with theme/layers/grid.
- Layout: closed board bounds, up to 20 px/mm, with layers/grid/airwires.
- Model: current camera at canvas resolution with transparency.

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

## Examples and verification

Home has nine curated projects under Example and fixed EMC Flyback Recent. Their original
geometry, source attribution and model identities remain pinned; support does
not establish hardware qualification. [Examples](EXAMPLES.md) owns
regeneration/assets and [EMC verification](EMC-FLYBACK.md) owns recorded numerical
comparisons.

| Check                                                                                                                                                                                                                      | Scope                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/pcb-project-sync.test.ts`, `tests/pcb-layout.test.ts`, `tests/pcb-routing.test.ts`, `tests/pcb-fill.test.ts`                                                                                                        | Synchronization, geometry, routing/fill transactions                                                                                                                     |
| `tests/pcb-properties.test.ts`, `node scripts/check-layout-properties-ui.mjs`                                                                                                                                              | Unified object fields, pad/via classification, native geometry/rules, undo and rejected drafts                                                                           |
| `node scripts/check-layout-editing-ui.mjs 'properties actions'`                                                                                                                                                            | Fixed deletion footers for selected objects/groups, icon-only fill, rejection and IME guards                                                                             |
| `tests/pcb-track-chain-drag.test.ts`, `tests/fixtures/emc-track-drag-kicad10.json`                                                                                                                                         | Ten installed KiCad 10.0.1 EMC references, tested in Shove/Walk Around through GUI and Agent paths; sampled centerlines, same-chain selection, native roundtrip and undo |
| `tests/layout-drag-capabilities.test.ts`                                                                                                                                                                                   | Agent discovery, picked corners, explicit constrained placement, GUI result parity, revision/Source barriers and native undo                                             |
| `node scripts/check-component-delete-ui.mjs`, `node scripts/check-model-cad-ui.mjs --delete-actions`                                                                                                                       | Shared delete button/footer across all three views; Model component/CAD removal, Agent parity, IME/Source/draft gates and native undo                                    |
| `node scripts/check-copper-fill-ui.mjs`                                                                                                                                                                                    | Properties fill, selected-zone Core/native clearance, Source and undo                                                                                                    |
| `tests/pcb-track-drag.test.ts`, `tests/pcb-track-drag-copper-key.test.ts`, `tests/pcb-track-shove.test.ts`, `tests/pcb-track-joint-drag.test.ts`                                                                           | Connected/free-angle geometry, contacts, owned-key reuse and bounds                                                                                                      |
| `tests/layout-camera-pan-reserve.test.ts`, `node scripts/check-layout-compositor-ui.mjs`, `node scripts/check-layout-frame-reserve-ui.mjs`                                                                                 | Camera scheduling, finite frame coverage, exact rebase, picking, captures and pixels                                                                                     |
| `tests/model-camera-clipping.test.ts`, `node scripts/check-model-compositing-ui.mjs`                                                                                                                                       | Model depth precision, transparent assembly compositing and native opacity preservation                                                                                  |
| `tests/model-cad.test.ts`, `tests/model-cad-emc.test.ts`, `tests/model-cad-step.test.ts`, `tests/model-cad-kernel.test.ts`, `tests/model-cad-host.test.ts`, `tests/model-cad-scene.test.ts`, `tests/model-picking.test.ts` | CAD schemas/proof gates/EMC construction/native round trips/STEP/kernel transport/retained meshes/picking                                                                |
| `$env:OPENPE_TEST_MODEL_CAD = '1'; npm test -- tests/model-cad-kernel-native.test.ts`                                                                                                                                      | Opt-in real bundled CAD kernel preview/STEP agreement and empty-result rejection                                                                                         |
| `tests/model-cad-selection.test.ts`, `tests/model-cad-faces.test.ts`, `tests/model-cad-operand-ghosts.test.ts`                                                                                                             | Typed selection, analytic face hits/paint and selectable operand resource ownership                                                                                      |
| `node scripts/check-layout-ui.mjs`, `node scripts/check-layout-routing-ui.mjs`, `node scripts/check-layout-track-drag-ui.mjs`                                                                                              | Isolated Layout editing/preview integration                                                                                                                              |
| `node scripts/check-model-cad-ui.mjs`, `node scripts/check-object-retention-ui.mjs`                                                                                                                                        | Isolated CAD focus/drafts and retained scenes                                                                                                                            |
| `node scripts/check-model-cad-ui.mjs --sketch-plane`, `tests/model-cad-sketch-scene.test.ts`                                                                                                                               | Live workplane coordinates/surfaces, distant-plane clipping/start alignment, draft/IME guards, camera restoration and preview resource disposal                          |
| `node scripts/check-model-cad-ui.mjs --color`, `tests/model-cad-mesh.test.ts`, `tests/model-cad-scad.test.ts`                                                                                                              | Solid color drafts/preview, material reset, undo, native persistence, appearance rendering and OpenSCAD color                                                            |
| `node scripts/check-model-cad-ui.mjs --sketch-input`                                                                                                                                                                       | Zero-offset rectangle/circle click and drag gestures, incomplete previews, Escape/IME guards, extrusion Apply and native-file undo                                       |
| `node scripts/check-emc-editing-workflow-ui.mjs`                                                                                                                                                                           | Offline real native Save/reopen, CAD/STEP and cross-view undo                                                                                                            |
| `node scripts/e2e-new-project.mjs`                                                                                                                                                                                         | Opt-in desktop: blank-project wiring, package placement, copper routing, board outline and Model edits; native Save/Save as and reopening in a fresh process             |
| `npm run examples:check-models -- --render`                                                                                                                                                                                | Verified offline STEP assets and all ten Home Model views                                                                                                                |

After explicit desktop-test authorization, measure the current built renderer
with EMC Flyback using PowerShell:

```powershell
$env:OPENPE_EXPERIENCE_OPERATIONS = 'layout-navigation,track-paced'
$env:OPENPE_EXPERIENCE_TARGET_MS = '50'
node scripts/benchmark-editor-experience.mjs layout-50ms
```

The target defaults to 100 ms and accepts positive finite values. This selection
requires 23 navigation and 31 track events, including the first D pickup from a
clean board, seven separate preview heads, Enter commit and a separate pointer
drag. The pinned DRV span also has separate pickup, seven preview heads across
its fixed obstacles and commit; reachable heads must retain an unconstrained
local detour following the cursor. The exact displayed path must match committed
native PCB geometry. Before each cold pickup, untimed setup waits for the transient
camera attribute to clear, then moves one CSS pixel past the pickup and back to
its exact coordinate and awaits two frames. It makes no selection click or
electrical edit. The `paced-single-api-inputs-v2` track protocol records 31
independent API invocations for those 31 events. D and Enter each use separate
`keyboard.down` and `keyboard.up` calls, so each key event has its own invocation
clock. The key stays held during the 250 ms idle after down acknowledgement;
CDP injection does not generate OS repeat, and repeated events fail pairing.
Keyup invocation bounds cover the release call alone rather than the whole key
press; event and two-frame endpoints are measured from the input event. Each event
and calibrated API-invocation upper bound through its second animation frame
must be strictly below the target. Inputs use one
acknowledged send followed by 250 ms idle pacing; pacing is outside each input's
latency interval. Track geometry, undo and final native-file equality remain
required. `layoutInteractionTarget.goalWithinTarget` cannot pass missing,
unpaired or incomplete evidence. This bounded protocol does not measure a GPU
fence or sustained input load. Clock/pairing checks run without a browser using
`node scripts/editor-experience-clock.mjs --test`.

Built runs retain a private renderer copy and SHA-256 file manifest in their
profile. Source manifests before/after copying must match the copy; a concurrent
replacement gets one retry, then fails. Reads and copies use at most four workers;
failed batches finish pending work before retrying. The benchmark adapter compiles the
original Electron main under its original filename/module paths, changing only
the loopback static directory. Reports retain original main/benchmark source
hashes, Next version and final snapshot verification. `OPENPE_DEV_URL` runs use a
mutable development renderer and make no fixed-artifact claim. Run snapshot,
retry and module-path checks without Electron using
`node scripts/editor-experience-artifact.mjs --test`.

For a fixed-build A/B, set `OPENPE_EXPERIENCE_RENDERER_SNAPSHOT` to a retained
snapshot before the same benchmark command, for example in PowerShell:

```powershell
$env:OPENPE_EXPERIENCE_RENDERER_SNAPSHOT = 'test-results/editor-experience-RETAINED-ID/renderer/1'
```

Replace `RETAINED-ID` with an existing run profile. Only this workspace's
`test-results/editor-experience-*/renderer/1` or `/2` accepted snapshot is allowed;
every ancestor and content entry must be unlinked. Its prior artifact record and
full manifest must match, then source-before/source-after/new-copy manifests
must agree under the same bounds. Reports retain source path, record hash and
renderer SHA. Electron main and host resources still use the current workspace.
This option cannot accompany `OPENPE_DEV_URL`; unset it to use current `out`.

`OPENPE_PROFILE_NODE=1` adds optional benchmark/Playwright Node diagnostics;
unset/`0` disables sampling. Paired Layout navigation/track APIs retain their
original invocation clocks. CPU/thread-CPU and event-loop-utilization counters
are sampled afterward and at the original API return, after the unchanged
acknowledgement clock. Missing features/read failures are explicit unavailable
values. A 20 ms unref heartbeat keeps at most 2048 samples; API observations are
capped at 1024, with drop counts. Final synchronous cleanup retains completed,
failed and unfinished observations without waiting for an input or watchdog.
`nodeInputDiagnostics` retains the helper source/hash and separate evidence;
it changes no latency endpoint, acceptance threshold or overload guard. It
observes this Node process, excluding Electron main/renderer CPU. Compare tagged
diagnostic runs separately; counter collection has overhead. Browser-free bounds,
lifecycle and feature checks use
`node scripts/editor-experience-node-diagnostics.mjs --test`.

`OPENPE_PROFILE_TRACE=input` requests one BrowserMain/IO diagnostic run with
`OPENPE_PROFILE_NODE=1`. Before timing, one `Tracing.getCategories` probe selects
only available members of a fixed allowlist: timeline/user timing, top-level
tasks, input/latency, three scheduler categories and `accessibility`. Verbose
disabled categories are excluded. AX configuration stays unchanged; formal AX
runs retain `OPENPE_EXPERIENCE_NATIVE_AX=1`. The `light` and `1` trace modes use
their own fixed category sets; `0`/unset disables tracing and unsupported
modes fail explicitly. For the same reviewed snapshot, operations and target:

```powershell
$env:OPENPE_PROFILE_NODE = '1'
$env:OPENPE_PROFILE_TRACE = 'input'
$env:OPENPE_EXPERIENCE_NATIVE_AX = '1'
node scripts/benchmark-editor-experience.mjs layout-input-diagnostic
```

Reports retain selected/missing categories and bounded process/thread metadata.
Each phase creates one uniquely named `performance.mark` before input timing,
retaining renderer before/after times and the matching trace timestamp, plus raw
Performance Timestamp/NavigationStart values. This explicit anchor bounds trace
alignment; arbitrary offsets cannot establish BrowserMain attribution. Missing
critical categories, anchor or expected thread names yields `inconclusive`.
Capture coverage never infers a cause or latency pass. Per-trace 64 MB, read-only
failure cleanup and original run/input budgets remain unchanged. Mode, category,
anchor and metadata checks use
`node scripts/editor-experience-trace.mjs --test` without a browser.

The optional `OPENPE_EXPERIENCE_OPERATIONS='layout-native-wheel'` diagnostic
injects one Windows pointer move and four alternating native wheel ticks through
a private worker. Before creating that worker, the actual Electron main must be
the direct child of Playwright's Windows launch shell and agree with Browser
metrics, the selected page's sole window, verified main/app/profile paths and a
fresh private launch nonce. Reports retain both shell and actual main/parent PIDs.
Before each input the worker verifies the owned foreground HWND/PID,
unchanged client/DPI/canvas, destination ownership, pointer position and released
buttons/modifiers. The initial cursor may be outside the window; its destination
must be inside the reviewed canvas. A duplicate starting position moves one
physical pixel right within that canvas. Focus loss or interference aborts; no
window activation or cursor restoration is attempted by the worker.

`nativeWheelDiagnostic` pairs five exact ordered events with QPC timestamps
immediately before `SendInput` and the same second-RAF endpoint. DOM
`wheelDeltaY` ticks must exactly match alternating ±120; DOM delta units are recorded and must
stay consistently proportional across all four wheels. This diagnostic remains
separate from CDP acceptance and goal status; it excludes physical-device latency
and a GPU/display fence. `node scripts/editor-experience-native-input.mjs --test`
checks the parser and compiled C# guards without Win32 observation/input calls.

Documentation changes need static checks. Desktop/real-runtime verification is
separate; follow [AGENTS.md](../AGENTS.md).
