# Local project version history

OpenPE stores complete validated snapshots in private bare Git repositories.
Install Git separately and restart the app if needed. Versions are local and
independent of native Save, recovery, conversations, dirty state and Core's
in-memory undo. [FORMAT.md](FORMAT.md) defines snapshot content;
[CORE.md](CORE.md) defines shared transactions.

## Creating, comparing and restoring versions

Click Git immediately to the right of List in the editor toolbar to open the history window while retaining the current editor mode:

1. Establish a native destination with Save; Home examples already have
   one and an initial version.
2. Enter a message above Changes, then click Commit or press Ctrl+Enter in
   the field to create a version of the complete validated project. Unsaved validated
   changes may be included; creation does not write native files or clear dirty
   state. An identical latest snapshot is a no-op error.
3. Select Worktree on the left to compare the latest version with the current
   validated project. Selecting a version compares the next older version
   with it, or itself for the initial version. Compare from can choose
   any loaded version or Worktree. The four comparison controls use the editor's
   Schematic, Layout, Model and Source icons and retain the same revision pair.
   Schematic opens by default with synchronized read-only pan/zoom/Fit, green
   additions, red removals and yellow changes; missing sheets are explicit. Initial Fit measures visible drawings
   after the window opens, including unchanged versions. Reopening the same
   comparison retains its camera; sheets changed while hidden fit when revealed.
   Stable IDs identify schematic additions/removals, values and order changes.
   The upper-left Changes list compares complete current native exports by filename
   and bytes/encoding, with A/M/D status; private snapshot fields are not file rows.
   Worktree and the linear local version timeline appear below. Layout shows
   Before/After PCB artwork with synchronized pan/zoom/Fit, using saved packages,
   tracks, vias and copper fills without refilling or analysing connectivity.
   Model shows each snapshot's board, assigned component models and Model CAD
   in equal Before/After panes with independent orbit/zoom/Fit. Model previews
   expose no design tools or editable properties; resource failures remain visible
   and retryable. Missing PCBs are explicit in both modes. Selecting a changed
   file switches to Source, showing read-only Before/After native text with line
   numbers and change-region highlighting. Graphical previews load on first use;
   mode switches and closing/reopening retain their cameras.
4. Restore validates the complete snapshot and commits one undo edit, retaining
   destination, save baseline and conversations. Save explicitly to write it.

Opening Git uses the shared Source validation/apply gate; invalid drafts remain
in Source. Pending Source blocks creation/restore. Reads accept only current-format
validated snapshots. Browsing/creation never changes dirty state; restore uses
normal baseline comparison. Version lists page by 50. Native file lists include
all changed filenames in the validated file sets. Text panes show excerpts around
the first changed region, capped at 12,000 characters and 160 lines per side, with
explicit notices. Binary files show a read-only byte count. Restoration always
uses the full snapshot.

File comparisons use complete native exports. File-list order and private PCB
net UUIDs are not file changes when native bytes remain identical. Electrical
names/connectivity, copper order/geometry, supporting bytes and encodings remain
significant. Graphical schematic differences use stable schematic object IDs.
Panel styling belongs in
[DESIGN.md](../DESIGN.md).

## Shared history capabilities

| Capability                        | Contract                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `versions.list` / `versions.read` | Bounded listing or reachable validated snapshot at the project's granted destination |
| `versions.create`                 | Snapshot current validated Core Source through the native bridge                     |
| `versions.restore`                | Read a reachable version, prepare exact CAD geometry and commit one undo edit        |
| `project.replace`                 | Replace complete canonical Source in one Core transaction                            |
| `history.undo` / `history.redo`   | Shared in-memory history                                                             |
| `project.save`                    | Native Save/Save as                                                                  |

The Git window and Agent use the same version operations. Restore reads the
selected ID again from the live destination and rechecks origin and revision
before committing. Revision, review, Source and close gates follow
[Core](CORE.md). Tools operate through the originating project's grant.

## Destinations, grants and storage

