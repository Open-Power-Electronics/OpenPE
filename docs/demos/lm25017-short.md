# LM25017: two-turn component completion

Follow the [recording rules](RECORDING.md). This short component-design demonstration records continuous OpenPE application content, not the OS desktop.

## Setup and targets

Open the **Home LM25017 Fly-Buck example** and Save as into a fresh recording directory. Preserve the original native files and verify their hashes after capture. In this source, R5/R6 are the feedback divider and R4/C5/C6 form the ripple-injection network. Do not substitute an earlier redrawn circuit whose references have different meanings.

Use visible selection and Delete to remove **R4, R5, R6, C5 and C6**, their 14 branch wire segments and the unused R6 ground marker from the copy. Preserve shared rails. Save and show the cleared area. Retain the remaining circuit, model and winding mapping. After setup, the upstream operator only submits the two prompts and uses ordinary UI choices, Save, observation and Stop; it supplies no replacement values or direct design commands.

| Criterion       | Target and evidence                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Input/load      | 24 V nominal; 100 Ω on each output                                                                           |
| Primary         | 8 V ±1%, measured after settling                                                                             |
| Feedback ripple | Target 25–50 mVpp at FB, with a datasheet-based R4/C5/C6 design                                              |
| Output ripple   | Primary ripple below 100 mVpp; if reporting the isolated rail, measure VOUT2 − GND2                          |
| Simulation      | Request 5 ms instead of the full scenario's 10 ms; report actual timing and whether the final window settled |
| Drawing         | Readable continuous wires; inspect the actual redrawn schematic                                              |
| Budget          | Two English prompts, approximately five minutes; stop at 315 seconds plus finalization                       |

These are design targets, not previously measured results. Unsettled waveforms or missing full-resolution evidence cannot establish a passing measurement. Do not claim independently regulated 8 V on the secondary or physical assembly qualification from this model.

## Prompts and capture

Round 1:

> Complete R4/R5/R6/C5/C6 for 24 V in, 8 V primary ±1% at 100 Ω, output ripple <100 mVpp and FB ripple 25–50 mVpp. Use the datasheet, keep it readable, and verify with 5 ms SPICE.

Round 2, after the first turn finishes and only if time remains:

> Check the final values, output voltage and FB ripple. Adjust and rerun if needed, then save and summarize what passed.

Run the [short recorder](../../scripts/record-lm25017-short.mjs):

    node scripts/record-lm25017-short.mjs --record --output=test-results/demos/lm25017-short-home-take-01

It uses the shared [recorder](../../scripts/record-lm25017-8v.mjs). The native Save as picker response is automated and recorded as such. Deletion, Agent input and saving use application controls. Each take keeps prompts, transcript, timestamps, screenshots, native files, source hashes and an uncut WebM. Two finished turns alone do not establish electrical success. If the budget expires, retain the incomplete take and discuss the limitation before another attempt. Writing a stop-recording marker in a running take's evidence directory requests a stop without adding an Agent prompt.
