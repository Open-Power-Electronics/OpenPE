# Local project version history

OpenPE stores complete validated snapshots in private bare Git repositories.
Install Git separately and restart the app if needed. Versions are local and
independent of native Save, recovery, conversations, dirty state and Core's
in-memory undo. [FORMAT.md](FORMAT.md) defines snapshot content;
[CORE.md](CORE.md) defines shared transactions.

## Creating, comparing and restoring versions

Open Version history from an editor toolbar:

1. Establish a native destination with Save; Home examples already have
   one and an initial version.
2. Name and create a version of the complete validated project. Unsaved validated
   changes may be included; creation does not write native files or clear dirty
   state. An identical latest snapshot is a no-op error.
3. Compare a version with Current project or another version. Stable IDs identify
   additions/removals, values and order changes. Compare schematics provides
   synchronized read-only pan/zoom/Fit with green additions, red removals and
   amber changes; missing sheets are explicit. Structured differences also cover
   PCB/settings/files. Comparison never applies Source or analyses connectivity.
4. Restore validates the complete snapshot and commits one undo edit, retaining
   destination, save baseline and conversations. Save explicitly to write it.

Pending Source blocks creation/restore. Reads accept only current-format
validated snapshots. Browsing/creation never changes dirty state; restore uses
normal baseline comparison. Lists page by 50; previews cap at 300 changed paths
and 12,000 characters per value with truncation notices. Restoration always uses
the full snapshot.

Native-backed comparisons order retained files by filename and match PCB nets
by unique native name, avoiding differences from file-list order or regenerated
private net UUIDs. Actual names/connectivity, copper order/geometry, supporting
bytes/encodings and extensions remain significant. Panel styling belongs in
[DESIGN.md](../DESIGN.md).

## Shared history capabilities

| Capability                        | Contract                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `versions.list` / `versions.read` | Bounded listing or reachable validated snapshot at the project's granted destination |
| `versions.create`                 | Snapshot current validated Core Source through the native bridge                     |
| `project.replace`                 | Replace complete canonical Source in one Core transaction                            |
| `history.undo` / `history.redo`   | Shared in-memory history                                                             |
| `project.save`                    | Native Save/Save as                                                                  |

The panel uses shared reads/creation, then Core's internal validated restore
adapter. Agents restore by reading and executing `project.replace`; no separate
restore/comparison capability exists. Revision/review/Source/close gates follow
[Core](CORE.md); transient capability events are not Git versions. Tools cannot
choose repository paths or another project's grant.

## Destinations, grants and storage

Personal repositories live under `OpenPE/project-history-v1`, keyed by SHA-256
of the normalized native destination. `OPENPE_DATA_DIR` selects application data.
Reopening a destination reconnects history; Save as associates an independent
repository. History does not travel in KiCad files.

Home examples open their original `examples/<file>/<file>.kicad_pro` files.
They use the same destination-keyed private history as other projects; no Git
repository is added to the example directory. Show in File Explorer reveals
the actual project folder. Closing never deletes its private history.

Electron resolves opaque live grants. Main-frame replacement clears them;
closing releases only the owning project's grant. Reopening an open destination
selects its editor; saving cannot overwrite another open project's source.
Recovery stores no host destinations, grants or history records. Only clean current
examples reconnect their original catalog destinations; dirty ones keep
source/drafts/sessions without a destination. Retired or unknown example
identities fail validation. Recovery replacement waits for cancellation
to release grants, and malformed recovery is preserved; see
[Architecture](ARCHITECTURE.md).

Save/export/version creation blocks close. Accepted close suspends commands and
Core edits before recovery/grant cleanup. Failure resumes the same drafts/undo;
no persistent Git repository is removed.

## Original example opening

`resources/example-catalog/home-manifest.json` defines ten fixed projects: nine
curated projects under Example and EMC Flyback under Recent during Preview.
Stable catalog IDs reconnect the original `examples/<stem>/<stem>.kicad_pro`
files, or their packaged `examples-native/<stem>/` directory. Opening and clean
recovery read the current native bytes. Save writes that destination; Save as
creates a personal copy with independent history. Ordinary Source disk files,
including SCAD and datasheet JSON/PDFs, remain outside native version snapshots.

### Opening barrier and concurrency

Service/window creation and Home loading perform no runtime example preflight.
One shared promise starts on the first example-opening IPC, including clean
recovery. Home, new projects and ordinary recovery do not wait. The example-opening
IPC awaits validation and private-history attempts for all ten original projects and rechecks its
originating frame. Unrelated preparation failures do not block a usable selected
project; missing Git remains a warning on that project's open result.

Preparation uses at most three concurrent operations.
[Build preparation](ARCHITECTURE.md#native-saving-and-example-preparation)
verifies the original native sets and pinned assets. Runtime opening validates
actual disk files and initializes private history without writing the example
directory. Same-example concurrent opens share their operation/grant; later
attempts reread and revalidate disk, and failures remain retryable. Recovery
errors remain visible independently of example preparation.

### Initial versions

A pristine example has one private `init` with its validated snapshot. When
reopening changed native files, only a pristine automatic seed may be replaced
with a parentless current seed; superseded automatic objects are removed.
Explicit versions survive. This updates private Git only. Resetting a
multi-commit repository requires explicit user authorization; no renderer API
exposes it.

Unchanged seeds verify their sole ref, root commit and application author in one
bounded Git query, then read the stored snapshot tree in a second. Changed or
personal histories retain the full refresh checks; the shortcut never skips
current snapshot validation or stored-tree verification.

## Git execution boundary

`server/project-history.mjs` writes `refs/heads/main` as
`OpenPE <local@openpe.invalid>`; this application identity also recognizes
application-authored seeds. There is no remote, branch/merge or deletion UI.

Git uses argument arrays, bounded stdin/output, isolated configuration, disabled
hooks/signing/credential prompts and no inherited Git overrides. The bridge
accepts an opaque grant, up to 8 MB of JSON, a one-line name up to 240 characters,
a full commit ID or bounded offset. Operations time out after 15 seconds and
reject same-repository concurrency. Compare-and-swap advances main only after a
complete snapshot write; reads must be reachable from main and validate now.
Shutdown terminates children. Missing Git/history never invalidates native files.

## Verification

| Check                                                                                                                                    | Scope                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `tests/project-history.test.ts`                                                                                                          | Real Git in temporary repositories: bounds, reachability, persistence, comparison and grants    |
| `tests/example-projects.test.ts`                                                                                                         | Original native bytes/filenames, directory grants, private seeds and bounded opening/retry      |
| `tests/project-core.test.ts`, `tests/core-integration.test.ts`                                                                           | Shared undo/revision/Source/close gates                                                         |
| `node scripts/check-project-history-ui.mjs`, `node scripts/check-example-refresh-ui.mjs`                                                 | Mocked isolated history/recovery UI                                                             |
| `node scripts/benchmark-startup.mjs [samples]`                                                                                           | 1–5 separate Node samples (default 3), prepared assets and real Git; no first-paint measurement |
| `node scripts/check-desktop-startup.mjs`, `node scripts/benchmark-desktop-startup.mjs [samples] [label]`, `node scripts/e2e-history.mjs` | Opt-in isolated Electron startup/history                                                        |

Documentation changes need static checks only. Desktop runs require explicit
authorization; [AGENTS.md](../AGENTS.md) defines verification boundaries.
