import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Optional module path allows a saved pre-change adapter to use the identical request.
const provider = process.argv[2] || 'codex';
const modulePath = path.resolve(process.argv[3] || 'server/agents.mjs');
const label = process.argv[4] || 'after';
const { runAgent } = await import(pathToFileURL(modulePath).href);
const cwd = path.resolve('test-results/chat-benchmark');
await mkdir(cwd, { recursive: true });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 120000);
const started = performance.now();
const events = [];
let text = '';
try {
  await runAgent(
    provider,
    {
      prompt:
        'In 180 to 220 English words, explain how a conceptual buck converter steps 24 V down to 12 V, including switch on/off paths, ideal duty cycle, inductor ripple and the output capacitor. Do not use tools or propose edits.',
      context: { title: 'Conceptual buck converter', parts: [], wires: [], labels: [] },
      history: [],
    },
    cwd,
    (event) => {
      const atMs = Math.round(performance.now() - started);
      events.push({ ...event, atMs });
      if (event.type === 'text') text += event.text;
      if (event.type === 'text-delta') text += event.delta;
      if (event.type === 'text-replace') text = event.text;
      if (event.type !== 'text-delta' && event.type !== 'text-replace')
        console.log(
          JSON.stringify({
            ...event,
            text: event.type === 'text' ? '(response)' : event.text,
            atMs,
          }),
        );
    },
    controller.signal,
  );
  const first = events.find((e) => ['text', 'text-delta', 'text-replace'].includes(e.type));
  const report = {
    provider,
    label,
    firstTextMs: first?.atMs ?? null,
    totalMs: Math.round(performance.now() - started),
    textEvents: events.filter((e) => ['text', 'text-delta', 'text-replace'].includes(e.type))
      .length,
    characters: text.length,
    cancelled: controller.signal.aborted,
    errors: events.filter((e) => e.type === 'error'),
    events,
  };
  await writeFile(path.join(cwd, `${provider}-${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, events: undefined }));
  if (!first || report.errors.length || report.cancelled) process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
