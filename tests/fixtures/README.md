# Regression fixtures

The native projects under [examples/](../../examples/) are OpenPE's sole maintained
example collection. Tests use those projects, their generated snapshots and small
programmatic fixtures. Test inputs do not establish general import/model support,
complete KiCad ERC/DRC parity or production qualification.

| Location | Purpose and source | Generation and checks |
| --- | --- | --- |
| `reference/` | Derived private snapshots of the nine native Home reference projects | `npm run examples`; reference fidelity, assets, native portability and simulation checks |
| `lib/project-example.ts` | Small programmatic RC project for document/PCB format tests; no separate native example files | Imported by unit tests; `scripts/format-test-project.mjs` exposes serialized fixtures to isolated browser checks |
| `switching-stage.ts` | Programmatic ideal high-side Buck for bounded compiler, timing and heat tests | SPICE unit checks and explicitly opted-in native solver checks |
| `model-parameters.ts` | Parameterized copies of the current LM2598 Home project for field editing and presentation tests | Unit tests and isolated browser checks; no independent example catalog |
| `annotation.ts` | Test-only Agent annotation builder | Annotation and capability checks |
| `pcb-point-queries.ts` | Exhaustive PCB point-selection oracle and interleaved EMC Flyback point shards | PCB point-index tests; reads the generated EMC snapshot without changing it |
| `agent-cli.mjs`, `plugin-cli.mjs`, `plugin-toggle.mjs` | Mock CLI processes for provider, plugin and cancellation tests | Isolated synthetic processes, not real provider verification |
| `agent-capability-cli.mjs`, `agent-capability-claude-cli.mjs` | Codex dynamic-tool and Claude scoped-MCP protocol mocks | Scoped query/execute/observe transport tests |
| `agent-pi-cli.mjs`, `agent-acp-cli.mjs` | Synthetic Pi RPC and DeepSeek ACP processes | Bounded context, proposals, model metadata and cancellation tests |

Private snapshots are test/build artifacts, not public design files. Canonical
Home designs remain native KiCad file sets under `examples/`. Their pinned
source evidence, models, notices and licenses remain with the owning catalog
resources. Regenerate snapshots with `npm run examples` rather than editing them.

Fixtures use ordinary [Core](../../docs/CORE.md) validation, whole-project undo,
Source gates and current document schemas. Runtime revisions, grants and reviews
stay outside fixture data. [Format](../../docs/FORMAT.md) owns native preservation.

## Verification

Use `npm test -- <test paths>` for focused checks; full tests cover Core,
capabilities, native files, recovery, providers and the ten Home projects.
Prepare portable Home models with `npm run simulation:download-examples`
before the explicitly requested offline `npm run simulation:check-examples` sweep.
Preparation may download pinned resources; the sweep itself never fetches them.
Real providers, native solvers and desktop checks have separate opt-in evidence.
See [AGENTS.md](../../AGENTS.md#verification-and-delivery) for required checks.
