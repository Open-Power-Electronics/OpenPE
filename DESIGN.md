# OpenPE design contract

This contract owns the current interface: visual language, layout, gestures, focus and visible state. Keep it aligned with implementation and replace obsolete rules.

| Contract                                                     | Owns                                              |
| ------------------------------------------------------------ | ------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                       | Engineering boundaries and verification           |
| [Architecture](docs/ARCHITECTURE.md)                         | Module ownership and execution                    |
| [Format](docs/FORMAT.md), [Core](docs/CORE.md)               | Native preservation, Source and edit transactions |
| [Layout](docs/LAYOUT.md)                                     | PCB geometry, routing, CAD and model support      |
| [Simulation](docs/SIMULATION.md), [Thermal](docs/THERMAL.md) | Supported physics, execution and results          |

Read the shared foundation and shell first, then the affected editor section. Dimensions below are defaults; user typography can increase control height without scaling the interface.

## Product, language and scope

The descriptor/native title is **OpenPE · Electrical Engineering Studio**. UI copy, accessible names/descriptions, dialogs and errors are English; Agent responses may follow the user's language. Preserve standard electrical symbols, references and units.

Keep Agent conversation left and editor right. Schematic, Layout, Model and Source share the current project. Up to 12 projects can remain open, each with 12 independent schematics and an optional PCB linked to its primary sheet. Schematic simulation/export uses the selected sheet; Layout/Model use the linked board. There are no hierarchy or cross-file electrical joins.

Use Open Design's neutral surfaces, compact rounded controls and original Signal E identity. Manual editing, documented ERC/DRC, bounded Model CAD and supported simulation do not imply general KiCad compatibility, autorouting or manufacturing qualification. Datasheets are read-only reviewed references, not simulation results.

Show actual state: CLI detection differs from authentication/runtime support; pending reviews differ from completed edits; dirty/recovery/save states differ. Never fabricate onboarding conversations or verification.

## Shared visual foundation

### Colour tokens

| Role                  | Token                                | Value                             |
| --------------------- | ------------------------------------ | --------------------------------- |
| Shell/surface/drawing | shell, surface, canvas               | `#ffffff`                         |
| Secondary/fill        | panel, tint                          | `#fafafa` / `#ededed`             |
| Body/heading          | text, text-strong                    | `#494949` / `#202020`             |
| Secondary/soft        | muted, soft                          | `#5c5c5c` / `#848484`             |
| Action/action text    | accent-strong, on-accent             | `#202020` / `#fafafa`             |
| Rule/soft/strong rule | line, line-soft, border-strong       | `#dbdbdb` / `#ededed` / `#bdbdbd` |
| Brand/text/surface    | brand, brand-ink, brand-surface      | `#87ea5c` / `#007106` / `#f2fff2` |
| Send arrow/button     | send-ground, send-ink                | `#00ff08` / `#202020`             |
| Connectivity          | wire                                 | `#007106`                         |
| Physical/virtual      | symbol-physical, symbol-virtual      | `#202020` / `#b45309`             |
| Reference/value       | schematic-reference, schematic-value | `#1d4ed8` / `#7e22ce`             |
| Marquee edge/fill     | selection-shadow, selection-area     | `#66b3ff` at 80% / 12%            |
| Error/error text      | error, error-ink                     | `#f04142` / `#b52a2a`             |

Charcoal buttons use light text; Send uses a green arrow. Neon green belongs to marks/small dark-surface accents; light-surface green text uses brand-ink. Active tools are neutral. Derive light/dark paint from actual surface brightness while retaining electrical semantics.

### Typography, spacing and shapes

Use local sans Segoe UI/Helvetica Neue/Arial/Microsoft YaHei and technical Cascadia Code/Consolas/monospace. No runtime web fonts. Shared tokens live in `app/globals.css`, layout in `app/workspace.css`. Reuse components/tokens and remove superseded declarations.

| Element                       | Default                                |
| ----------------------------- | -------------------------------------- |
| Controls/body/input           | 14 / 15 / 15 px                        |
| Secondary/metadata            | 13 px / at least 12 px                 |
| Conversation heading/body     | 16 px / 15 px, 1.6 line height         |
| Home hero/support             | 34–48 px (32–44 short windows) / 15 px |
| Onboarding                    | 22 px (20 short windows), weight 600   |
| Icons/rules                   | 16–18 px / 1 px                        |
| Control/panel/composer radius | 8 / 12 / 16 px                         |
| Standard control minimum      | 30 px height                           |
| Spacing scale                 | 4, 8, 12, 16, 24, 32, 48 px            |

Keep readable text in compact windows; grow/wrap controls and footers instead of CSS zoom/transform scaling. Use sentence case, normal letter spacing, hairlines and shared theme-aware panel/floating/dialog shadows. Neutral hover fills stay subtler than selected fills. Editable fields share `field-surface`/`field-border`, 8 px corners and a 30 px minimum height. Engineering values use local technical typography and tabular numbers; read-only metadata wraps within softly divided groups.

### Copy, keyboard and focus

Icon-only and symbolic controls have accessible names and short native hover labels naming the action, without colons, separator glyphs, current values or diagnostics. Put details in accessible descriptions or the relevant visible UI. Visible-text controls do not repeat their text in tooltips; drawing geometry, metadata, text and Markdown have none. Do not add floating name popups. Keep visible names, values, ambiguous actions and consequences. Never show shortcut hints in controls, tooltips, accessible names or notifications.

Omit persistent small print, repeated headings/welcomes and generic helper/status captions. Secondary diagnostics belong to the relevant accessible description; plugin catalog warnings belong to Refresh plugins. Preserve visible actionable errors, authentication uncertainty, unsaved/destructive consequences and actual loading/empty states.

Focus adds no decorative outline/halo/border recolouring/shadow. Preserve keyboard navigation, carets, selection and modal focus containment/return. Inputs/buttons retain normal shortcuts; dialogs/menus block background edits/file actions. Dialog menus remain in its top layer and Escape closes options first.

IME composition, including key code 229, cannot commit/discard input, save, place or cancel tools. Streaming follows only its conversation container and preserves editor focus/menus/gestures. Menus dismiss on outside interaction, viewport resize or trigger-ancestor scrolling, not neighbouring-panel scrolling.

## Brand: Signal E

`public/brand/openpe-mark.svg` is the sole transparent 64 × 64 geometry master: smooth charcoal `#292929` E, green `#87EA5C` signal and fine green outline retained on light/dark surfaces. No pixel steps, background tiles, glow, extra circuit details or copied product marks. Minimum size 16 px, preferred header about 30 px; scale uniformly with clear space.

Generate assets through `node scripts/brand-assets.mjs`. Mono is charcoal throughout; optional inverse has a `#FAFAFA` body with green signal/edge and is not the app mark. PNG/ICO retain alpha; native icons use the tighter crop. Inspect native-size light/dark previews. Reference sheets are not production backgrounds; [AGENTS.md](AGENTS.md) owns asset and graphical-check requirements.

