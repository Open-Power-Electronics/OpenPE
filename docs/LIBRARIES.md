# KiCad libraries and model delivery

OpenPE uses bundled official KiCad libraries, pinned native example footprints
and the explicitly selected NextPCB and JLCPCB online catalogs. It uses bundled
resources and host adapters without installed KiCad resource discovery or runtime
CLI conversion.
Catalog availability does not imply support
for every feature or simulation model. [FORMAT.md](FORMAT.md) defines native
data, [LAYOUT.md](LAYOUT.md) defines synchronization/Model editing, and
[API.md](API.md#library-capabilities) defines capability schemas.

## Resources and preparation

`resources/kicad.lock.json` pins KiCad 10.0.0 symbol/footprint commits and the
optional model archive. `npm run libraries:download` prepares
`resources/kicad/10.0.0/`, starter symbols/search indexes and parser source
archives. Symbols may be packed `.kicad_sym` or `.kicad_symdir` directories.
Downloads/caches stay outside Git; locks, generators and notices remain tracked.
`npm run package` prepares/includes versioned resources without `.git` metadata.

Default preparation includes these STEP models:

- `Resistor_SMD:R_0805_2012Metric`
- `Capacitor_SMD:C_0805_2012Metric`
- `Package_TO_SOT_SMD:SOT-23`

`npm run libraries:download-models` optionally installs the hash-pinned complete
collection: 7,236 STEP files, no VRML. Originals/notices live in
`resources/kicad/10.0.0/models/`; the archive stays under
`resources/third-party-source/`. Differing existing files are preserved as
conflicts. Packaging includes the collection when present.
`node scripts/download-kicad-models.mjs --verify` checks existing resources
offline; the complete collection is separate from default preparation.

## Symbols and embedded designs

`scripts/build-starter-symbols.mjs` generates
`lib/kicad-starter-symbols.json` from official geometry. Empty sheets embed
symbols when placed; loaded designs retain embedded variants, fields and pin
mappings. The worker resolves inheritance and validates supported geometry
before placement. Multi-unit instances have distinct UUIDs with shared
reference/value/fields; import/round trips check references and units.

New `Connector`/`Connector_*` symbols default to simulation-excluded; other
placements honour upstream defaults. The chooser only places components.
The SPICE settings Components list or `part.participation` edits
`simulation.excluded`, exported as `exclude_from_sim`, independently of model
support. The list requires the enabled plugin; Core/Source edits remain available
independently of plugin state.

A nonblank assigned Footprint determines physical styling and PCB participation
through `lib/symbol-role.ts`. Instance assignment overrides library defaults;
unplaced previews use defaults. Ground/power remain markers. Namespace and
simulation fields never determine physical role.

## Footprint assignment and Layout

The component's Footprint field and linked package share one Core transaction.
`PCBProjectSync` prepares library details/networks; Core validates acceptance.
Reassignment replaces geometry while retaining matching identity/placement;
clearing assignment removes its package and retains copper. Manual Layout
placement updates the schematic assignment.

Loaded boards remain authoritative until relevant primary-sheet inputs change.
Opening, saving and other-sheet edits do not refetch or normalize packages.
Source aliases survive until explicit reassignment. Ordinary Value, simulation
and custom captions retain native nets, fills and packages while refreshing
linked captions; power-symbol Values remain electrical. Participation-only
changes retain PCB bytes. Async preparation cannot replace pending Source,
newer revisions or a closing project. Accepted synchronization joins its
originating undo edit; clean materialization retains its baseline. Footprint and
Model browse buttons open an assigned online footprint by exact identity and
prefer the project's downloaded footprint and STEP files. Search remains
available to browse other packages. Detailed
connectivity/copper handling belongs in [Layout](LAYOUT.md#project-integrity-and-schematic-synchronization).

## Catalog service and chooser

Authenticated routes accept bounded IDs/model indices, never renderer paths or
URLs:

| Route                       | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `/api/libraries/symbols`    | Ranked/paged search or detail by ID         |
| `/api/libraries/footprints` | Ranked/paged search or detail by ID         |
| `/api/library-model`        | STEP conversion by footprint ID/model index |

`server/libraries.mjs` owns workers; `server/library-worker.mjs` indexes/resolves
catalogs within the real resource root and file bounds. Shared resolution,
placement and ranking rules in `lib/library.ts` generate
`server/library-format.mjs` through `npm run build:format`; edit sources, not
bundles.

The KiCad source in the Footprint and Model choosers combines official
namespaces with pinned native examples, including all seven reviewed Würth
Elektronik footprints and their linked STEP models. Filter by the native
namespace or search by footprint ID or pinned STEP filename. Search
deduplicates shared footprint IDs before ranking and pagination. Detail and
assignment use the original native IDs and asset provenance. The on-disk KiCad
index tracks the official resource tree.

Bundled search ranks all matches before returning pages of at most 100. Exact IDs/names,
prefixes and partial names precede keywords/descriptions, with stable ID ties.
Empty queries browse alphabetically. Workers retain the last ranked query per
kind so appending pages avoids repeating a search.

Search for common package codes such as `0603`, `SOT-23` and `SOP8` directly in
KiCad, NextPCB and JLCPCB. Use `package:<name>` to search for other package
labels. Package queries match the linked native footprint for KiCad symbols,
the native ID for KiCad footprints and the declared Package field for online
sources. Named package matching ignores case, spaces and punctuation. Chip
size matching uses the package code and excludes parenthesized metric aliases.
Ordinary KiCad symbol search also matches the linked footprint name and ID.
Scroll or use Load more to continue online package-only searches, including
after a batch with no matches.

Ordinary catalog queries do not read CAD for result rows. The symbol chooser
requests status-checked pages via `library.search`. Each batch covers up to
16 KiCad results or 16 raw NextPCB or JLCPCB catalog rows for ordinary searches.
Online package search can examine the rest of the current catalog page and
returns at most 16 matches per status-checked batch. Online batches
continue across provider page boundaries; filtered or repeated rows consume
their raw cursor positions and can yield fewer results. KiCad reads the exact
linked native footprint, and NextPCB checks up to four rows in parallel with a
ten-second page budget. JLCPCB pages use cached statuses from previously
validated details. They leave uncached rows unknown until their CAD is opened.
These statuses describe verified footprints and model references. STEP files
are read on demand.
The chooser receives the eligible page size and a running count of confirmed
checks on the same request. A confirmed absence counts as a completed check.
Denied, failed or skipped checks leave the count below the total.

The symbol chooser shows up to 16 unique results per batch for KiCad, NextPCB
and JLCPCB, in both browsing and keyword searches. Scrolling or Load more
adds another batch. It uses eligible rows already fetched, then follows the
catalog cursor until the batch is full or the results end. Rows appear as
checked pages arrive, and checked selections remain usable during the initial
append.

Submit from any source with Search or non-composing input Enter. Editing or clearing
the draft retains accepted rows, selection, preview, count and appended pages.
Submitting a query or changing category restarts paging. Retry resumes a failed
page, preview or category request. Initial loading uses the branded indicator. The chooser retains
search/filter/selection/preview through appends and errors. Confirm only current loaded valid details, ignoring stale,
repeated or composing Enter. Symbols enter a canvas preview before committing;
footprint assignment uses Core. [DESIGN.md](../DESIGN.md) owns presentation.

### Component pricing

The **Price source** dropdown offers LCSC Electronics and HQ Online for selected
KiCad, NextPCB and JLCPCB entries. A NextPCB selection starts with HQ Online,
and a JLCPCB selection starts with LCSC Electronics, which shares its part codes.
KiCad starts with HQ Online. A manual choice applies to the selected entry until
the selection changes or the chooser closes. **Check price** or **Refresh price**
starts a request.
Search, selection, switching price sources and CAD previews issue no price
requests. A source or selection change cancels pending requests. Each source's
last successful result and check time stay with the selected entry through
switches and failed refreshes. Changing the selected entry or closing the chooser
discards those quotes.

The host resolves the catalog identity before lookup. KiCad uses the symbol's
Manufacturer Part Number or MPN property and the Manufacturer property when
present. The bundled `Regulator_Switching:LM2596S-5` and
`Regulator_Switching:LM2596T-5` symbols with the TI LM2596 datasheet use the
reviewed order numbers `LM2596S-5.0/NOPB` and `LM2596T-5.0/NOPB` for pricing
when those fields are empty. Other symbols without a part-number property use
their full symbol name when it contains a digit. [TI orderable parts](https://www.ti.com/lit/ds/symlink/lm2596.pdf)

Generic symbols without a suitable identifier and standalone KiCad
footprints yield an empty result. NextPCB and JLCPCB use their catalog part
numbers and manufacturer metadata without requiring downloadable CAD artwork.
Cross-catalog searches match the full part number and, when available, the
manufacturer name or its catalog-provided parenthetical alias. Searches are
bounded to the first provider page.

- LCSC Electronics supplies USD quantity tiers from its public storefront catalog. JLCPCB
  entries use the exact shared LCSC part code. Other catalogs use the part number
  and available manufacturer metadata.
- HQ Online quotes come from NextPCB's fixed HTTPS `searchSupplyChain` endpoint. A NextPCB entry
  supplies its validated manufacturer ID and original part number. For KiCad and
  JLCPCB, the host finds up to four matching NextPCB catalog identities first.
  The request sends each identity as `manufacturerId-MPN` and accepts HQ Online
  offers carrying the corresponding ID and complete part number. The offer
  includes the supplier SKU. The lookup's manufacturer ID identifies the
  request, so the maker remains unlisted in the offer.

Results contain up to four distinct SKUs with valid USD unit prices by order
quantity, the manufacturer's label and stock where available. No matching
priced offer yields an empty result. Provider failures and malformed responses
remain retryable. Provider requests use fixed HTTPS endpoints with bounded
responses and no quote cache.

### Component datasheet preview

The selected component's **PDF** tab loads page one from **HQ Online** for
NextPCB and KiCad entries, and from **JLCPCB** for JLCPCB entries. Catalog
browsing, selection and CAD previews do not download PDFs.

HQ Online uses the NextPCB component detail record. JLCPCB reads a fresh
catalog page and keeps the signed PDF locator in the host. For their own catalog
entries the host uses the exact provider identity. For other entries it shares the
[pricing identity rules](#component-pricing), then requires a unique full
part-number and available manufacturer match on the first provider page. The
host checks the JLCPCB PDF locator against the resolved component code.
Online footprint entries share their component's identity.

The host accepts direct PDF references on approved manufacturer literature
paths and the documented vendors' dedicated asset hosts. It upgrades supported
legacy HTTP links to HTTPS, preserves JLCPCB's signed query, and rejects
redirects. Missing or unsupported references show an empty preview. Download
and parse failures allow retry.

Each PDF is limited to 32 MiB. A cancellable worker rasterizes only the
requested page, up to 2,400 pixels on the longest side and 8 MiB per PNG.
The service allows two concurrent previews with a 45-second deadline and
briefly retains up to two successfully parsed PDFs in memory for paging.
Leaving the PDF tab, changing the component or closing the chooser cancels
pending work. The inline and expanded views share the same reader while the
component remains selected. The reader retains up to two rendered pages for
back/forward navigation.
The preview stays outside design data and Agent context. [Reviewed example
datasheets](DATASHEETS.md) have a separate binding and verification contract.

### NextPCB online catalog

The selected deepest category ID determines the displayed path and lower-field
values. Selecting an ancestor clears lower selections. **All categories** clears
the category selection; **All subcategories** in a lower field selects its parent
ID. A field without a selected parent or real children stays disabled, with no
invented categories. The second category field lists all descendants beneath the
selected root using breadcrumb labels and their actual category IDs, so the two
category fields do not limit the host's supported hierarchy depth. Field
descriptions expose the selected
path. Both symbol and footprint choosers retain the same authenticated routes and
`library.categories`, `library.search`, `library.detail`, placement and assignment
capabilities as Agents.

Selected details group native information into Basic information, Symbol details,
Package, 3D models and Description; missing fields are omitted rather than
guessed. Pin counts refer to the selected unit.

`components/LibrarySourceSelect.tsx` owns source/category presentation and cancels
obsolete category reads. Selecting NextPCB loads its categories; merely opening
the default KiCad chooser performs no remote requests. Category errors have an
explicit retry and cannot replace the current results. The catalog search
and category picker load independently.
A source switch retains each source's query, category and completed browsing state for the chooser's
lifetime, including separate draft and committed queries. Search or Enter submits
keywords; typing alone keeps the current results. Filters initially remain at All categories.
The public NextPCB search requires a category or keyword. An empty query under
All categories automatically browses suggestions from the reachable Operational
Amplifier and Comparators category (1737). A keyword under All categories
searches across the catalog. Explicit choices survive component selection,
query resubmission, clearing and source restoration.
Common chip package codes (`01005`, `0201`, `0402`, `0603`, `0805`, `1008`,
`1206`, `1210`, `1812`, `2010`, `2220`, `2512`) search the declared package
directly. The first numeric group must equal the code. All categories combines the
first 50 rows of each reachable Chip Resistors, Chip Capacitor (MLCC), Ceramic
Capacitors, Inductors and Chip Bead category, deduplicates identities, and pages
through the matching sample. Recognized named packages sample General Purpose
Transistors, MOSFETs, Schottky Diode, Operational Amplifier and Comparators, and
Linear Voltage Regulators, plus the first cross-category keyword page. Selecting
a category searches its browsing pages. Other package labels under All
categories filter the provider's keyword results by their declared package.
Result Enter/double-click starts placement. Category
changes restart paging, while completed source restoration retains loaded pages,
selection and preview. Repeated identities across provider pages produce one
visible row per ID. Online pagination follows the next offset returned by the service, even when a
batch has no eligible entries. The chooser announces its loaded count of unique
results and preserves active rows and previews while appending. This state is
local to the chooser.

`server/nextpcb-library.mjs` posts bounded searches to
`https://library.nextpcb.com/api/chiplet/products/kicad/queryPage` and component
identities to `/api/chiplet/kicad/productDetail` on that same origin. Results retain
the provider's ranking. Native pages contain up to 50 catalog rows, and both
chooser kinds share the same cached pages. Symbols retain catalog candidates
without a usable footprint link. The footprint chooser lists rows with an
allowlisted native `.kicad_mod` link. Native files are validated before preview
or use. IDs are
`NextPCB:<manufacturer_id>_<percent-encoded MPN>`; callers supply no asset URLs.
Category discovery posts `{}` to `/api/chiplet/products/cateTree`. Its flat
`cateId`/`parentId` records become the same reachable hierarchy used by the
provider's browser UI, using English display names without invented parents or
fallback labels. Up to 2,000 records and eight levels are accepted; malformed,
duplicate or cyclic hierarchies reject. Search accepts only reachable category
IDs and forwards the selected numeric `cateId`. One category tree is cached for
five minutes independently of search pages. Manufacturer and package metadata
remain separate bounded fields. Result rows show Model and Package on one line;
manufacturer remains in the selected-item details.
Line breaks and tabs in catalog descriptions become spaces in search and detail.
Native `.kicad_sym` and `.kicad_mod` links must point to the HTTPS
`file.eda.cn/web1/M00/` or `/web2/M00/` paths. Scheme-relative links on the same
CDN resolve to HTTPS. Filenames can contain percent-encoded characters such as
spaces, and decoded names must retain the expected file extension without path
separators. Requests forbid credentials, query strings, fragments and redirects.
JSON and native responses each stop at 2 MB, with eight concurrent
catalog operations and a 20-second operation deadline. Symbol detail requests
the symbol and linked footprint in parallel, bounded to at most 16 simultaneous
native reads. A rejected footprint link or an unavailable package leaves an
independently valid symbol usable. Standalone footprint detail reads and
validates the package on its own, including when the symbol is absent or
invalid. Disconnect or close cancels work. Memory caches expire after
five minutes and retain at most eight search pages,
32 component records and 16 native details; errors remain retryable.
Provider business rejection codes are reported separately from transport
failures; upstream messages and raw responses are not forwarded to the renderer.
Electron supplies its system-network `net.fetch` adapter, shared with existing
vendor resource reads, so the service follows system proxy settings without
exposing credentials or networking to the renderer.

Symbols use the manufacturer part number as Value, normalize a trailing `?`
reference placeholder and bind any supplied footprint to the same NextPCB ID.
Embedded symbol geometry, pins and other fields remain native KiCad data and
pass the shared project validator. Symbol detail checks the linked package with
the same `createPCBFootprint` preparation used by Layout. Standalone detail uses
the shared footprint parser, and assignment checks the target symbol's pin
numbers against the package. Unsupported linked package geometry produces a
diagnostic in symbol detail while allowing placement of a valid schematic symbol.
The assigned Footprint is retained for explicit reassignment in Properties.
Footprint assignment still rejects unsupported geometry. Embedded remote 3D
references must use a validated `${KICAD<n>_3DMODEL_DIR}` library path; native
offset, scale, rotation, visibility and opacity remain intact. NextPCB
`20210108` package conversion expresses inch-based model
`at` coordinates as metric `offset` coordinates when exactly representable at
native precision. [KiCad model parser](https://github.com/KiCad/kicad-source-mirror/blob/10.0/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp#L869-L887)
The shared converter retains exact circle, arc and polygon artwork, user text, pad thermal
angles and mask/paste settings. Native line-width records from `20210108` and
`20211014` footprints are accepted alongside supported stroke records. Unsupported shapes,
pad types or ambiguous fields still reject without dropping geometry.

Adopting a NextPCB package prepares its STEP models through the bounded host
service. A single provider `3d` STEP asset is paired only with a single embedded
model record; its transform is retained. The asset uses the same fixed HTTPS CDN
and no redirects, with a 32 MiB limit and STEP parsing before acceptance. Without
a provider STEP asset, an explicit official KiCad reference resolves through the
versioned KiCad model store; `.wrl` references resolve the corresponding STEP
basename in that store. Missing/ambiguous assets remain explicit retryable errors;
models are never inferred from a package name. NextPCB SPICE downloads and
arbitrary model URLs/local paths are unsupported.

Schematic placement prepares supported linked packages for both online catalogs,
including additional sheets and Virtual components. Placement adds the native
`.kicad_mod` under `footprints/<catalog>.pretty/` and its `fp-lib-table` entry in
the same Core edit as the symbol. Existing project packages are reused offline.
Filenames follow native limits. Differing files and library mappings reject
adoption and retain their bytes. Model references use
`${KIPRJMOD}/models/<SHA-256>.step`, backed by verified immutable bytes in the
component model store. The project can preview staged assets immediately. Save
and Save as write the footprint library and STEP assets beside the native
project, including STEP files referenced only by a downloaded library footprint.
Browsing leaves project files alone.

No remote model paths receive local file access. Search/preview never edits a project;
placement embeds the accepted symbol and uses ordinary Core undo/native Save.
Loaded native boards retain their existing authority and never refetch just for viewing.

NextPCB files are fetched on demand, not bundled or relabeled as official KiCad
library content. Provider metadata is untrusted data. Catalog access adds no
general downloader, external-page embedding, login or executable authority.

### JLCPCB online catalog

JLCPCB is available in the symbol and footprint choosers and through the shared
library queries. On selection, the chooser loads an unfiltered catalog page
and the provider's root and child categories. Scrolling appends more catalog
results, including when All categories is selected and the query is blank.
Choose a root to include its descendants or a child to narrow the search.
Categories can be browsed without a keyword. A model, keyword or `C` part
number can search across all categories or within the selected category.
Package-only search sends the package text as a keyword and filters the
returned candidates by their declared package.
The host returns up to 100 catalog rows per page in provider order. A row
with a declared or verified package is eligible. An exact part-number search
can also find a part whose package label is missing. An earlier detail check
can establish that a part lacks a usable footprint and exclude it from later
searches. Detail requires the requested part number in both the EasyEDA product
and the embedded symbol's LCSC `Supplier Part` field. The product and symbol
UUIDs identify their respective records. The linked footprint must match the
symbol's package UUID and its own document UUID.

`server/jlcpcb-library.mjs` reads the public JLCPCB assembly catalog at
`jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2`.
The same endpoint supplies the two-level category tree. Category IDs are the
provider's canonical decimal `componentSortKeyId` values. The host validates
each selected ID against the current tree and sends its source name and parent
name when needed. Repeated identical leaf entries appear once.
Selected details read the EasyEDA international component endpoint
`easyeda.com/api/products/<code>/components`. The service serializes uncached
CAD reads and spaces their starts at least one second apart. Only component detail requests read
CAD, so browsing and appending catalog pages can finish independently of
EasyEDA. Up to eight JLCPCB operations can run at once. Five-minute caches retain 16 catalog
pages, 1,024 verified footprint/model statuses and 16 converted details. Checked
rows reuse cached statuses after converted geometry expires or is evicted. Preview reuses cached
catalog metadata and CAD. A direct ID without a cached catalog
entry requires an exact catalog lookup first. Each response is capped at 2 MB.
Requests time out at 20 seconds and cancel on disconnect. Desktop requests to
JLCPCB and EasyEDA use Electron's system-network transport. Errors identify the
catalog, EasyEDA CAD or EasyEDA STEP request that failed. For CAD HTTP 403 or
429, the service honours a valid upstream `Retry-After`. A first HTTP 403
without that header gets one automatic retry after two seconds. Continued
denials without a header pause uncached CAD reads for 60 seconds, with
successive pauses increasing to at most five minutes. An initial HTTP 429
without the header starts with a 60-second pause. The error reports the
remaining wait. Requests during a pause leave its deadline unchanged. The
first eligible request after a pause probes EasyEDA, and a verified CAD
response resets the backoff. Unconfirmed availability remains unknown. The chooser retains
catalog results and shows metadata for the selected part. Successful detail
loads update the corresponding row. An in-flight preview retry keeps that
selection. Only validated metadata and converted geometry
reach the renderer or Agent.

`server/jlcpcb-cad.mjs` converts a bounded subset of EasyEDA Standard 5/6 library
records, including Standard 6 editor versions with a fourth numeric field.
Multi-unit containers accept up to 32 embedded subparts. Explicit reference
suffixes determine unit numbers. Each subpart must match the parent component
and package identities. The native units use their individual origins and
preserve their graphics and pins. They share one footprint. The subparts
must account for every physical pin drawn in a supplied parent overview.
Footprint detail validates the linked physical geometry independently of the
schematic drawing. Unsupported symbol artwork can leave a valid package
available in the footprint chooser. Assignment still checks the electrical
pad numbers against the actual schematic component.
It preserves physical pin names and numbers. The connection dot sets the pin
anchor, while the path and pin header can start at either endpoint. The
standard clock marker at the body endpoint maps to a native clock pin.
Repeated numbers with matching names and electrical types retain every anchor
for the same terminal. Individually
hidden names or numbers use zero-sized native labels. Static labels accept
numeric SVG sizes and point sizes. Unfilled circular symbol arcs use native arcs.
Solid, dashed and dotted strokes map to the corresponding native stroke styles.
Identical SVG arc endpoints contribute no symbol geometry. Filled major arcs
with a closing chord within the curve tolerance, axis-aligned symbol ellipses,
elliptical arcs and filled rounded rectangles use bounded native polylines
with at most 0.001 mm geometric error. EasyEDA's directionless Power
classification maps to KiCad unspecified. Standard `PT` symbol paths preserve
straight segments and approximate curves as native polylines within the same
tolerance. The `none` fill token is case-insensitive. Unfilled paths can have
separate subpaths. A filled path requires
one simple closed contour. Matching stroke and fill colours use KiCad's
outline fill.

Packages retain front and back SMD pads, round drills and straight slots with
round ends, explicit pad mask and paste margins, and pad rotations. A slot
requires two declared tool centreline endpoints, a consistent overall length
and tool diameter, and alignment with one of the pad's local axes. The length
and axis checks allow 0.001 mm of supplier coordinate rounding. The slot uses
the endpoint midpoint, with up to 0.002 mm of difference from the supplier's
redundant centre. Plated drills retain their location inside the pad copper,
including offset slots. Non-plated slots retain the supplied number and may
be offset within an oval mask opening. A number on a non-plated hole is a
mechanical identifier and may match an electrical pad number. Polygon pads
that match their declared rectangle or a rectangle with equal 45-degree
chamfers use those native pad shapes. Other surface-mount and centred plated
pads can use a single simple polygon within the [Layout custom pad
limits](LAYOUT.md#layout-and-model). The original origin and
rotation locate the native pad, and its outline determines the copper. The
polygon must fully enclose the rectangular anchor and any plated round drill
or slot. It retains its vertices through preview, placement and Save.
Supported silkscreen and assembly layers accept outline rectangles, solid
rectangles, filled regions and simple filled SVG path nodes alongside lines,
arcs and circles. Circular arc paths accept surrounding whitespace. Silkscreen
lines and arcs can carry EasyEDA `S$<digits>` identifiers as source metadata.
Static silkscreen and assembly labels use the saved glyph strokes. Each label
can use up to 64 glyph contours and 1,536 vertices within the footprint's
2,000-graphic limit. Filled regions on either solder mask or paste layer become
strokeless native footprint polygons. Gerber plots these apertures
independently of the pads. Board-outline tracks, circular arcs, circles and
outline rectangles retain their Edge.Cuts geometry. Explicit multi-layer
non-plated cutout regions become closed Edge.Cuts polygons and use the
board's ordinary outline validation and profile output.
Point lists and paths with absolute or relative SVG M/L/H/V/A/Q/T/C/S/Z commands
can contain concave or disjoint contours. Curves are tessellated to a
0.001 mm geometric tolerance in native coordinates. Each region is bounded to
32 contours and 512 vertices, with a total geometry work limit per footprint.
Nested, touching or self-intersecting contours, standalone copper graphics,
unsupported custom pad geometry and slots that fail the geometry
checks fail footprint detail. An independently valid symbol
retains its linked assignment and includes the package diagnostic. Document
and 3D preview layers are omitted, including document-layer solid regions
with EasyEDA `S$<digits>` identifiers.

Up to 32 verified EasyEDA STEP references per footprint use the fixed
`modules.easyeda.com` model host. Explicit origins, heights and XYZ angles map to
native model settings in the same frame as KiCad's EasyEDA Standard import.
Positive uniform scaling and translation on the SVG outline are outline
metadata. The STEP uses its explicit origin, height and angles. An unsupported
model record leaves the 2D package and other verified models usable. The host
limits each STEP read to 32 MiB and
validates geometry with the shared parser. Chooser previews apply the native
pose and load each selected model on demand. Placement prepares portable STEP
references, and Save publishes their bytes. A STEP HTTP 403 or 404 omits that
model during package preparation while retaining the verified 2D footprint and
remaining models. An explicitly requested 3D preview reports a 403 and remains
retryable.

Accepted footprints use the shared package transaction and persist in
`footprints/JLCPCB.pretty/` with their `fp-lib-table` mapping for offline reuse.
Browse and detail leave project files alone. The catalog does not bundle vendor
geometry. Each converted symbol and footprint preserves its supplied notice and
identifies the **JLCEDA/EasyEDA Official Library** in detail and native metadata.
The final chooser card shows the source name and both official website links.
Its collapsed chevron opens the English terms from the supplied notice.
The links open in the system browser on desktop.
See the [JLCPCB Assembly Parts Library](https://jlcpcb.com/Parts), the
[EasyEDA Standard format](https://docs.easyeda.com/en/DocumentFormat/EasyEDA-Format-Standard/),
and the [JLCEDA](https://lceda.cn/) and [EasyEDA](https://easyeda.com/) homepages.

### Shared library capabilities

| Capability           | Contract                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `library.search`     | Bounded symbol/footprint catalog search                                       |
| `library.categories` | Read bundled namespaces or the NextPCB and JLCPCB category trees              |
| `library.detail`     | Validated KiCad, NextPCB or JLCPCB symbol/footprint                           |
| `schematic.place`    | Load/validate a symbol unit and place on an explicit sheet                    |
| `part.footprint`     | Verify/assign a catalog footprint or clear an explicit component's assignment |

Human/Agent placement shares reference allocation, 1.27 mm snapping, multi-unit
and participation rules. Assignment uses Core's property validation. Async
commands recheck cancellation/revision before commit and reject pending Source.
[Core](CORE.md) defines common review/close gates. Chooser gestures are
presentation, not additional typed capabilities; runtime discovery is
authoritative.

## STEP access and previews

Browser development exposes only read-only footprint detail and model mesh previews through the [authenticated preview transport](API.md#browser-development-preview-transport). It resolves fixed bundled example assets and prepared official library IDs/model indices through the existing library service. It performs no downloads, cache writes, model imports or reads of arbitrary project-local paths. Missing official models require explicit build-time preparation with `npm run libraries:download-models`. Browser CAD and component previews share a serial parse queue and bounded STEP worker pool; model scale, pose, material, visibility, picking and scene caches retain their existing renderer behavior.

Native model paths/transforms/visibility are design metadata, not filesystem
grants. Runtime resolves fixed example identities, official footprint/model indices, or validated component model references through the local STEP asset store. Explicit native STEP selection and Save portability follow [Layout](LAYOUT.md#model-resolution-and-alignment). Without instance links, alignment is permitted only when all numbered
embedded pads share one translation; unsafe alignment errors without rewriting
the board.

Official reads prefer bundled resources, then the private
`OpenPE/library-models/10.0.0/` cache. A miss may download only the STEP linked by
the bundled versioned footprint or a validated NextPCB or EasyEDA reference. STEP
reads use the owning provider's byte limit, fixed source, redirect rejection and STEP validation,
coalesced requests and atomic verified cache writes. A 404 retains usable 2D
geometry; network failures remain retryable. Custom unsupported pad previews
report limits rather than inventing geometry.

The reference examples bundle 46 hash-verified STEP files and the source-extracted WE-DD-7345straight
footprint under `resources/example-catalog/footprints/`. The subset contains 42 official KiCad 10 models and four pinned source models absent from that release. The custom footprint retains the LM25017 expert board's local pad geometry. EMC separately pins 31 files in
`resources/example-catalog/emc-flyback-assets.json`: 26 upstream component
models, two OpenPE analytical bodies, one manufacturer supplement, and
two static enclosure source models outside the footprint catalog. See
[MODEL-SOURCES](../resources/example-catalog/footprints/emc-flyback/MODEL-SOURCES.md).
L2 and T1 are `L_8040_Shielded.step` and `T_EFD25_SMD.step`. Their bytes are
OpenPE analytical solids, so no third-party license applies to them. L1 has a marked reproducible rigid assembly-frame
alignment, retaining topology/colours. The 29 component models serve 83 EMC
instances. Five mounting holes have no separate component model. Preparation
verifies fixed hashes and notices. `npm run examples:prepare` first runs
`scripts/prepare-emc-analytical-models.ts`, which generates only those two
OpenPE bodies when they are missing and rejects a different existing file, then
`scripts/download-manufacturer-models.mjs`, which fetches only the WE-CMB
manifest URL, follows redirects solely to that entry's `approvedHosts`, and
rejects every other host. The WE-CMB file stored for the project is the pinned
derivative, not the raw download. Example previews never download. Build preparation, native
Save and PCB export copy required model files beside the destination using
`${KIPRJMOD}/models/<model>.step`. LM25017 and EMC custom libraries/tables are
native Source files under `footprints/<stem>.pretty/` and `symbols/<stem>.kicad_sym`,
retained and renamed by Core on Save
as; asset preparation does not overwrite them or create duplicate libraries.
Project preparation supplies missing pinned package/table sidecars. Native STEP references retain their documented KiCad paths.
Project preparation creates no `NOTICE.txt`, `licenses/` or empty resource
directories. Original license texts and provenance remain in pinned shared
sources and packaged notices. Portable SPICE files follow the
[Simulation](SIMULATION.md) `models/<component>.lib` naming. `footprints/` holds `.kicad_mod`
packages, `symbols/` holds `.kicad_sym` libraries and `models/` holds STEP files.
Flat STEP basename collisions use an eight-character content hash
suffix. Stable registry IDs and model bytes are unchanged.
Asset preparation rejects links, never deletes files and fails on an existing
differing asset instead of overwriting it.

`occt-import-js` 0.0.23 tessellates STEP in workers for Three.js. Conversion is
cancellable with a 45-second timeout, two service jobs and one conversion per
worker. Initialized parsers are reused, then released after 30 idle seconds,
32 jobs or a 128 MiB WASM heap; JavaScript old-generation memory is 256 MiB.
Failure/cancellation/timeout/close terminates the affected worker. Reuse keeps
identical tessellation parameters and never caches failures. A missing STEP
source or explicit tessellation rejection confirms the current preview is
unavailable. Network errors, timeouts and worker failures remain retryable.
Chooser 3D previews one footprint. Model renders the board and available packages.

Four pinned Würth STEP assemblies (WE-DD-7345straight, WE-LQSH-2010,
WE-LQSH-2512 and WE-CMB 744822222) carry surface colours on the component
definition. `server/step-appearance.mjs` matches their SHA-256 hashes and
reads the same solids without the single assembly occurrence to recover its
solid and face colours. Mesh and face counts must agree before recovered
colours fill uncoloured ranges. Positions, normals, indices, face ranges and
saved STEP bytes come from the original model. The analytical 750311591 STEP
has no colour records and uses the neutral preview material.

### Model lifetime and caches

Lazy editors remain mounted. Each Model retains scene/camera/display state
across navigation; hiding pauses rendering/new requests and defers board rebuilds
until return. Replacement/close cancels obsolete work and disposes GPU resources;
late models never reset the camera.

`lib/pcb-preview-cache.ts` shares CPU definitions/meshes across renderer scenes:
256 footprints, 128 meshes and 12 million numeric values. Board conversions
serialize across projects, reserving service capacity for the chooser; queued
work rechecks cancellation/cache. Failed jobs never poison the queue/cache.
Scene/GPU ownership remains independent, with separate instance/complexity bounds.

## Licenses and replaceable parser

Official libraries and the derived index use CC BY-SA 4.0 with the KiCad
libraries exception. Preserve notices; redistributed collections retain their
attribution/share-alike obligations. OpenPE is not endorsed by KiCad.
About OpenPE displays packaged `public/licenses/` notices. Three.js uses MIT;
`occt-import-js` uses LGPL-2.1, and Open Cascade has its LGPL-2.1 exception.
OpenPE permits modification and reverse engineering needed to debug changes.
Bundled ngspice, Gmsh, Elmer and OpenBLAS notices are `public/licenses/ngspice.txt`
and `public/licenses/thermal.txt`. Locks cover `win32-x64`, `darwin-arm64`
and `linux-x64`. [Solver bundle maintenance](DEVELOPMENT.md#solver-release-access)
owns archive access and rebuilds; [Simulation](SIMULATION.md#portable-models-and-bundled-solver)
and [Layout Thermal](THERMAL.md#runtime-and-lifecycle) own solver configuration
and corresponding sources.

Full datasheet pages use pinned `pdfjs-dist` 6.5.438 (Apache-2.0) and
`@napi-rs/canvas` 1.1.0 (MIT) in a host worker. About OpenPE includes
`public/licenses/pdf-reader.txt`, preserving their upstream license texts and
the bundled PDF.js font/CMap/codec notices. npm production dependencies deliver
the PDF.js worker, fonts, CMaps and WASM; the canvas native packages are unpacked
from ASAR. No system PDF renderer or runtime executable discovery is used.

Model Render bundles `three-gpu-pathtracer` 0.0.24 and `three-mesh-bvh` 0.9.5
under MIT. Their unmodified license texts are delivered as
`public/licenses/three-gpu-pathtracer.txt` and `public/licenses/three-mesh-bvh.txt`
and appear in About OpenPE. The installed `xatlas-web` 0.1.0 peer retains its
MIT notice in `public/licenses/xatlas-web.txt`; Render does not use its UV
unwrapping utility or load its WASM. The path tracer and BVH operate locally on
render-only scene data without downloading studio images or native Blender.
The path tracer notice also preserves the MIT attribution to HOVER's
`ray-tracing-renderer`, identified as the bundled stratified samplers' source.
The path tracer's denoising shader incorporates Michele Morrone's
glslSmartDeNoise under BSD-2-Clause. Its embedded 2018–2019 copyright and full
upstream license, identified by blob `6ce8dacef27906c1c0f9b726af1b28f5065c86c2`,
are delivered in `public/licenses/glsl-smart-denoise.txt` and About OpenPE.

The Git glyph adapts Microsoft's VS Code Codicons `source-control.svg` at revision
`ceaa8663a7e63e2bac7f1ecac128ce31404b7487`. The redrawn geometry retains its
three-node branch structure with round nodes, balanced spacing and the shared
2-unit stroke, inheriting the UI color and control size. Its CC BY 4.0 license,
attribution and source URL are bundled in `public/licenses/vscode-codicons.txt`
and listed in About OpenPE.

Wire adapts KiCad 10.0.0 `resources/bitmaps_png/sources/light/add_line.svg`,
the Draw Wires action icon, preserving its diagonal, round caps and 2-unit stroke
while using the UI text color. The adapted artwork remains under CC BY-SA 4.0;
`public/licenses/kicad-icons.txt` bundles attribution, the source URL and license,
also listed in About OpenPE.

`scripts/download-parser-source.mjs` prepares parser source commit
`c2148e54b456b571238d35cac037d304053d64b2` and Open Cascade
`d2abb6d844231cb8f29be6894440874a4700e4a5`. Packages ship corresponding
archives/manifest/instructions under `resources/third-party-source/`. Extract
Open Cascade into `occt/` and follow the included build scripts with Emscripten
3.1.69. Replace JS/WASM under
`resources/app.asar.unpacked/node_modules/occt-import-js/dist/`; the parser is
unpacked to support replacement. Do not package missing notices/source.

## Verification

The live NextPCB sweep defaults to one library service. Use `--clients 2` or
`--clients 3` for independent service instances with the same per-instance
limits. HTTP 403 and 429 from NextPCB pause the sweep.
Pass `--exclude path/to/components.jsonl` for each earlier sweep to verify
distinct catalog identities in a new output directory.

The opt-in supply audit reuses completed symbol and footprint checks from each
`--cad` report. It sends batches of up to 50 distinct manufacturer ID and full
part-number pairs. The output under `test-results/` contains separate lists for
priced, unpriced, failed and unqueried identities plus a summary. HTTP 403 and
429 stop further requests and retain the results collected so far. Pass
`--resume <audit-directory>` with the same CAD reports to reuse completed
results and retry the remaining identities in a new output directory.

| Check                                                                                                               | Scope                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run libraries:verify`                                                                                          | Prepared catalogs, symbols, fields and starter models                                                                                                                                                                    |
| `node scripts/download-kicad-models.mjs --verify`                                                                   | Complete archive/inventory, offline                                                                                                                                                                                      |
| `npm run examples:check-models -- --render`                                                                         | Real parsing of 46 reference/31 EMC files and all ten Home Model views; 83 visible EMC model instances, five mounting-hole notices                                                                                       |
| `tests/libraries.test.ts`, `tests/core-integration.test.ts`, `tests/project-core.test.ts`                           | Catalog/access boundaries, placement/assignment and atomic synchronization                                                                                                                                               |
| `tests/library-prices.test.ts`                                                                                   | Mocked pricing across the three CAD catalogs and both suppliers, with exact match filtering and reviewed LM2596 orderable identities.                                                                                     |
| `tests/datasheet-pages.test.ts`, `tests/browser-previews.test.ts`, `node scripts/check-nextpcb-library-ui.mjs` | Exact datasheet identities, bounded fetching, PDF rasterization and chooser paging, retry and focus with mocked catalog responses |
| `tests/nextpcb-library.test.ts`, `node scripts/check-nextpcb-library-ui.mjs`                                        | Mocked online catalog boundaries, native validation, retry/cancellation and chooser/IME behavior                                                                                                                         |
| `node scripts/check-nextpcb-models.mjs --count 10000`                                                               | Opt-in live NextPCB sweep of unique catalog identities, native symbols, footprints and each supported STEP reference. Records per-asset outcomes in `test-results/nextpcb-models/` and resumes from recorded components. |
| `node scripts/check-nextpcb-prices.mjs --cad test-results/nextpcb-models/components.jsonl`                         | Opt-in live HQ Online quote audit for identities with validated NextPCB symbols and footprints. Repeat `--cad` for additional reports. |
| `tests/jlcpcb-library.test.ts`, `node scripts/check-library-details-ui.mjs`                                         | Catalog transport, EasyEDA conversion, GUI/Agent queries, portable adoption and the attribution disclosure/links in an isolated browser                                                                                  |
| `tests/library-footprint-geometry.test.ts`, `tests/nextpcb-project-assets.test.ts`, `tests/library-package.test.ts` | Exact vendor geometry, native package sidecars, portable STEP adoption, offline reuse and shared undo                                                                                                                    |
| `node scripts/check-model-sync-ui.mjs`                                                                              | Isolated Workbench Model synchronization status/retry, Source/close/IME gates and retained scene/camera; mocked host, no Electron                                                                                        |
| `node scripts/check-layout-package-ui.mjs`                                                                          | Isolated Layout package preparation/placement, sidecars, undo and cancelled/stale/Source/close/IME rejection; mocked host, no Electron                                                                                   |
| `tests/step-parser-pool.test.ts`, `node scripts/check-step-parser-reuse.mjs`                                        | Worker bounds/recovery and exact 31-file mesh parity                                                                                                                                                                     |
| `node scripts/check-library-scroll-ui.mjs`, `node scripts/check-object-retention-ui.mjs`                            | Mocked isolated chooser/state retention                                                                                                                                                                                  |
| `node scripts/check-assignment-preview-ui.mjs`                                                                      | Isolated browser check of shared chooser layout, STEP previews with an unsaved grant, model-index confirmation and retry, retained placement scene, IME and native undo                                                                         |
| `node scripts/e2e-libraries.mjs`                                                                                    | Opt-in desktop interaction                                                                                                                                                                                               |

`KICAD_CLI` is test-only for `libraries:verify` and must report KiCad 10.x.
Documentation changes need static checks, without downloads/previews; desktop
checks follow [AGENTS.md](../AGENTS.md).

References: [official libraries](https://www.kicad.org/libraries/download/),
[library exception](https://www.kicad.org/libraries/license/),
[parser source](https://github.com/kovacsv/occt-import-js/tree/0.0.23).

Local plugin execution uses `quickjs-emscripten` 0.32.0 and its QuickJS WebAssembly runtime. Their MIT notices are included in `public/licenses/quickjs.txt` and About OpenPE. [Plugin execution boundaries](PLUGINS.md#plugin-packages-and-sdk)