Personal repositories live under `OpenPE/project-history-v1`, keyed by SHA-256
of the normalized native destination. `OPENPE_DATA_DIR` selects application data.
Reopening a destination reconnects history; Save as associates an independent
repository. History does not travel in KiCad files.

Home examples also use destination-keyed private history. Show in File Explorer
reveals the actual project folder. Closing preserves its private history.

Electron resolves opaque live grants. Main-frame replacement clears them;
closing releases only the owning project's grant. Reopening an open destination
selects its editor; saving cannot overwrite another open project's source.
Recovery stores no host destinations, grants or history records. Only clean current
examples reconnect their original catalog destinations; dirty ones keep
source/drafts/sessions without a destination. Retired or unknown example
identities fail validation. Recovery replacement waits for cancellation
to release grants, and malformed recovery is preserved; see
[Architecture](ARCHITECTURE.md).

Save, File Export, Model STEP export and version creation/restoration share one
operation lock per project. An in-flight operation blocks close. Accepted close
suspends commands and Core edits before recovery and grant cleanup. Failure
resumes the same drafts and undo history. The private Git repository persists.

## Original example opening

The [example directory contract](EXAMPLES.md#original-project-directories-and-portable-assets)
defines native roots, catalog identities and opening. The private initial version
uses the current native files when opened or cleanly recovered. Save as starts
independent history at the personal destination.

### Opening barrier and concurrency

Service/window creation and Home loading perform no runtime example preflight.
One shared promise starts on the first example-opening IPC, including clean
recovery. Home, new projects and ordinary recovery do not wait. The example-opening
IPC awaits validation and private-history attempts for the bundled and discovered
projects and rechecks its originating frame. Unrelated preparation failures do not block a usable selected
project; missing Git remains a warning on that project's open result.

Preparation uses at most three concurrent operations.
[Build preparation](ARCHITECTURE.md#native-saving-and-example-preparation)
verifies the original native sets and pinned assets. Runtime opening validates
actual disk files and initializes private history without writing the example
directory. Same-example concurrent opens share their operation/grant; later
attempts reread and revalidate disk, and failures remain retryable. Recovery
errors remain visible independently of example preparation.

### Initial versions

A pristine example has one private automatic `init` with its validated
snapshot. After validating the current snapshot, opening checks that the
repository has only the main ref and that it points to an application-authored
root commit with the `init` subject. It then checks the stored tree. A changed
snapshot replaces that seed with a parentless current seed and prunes the
superseded automatic objects. Multi-commit histories, other refs and other
subjects are preserved.

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

| Check                                                                                                                                    | Scope                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tests/project-history.test.ts`                                                                                                          | Real Git in temporary repositories: bounds, reachability, persistence, comparison and grants           |
| `tests/example-projects.test.ts`                                                                                                         | Original native bytes/filenames, directory grants, private seeds and bounded opening/retry             |
| `tests/project-core.test.ts`, `tests/core-integration.test.ts`                                                                           | Shared undo/revision/Source/close gates                                                                |
| `node scripts/check-project-history-ui.mjs`, `node scripts/check-example-refresh-ui.mjs`                                                 | Mocked isolated history/recovery UI                                                                    |
| `node scripts/check-schematic-comparison-ui.mjs`                                                                                         | Native LM5001/TPS61046 comparisons: visible initial Fit, themes, retained camera and hidden changes    |
| `node scripts/check-history-previews-ui.mjs`                                                                                             | Four comparison modes, native PCB/CAD snapshots, read-only navigation, retained state and missing PCBs |
| `node scripts/benchmark-startup.mjs [samples]`                                                                                           | 1–5 separate Node samples (default 3), prepared assets and real Git; no first-paint measurement        |
| `node scripts/check-desktop-startup.mjs`, `node scripts/benchmark-desktop-startup.mjs [samples] [label]`, `node scripts/e2e-history.mjs` | Opt-in isolated Electron startup/history                                                               |

Documentation changes need static checks only. Desktop runs require explicit
authorization; [AGENTS.md](../AGENTS.md) defines verification boundaries.
