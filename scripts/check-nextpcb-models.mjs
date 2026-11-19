import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLibraryService } from '../server/libraries.mjs';
import { LibraryAssetUnavailable } from '../server/library-asset-error.mjs';

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '10000' },
    output: { type: 'string', default: 'test-results/nextpcb-models' },
    clients: { type: 'string', default: '1' },
    exclude: { type: 'string', multiple: true, default: [] },
  },
});
const target = Number(values.count);
if (!Number.isSafeInteger(target) || target < 1 || target > 10_000)
  throw new Error('Choose a count between 1 and 10,000.');
const clientCount = Number(values.clients);
if (!Number.isSafeInteger(clientCount) || clientCount < 1 || clientCount > 3)
  throw new Error('Choose between one and three independent library clients.');

const detailConcurrency = 8;
const modelConcurrency = 2;
const directory = path.resolve(values.output);
await mkdir(directory, { recursive: true });
const reportFile = path.join(directory, 'components.jsonl');
const pageFile = path.join(directory, 'pages.jsonl');
async function records(file) {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map(JSON.parse);
}
const excluded = new Set();
for (const file of values.exclude) {
  for (const { id } of await records(file)) {
    if (typeof id !== 'string' || !/^NextPCB:[1-9][0-9]*_.+$/.test(id))
      throw new Error('An exclusion report contains an invalid NextPCB identity.');
    excluded.add(id);
  }
}
const results = new Map();
try {
  for (const result of await records(reportFile)) {
    if (excluded.has(result.id))
      throw new Error('The output overlaps a prior sweep. Use a new directory.');
    results.set(result.id, result);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const stop = new AbortController();
process.once('SIGINT', () => stop.abort(new Error('NextPCB sweep interrupted.')));
let requests = 0;
let pages = 0;
let pageErrors = 0;
let duplicateRows = 0;
let excludedRows = 0;
async function nextpcbFetcher(url, options) {
  requests++;
  const response = await fetch(url, options);
  if (response.status === 429 || response.status === 403) {
    stop.abort(new Error(`NextPCB returned HTTP ${response.status}. Sweep paused.`));
    await response.body?.cancel();
    stop.signal.throwIfAborted();
  }
  return response;
}
const services = Array.from({ length: clientCount }, (_, index) =>
  createLibraryService({
    dataDir: path.join(directory, index ? `cache-${index + 1}` : 'cache'),
    nextpcbFetcher,
  }),
);

async function attempt(operation) {
  for (let index = 0; ; index++) {
    stop.signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      stop.signal.throwIfAborted();
      if (
        index === 1 ||
        !/timed out|Check your internet connection|failed \(5\d\d\)/i.test(error.message)
      )
        throw error;
      await delay(1_000, undefined, { signal: stop.signal });
    }
  }
}

async function inspect(operation, describe) {
  try {
    return { status: 'loaded', ...describe(await attempt(operation)) };
  } catch (error) {
    stop.signal.throwIfAborted();
    return {
      status: error instanceof LibraryAssetUnavailable ? 'unavailable' : 'failed',
      error: error.message,
    };
  }
}

async function mapLimited(items, concurrency, operation) {
  const output = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await operation(items[index]);
      }
    }),
  );
  return output;
}

function request(message) {
  return attempt(() => services[0].request({ ...message, signal: stop.signal }));
}

async function inspectBatch(service, entries, category) {
  const inspected = await mapLimited(entries, detailConcurrency, async ({ id }) => {
    const detail = (kind) => service.request({ action: 'detail', kind, id, signal: stop.signal });
    const symbol = await inspect(
      () => detail('symbols'),
      ({ units, warning }) => ({ units, ...(warning ? { warning } : {}) }),
    );
    const footprint = await inspect(
      () => detail('footprints'),
      ({ models, pads }) => ({ models: models.map(({ path }) => path), pads: pads.length }),
    );
    return { id, category, symbol, footprint, step: [] };
  });
  await mapLimited(
    inspected.flatMap((result) =>
      (result.footprint.models ?? []).map((reference, index) => ({ result, reference, index })),
    ),
    modelConcurrency,
    async ({ result, reference, index }) => {
      result.step[index] = {
        reference,
        ...(await inspect(
          () => service.model(result.id, index, stop.signal),
          ({ meshes }) => ({ meshes: meshes.length }),
        )),
      };
    },
  );
  return inspected;
}

async function inspectPage(entries, category) {
  const batches = await Promise.all(
    services.map((service, index) =>
      inspectBatch(
        service,
        entries.filter((_, position) => position % services.length === index),
        category,
      ),
    ),
  );
  const inspected = batches.flat();
  await appendFile(reportFile, inspected.map((result) => JSON.stringify(result) + '\n').join(''));
  for (const result of inspected) results.set(result.id, result);
}

function totals() {
  const counts = {
    symbols: { loaded: 0, unavailable: 0, failed: 0, warnings: 0 },
    footprints: { loaded: 0, unavailable: 0, failed: 0, withoutModel: 0 },
    step: { loaded: 0, unavailable: 0, failed: 0 },
  };
  for (const { symbol, footprint, step } of results.values()) {
    counts.symbols[symbol.status]++;
    counts.footprints[footprint.status]++;
    if (symbol.warning) counts.symbols.warnings++;
    if (footprint.models?.length === 0) counts.footprints.withoutModel++;
    for (const model of step) counts.step[model.status]++;
  }
  return {
    target,
    clients: clientCount,
    components: results.size,
    priorIdentities: excluded.size,
    ...counts,
    pages,
    pageErrors,
    duplicateRows,
    excludedRows,
    requests,
  };
}

async function sweep() {
  if (results.size >= target) return;
  const { categories } = await request({
    action: 'categories',
    kind: 'symbols',
    source: 'NextPCB',
  });
  const queue = categories.map(({ id }) => ({ id, offset: 0 }));
  const descendants = categories.flatMap(({ children }) => children);
  for (const node of descendants) descendants.push(...node.children);
  const fallback = descendants.map(({ id }) => ({ id, offset: 0 }));
  while (results.size < target && (queue.length || fallback.length)) {
    const { id: category, offset } = queue.shift() ?? fallback.shift();
    let page;
    try {
      page = await request({
        action: 'search',
        kind: 'symbols',
        library: 'NextPCB',
        category,
        offset,
      });
    } catch (error) {
      stop.signal.throwIfAborted();
      pageErrors++;
      await appendFile(pageFile, JSON.stringify({ category, offset, error: error.message }) + '\n');
      continue;
    }
    pages++;
    const selected = new Map();
    for (const entry of page.entries) {
      if (excluded.has(entry.id)) excludedRows++;
      else if (results.has(entry.id) || selected.has(entry.id)) duplicateRows++;
      else if (results.size + selected.size < target) selected.set(entry.id, entry);
    }
    await appendFile(
      pageFile,
      JSON.stringify({
        category,
        offset,
        rows: page.entries.length,
        new: selected.size,
        total: page.total,
      }) + '\n',
    );
    if (page.nextOffset !== null) queue.push({ id: category, offset: page.nextOffset });
    if (selected.size) {
      await inspectPage([...selected.values()], category);
      console.log(JSON.stringify(totals()));
    }
  }
}

try {
  await sweep();
  if (results.size < target)
    throw new Error('NextPCB sweep did not reach the requested component count.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const service of services) service.close();
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(totals(), null, 2) + '\n');
}
