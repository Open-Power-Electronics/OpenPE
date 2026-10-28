// Developer-only preparation for reproducible profile generation; never package model bytes.
import { mkdir, writeFile } from 'node:fs/promises';
import { exampleModelLock } from '../server/example-models-lock.mjs';
import { createExampleModelStore } from '../server/example-models.mjs';
const store = createExampleModelStore('test-results/example-model-preparation');
await mkdir('test-results/example-models', { recursive: true });
for (const model of exampleModelLock.models) {
  const bytes = await store(model.id, new AbortController().signal);
  await writeFile(`test-results/example-models/${model.file}`, bytes);
  console.log(`Verified ${model.file}`);
}
