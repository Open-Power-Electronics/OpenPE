# Plugins and Marketplace

OpenPE manages bundled workbench features and installed Codex/Claude Code
plugins through separate bounded adapters. The capability registry is not a
runtime extension loader or online catalog. [API.md](API.md) defines schemas,
[CORE.md](CORE.md) defines shared execution/review, and
[DESIGN.md](../DESIGN.md) defines presentation.

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
failures retain successful categories and native controls. Identity includes
kind/provider, preventing colliding package IDs from targeting another install.
Enable/disable acts immediately; Uninstall requires confirmation. Keep confirmed
rows and empty states during refresh/mutations, with per-provider loading and
actionable errors. Catalog warnings use Refresh's accessible description.

## Shared capability interface

Human controls and scoped Codex/Claude tools use the same per-project host.
DeepSeek/Pi use context/proposals; Cursor supports detection only.

| Capability                           | Contract                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `workbench.plugins.list` / `.change` | Read confirmed bundled catalog; change a fixed allowlisted ID using install/uninstall/enable/disable     |
| `provider.plugins.list` / `.change`  | Read one provider's installed entries; mutate an explicit qualified ID after service policy/scope checks |
| `pcbDesign.guide`                    | Read a fixed, verified workflow/reference when enabled                                                   |
| `simulation.*`                       | [SPICE settings, runs, probes and waveforms](SIMULATION.md#shared-simulation-capabilities)               |
| `thermal.*`                          | [Thermal settings, runs, probes and images](THERMAL.md#interface)                                        |

Discover exact schemas and live availability with `capabilities.list`. Review
queues immutable commands; Apply/Auto use the same validation and captured
revision. Project revision checks do not replace service-owned CLI/lifecycle
checks. Confirmed changes publish `workbench.plugins.changed` or
`provider.plugins.changed`; refresh reconciles uncertain outcomes. Closing a
project aborts its owned work but cannot undo completed external writes. See
[Core](CORE.md) for review, event budgets and cancellation.

## Bundled workbench lifecycle

SPICE Simulation (`spice-simulation@openpe`), Thermal FEM
(`pcb-thermal@openpe`) and PE Layout Skill (`ai-pcb-layout@openpe`) are
preinstalled/enabled. Install activates packaged resources without downloading
code or running provider CLIs; uninstalled entries remain in Marketplace.

`server/workbench-plugin-catalog.json` fixes the catalog.
`server/workbench-plugins.mjs` atomically persists flags in
`workbench-plugins-v1.json`, separate from projects, recovery and provider
receipts. Saved state must include each current catalog entry exactly once with
explicit installation and enabled flags. Missing files initialize the bundled
defaults; partial, obsolete or malformed files are preserved and fail closed.

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
SPICE and Thermal cancellation remain independent. Their run/restore and panel
retention rules belong in [Simulation](SIMULATION.md) and [Thermal](THERMAL.md).

### PE Layout Skill

The [power-pcb-design workflow](https://github.com/ChengminLi/AI-PCB-layout), by
Chengmin Li and Xiao Yang, is bundled unchanged at
`e1b9a64ac9ac306647fa30094932fb792d17e373` under CC BY 4.0.
`server/pcb-design/manifest.json` pins it and ten references with SHA-256 hashes.
Packaged notices appear in About OpenPE; runtime performs no download or global
Agent configuration change.

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
OpenPE never reads credentials, edits provider configuration files directly or
approves interactive CLI requests. Cancellation cannot reverse completed CLI
writes. Installed state proves neither authentication nor restricted-thread
compatibility. Provider plugins do not add tools or permissions to OpenPE's
catalog: Codex receives its dynamic tools and Claude the application-owned stdio
MCP bridge, with unrelated shell/web/tool access restricted.

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

Codex model discovery allows 300 ms for owned app-server EOF exit; completed
Codex/Claude turns allow 500 ms. Their Windows cleanup starts at most one
process-tree helper with a one-second deadline, then falls back to the captured
child process if still open. An exited child cannot start a new PID-based helper.

Display metadata comes only from real-path-contained CLI package roots:
manifests up to 128 KB and icons up to 32 KB. Paths and executable/MCP
configuration are not exposed. SVG icons reject active/external content and
render as images.

## Verification

| Check                                                                            | Scope                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tests/workbench-plugins.test.ts`, `tests/workbench-plugin-capabilities.test.ts` | Persistence, corrupt state, shared lifecycle and service cancellation              |
| `tests/pcb-design-plugin.test.ts`                                                | Bundled hashes, trusted instructions, corruption and turn cancellation             |
| `tests/plugins.test.ts`                                                          | Installed lists, receipts, provider/scope/policy isolation, bounds and concurrency |
| `tests/chat.test.ts`                                                             | Model discovery, cancellation and owned child cleanup, including Windows fallback  |
| `tests/capabilities.test.ts`, `tests/agent-capabilities.test.ts`                 | Schemas, review/revisions, cancellation and synthetic scoped transports            |
| `node scripts/check-plugins-ui.mjs`, `node scripts/check-agent-tools-ui.mjs`     | Isolated mocked lists, controls and Agent commands                                 |
| `node scripts/e2e-plugins.mjs`                                                   | Opt-in desktop checks with fixtures; no real installs                              |

Mock tests do not establish installed-provider compatibility or authentication.
Documentation changes need static checks; real provider mutations and desktop
checks follow [AGENTS.md](../AGENTS.md).
