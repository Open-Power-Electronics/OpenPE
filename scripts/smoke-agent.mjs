import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from '../server/agents.mjs';
const provider = process.argv[2] || 'codex';
const cwd = path.resolve('test-results/agent-smoke');
await mkdir(cwd, { recursive: true });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90000);
let text = '',
  failed = false;
try {
  await runAgent(
    provider,
    {
      prompt: '这是 OpenPE 集成连通测试。不要使用任何工具，也不要检查文件。请只回复 OPENPE_OK。',
      context: { title: 'Connection test', parts: [], wires: [] },
      history: [],
    },
    cwd,
    (event) => {
      if (event.type === 'text') text += event.text;
      if (event.type === 'text-delta') text += event.delta;
      if (event.type === 'text-replace') text = event.text;
      if (event.type === 'error') {
        failed = true;
        console.error(event.text);
      }
      if (event.type === 'status') console.log(event.text);
    },
    controller.signal,
  );
  if (failed || !text.includes('OPENPE_OK'))
    throw new Error('Agent smoke test did not return OPENPE_OK');
  console.log(`PASS: ${provider} actual CLI response: ${text}`);
} finally {
  clearTimeout(timer);
}