## Application shell

### Dimensions

| Area                        | Dimensions                                   |
| --------------------------- | -------------------------------------------- |
| Minimum/review windows      | 1100 × 740 / 1480 × 920 and 1120 × 760 px    |
| Windows caption/app header  | 30 / 52 px                                   |
| Rail                        | 52 px; 36 px targets; 20 px icons; 6 px gaps |
| Conversation                | 384 px; 352 px below 1250 px                 |
| Conversation/document bars  | 40 px / at least 44 px                       |
| Editor inset/toolbar/status | 12 px / at least 44 px / at least 34 px      |
| Toolbar controls            | 30 px square; 17 px icons; 8 px corners      |
| Zoom controls               | 28 px buttons; 15 px icons; 18 px edge inset |

### Caption, rail and File menu

Windows caption is charcoal: Back, Forward, Toggle sidebar, File/Edit/View/Help and native window controls. Menu labels stay light over a subtle dark hover/open surface in every theme. Omit long title/logo there but retain native identity and close protection. Browser/non-overlay surfaces omit the caption. Back/Forward covers Home and active Schematic/Source with pending-Source validation. Blank caption space is draggable; controls are not.

Header uses a 32 px rail-aligned mark, 12 px gap, 20 px semibold OpenPE and quiet Preview badge. Save/Save as/Export/Close belong to File; fallback File stays at header right.

File includes Recent and Example submenus on Home and in projects, using Home's fixed catalog. Quiet separators group project opening, examples, saving/export and closing. Menus use muted icons/chevrons, reserved green checks and distinct highlighted/selected fills without selected-weight changes. Hover/click or Right opens children; Left/Escape returns one level, then Escape closes File. Opening preserves other projects' drafts and activates an already-open example. Caption and fallback File share the same menu definition and current actions.

Rail order: Home, New project, Open project, Plugins, scrollable project entries, Agent, Settings. Use plain Folder icons and neutral selected surfaces. Compact controls in the 52 px rail retain full action and project names as native hover labels and accessible names/descriptions, without a separate floating name reveal. Omit redundant Workbench/Components/Quick guide links.

Agent/Settings popups anchor 8 px right, bottom-aligned/clamped, widths 264/208 px, with 8 px padding, 12 px outer/8 px row corners and 2 px gaps. Readable rows scroll within the viewport.

### Document and view tabs

File tabs sit at the left with intrinsic widths; New file follows without a growing spacer. Tabs shrink/scroll horizontally when needed. The mounted Workflow/CircuitBoard/Box/Code2 view switch sits at the far right with a 12 px inset and no extra vertical rule.

- File/view controls use 36 px tab profiles with rounded tops and square bottoms. The row grows from 44 px with typography. File close/action targets are at least 34 px; New file shares the tab baseline.
- View targets have 44 px minimum widths, 6 px gaps and 12 px horizontal padding. Inactive views are transparent icons whose labels expand on hover/focus; reduced motion makes transitions immediate. Inactive file tabs have a quiet tint.
- Active tabs use the editor surface and join the toolbar across the document-bar rule. The active view retains its semibold label, soft side borders and transparent top border. No outer segmented capsule; exposed editor corners remain rounded in every view.

### Conversation and right docks

Toggle sidebar retains the rail and mounted conversation/composer/divider state; unavailable on Home/Plugins. The invisible 8 px divider enforces 328 px conversation/560 px editor minimums, retains proportions and supports keyboard resize, Escape and double-click reset. Show a quiet 2 × 32 px grip on hover/drag with a centered 32 px resize cursor.

Full-height right docks exist in Schematic/Layout/Model. Toggle right sidebar follows Version history at the toolbar's far right, behind a centered 18 px soft divider with 8 px inset and 4 px outer gap. Its pressed state uses a quiet hover surface. Keep it with the right-aligned actions during wrapping; omit it in Source/Home/Plugins and views without a dock. Hiding retains per-project selection, drafts and preferred widths. Pending Source permits visibility controls. Resizing preserves pixels/mm and compensates the viewport origin.

| Dock/panel              | Default/minimum width |
| ----------------------- | --------------------- |
| Schematic Properties    | 280/280 px            |
| Layout Appearance       | 280/224 px            |
| Model Properties        | 280/280 px            |
| Parts list window       | 720/340 px            |
| Visualization/Selection | Current sidebar width |
| Version history window  | 840/480 px            |
| ERC/DRC                 | 420/320 px            |

All three drawing docks default to 280 px and resize from their full-height left edge up to 480 px, retaining at least 160 px drawing space. Headers/footers stay fixed. Arrow keys resize by 16 px, Home/double-click resets and Escape cancels a drag. Each view retains its width through hiding and navigation.

### Independent windows and status

ERC/DRC, Parts list and Version history use independent centered modal windows, like the component chooser, with 24 px viewport margins. Retain preferred sizes and scrolling bodies with fixed headers/footers; each window has one bottom-right resize grip. Dragging right/down or keyboard steps of 16 px grows the window while retaining its top-left position; Home/double-click resets the centered default and Escape cancels capture. Locating a rule issue closes its window and reveals the selected issue in the editor.

EditorStatusBar uses shared surface/top rule, 4 px vertical/10 px horizontal padding: mode dot/name and coordinates left, view controls after flexible space, actual draft/recovery state last. When Grid is the final footer item, its right inset matches the 4 px vertical inset; its trigger radius equals the outer panel radius minus that inset and the editor border. Omit completed Draft saved and Connectivity captions. Source uses line/column without an extra row. Pointer/camera readouts update independently of retained drawing.

### Toolbars and tool settings

Toolbars grow from 44 px with 6 px vertical padding. Insets remain 8 px left and 15 px right at every supported window width, aligning the 30 px end actions with the 44 px view-tab centers above.

Group Interaction/Annotation, Place/connect, Edit/history with 2 px internal gaps and whole-group wrapping. Primary group separators use a shared soft rule spanning the control height, with 8 px clearance on each side. Right-align the independent-window buttons with 4 px gaps: Schematic ERC/Layout DRC, Parts list and Version history, followed by Toggle right sidebar behind one compact centered divider. Schematic Simulation and Layout Thermal occupy a separate left-aligned Plugins group after Edit/history, with the shared group separator and clearance. Keep plugin actions out of the right-aligned window group; omit empty plugin groups when unavailable. No standalone Properties button.

Component/footprint selection retains its independent centered modal chooser. Other upper-left tools use shallow single-row parameter strips 8 px below the drawing top, with 12 px side clearance, compact title and pinned Close/Cancel. Parameters remain on one row and scroll horizontally when needed. Use a quiet top binding, layered page-edge shadow and a 200 ms top-origin unfolding transition; reduced motion opens immediately.

### Properties, Visualization and Selection

