# Plugin design specification

OpenPE manages bundled workbench features and installed Codex/Claude Code
plugins through separate bounded adapters. The capability registry is not a
runtime extension loader or online catalog. [API.md](API.md) defines schemas,
[CORE.md](CORE.md) defines shared execution/review, and
[DESIGN.md](../DESIGN.md) defines the shared editor and control system. This
specification owns plugin presentation, lifecycle and provider integration.

## Bundled plugin surfaces

| Plugin | Catalog ID | Workbench entry | Output |
| --- | --- | --- | --- |
| [SPICE Simulation](SIMULATION.md) | `spice-simulation@openpe` | Schematic Plugins toolbar group and component SPICE Properties | Transient waveforms and probe readouts |
| [Layout Thermal](THERMAL.md) | `pcb-thermal@openpe` | Layout Plugins toolbar group | Board temperature map, probes and image export |
| [PE Layout Skill](#pe-layout-skill) | `ai-pcb-layout@openpe` | Plugin details and scoped Agent guidance | Verified bundled workflow and references |
| [Layout Parasitics](LAYOUT.md#layout-parasitics) | `layout-parasitics@openpe` | Layout Plugins toolbar group | Estimated two-terminal DC resistance, shortest modeled path and partial inductance |

Toolbar groups appear when an installed and enabled plugin contributes an
action. Use the shared [toolbar order and spacing](../DESIGN.md#toolbars-and-tool-settings).
The shared PluginLogo uses 17 px in toolbars and 64 px in details, with a
4-unit outline on its 64-unit viewBox. Layout Parasitics depicts two plated
pad rings joined by parallel traces, with one trace in signal green.

## Page and categories

The navigation rail's Plugins action opens search, refresh, details and these
categories without changing the conversation Agent or mounted project state:

| Category            | Entries                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Marketplace         | Local allowlisted workbench catalog, including uninstalled entries                              |
| OpenPE              | Installed workbench features and provider plugins with a successful OpenPE installation receipt |
| Codex / Claude Code | Installed provider plugins without a matching receipt                                           |
| Unknown origin      | Entries whose installation records could not be read                                            |

All plugins combines installed entries. Provider lists load independently;
failures retain successful categories and native controls. Rows are keyed by
provider, qualified plugin ID and scope.
Enable/disable acts immediately; Uninstall requires confirmation. Keep confirmed
rows and empty states during refresh/mutations, with per-provider loading and
actionable errors. Catalog warnings use Refresh's accessible description.

Use the Blocks icon after Open project in the rail. The Plugins sidebar is
228 px wide and narrows to 200 px in compact windows. Show counts beside
category names. Preserve projects, drafts, conversations and the Home brief
through navigation. Keep provider choice in the category list.

Group the main list by origin, with a shared search field, quiet category
dividers and softly bordered rows. Each row shows a 44 px mark, name and
short description. Installed rows expose a detail action and a separate
enabled switch where the provider confirms the state. Details show
publisher, version, source, origin, scope and available actions. Marketplace
actions use transparent resting surfaces. Detail and uninstall confirmation
footers use icon-only actions with accessible names and hover titles.
Successful changes update silently. Use the relevant category or action for
loading, warnings and recoverable errors.

## Analysis docks and footers

SPICE settings, Layout Thermal and Layout Parasitics keep their headers and
footers fixed around a scrolling settings body. Layout dock replacement,
resizing and sidebar restoration follow the
[editor dock contract](../DESIGN.md#analysis-dock).

Use Properties surfaces, 10 px exposed corners and 8/12 px body insets for
SPICE and Thermal. Settings rows have 4 px gaps and 64% value columns with a
112 px minimum. Action footers have a surface background, soft top divider,
2/12 px insets and a shared 35 px minimum height that grows with interface
text. Align their resting top and bottom edges with the drawing status bar.
Wrapping feedback can expand the footer.

Footer actions use 14 px icons in square targets matching the adjacent Grid
button's height at each text size. Keep resting backgrounds transparent and
retain hover and keyboard-focus feedback, accessible action names and hover
titles. Use Play for Run, Square for Stop, a circular arrow for Reset and a
ruler for Measure. Measure shows a spinner while pending. The Parasitics
footer keeps its live picking status to the left of Reset and Measure. Its
canvas interaction follows [Layout Parasitics](../DESIGN.md#layout-parasitics).

## Shared capability interface

Human controls and scoped Codex/Claude tools use the same per-project host.
DeepSeek/Pi use context/proposals. Cursor uses the service-hosted SDK with the same scoped tools as Codex/Claude.

| Capability                           | Contract                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `workbench.plugins.list` / `.change` | Read confirmed bundled catalog; change a fixed allowlisted ID using install/uninstall/enable/disable     |
| `provider.plugins.list` / `.change`  | Read one provider's installed entries; mutate an explicit qualified ID after service policy/scope checks |
| `pcbDesign.guide`                    | Read a fixed, verified workflow/reference when enabled                                                   |
| `parasitics.measure`                | [Two-terminal PCB DC resistance, route length and partial inductance](LAYOUT.md#layout-parasitics)     |
| `simulation.*`                       | [SPICE settings, runs, probes and waveforms](SIMULATION.md#shared-simulation-capabilities)               |
| `thermal.*`                          | [Layout Thermal settings, runs, probes and images](THERMAL.md#interface)                                 |

Discover exact schemas and live availability with `capabilities.list`. Review
queues immutable arguments. Apply/Auto use the same validation and recheck
the current targets and gates. Service-owned CLI and lifecycle checks apply
to every request. Confirmed changes publish `workbench.plugins.changed` or
`provider.plugins.changed`; refresh reconciles uncertain outcomes. Closing a
project aborts its owned work but cannot undo completed external writes. See
[Core](CORE.md) for review, event budgets and cancellation.

## Bundled workbench lifecycle

Bundled plugins start installed and enabled. Install activates packaged
resources without downloading code or running provider CLIs. Uninstalled
entries remain in Marketplace.

`server/workbench-plugin-catalog.json` fixes the catalog.
In `dev:web`, all four bundled plugins start installed and enabled. The
development host keeps Marketplace changes in process memory and resets them
on restart. Layout Parasitics uses the renderer, PE Layout Skill serves bundled
guidance, and the solver plugins use the bundled runtimes. SPICE and manual
thermal runs keep results in the current renderer session. Codex and Claude
Code plugin management uses the same provider adapters and OpenPE receipts as
desktop. Native project result operations require the desktop host.

`server/workbench-plugins.mjs` atomically persists flags in
`workbench-plugins-v1.json`, separate from projects, recovery and provider
receipts. Saved state must include each of the four current catalog entries
exactly once with explicit installation and enabled flags. Missing files
initialize the bundled defaults. Partial, obsolete or malformed files are
preserved and fail closed.

| Action              | Effect                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Install / Enable    | Makes an installed packaged feature available                                                                               |
| Disable / Uninstall | Removes its action/resident registrations, releases UI/probes and cancels owned work; Uninstall also clears installed state |

Uninstall retains native documents, model/footprint files, completed analysis
records, verified caches and bundled runtimes. Component simulation attributes
remain native design data editable through Source; the Schematic SPICE Simulation
action, Properties parameter section and settings-dock participation switches require the plugin to be installed
and enabled. Shared component Properties exposes parameters in Schematic, Layout
and Model; the action and participation switches remain Schematic-only. All solver/detection/model/result routes independently check
service-owned lifecycle state; stale responses cannot restore disabled UI.
SPICE and Layout Thermal cancellation remain independent. Their run/restore and panel
retention rules belong in [Simulation](SIMULATION.md) and [Layout Thermal](THERMAL.md).
Disabling or uninstalling Layout Parasitics removes its Layout action, closes
its dock and makes its query unavailable. See the
[measurement scope](LAYOUT.md#layout-parasitics).

### PE Layout Skill

The [power-pcb-design workflow](https://github.com/ChengminLi/AI-PCB-layout), by
Chengmin Li and Xiao Yang, is bundled unchanged at
`e1b9a64ac9ac306647fa30094932fb792d17e373` under CC BY 4.0.
`server/pcb-design/manifest.json` pins it and ten references with SHA-256 hashes.
Packaged notices appear in About OpenPE; runtime performs no download or global
Agent configuration change.

The enabled plugin's details offer an icon-only Read workflow action. It opens
the verified workflow in a read-only dialog through the shared guidance path.

Enabled Codex/Claude turns receive service-owned instructions to read
`pcbDesign.guide` and relevant references. DeepSeek/Pi receive the workflow as
context only. The service overrides renderer-supplied instructions and rejects unknown IDs,
extra keys and paths/URLs; each document is verified and limited to 64 KiB.
Missing/corrupt resources require repair. Disable/uninstall revokes reads and
cancels turns carrying this guidance; conversation history remains data.

The workflow's engineering review gates are independent of Review/Auto and may
be waived only by explicit user instruction. Reports stay in the conversation.
Edits use advertised commands and existing Source/revision/undo gates. Guidance
adds no autorouter, arbitrary scripts, format support, standards database,
parasitic extraction, fabrication exporter or certification. OpenPE's KiCad 10
contract governs upstream tool examples; unsupported checks remain missing
evidence.

## Provider discovery and management

Actions follow discovered CLI support rather than package presence:

| Provider    | Discovery                                                                      | Mutation                                                    |
| ----------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Codex       | `plugin marketplace list --json`, then `plugin list --marketplace NAME --json` | Supported add/remove; narrow app-server enable/disable RPC  |
| Claude Code | `plugin list --json`                                                           | Supported install/uninstall/enable/disable, user scope only |

Codex source failures retain successful results with a partial-list warning.
OpenPE does not query online recommendations. UI mutations target installed
entries; the installation API accepts explicit `plugin@marketplace` identities.
Provider-managed/non-user-scope entries stay managed by their provider.

Codex switches write only `plugins."ID".enabled` through `config/value/write`,
rechecking policy and effective state. Renderer-selected keys/paths are rejected.
OpenPE never reads other tools' credential files, edits provider configuration
files directly, or approves interactive CLI requests. A Cursor API key is the
documented exception: Settings stores it through Electron `safeStorage` as
`cursor-credential.bin` in the OpenPE data directory, and the service alone
passes it to `@cursor/sdk`. POSIX creation uses mode 0600. On Windows the file
remains in the per-user OpenPE data directory under `%APPDATA%`, which inherits
that profile's user-only ACL; OpenPE does not call `icacls`. Windows ACL
inheritance is unverified. A failed rename surfaces a non-ENOENT error from
removing the temporary file. Cancellation cannot reverse completed CLI
writes. Installed state proves neither authentication nor restricted-thread
compatibility. Provider plugins do not add tools or permissions to OpenPE's
catalog: Codex receives its dynamic tools, and Claude and Cursor use the
application-owned stdio MCP bridge, with unrelated shell/web/tool access restricted.

## Receipts, caches and restart boundaries

`plugin-installations-v1.json` records successful installs by provider,
qualified ID and user scope. Removal deletes the receipt. Failed/cancelled
commands create none; persistence failure after CLI success is explicit.
Transactions serialize across providers and persist atomically. Receipts
identify origin, not authoritative installed state: only listed entries can
match them. Preserve corrupt records and show Unknown origin.

Provider caches last five minutes. Visits reuse them; Refresh and mutations
invalidate them, including uncertain outcomes, while retaining confirmed rows.
Responses require the current `controlsVersion`; unversioned and unsupported
protocols cannot enable controls or enter the reusable provider cache.
Renderer refresh does not reload Electron/service modules; preserve unsaved
work before restarting.

## Service boundaries

Authenticated loopback plugin routes reject arbitrary paths, commands,
executables, URLs and catalog selectors. `/api/plugins` reads provider plus
optional `refresh=true`; writes accept provider, fixed action and qualified ID.
`/api/workbench-plugins` accepts only fixed catalog IDs/actions.

Provider processes use argument arrays, closed stdin, 4 MB combined output and a
60-second deadline; Codex switch RPCs use 15 seconds. One operation runs per
provider; receipt transactions serialize across providers. These limits do not
apply to ngspice runtime.

Codex/Claude model discovery allows 300 ms for owned child EOF exit; completed
Codex/Claude turns allow 500 ms. Their Windows cleanup starts at most one
process-tree helper with a one-second deadline, then falls back to the captured
child process if still open. POSIX cleanup spawns the child as a process-group
leader and signals that group with `kill(-pid)`; `ESRCH` means the process has
already exited. An exited child cannot start a new PID-based helper.

Display metadata comes only from real-path-contained CLI package roots:
manifests up to 128 KB and icons up to 32 KB. Paths and executable/MCP
configuration are not exposed. SVG icons reject active/external content and
render as images.

## Verification

| Check                                                                            | Scope                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tests/workbench-plugins.test.ts`, `tests/workbench-plugin-capabilities.test.ts` | Persistence, shared lifecycle, service cancellation and Layout Parasitics query gates |
| `tests/pcb-design-plugin.test.ts`                                                | Bundled hashes, trusted instructions, incomplete catalogs and turn cancellation    |
| `tests/plugins.test.ts`                                                          | Installed lists, receipts, provider/scope/policy isolation, bounds and concurrency |
| `tests/browser-previews.test.ts`, `tests/browser-previews-bridge.test.ts`           | Browser authentication, fixed plugin endpoints and desktop-only project grants     |
| `node scripts/check-thermal-workbench-ui.mjs --parasitics-dock`                  | Endpoints, measurement, fixed footer status, reset and dock switching             |
| `tests/chat.test.ts`, `tests/agent-cursor.test.ts`, `tests/cursor-credential.test.ts` | Model discovery, Cursor SDK isolation, credential ciphertext, and cancellation |
| `tests/capabilities.test.ts`, `tests/agent-capabilities.test.ts`                 | Schemas, review/revisions, cancellation and synthetic scoped transports            |
| `node scripts/check-plugins-ui.mjs`, `node scripts/check-agent-tools-ui.mjs`, `node scripts/check-agent-effort-ui.mjs` | Isolated mocked lists, controls, Agent commands, model-specific effort selection and Cursor catalog parameters |
| `node scripts/e2e-plugins.mjs`                                                   | Opt-in desktop checks with fixtures; no real installs                              |

Mock tests do not establish installed-provider compatibility or authentication.
Documentation changes need static checks; real provider mutations and desktop
checks follow [AGENTS.md](../AGENTS.md).
