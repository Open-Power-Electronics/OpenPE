import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { nextpcbSupplyBatchLimit, readNextpcbSupplyPrices } from '../server/nextpcb-prices.mjs';

const { values } = parseArgs({
  options: { cad: { type: 'string', multiple: true }, resume: { type: 'string' } },
});
if (!values.cad?.length) throw new Error('Pass --cad <components.jsonl> for each CAD sweep.');

const target = 10_000;
const candidates = new Map();
for (const file of values.cad) {
  const source = path.resolve(file);
  const text = await readFile(source, 'utf8');
  for (const [index, line] of text.trimEnd().split('\n').entries()) {
    const row = JSON.parse(line);
    if (
      row.symbol?.status !== 'loaded' ||
      !Number.isSafeInteger(row.symbol.units) ||
      row.symbol.units < 1 ||
      row.footprint?.status !== 'loaded' ||
      !Number.isSafeInteger(row.footprint.pads) ||
      row.footprint.pads < 0
    )
      continue;
    const identity = /^NextPCB:([1-9]\d{0,18})_(.+)$/.exec(row.id);
    if (!identity) throw new Error(`Invalid CAD identity at ${source}:${index + 1}.`);
    const [, manufacturer_id, encoded] = identity;
    const mpn = decodeURIComponent(encoded);
    if (
      !mpn.trim() ||
      mpn.length > 200 ||
      /[\u0000-\u001f]/.test(mpn) ||
      encodeURIComponent(mpn) !== encoded
    )
      throw new Error(`Invalid CAD part number at ${source}:${index + 1}.`);
    if (!candidates.has(row.id)) {
      candidates.set(row.id, {
        id: row.id,
        manufacturer_id,
        mpn,
        symbolUnits: row.symbol.units,
        footprintPads: row.footprint.pads,
        evidence: { file: source, line: index + 1 },
      });
    }
  }
}
if (!candidates.size) throw new Error('The reports contain no verified symbols and footprints.');

const directory = path.resolve('test-results', `nextpcb-supply-audit-${Date.now()}`);
await mkdir(directory, { recursive: true });
const outputs = ['priced', 'no-price', 'failed', 'unqueried'];
for (const kind of outputs)
  await writeFile(path.join(directory, `${kind}.jsonl`), '', { flag: 'wx' });

const stop = new AbortController();
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => stop.abort(new Error('Supply audit interrupted.')));
}
let requests = 0;
let lastStart = 0;
const counts = { priced: 0, 'no-price': 0, failed: 0, unqueried: 0 };
const resumed = { priced: 0, 'no-price': 0 };
const startedAt = new Date().toISOString();
const concurrency = 3;
const summary = () => ({
  directory,
  startedAt,
  target,
  cadIdentities: candidates.size,
  batchSize: nextpcbSupplyBatchLimit,
  requests,
  counts,
  ...(values.resume ? { resumedFrom: path.resolve(values.resume), resumed } : {}),
  ...(stop.signal.aborted ? { stopped: stop.signal.reason.message } : {}),
});

async function requestBatch(batch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const startsAt = Math.max(Date.now(), lastStart + 500);
      lastStart = startsAt;
      await delay(Math.max(0, startsAt - Date.now()), undefined, { signal: stop.signal });
      requests++;
      return await readNextpcbSupplyPrices(
        fetch,
        batch,
        AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]),
      );
    } catch (error) {
      if (error.status === 403 || error.status === 429) stop.abort(error);
      if (
        stop.signal.aborted ||
        attempt > 0 ||
        !(error instanceof TypeError || error.name === 'TimeoutError' || error.status >= 500)
      )
        throw error;
      await delay(1_000, undefined, { signal: stop.signal });
    }
  }
}

async function record(kind, records) {
  if (!records.length) return;
  await appendFile(
    path.join(directory, `${kind}.jsonl`),
    records.map((row) => JSON.stringify(row) + '\n').join(''),
  );
  counts[kind] += records.length;
}

async function reuseCompleted() {
  const completed = new Set();
  if (!values.resume) return completed;
  for (const kind of ['priced', 'no-price']) {
    const file = path.resolve(values.resume, `${kind}.jsonl`);
    const contents = (await readFile(file, 'utf8')).trimEnd();
    const records = contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
    for (const row of records) {
      const candidate = candidates.get(row?.id);
      const checkedAt = kind === 'priced' ? row.quote?.checkedAt : row.checkedAt;
      if (
        !candidate ||
        candidate.manufacturer_id !== row.manufacturer_id ||
        candidate.mpn !== row.mpn ||
        completed.has(row.id) ||
        !Number.isSafeInteger(checkedAt) ||
        checkedAt <= 0 ||
        (kind === 'priced' &&
          (row.quote?.currency !== 'USD' ||
            !Array.isArray(row.quote.offers) ||
            !row.quote.offers.length))
      )
        throw new Error(`Invalid completed result in ${file}.`);
      completed.add(row.id);
    }
    await record(kind, records);
    resumed[kind] = records.length;
  }
  return completed;
}

let next = 0;
let round = 0;
try {
  const completed = await reuseCompleted();
  const rows = [...candidates.values()].filter(({ id }) => !completed.has(id));
  console.log(JSON.stringify(summary()));
  while (next < rows.length && !stop.signal.aborted) {
    const batches = [];
    for (let i = 0; i < concurrency && next < rows.length; i++) {
      batches.push(rows.slice(next, next + nextpcbSupplyBatchLimit));
      next += batches.at(-1).length;
    }
    const results = await Promise.allSettled(batches.map(requestBatch));
    const collected = { priced: [], 'no-price': [], failed: [] };
    for (const [index, result] of results.entries()) {
      const batch = batches[index];
      for (const [position, row] of batch.entries()) {
        if (result.status === 'rejected') {
          collected.failed.push({ ...row, error: result.reason.message });
          continue;
        }
        const { quote, error } = result.value[position];
        if (error) collected.failed.push({ ...row, error });
        else if (quote.offers.length) collected.priced.push({ ...row, quote });
        else collected['no-price'].push({ ...row, checkedAt: quote.checkedAt });
      }
    }
    for (const [kind, records] of Object.entries(collected)) await record(kind, records);
    if (++round % 5 === 0) console.log(JSON.stringify(summary()));
  }
  await record('unqueried', rows.slice(next));
  if (counts.priced < target || counts.failed || counts.unqueried) process.exitCode = 1;
} finally {
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary(), null, 2) + '\n');
  console.log(JSON.stringify(summary()));
}