These sections always appear in that order, initially open, with headers above independently scrolling content. Headers have 36 px minimum height, control-size semibold text, tint surfaces, 12 px horizontal insets and strong top/bottom rules.

- Visualization and Selection fit their content at the bottom, each capped at 60% with internal scrolling. Expanded Properties fills the remaining height. Collapsed sections reserve only their headers; when Properties is collapsed, the ordered stack stays at the bottom.
- Collapsing, hiding and view changes retain settings, expansion and mounted Properties drafts. Expanded sections permit canvas interaction. Unhandled Escape collapses the focused section and returns focus to its disclosure; input draft handling and composition take priority.
- Explicit inspection reopens Properties and its dock; ordinary Schematic selection retains dock visibility. Wire selection alone does not inspect it; double-click/E does.
- Source has no display sections; Model without a PCB has no display drawers. Layout Visualization contains Layers/Objects/Nets without a separate Appearance heading. Visibility toggles and Model view actions keep Visualization open.

Schematic and Model Visualization follow Layout's visibility rows: secondary-size text, 30 px rows, shared control corners, 14 px bordered colour swatches and right-aligned 30 px eye controls. The first column uses a 12 px leading inset and a 34 px text alignment across headers, visibility rows, view presets and Selection. All three Selection panels use a compact two-column grid with 14 px leading checkboxes, 30 px minimum rows, 8 px label gaps and 12 px horizontal insets. Each view retains its own supported display/filter categories; Schematic and Model visibility rows toggle across the full row.

Filters change selection eligibility without hiding geometry or changing electrical targets. They cancel conflicting gestures and remove ineligible selection.

Schematic and Layout retain the shared persisted left-button drag behavior. The default drags selected objects and starts a selection rectangle over unselected objects. Existing drag-any and selection-only preferences still apply; modifier selection remains available in every mode. Selection contains only selection eligibility controls.

### Parts list

Search current-sheet reference/resolved Value/Footprint by trimmed case-insensitive substring, preserving order and distinct IDs. Pin search/headings above 32 px rows with a separate 30 px Locate column, ellipses/full accessible text and no horizontal scroll. The body caps at 560 px/viewport.

Clear restores search focus; reopening starts empty. Enter locates only one match; composition cannot locate/dismiss. Edit opens Properties even for hidden layers. Locate enters Schematic Interaction, centers readably and focuses the canvas without editing; stale sheet/revision/Source/activation requests cannot locate.

## Home, projects and recovery

Home is document-free unless valid recovery restores projects. Home performs no runtime example preflight or aggregate asset-error display; example opening and clean recovery initiate preparation when needed. Preserve malformed-recovery errors without idle overwrite. Navigation keeps live work; new/open/example appends without applying another project's drafts. Reopening an open destination/example selects its editor.

Center Home content to 960 px (except full-width), composer to 720 px, with 16 px inset corners. Show 48 px mark/32 px wordmark and “What will you Power next, Engineer?” with Power and Engineer? green. Faint noninteractive grid/traces/glow use six-second motion, static when reduced. Spacing is 28–56 px top/40 bottom, 16/20 in short windows.

The shared 64 px composer Start project creates an empty schematic with the brief retained, never auto-submits. Enter activates, Shift+Enter adds a line. Recent precedes Example: fixed EMC Flyback plus nine Example entries follow `resources/example-catalog/home-manifest.json`. Cards have full-width 112 px previews above a soft rule, padded names/concise factual descriptions and three columns/12 px gaps, reducing at 684/452 px section width. Use semibold section/card titles, balanced hero text and a small green arrow on card hover. Load previews incrementally and cancel inactive work.

Project/tab unsaved dots are 5 px. New/open/import/example starts clean; pending Source counts as unsaved and undo to baseline clears dots. New project contains Schematic 1; New file appends within the 12-file limit. Tabs retain viewport/selection and an always-visible 30 px X. X closes a view, never data; Open file restores it. Last-tab close requests protected project closure.

Project context menu targets its clicked project: Save, Save as, Duplicate, Explorer, Close. Duplicate validates/copies the complete candidate including valid Source drafts without changing the original. Managed examples Save directly; Save as creates a personal destination. Explorer resolves a live saved/import location; otherwise activate and Save first.

