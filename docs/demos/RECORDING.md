# OpenPE demonstration recording

These rules apply to recorded feature demonstrations. Product behaviour remains
owned by the [engineering contract](../../AGENTS.md), [Design](../../DESIGN.md),
[native-file contract](../FORMAT.md), [Agent contract](../CORE.md#agent-transport-and-review)
and [simulation contract](../SIMULATION.md).

## Authenticity and capture

- Obtain an explicit request before launching a desktop demonstration, a real
  provider or a real solver. The recording request must cover the demonstrated work.
- Use a separate `OPENPE_DATA_DIR` and a new output directory for each take.
  Preserve the user's running application and unsaved projects.
- Open the original example, show its initial state, then use native **Save as**
  to create a demonstration copy before changing it. Retain source checksums.
- Capture continuously from application opening through the final inspection.
  Keep provider latency, solver waits, failed attempts, corrections and retries.
  Do not cut, speed up, remove waits or concatenate takes. Save unsuccessful
  takes with their actual outcome.
- State the capture boundary: the LM25017 recorder saves the OpenPE renderer at
  **1600 × 1000, 25 fps, WebM**. It records neither native operating-system
  dialogs nor other windows nor audio. It is not a full-desktop capture.
- Keep all submitted prompts and Agent replies in English. Use the real selected
  provider and actual OpenPE capabilities. Do not insert replies, mocked solver
  results or substitute waveform images. Preserve the transcript and prompts.
- Split long design work into observable turns: deletion/research, construction,
  preflight, first run and measured iteration. If a provider turn stops, retain
  its output and continue from the accepted design with a focused prompt.
  Keep the interruption in the continuous recording.
- Automation may select an approved Save as destination and operate application
  controls. Record that automation in the script/report. Do not represent an
  automated picker response as a recorded human interaction.
- Keep the selected controller and connector identities when the scenario calls
  for them. Show the requested deletion before rebuilding. Replacements use fresh
  identities and ordinary validated edits. Do not restore the old circuit to
  simulate a redesign.
- For construction and redraw demonstrations, follow the
  [schematic drafting contract](../../DESIGN.md#schematic-canvas). Rehearse the
  supported workflow on a separate disposable copy before starting a new take;
  keep that rehearsal distinct from the continuously recorded redesign. Inspect
  the actual native rendering and electrical pin groups before simulation. A
  collection of labelled pin stubs or a successful solver run does not establish
  a readable drawing. Preserve accepted drawings during value-only tuning.

## Evidence and handoff

Save the runnable recorder, scenario runbook, full video, chapter timestamps,
transcript, exact prompts, screenshots and outcome report. Keep native design
files and supporting resources separate from recording evidence. Preserve each
completed solver run before a later run replaces the destination's current result.
Do not create a private JSON design or edit pinned example/model bytes.

The outcome report must distinguish intended steps from observed completion and
include the saved design destination, capture settings, source checksums, actual
provider/solver outcomes, measurement windows and any errors. A script or a
completed video alone does not prove that the design goal was achieved. Identify
an interrupted take explicitly; never populate unmeasured values as results.

Before delivery, finalize the video, verify that it decodes and inspect its start,
deletion checkpoint, reconstruction, both simulation stages and ending. Check
duration against chapter times and verify the original files remain unchanged.
Keep the complete recording; any future edited version must be a separate file
and requires a separate request.

## Recorder control

The [LM25017 recorder](../../scripts/record-lm25017-8v.mjs) is explicitly opt-in:

```powershell
node scripts/record-lm25017-8v.mjs --record --control --output=test-results/demos/lm25017-8v-20261107
```

Use a fresh output path when repeating a take. `--control` executes saved,
numbered `control/*.mjs` modules in lexical order. Each exports an async default
function receiving `demo`; each receives a sibling `.result.json` record. These
are local recorder instructions, outside the application's Agent boundary.
Inspect their source before replaying; they can operate a real desktop/provider
and solver. A failed step stays in the continuous take and its result file.

Available helpers are `demo.send(stage, prompt)`, `demo.status()`,
`demo.checkpoint(name)`, `demo.mark(stage, detail)` and `demo.finish(outcome)`.
Wait for an actual provider completion and inspect the result before dependent
steps. Finish controlled takes through `demo.finish` so the report, original-file
check and video finalization run. Without `--control`, the recorder leaves the
window available for manual operation and saves the video after it closes; its
manual path does not produce the controlled completion report automatically.

See the [LM25017 8 V runbook](lm25017-8v.md) for the first scenario.
