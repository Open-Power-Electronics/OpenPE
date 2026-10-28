import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import manifest from '../tests/fixtures/kicad/manifest.json';
import { importDocument } from '../lib/project';
import { parseSExpr, writeSExpr } from '../lib/sexpr';

// Offline, reproducible snapshot. Upstream originals are checked in unchanged.
const sources: Record<string, string> = {};
for (const entry of manifest.examples) {
  const source = await readFile(`tests/fixtures/kicad/upstream/${entry.file}`, 'utf8');
  const hash = createHash('sha256').update(source).digest('hex');
  if (hash !== entry.sha256) throw new Error(`Upstream checksum mismatch: ${entry.file}`);
  importDocument(source); // Never generate a snapshot from unsupported content.
  // The upstream archive remains hash-pinned; app snapshots omit print settings.
  sources[entry.id] =
    writeSExpr(parseSExpr(source).filter((node) => !Array.isArray(node) || node[0] !== 'paper')) +
    '\n';
}
await writeFile('lib/kicad-examples.json', JSON.stringify(sources, null, 2) + '\n');
console.log(`Generated ${manifest.examples.length} official KiCad example snapshots.`);