Save changes? shows document title and Cancel / Don’t save / Save. Busy actions prevent duplicate submission/dismissal. Close/quit rechecks background changes and retains live work until all reviews succeed. Save/cleanup failure remains retryable/cancellable. [Recovery](AGENTS.md#recovery-and-quit) owns persistence.

## Agent conversation

The 40 px session header has Select/Clear/plus; plus creates an empty session. Names use first prompt/New session and retain their full accessible text. Messages/drafts/streams are independent; preferences are shared. Disable Agent switching for the running active session.

Composer is one rounded surface: permissions left, model/effort/Send or Stop right even at minimum width. The compact permission menu uses Review commands / Approve commands before running and Auto-approve / Run supported commands automatically, with a 300 px minimum width. Review has a green checked shield; Auto a yellow exclamation shield. Review cards capture immutable arguments/revision with Apply/Reject; mode changes never run old cards. Fenced proposals retain submission mode.

Pending annotations stack as compact rows in a subtle rounded tray above the composer input, with the input surface in front below. Each row shows a 40 px screenshot, a single-line comment and a right-aligned Remove action. Stale rows show Earlier capture with a detailed accessible description. Open a row for its full comment and capture details; sent-message attachments retain readable thumbnail-and-text rows.

Use official transparent Agent marks, with attribution. Monochrome follows actual background; Claude/Pi retain official colours. List Codex/Claude Code/DeepSeek Harness/Pi/Cursor even when unavailable; detection/version never implies sign-in. Agent rows use 24 px marks/reserved check space and readable softened unavailable status.

Model/effort menus use 13 px names/12 px descriptions, reserved checks, no selected-weight change and 6 px upper anchor. Navigate without committing; Enter confirms, Escape/Tab/outside dismiss. Preserve saved choices on failure. Show effective/discovered model or Choose model, labelled Claude aliases, no manual-ID/default/refresh rows. Low defaults within supported efforts; DeepSeek has none. Unavailable adapters disable execution/model/effort.

Empty conversations show suggestions only. User bubbles fit right-aligned charcoal surfaces with literal line breaks; assistant retains name/logo. Stream observed stages and one client elapsed time, never percentages. Completed/cancelled/failed replies retain total Worked for… when present.

Stop works before text and with an empty next draft, cancels only that session/capability work, preserves partial text/drafts and rejects late proposals. Show Generation stopped. Successful completion alone exposes fenced Apply. Live review state reflects actual execution and actionable errors; reviews are transient.

Lazy-load local Markdown/KaTeX at first assistant reply, including recovery; plain loading text hides proposal payloads. Support bounded GFM/code/math with contained overflow. User text stays literal; disable raw HTML/remote images/unsafe links/KaTeX trust and preserve raw response/formula source.

## Schematic canvas

### Geometry and paint

Use an infinite millimetre canvas with 1.27 mm snap. Native Save retains loaded paper records; editor/generated content and standalone export omit paper controls. New symbols use official geometry; loaded embedded units/fields remain authoritative. Hit transformed body/pins/fields independently. Keep reference/value upright outside bodies and honor imported positions.

Examples use measured text layout without electrical/pinned-source changes. Preserve aligned virtual-source/load anchors. Voltage-source circles gain a renderer-only upright V. Physical/virtual follows assigned nonblank Footprint independently of simulation metadata: charcoal/light bodies versus orange/amber; ground/power/no-connect stay neutral. Connectivity is deep green, references/pins blue, values violet, other fields/notes slate.

Schematic selection is blue for neutral symbols/markers/notes and stronger brightness-aware contrast for coloured geometry, retaining widths/fills/note opacity without halos. Fields select independently. Pin hit targets stay invisible in every tool; native symbol circles and solid junction dots retain their original geometry. Layout/Model retain hue and change contrast. Selection never exports.

### Selection and edits

Left-to-right marquee contains full visible geometry; right-to-left touches/intersects it. Solid containment/dashed crossing; Shift adds, Ctrl/Cmd toggles, Ctrl/Cmd+Shift subtracts. Select all respects visibility without redundant owner-field selections. Cancellation retains prior selection.

Focused bindings remain V select, H pan, W wire, A add, M move, G connected drag, R/Shift+R rotate, pickup X/Y mirror, Delete, Space Fit and standard undo/save/open. Never show hints. Inputs/modals/composition/pending Source block conflicting actions; right/middle camera navigation remains available during pickup.

Wire stroke is 0.28 mm, square-ended; draft dash/gap 0.55/0.35 mm. Continuous routing supports bends/posture reversal/Enter/double-click. Enter includes live head once. Escape cancels draft while retaining Wire; next idle Escape returns Interaction, with held repeats ignored between stages. Shift suspends attraction but retains grid/exact joins, updating stationary previews. Deliberate joins split; crossings do not connect. Junction simplification is presentation only.

Direct component/label/wire drag and arrows preserve attached connections, branches, labels/no-connects and UUIDs, including collapsed leads. M leaves unselected wires; G retains connections. Selection precedes hover. Rotation/mirror/arrows stay inside one preview, committed with its generated IDs by click/Enter. Blocked poses cannot commit old previews; valid retries work. Menu pickups start at original pose and immediate Enter stays clean. Deactivation/replacement/layer changes/lost capture cancel stale gestures.

Delete through keyboard/Properties/Agent removes attached leads/orphans to surviving pins/shared branches, preserving trunks/crossings. Copies get fresh IDs/references. [Core](docs/CORE.md) owns transaction guarantees.

### Visibility, grid and export

Visualization offers References, Pin names, Pin numbers, Values and Notes with swatches; omit bulk/symbol/connectivity controls/legends. Hidden text leaves hit/selection/snapping/Fit bounds. Other fields/model names/mappings default hidden; standalone Sim.Params follows Values without duplicated resolved Value.

Schematic filters use single-line labels: All, Symbols, Wires, Labels, Text, No-connects. Wires includes junctions; Text includes fields. All shows mixed state; right-click isolates a category without hiding geometry. Parameter text can move in Interaction with Simulation open; explicit Sim.Params inspection closes Simulation and restores/focuses Properties for editing. Field drag shows a dashed owner guide only during the gesture.

Display grid is 0.5/1/2/5/10 mm or Off, default 2; snapping stays 1.27. All display settings remain outside native/undo/dirty state.

Bottom-right is Minus, percentage, Plus, Fit, Export image. PNG captures visible drawing bounds plus 4 mm/current theme/layers/grid, up to 20 px/mm and 4096 px per side, excluding selection/drafts/comments/hit hints. Preserve camera/content/destination; picker cancellation is silent.

## Properties and library choosers

Schematic Properties uses the shared disclosure header, 12 px content inset, fixed deletion footer and scrolling body. Empty: Select a component to view its properties. Simulation replaces the ordinary sidebar while retaining its drafts, selection and visibility preference; wire inspection is explicit. Collapsing retains drafts/selection.

Reference/Value use two columns beneath the softly divided identity strip; fields use three shrinkable columns (value 1.65× name, 30 px actions), 6 px row/8 px column gaps. Names are quiet, values bordered, empty footprint Unassigned. The fixed deletion footer uses the secondary surface and a restrained error-tinted hover. Simulation defaults collapsed with independent Include in simulation switch (30 × 18 px) at heading right. Retain native field identities and engineering units.

Properties content uses 12 px horizontal insets across drawing modes. Model's fixed solid-settings footer shares the field body's scrollbar gutter and 12 px horizontal insets, with 6 px vertical padding. Delete and the standard Apply button align to the field edges and use 30 px minimum controls. Delete uses the shared undoable solid-removal command and remains blocked by unapplied drafts; Reload appears only beside a stale-draft error for recovery. Read-only metadata uses plain 30 px key/value rows, muted labels and right-aligned tabular values, without separate filled or bordered cards. Editable controls retain the shared field surfaces and typography.

Enter/blur commits valid fields/grid-snapped coordinates once; Escape restores drafts; invalid/rejected inputs remain retryable. Footprint/removal commits immediately; unchanged blur/blank rows stay clean. Ctrl/Cmd+S/Shift+S commits valid current input before Save, blocked by invalid/composing input. Same-object drafts/errors survive Layout/Model; actual property changes refresh. Hidden controls cannot edit.

Reference/Value text inspectors show only text/X/Y and an owning Component properties action. Display coordinates to four decimals without materializing/snapping untouched text. Net name Enter uses blur commit/Escape accepted text. Linked Sim.Params has one editable Value with hidden mappings retained.

Chooser maximum is 840 px: search/results left on a secondary surface, actual symbol/footprint/3D preview right. Selected rows use neutral fills; preview tabs use inset rounded controls. Rank exact/prefix/name/keyword/description matches with stable ties; library filter caps 280 px. Append bounded pages without losing selection/preview; no Previous/Next row. Rows are at least 34 px and retain full IDs as accessible text; Close/Escape dismiss; footer Place/Assign only.

Search/list arrows highlight, Enter confirms loaded current valid detail. Composition/repeats/pending/stale entries cannot confirm. Symbols enter placement without design edit until canvas commit. Assign rechecks current unplaced target and rejects unavailable targets without stale previews. Keep unit/2D/3D tabs; licenses belong to About.

## Rule checks and version history

ERC/DRC open independent resizable Electrical rules/Design rules windows from the upper-right toolbar without auto-running. Show counts in a quiet summary, softly framed scrollable issues/rule IDs, Locate and Run/Recheck icons. Keep coverage details in [Design rules](docs/DESIGN-RULES.md), not repeated helper paragraphs.

Locate selects visible objects/pans/briefly marks without repair. Sheet/document/settings changes stale reports and block locate; pending Source/close blocks Run. Hide/cancel on view/project/Home switches. DRC has six mm thresholds; invalid numbers block Run. Only complete current reports can say no issues; settings/reports never dirty or enter native/undo/recovery.

Version history follows Parts list in the right action group; drawing modes keep Toggle right sidebar last. Source Copy/Apply precede Parts list/history. Use an 840 px centered window with padded version rows and differences in independently scrolling columns, compact icon actions/fixed footer, local time/hash and full-path accessible descriptions. Selected versions use a stronger neutral fill than hovered rows; paired change values use bounded secondary-surface code panels. Before first Save show only Save prompt/action.

Compare selected with Current project/another version. Use Added/Removed/Changed and bounded previews. Compare schematics shows equal Before/After panes, union of sheets by stable ID, synchronized world pan/zoom/Fit, added green/removed dashed red/changed amber and explicit missing-sheet state. Browsing never applies Source/edits. Escape closes comparison first. [Version history](docs/VERSION-HISTORY.md) owns restore/persistence.

## Layout editor

Entry validates pending Source and retains the board, clean state, camera, selection and tools. Viewing does not synchronize packages or refill zones. [Layout](docs/LAYOUT.md) owns board authority, schematic synchronization, connectivity and collision rules.

### Visualization and selection

Appearance pins Layers/Objects/Nets tabs with Selection below. Layer rows select a display priority; clicking the selected row again clears it and restores the default physical stack. Its eye independently controls visibility. There is no separate Priority layer selector. Objects has Footprints, Pad numbers/net names, Airwires, Zone outlines, Copper preview. Nets pins search/conditional clear icons above aligned name/count/visibility/highlight columns, using eye icons for visibility and omitting zero-only counts; Clear restores search focus, keyboard highlight clearing does not steal unrelated focus.

Filters order: All/Locked, Footprints/Text, Tracks/Vias, Pads/Graphics, Zones/Rule areas, Dimensions/Points. All supported object categories, including Pads, default checked, so All items starts checked without a mixed state. Locked items defaults unchecked and remains independent of All items; unsupported Points stays disabled and unchecked. Filters permit pick-through without hiding/unlocking. Pads inspect individual footprint terminals or mechanical holes; Vias select independent plated connections through all copper layers.

The default top view follows the board's physical stack: back-side layers below inner copper, front copper and front-side artwork. Each layer paints its copper, pads, artwork and captions together; technical guides and annotations remain overlays. Explicit display priority moves that complete visible layer pass last. Through pads and vias paint once; drill voids stay above physical artwork. Point ties follow the visible stack; default marquees include all visible layers, while explicit priority restricts them to its visible geometry. Selecting a different layer row cancels M/D/G/marquee while retaining selection; clearing priority retains gestures, drafts and the remembered copper tool layer. Outside routing, layer keys explicitly select their layer without toggling priority off; within routing they request a via transition. Display changes never edit native board data.

### Object Properties

Linked footprints share Schematic's identity strip, Reference/Value, field table, Footprint chooser, Simulation section and fixed deletion footer. PCB X/Y/rotation/side use the shared form. A rejected replacement retains the current assignment and board; an accepted replacement preserves pose, side, tracks and matching pad/net associations. Board-only footprints use the same spacing and preview their actual artwork without a schematic link.

| Object             | Editable fields and visible distinctions                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pads               | Show surface-mount/plated/non-plated type, owner, pin, schematic net and physical layers. Edit local position/rotation, shape, size, drill and supported mask/paste/thermal overrides; blank overrides inherit. Type, layer membership and pin identity are read-only. |
| Vias               | Show through type/copper span; edit net, position, diameter and drill.                                                                                                                                                                                                 |
| Tracks             | Endpoints, width, net and layer respect the explicit lock.                                                                                                                                                                                                             |
| Graphics           | Native geometry, layer, stroke/fill and text.                                                                                                                                                                                                                          |
| Zones / rule areas | Zone bounds, corners, cutouts and fill rules; individual rule-area exclusions.                                                                                                                                                                                         |

Use shared control typography, surfaces and dimensions with soft section dividers and wrapping metadata. Valid edits commit once; invalid/rejected inputs, composition and hidden-dock drafts remain intact.

### Placement, routing and copper

Place footprint opens an independent component/library chooser with 2D/3D previews. Confirmation starts canvas placement; cancelling a reopened chooser retains the current placement preview. Route tracks uses a compact upper-left nonmodal horizontal panel sized to its title, three numeric fields and pinned Close: Track width, Via diameter and Via drill, all in mm and visible before a via transition starts. Vias and outlines retain their single-row strips across the actual drawing width. Parameters scroll horizontally when constrained. Zone creation parameters remain in Properties. Close/deactivation/tool changes cancel drawings but retain settings; modal suspension retains blocked drafts. Number Escape restores accepted value/canvas focus, then canvas Escape cancels; selector Escape closes options first.

Board outline settings expose Lines/Rectangle and native width on visible Edge.Cuts. Each line click commits one native segment and continues from its exact endpoint; Escape discards the unplaced head and returns to Interaction while retaining placed lines. First-corner closure and Enter/double-click/Finish avoid duplicate segments; open chains remain editable native lines. Edge endpoints attract within eight screen pixels; Shift bypasses attraction and Ctrl/Cmd bypasses grid snapping. Unrelated board revisions cancel continuation; rejection retains its exact origin/head. Rectangles commit once and retain the tool; rectangle Escape discards its preview before idle Escape exits.

Selected rectangular Edge.Cuts polygons and four-line frames expose eight resize handles plus X/Y/Width/Height Properties. Corners resize two axes; edge handles resize one, keeping opposite edges fixed. Four-pixel jitter stays clean. Release commits the exact preview once; Escape, tool/layer changes and lost capture cancel. Preserve native UUIDs, line widths and untouched copper; invalidate saved fills only on commit. Other outline shapes retain graphic editing. Selected board zones also expose box handles and X/Y/Width/Height; scale their polygon and holes together, retaining net/layer/rules and invalidating saved fills only on commit.

X starts routing at hovered visible assigned copper's exact anchor/net/layer; empty/hidden/bypassed starts only activate the tool. Snap within eight screen pixels to compatible pads/vias/tracks, retaining off-grid anchors. Shift bypasses object snap, Ctrl/Cmd grid snap. Preview/click/Enter/double-click share validation; Enter includes live head. Via transitions are one transaction with Backspace rollback. Different net/current layer cancels all; routes keep obstacles fixed, pours do not obstruct and copper edits invalidate fills.

Successful zone completion selects it/restores canvas focus; rejection retains draft/focus. Fill saves supported contours explicitly; viewing never refills. Fills retain 80% opacity/actual holes/clearances. Airwires estimate pad/track/via/saved-fill contacts; unfilled boundaries create none.

Fill copper zones opens an upper-left nonmodal single-row strip, with Minimum clearance (mm), default 0.25, beside Fill zones. Larger per-zone clearances remain authoritative. Fill saves effective clearances and contours as one undo edit. Invalid input/composing Enter cannot fill; field Escape restores the accepted value/canvas focus, then canvas Escape closes settings. Closing/switching tools/leaving Layout cancels settings and retains the last accepted minimum.

### Picking, movement and camera

Point picks nearest eligible visible geometry regardless of SVG stacking/old selection; broad footprint/fill interiors are fallbacks. Alt uses the same direct picking, without an object-choice menu. Embedded zones select their footprint. Require more than four screen pixels before moving; jitter stays clean. Dragging selected targets retains selection.

Marquee modifiers match Schematic. M/rotate/flip commit the exact preview, with selection before hover. D/mouse track drag uses connected 45-degree geometry with Shove; G handles free-angle joints/bends. Shove may reroute unlocked neighbours; pads/vias/locked tracks stay fixed. An illegal cursor displays the freshly validated legal boundary; release commits that displayed boundary. Lock-only edits retain fills. Off-grid values remain exact until edited; invalid drafts persist. U expands visible/filter-eligible connected copper without editing it.

Layout Selection contains object eligibility controls, with no mouse-drag behavior, obstacle-mode or drag-clearance settings. Track dragging uses the fixed 0.25 mm routing clearance and never opens a floating settings card. Manual routing uses Walk Around with 45-degree segments and the configured track width, including starts from existing tracks. Source copper supplies the net; Appearance and layer keys select the active copper layer. Track width and via sizes survive completion/cancellation; changed via sizes affect future vias while placed draft vias retain their exact dimensions. Settings alone never dirty the project.

Palette uses front/back copper, yellow/pink silk, gray fab/magenta courtyards. Board edges use charcoal on light canvases and white on dark canvases, with a 0.05 mm display minimum shared by board/footprint artwork and drawing previews; wider native strokes retain their width. Display widths never change native geometry or hit targets. Zone outlines use 0.08 mm dashes without native-width changes. Captions above pads; number/net switches default on; source-hidden fields remain. Selection retains hue/width/drills/fill opacity and never exports.

Grid is 0.1/0.2/0.25/0.5/1 mm or Off, default 0.5. Retired spacing values are rejected. Dots coarsen by powers of two to six screen pixels while snap/status/origin remain exact; output images derive their own density. Bottom-right Fit board and Space/Home fit the board; Ctrl/Cmd+Home fits visible objects. These camera bindings remain available during thermal probing. Middle/right drag pans; right-click opens no context menu. 100% is 96 px/in.

## Model view

### Toolbar and retained view

Model follows the shared Interaction/Annotation, Create and modify geometry, and Edit/history groups:

- Sketch, Box, Cylinder and Hole are direct actions. Modify solids groups Chamfer, Fillet and Boolean operations. Edit model groups Move, Rotate, Duplicate, Delete and Pan before standalone Undo/Redo.
- While drawing a sketch, Rectangle, Circle, Polyline and Finish sketch replace geometry/history tools. Leaving sketch mode restores them.
- Menus expose currently available actions. Pan remains available with pending Source or Properties drafts; Interaction is selected only when no tool or Pan is active. There is no STEP export toolbar button.

Retain camera, projection, visibility and scene across view/project/Home; hidden views pause rendering and consume current data on reveal. Orthographic projection and silkscreen default on. Loading real STEP replaces approximate packages without resetting the camera; unavailable resources remain visible notices. EMC's 31 pinned models are offline. Board/copper/mask/silk reflect thickness, cutouts and drills; copper fills use 80% opacity. [Layout](docs/LAYOUT.md) owns supported models and CAD geometry.

Fit uses visible world bounds, including transparent covers and excluding hidden/suppressed objects, with a finite empty fallback. Fit and Isometric view use the equal-axis isometric direction, native Z up, and clear inertia. Space on the active canvas invokes Fit once per press; inputs, overlays, composition and held pointer gestures retain keyboard ownership. Projection changes preserve pose, orbit target and target-plane scale. Zoom/PNG preserve the camera.

### Visualization and selection

Visualization has Views/Display tabs, initially Views, retained through hiding and navigation. Arrow keys and Home/End navigate tabs; only the active panel is exposed. Views offers Top, Bottom, Front, Back, Left, Right and Isometric in two columns, with Isometric spanning the final row. Orthographic projection follows a soft divider. Keep visible labels, aligned icon/text columns and the projection toggle's pressed state. Presets retain orbit target, zoom and projection. Display offers CAD solids, Component models and Silkscreen eye controls. These actions keep Visualization expanded.

Selection has one checkbox set: All items, Solids, Faces, Edges and Lines. All items supports mixed state; checked categories jointly define eligibility, without a separate selection-type menu or remembered override. Solids includes CAD bodies and read-only component instances; subentities are bounded analytic faces/edges, with straight edges available as Lines. Modifiers add/toggle entities and Properties names their type.

Filter changes exit Pan, clear only ineligible selections and cancel conflicting tools. Edge treatments pick eligible edges; Boolean tools pick eligible bodies; finishing/cancelling restores ordinary picking. Creation never enables filters or selects ineligible results. Busy commits and unapplied Properties drafts block filter changes. Depth and transparent-cover occlusion still apply.

### Sketches and grid

Sketch starts with XY/XZ/YZ, a normal-axis position in millimetres and a visible plane preview. Start sketch aligns the retained camera orthographically to that plane and enables rectangle, circle or closed polygon drawing on the shared canvas.

- Finish sketch restores the previous camera/projection and retains the profile outline. It does not start extrusion.
- Extrude sketch opens distance/direction and a solid preview. Cancel returns to the finished profile; Edit sketch resumes drawing. Profile validity does not depend on extrusion distance. Apply adds one solid/undo edit; unfinished planes/profiles remain local drafts.
- Drawing owns the left pointer; Escape cancels an active stroke without discarding a completed profile. Plane setup, finished profiles and extrusion allow 3D orbit.

The theme-aware line grid appears only during sketch drawing, aligned and anchored to the workplane. Plane setup retains its boundary/axes; Finish sketch removes the grid. Footer Grid offers 0.5/1/2/5/10 mm or Off, default 0.5 mm. Spacing is independent of Schematic/Layout; visibility is shared. Display lines coarsen by powers of two with zoom. Grid changes preserve camera/geometry and CAD's 0.5 mm snapping; grid lines do not affect picking, Fit or clipping bounds.

### Solid and edge editing

Right Properties edits dimensions, XYZ, material, opacity and local-Z holes. Component reference/value/footprint/pose/model references are read-only. Drafts and stale errors survive hiding; field Escape restores only edits since focus while retaining other drafts, tool and selection. Pan cancels tools/Annotation but retains inspection/drafts/previews. Placement/duplication reveals the new solid's Properties without stealing focus and replaces component inspection; tool start/cancel retains inspection.

Picking a visible analytic edge selects it and opens edge Properties; modifiers add/toggle. Chamfer/Fillet retains those picks, accepts further edges, highlights them and previews radius/distance before Apply. Boxes, extrusions, circular rims and hole rims expose semantic base edges; Boolean results expose no editable edge catalogue. Empty/unsupported selections cannot Apply.

Boolean Target/Tool follow ordered canvas body picks before or during the tool, with explicit Swap/Remove and no automatic operand/dropdown. Face/edge/line selections require Use owning solids before Apply. Union/Difference/Intersection show the exact prepared result and replace both bodies in one undo edit. Boolean dimensions are a read-only conservative envelope. Invalid, empty, stale or cancelled results cannot commit.

M picks up; R/Shift+R rotates local Z while retaining dimensions/holes. Immediate Enter commits the current validated preview once. Pointer XY snaps 0.5 mm; numeric XY remains exact through navigation until ordinary pointer movement. Wheel/middle/right navigation remains available during placement/drilling; left orbit pauses. Explicit Cancel restores Properties/canvas focus; automatic Source/revision/deactivation cancellation does not steal it. Placement/hole settings use the shared single-row strips with pinned Cancel and translucent previews.

Apply commits the complete valid draft. Duplicate offsets 5 mm in XY with fresh IDs; move/rotate/delete share whole-project undo. Hole cuts local Z on visible supported solids; Boolean holes use subtractive bodies. Unapplied Properties drafts block drilling, conflicting actions and export. Unsupported edges/overlaps fail unchanged; exports omit previews/selection.

EMC Flyback uses ordinary editable CAD boxes for its aluminium base, side walls and drilled transparent cover; original static case/cover assignments remain hidden. Retired enclosure data is rejected. Independent bodies stay separate in STEP unless explicitly combined. Arbitrary CAD programs, imported/Boolean topology editing and whole-assembly simulation are unsupported.

## Source editor

### File navigation

The project-file sidebar groups actual disk paths into nested folders, initially collapsed, including newly discovered folders. Sibling folders precede files; both use case-insensitive natural name order. Toggling folders retains state without selecting files or applying drafts; selecting a file reveals its ancestors. Rows show basenames, full-path accessible descriptions and distinct hover/active fills.

The divider retains at least a 144 px file list and 160 px code area. Arrows resize, Escape cancels a drag and Home/double-click resets. Width persists across view changes without disturbing drafts, histories or folder state.

### File editing and previews

Open the selected actual native text in local CodeMirror JSON/S-expression/plain highlighting. Each file retains history, selection, scroll and invalid drafts. Copy returns the selected file; file switching does not apply. Apply/Save/leaving Source validates the complete pending set as one undo edit. Errors remain editable in a bounded error-tinted region. External replacement resets history; view switches do not. [Format](docs/FORMAT.md) owns validation and preservation.

Source lists the current project directory with its actual filenames, including empty folders and `footprints`, `models`, `datasheets`, `spice` and `thermal`. Native files keep validated editing. Ordinary text files, including `.scad`, are editable with Save file; project Save also saves pending text files. Each file retains its draft across selection, refresh and view changes. Binary files show metadata; large text shows a bounded read-only prefix with a truncation status. Refresh project files, Source reveal and window focus reload the directory. Browsing preserves pending drafts. Ordinary file edits stay outside design undo, recovery and automatic Agent presentation; pending changes participate in project close review.

Datasheets appear at their actual paths, including `datasheets/parameters.json`
and local PDFs. Selecting a PDF opens the local document viewer in the code area.
There is no virtual reference group. Native drafts survive file browsing.

### Code presentation

Use line numbers/folding/brackets/two-space indent, semantic syntax, three-depth bracket colours/matching underline. Symbolic fold controls retain concise hover labels and accessible names. Indent lines or 8% rainbow blocks retain whitespace dots/tab arrows without decorating string contents. Line numbers and whitespace are enabled; lines do not wrap. Presentation never enters copied/saved text. Source uses independent code typography; Escape then Tab can leave focus.

Hidden clean Source defers presentation until reveal; drafts/explicit observations remain current. Export applies valid drafts first; picker cancellation retains those accepted edits/undo while preserving destination/baseline.

## Simulation and Thermal FEM

### SPICE settings and probes

Simulation appears in Schematic's left-aligned Plugins toolbar group after Edit/history, with the shared 17 px mark. Settings replaces the ordinary right sidebar with a retained full-height analysis dock using the same current width and width limits as Schematic Properties. Opening or closing settings preserves the drawing's zoom and position. Its secondary-surface header and Run/Stop footer stay fixed around a scrolling body of label/control rows. Close restores the ordinary sidebar's previous visibility; Toggle right sidebar returns to that sidebar. Duration is ms, Max. step µs; any positive finite timing is allowed. Schematic IRF540N exposes timing only. Keep wrapping actionable errors above Run/Stop in the footer, without solver logs/netlist/model captions.

Interaction editing/Annotation remain usable; component Properties is suppressed. Plain eligible clicks probe; drags/wires/placement never probe. Probes may precede Run; without probe/restore, results reserve no waveform space. Restore opens an initial trace. Live samples retain requested full-duration axis; explicit Stop retains Stopped · Partial results, failure/automatic cancellation discards previews.

### Waveforms and result lifetime

Waveform initially caps at 48% drawing height/340 px, leaving 120 px schematic. Top divider supports resize/keyboard/Escape/reset. Header is 40 px with hidden-by-default A/B, one linked-cursors toggle default on, Add/Layout. Hidden cursor times persist and background cannot create them.

Plots have zoom in/out/region, previous/next, auto/time range. Auto layout fits area; explicit 4×3 picker retains empty cells/adds rows; minimum 220 × 128 px. Right-drag pans one history entry; region selection supports one axis under six pixels; Ctrl+wheel scales time. Axis editors validate engineering units/finite bounds/ticks and two samples minimum.

Each trace has independent view/history (64 changes); cursor linking only syncs times. Cursors snap native samples, retain identity on crossing and display clamped value/unit labels without visible A/B markers. Reprobes deduplicate. Presentation never enters circuit undo; result replacement resets view history.

Within Schematic Interaction/Annotation, runs/results stay. Hiding settings/editor/project/Home cancels active work, retains complete/explicitly stopped sessions and discards automatic partials. Setup edits retain previous result until Run; circuit/sheet/pending Source invalidates. Restore is read-only and cannot overwrite newer setup. [Simulation](docs/SIMULATION.md) owns supported profiles and identities.

### Thermal FEM

Thermal appears in Layout's left-aligned Plugins group. It replaces the ordinary right sidebar with a retained 260–360 px analysis dock/max 48%, fixed header and scrolling body; Close restores the sidebar. Opening the panel automatically checks solver availability; the footer contains Run/Stop. Manual heat starts zero. Explicit SPICE import uses verified matching original final-20% terminal power and shows the interval; manual heat remains available when SPICE is disabled.

Fields overlay existing Layout coordinates/camera. Result actions: Show temperature, Probe, Front/Back, Export; one field scale, selected-surface hotspot and real-node/temperature/XYZ legend. Holes/outside triangles stay transparent; clicks probe actual solved nodes. Retain camera navigation, no duplicate mini-map/junction-temperature claim. Desktop Run requires Save; fields/settings never dirty design. [Thermal](docs/THERMAL.md) owns physics/resources/records.

## Annotations

Annotation offers element/rectangle/freehand/visibility/list/clear/exit in a charcoal floating toolbar, with keyboard-reachable numbered pins and a clamped nonmodal input (max 340 px).

- Schematic and Model element annotations use blue outlines following visible geometry, including curves/irregular shapes; captures retain the outline without a rectangular element frame.
- Layout element annotations share Interaction's geometry colour, contrast, widths and opacity. They do not add a blue bounds box.
- Element drag rectangles share the view's selection paint and directional dashes. Explicit rectangle/freehand annotations retain blue region marks.

Comment text stays local until Add, Update or Enter accepts it into the Agent composer. Shift+Enter inserts a newline; Escape discards the unaccepted local draft. Composition cannot commit.

Accepted comments queue without auto-submission, up to four immutable screenshot attachments in the originating session. Preserve IDs/properties/view/fingerprint and stale previews; Source blocks capture/hidden geometry cannot contribute. Only the Agent composer's Send submits the message and attachments. Marks never edit/dirty/undo/export geometry.

Schematic and Layout annotation element picks and object membership follow Selection eligibility. Layout element picks share Interaction's nearest-geometry ranking and three-screen-pixel surface tolerance; element marquees share its directional geometry and layer-priority rules. The element tool creates no annotation when a click or marquee finds no eligible objects. Changing filters clears ineligible live highlighting and rejects captures started under older eligibility; saved screenshots/comments remain previewable and unchanged. Explicit rectangle/freehand tools may capture regions without eligible elements.

Schematic/Layout marks follow world geometry. Model captures actual camera, pauses gestures and hides screen-space marks after camera/projection/display changes while retaining images/comments. Never cross-render views. Use centered 32 px crosshair and ordinary grabbing on pan.

## Dialogs and native actions

Use shared Dialog/Select, not browser alerts/ordinary native messages. Modal HTML makes background inert; anchored panels have transparent backdrops. On-demand dialog modules show a cancellable shared modal while loading, preserving background input blocking and focus return. Standard/confirmation/library widths are 520/360/840 px, with 24 px viewport margin, 12 px corners/insets and fixed headers/footers. Standard headers/footers use secondary surfaces and soft rules; empty states use bounded, padded secondary surfaces. Confirmation uses 15 px title/13 px actions, plain document row and no decorative tile.

OS pickers grant access with English titles/KiCad filters. File Export opens native picker directly after Source validation for selected schematic/optional PCB; extension chooses supported output. Cancellation is silent and does not undo applied Source. Save success says Save project; errors use existing notifications.

## Settings and appearance

Settings is 1080 px viewport-capped, 200 px category sidebar/720 px content max with fixed Close/footer. Categories distinguish hover from selection; Appearance groups aligned label/field rows in quiet cards with standard control corners. Appearance/Agents tabs retain mounted drafts. Agents lists all five marks/names/states in softly bordered rows with a detection action, no installation small print; runtime-unavailable diagnostics remain in accessible descriptions. About is a 480 px viewport-capped dialog with the 44 px Signal E mark, one OpenPE heading, descriptor and concise product summary. Its Close action stays in the header. Third-party licenses use a bordered disclosure with stable readable source names and load on first expansion; expanded content scrolls within the dialog.

Light/Dark/System and presets/custom six-digit colours/native pickers derive shared paint without changing logo/data. Presets clear overrides. Contrast 0–100/default 60 adjusts derived text/rules, never a canvas filter. Codex mark follows actual background.

Local interface families: System/Technical/Arial/Georgia; content can inherit. Code: system mono/Consolas/Courier New. Styles Regular/Medium/Bold/Italic. Sizes interface 12–20, content/code 12–28; quick 13/14/15/17/19 resets overrides/coordinated scale. Typography never changes exported geometry.

Advanced starts collapsed: motion System/On/Off, retained separate light/dark/shared profiles, Editing mode, translucent sidebar 40–100%/85 default, full-width Home (composer remains capped), Source lines/blocks. Smart punctuation defaults off and only transforms newly typed prose, preserving paste/code/units/source/history.

Colour/number Escape discards local draft and keeps Settings open; elsewhere normal close. Copy/Export serializes full appearance JSON, browser download, Reset restores defaults. Load separately from projects, disable before ready, retain unreadable preferences on failure.

## Plugins page

Rail Blocks follows Open project. Sidebar 228 px/200 compact: All, Marketplace, OpenPE, Codex, Claude Code with installed counts. Load providers independently; failure cannot blank other counts/totals. No extra provider selector/repeated individual entries.

Main heading/search/refresh groups OpenPE/Codex/Claude; OpenPE combines bundled and receipt-backed Agent entries, with Unknown origin when needed. Softly bordered rows have 44 px marks/name/short description/detail action/separate immediate enabled switch. Category headings use quiet rules, search shares the standard field treatment and detail facts align within a bounded secondary surface. Keep disabled/empty content through mutations. Details report actual publisher/version/source/origin/scope/actions; Uninstall is confirmed, successful actions update silently.

Marketplace is fixed SPICE/Thermal/AI PCB Layout, including uninstalled entries. Shared PluginLogo is 64 px detail/17 px toolbar. Preserve attribution/license; AI PCB Layout supplies guidance/review gates without panel/autorouter. Disable/uninstall cancels affected turns.

Cache provider lists five minutes/refresh on request or mutation; transient status belongs to its category. Navigation preserves projects/drafts/conversations/Home brief. No extra plugin-settings dialog. Verify effective state/managed policies; provider management grants no workbench tools.

## Maintenance and verification

Update this contract for visible behaviour/dimensions/icons/gestures. Setup belongs to README, engineering to AGENTS, numerical/storage details to feature contracts. Documentation-only edits need content/format/link checks. [Architecture verification](docs/ARCHITECTURE.md#verification) indexes isolated/opt-in checks.

## References

- [Open Design architecture](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md) and [tokens](https://github.com/nexu-io/open-design/blob/main/apps/web/src/styles/tokens.css)
- [KiCad schematic painter](https://docs.kicad.org/doxygen/sch__painter_8cpp_source.html) and [PCB painter](https://docs.kicad.org/doxygen/pcb__painter_8cpp_source.html)
- Local research: `references/open-design-tokens.css`, `references/open-design-home.png`, `references/open-design-studio.webp`
- Neutral/green identity, concise English copy and no decorative focus indicators are explicit user preferences.
