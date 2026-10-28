// Host-infrastructure tooling for reviewed reference assets; never imported by the app.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

/**
 * @typedef {{category: string, unit: string, values: {min: number|null, typ: number|null, max: number|null}, conditions: string, source: {page: number, section: string, row: string}, notes?: string}} DatasheetParameter
 * @typedef {{
 *   $schema: string,
 *   schema_version: string,
 *   example: {id: string, file: string, title: string, topology: string},
 *   ic: {manufacturer: string, family: string, reference: string, schematic_value: string, symbol_library_id: string, footprint: string, package: string, datasheet_variant: string},
 *   datasheet: {title: string, document_number: string, revision: string|null, published_month: string, product_url: string, source_url: string, filename: string, sha256: string, bytes: number, page_count: number, downloaded_on: string},
 *   extraction: {method: string, reviewed_on: string, scope: string, notes: string[]},
 *   parameters: Record<string, DatasheetParameter>
 * }} DatasheetRecord
 */

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const schema = JSON.parse(
  await readFile(
    new URL('../resources/example-catalog/ic-datasheet.schema.json', import.meta.url),
    'utf8',
  ),
);
/** @type {import('ajv').ValidateFunction<DatasheetRecord>} */
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

/** @param {unknown} record @returns {DatasheetRecord} */
export function assertDatasheetRecord(record) {
  if (!validate(record))
    throw new Error(`Invalid datasheet JSON: ${JSON.stringify(validate.errors)}`);
  const { family } = record.ic;
  const name = family.toLowerCase();
  const { datasheet } = record;
  if (
    !record.example.file.startsWith(`${name}-`) ||
    datasheet.filename !== `${name}.pdf` ||
    datasheet.source_url !== `https://www.ti.com/lit/ds/symlink/${name}.pdf` ||
    datasheet.product_url !== `https://www.ti.com/product/${family}` ||
    (datasheet.revision !== null && !datasheet.document_number.endsWith(datasheet.revision))
  )
    throw new Error(`${family}: datasheet identity does not match the selected IC`);
  for (const field of [record.extraction.reviewed_on, datasheet.downloaded_on]) {
    if (new Date(field).toISOString().slice(0, 10) !== field)
      throw new Error(`${family}: invalid calendar date ${field}`);
  }
  for (const [id, parameter] of Object.entries(record.parameters)) {
    const { min, typ, max } = parameter.values;
    const ordered = [min, typ, max].filter((value) => value !== null);
    if (
      ordered.some(
        (value, index) => !Number.isFinite(value) || (index > 0 && value < ordered[index - 1]),
      )
    )
      throw new Error(`${family}.${id}: values must be finite and min <= typ <= max`);
    if (parameter.unit === '1' && ordered.some((value) => value < 0 || value > 1))
      throw new Error(`${family}.${id}: dimensionless duty cycle must be a fraction in [0, 1]`);
    if (parameter.source.page > datasheet.page_count)
      throw new Error(`${family}.${id}: source page exceeds the pinned PDF page count`);
  }
  if (
    ![
      'switching_frequency',
      'minimum_switching_frequency',
      'switching_frequency_programmable_maximum',
    ].some((id) => Object.hasOwn(record.parameters, id))
  )
    throw new Error(`${family}: a frequency specification is required`);
  return record;
}

export async function loadDatasheetCatalog(root = repositoryRoot) {
  const catalog = JSON.parse(
    await readFile(path.join(root, 'resources/example-catalog/manifest.json'), 'utf8'),
  );
  const records = [];
  for (const example of catalog.examples) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(example.file))
      throw new Error('Invalid example file stem');
    const directory = path.join(root, 'examples', example.file, 'datasheets');
    const record = assertDatasheetRecord(
      JSON.parse(await readFile(path.join(directory, 'parameters.json'), 'utf8')),
    );
    if (
      ['id', 'file', 'title', 'topology'].some((key) => record.example[key] !== example[key]) ||
      record.ic.package !== example.package
    )
      throw new Error(`${example.file}: reference data no longer matches the Home catalog`);
    const fixture = JSON.parse(
      await readFile(path.join(root, 'tests/fixtures/reference', `${example.file}.json`), 'utf8'),
    );
    const controller = fixture.schematic.components.find(
      (part) => part.reference === record.ic.reference,
    );
    if (
      !controller ||
      controller.value !== record.ic.schematic_value ||
      controller.libraryId !== record.ic.symbol_library_id ||
      controller.fields?.Footprint !== record.ic.footprint
    )
      throw new Error(`${example.file}: reference data no longer matches the canonical controller`);
    records.push({ record, directory });
  }
  if (new Set(records.map(({ record }) => record.ic.family)).size !== records.length)
    throw new Error('Each Home example must have a distinct controller reference');
  return records;
}

function verifyBytes(data, record) {
  const expected = record.datasheet;
  if (
    data.length !== expected.bytes ||
    data.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    createHash('sha256').update(data).digest('hex') !== expected.sha256
  )
    throw new Error(
      `${record.ic.family}: PDF differs from the reviewed bytes; preserve it and review the vendor revision before updating the JSON`,
    );
}

async function ensureDirectory(directory, create = false) {
  // Check every ancestor before mkdir/read/write; do not follow linked asset folders.
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent !== absolute) await ensureDirectory(parent, create);
  try {
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Not an ordinary directory: ${absolute}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (create) await mkdir(absolute);
  }
}

export async function verifyDatasheet(record, directory) {
  await ensureDirectory(directory);
  const file = path.join(directory, record.datasheet.filename);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== record.datasheet.bytes)
    throw new Error(
      `${record.ic.family}: existing PDF has an unexpected type or size; it was preserved`,
    );
  verifyBytes(await readFile(file), record);
  return true;
}

export async function downloadDatasheet(record, directory, fetchImpl = fetch) {
  assertDatasheetRecord(record);
  if (await verifyDatasheet(record, directory)) return 'cached';
  let url = record.datasheet.source_url;
  const signal = AbortSignal.timeout(60000);
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.origin !== 'https://www.ti.com' ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith('/lit/')
    )
      throw new Error('Datasheet download must remain on the official TI HTTPS literature origin');
    response = await fetchImpl(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3)
      throw new Error('Invalid or excessive TI datasheet redirects');
    url = new URL(location, url).href;
  }
  if (!response.ok || !response.body)
    throw new Error(`${record.ic.family}: datasheet download returned HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > record.datasheet.bytes)
        throw new Error(`${record.ic.family}: downloaded PDF exceeds the reviewed size`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (!signal.aborted) await response.body.cancel().catch(() => {});
    throw error;
  }
  const data = Buffer.concat(chunks);
  verifyBytes(data, record);
  await ensureDirectory(directory, true);
  const file = path.join(directory, record.datasheet.filename);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    // Publish a complete file without replacing a file created by another process.
    await link(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return 'downloaded';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--verify', '--download'].includes(args[0]))
    throw new Error('Usage: node scripts/example-datasheets.mjs --verify|--download');
  const catalog = await loadDatasheetCatalog();
  for (const { record, directory } of catalog) {
    if (args[0] === '--download') {
      console.log(`${record.ic.family}: ${await downloadDatasheet(record, directory)}`);
    } else if (!(await verifyDatasheet(record, directory))) {
      throw new Error(`${record.ic.family}: PDF missing. Run npm run datasheets:download.`);
    }
  }
  const count = catalog.reduce(
    (total, { record }) => total + Object.keys(record.parameters).length,
    0,
  );
  console.log(
    `Verified ${catalog.length} controller records, ${count} parameters and ${catalog.length} pinned PDFs.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
