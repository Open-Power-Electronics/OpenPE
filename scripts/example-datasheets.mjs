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
  const st = record.ic.manufacturer === 'STMicroelectronics';
  if (
    (st && (family !== 'UC3845B' || record.example.id !== 'emc-flyback-demo')) ||
    (!st && family === 'UC3845B') ||
    (st ? record.example.file !== 'emc-flyback' : !record.example.file.startsWith(`${name}-`)) ||
    datasheet.filename !== `${name}.pdf` ||
    datasheet.source_url !==
      (st
        ? 'https://www.st.com/resource/en/datasheet/uc3842b.pdf'
        : `https://www.ti.com/lit/ds/symlink/${name}.pdf`) ||
    datasheet.product_url !==
      (st
        ? `https://www.st.com/en/power-management/${name}.html`
        : `https://www.ti.com/product/${family}`) ||
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
      'oscillator_frequency',
    ].some((id) => Object.hasOwn(record.parameters, id))
  )
    throw new Error(`${family}: a frequency specification is required`);
  return record;
}

async function readHomeManifest(root) {
  return JSON.parse(
    await readFile(path.join(root, 'resources/example-catalog/home-manifest.json'), 'utf8'),
  );
}

function datasheetDirectory(root, catalog, example) {
  const sourceRoot = catalog.sourceRoots[example.root];
  if (!sourceRoot) throw new Error('Unknown example source root.');
  return path.join(root, sourceRoot, example.directory, 'datasheets');
}

export async function loadDatasheetCatalog(root = repositoryRoot) {
  const catalog = await readHomeManifest(root);
  const examples = [...catalog.examples, ...catalog.recent];
  const reviewed = JSON.parse(
    await readFile(path.join(root, 'resources/example-catalog/ic-datasheets.json'), 'utf8'),
  );
  if (!Array.isArray(reviewed) || reviewed.length !== examples.length)
    throw new Error('The internal datasheet catalog must match the current example catalog.');
  const identities = new Set(reviewed.map((record) => assertDatasheetRecord(record).example.id));
  if (identities.size !== reviewed.length)
    throw new Error('The internal datasheet catalog contains duplicate identities.');
  const records = [];
  for (const example of examples) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(example.file))
      throw new Error('Invalid example file stem');
    const directory = datasheetDirectory(root, catalog, example);
    const record = assertDatasheetRecord(
      reviewed.find((record) => record.example.id === example.id),
    );
    if (
      ['id', 'file', 'title', 'topology'].some((key) => record.example[key] !== example[key]) ||
      record.ic.package !== example.package
    )
      throw new Error(`${example.file}: reference data no longer matches the Home catalog`);
    const fixture = JSON.parse(
      await readFile(
        example.id === 'emc-flyback-demo'
          ? path.join(root, 'lib/emc-flyback-example.json')
          : path.join(root, 'tests/fixtures/reference', `${example.file}.json`),
        'utf8',
      ),
    );
    const controller = fixture.schematic.components.find(
      (part) => part.reference === record.ic.reference,
    );
    if (
      !controller ||
      controller.value !== record.ic.schematic_value ||
      (controller.libraryId ?? controller.symbol) !== record.ic.symbol_library_id ||
      controller.fields?.Footprint !== record.ic.footprint
    )
      throw new Error(`${example.file}: reference data no longer matches the canonical controller`);
    records.push({ record, directory });
  }
  if (new Set(records.map(({ record }) => record.ic.family)).size !== records.length)
    throw new Error('Each Home example must have a distinct controller reference');
  return records;
}

// Download-only references for the other fitted EMC ICs. These are not reviewed
// parameter records and are never submitted as Agent context.
export async function loadSupplementalDatasheets(root = repositoryRoot) {
  const catalog = await readHomeManifest(root);
  const example = catalog.recent.find((entry) => entry.id === 'emc-flyback-demo');
  if (!example) throw new Error('The EMC Flyback Home entry is missing.');
  const directory = datasheetDirectory(root, catalog, example);
  const assets = JSON.parse(
    await readFile(
      path.join(root, 'resources/example-catalog/emc-ic-datasheet-files.json'),
      'utf8',
    ),
  );
  const fixture = JSON.parse(
    await readFile(path.join(root, 'lib/emc-flyback-example.json'), 'utf8'),
  );
  const sources = {
    U2: 'https://www.st.com/resource/en/datasheet/l78l.pdf',
    U3: 'https://www.ti.com/lit/ds/symlink/tl431.pdf',
    U4: 'https://pdf.hitech-semi.com/754058/LTV-817S.pdf',
  };
  if (
    !Array.isArray(assets) ||
    assets.length !== 3 ||
    new Set(assets.map((asset) => asset.ic?.reference)).size !== 3
  )
    throw new Error('Expected one supplemental PDF for each of EMC U2, U3 and U4.');
  return assets.map((record) => {
    const { ic, datasheet } = record;
    const part = fixture.schematic.components.find((part) => part.reference === ic?.reference);
    if (
      Object.keys(record).sort().join() !== 'datasheet,ic' ||
      !part ||
      Object.keys(ic).sort().join() !==
        'family,footprint,manufacturer,reference,schematic_value,symbol_library_id' ||
      ic.schematic_value !== part.value ||
      ic.symbol_library_id !== part.symbol ||
      ic.footprint !== part.fields.Footprint ||
      !/^[A-Za-z0-9-]+$/.test(ic.family) ||
      typeof ic.manufacturer !== 'string' ||
      !ic.manufacturer ||
      Object.keys(datasheet).sort().join() !==
        'bytes,downloaded_on,filename,page_count,sha256,source_url,title' ||
      datasheet.source_url !== sources[ic.reference] ||
      datasheet.filename !== `${ic.family.toLowerCase()}.pdf` ||
      !/^[a-f0-9]{64}$/.test(datasheet.sha256) ||
      !Number.isInteger(datasheet.bytes) ||
      datasheet.bytes < 5 ||
      datasheet.bytes > 20971520 ||
      !Number.isInteger(datasheet.page_count) ||
      datasheet.page_count < 1 ||
      datasheet.page_count > 1000 ||
      typeof datasheet.title !== 'string' ||
      !datasheet.title ||
      !/^\d{4}-\d{2}-\d{2}$/.test(datasheet.downloaded_on) ||
      new Date(datasheet.downloaded_on).toISOString().slice(0, 10) !== datasheet.downloaded_on
    )
      throw new Error(
        'Supplemental EMC PDF metadata does not match the fitted IC or pinned source.',
      );
    return { record, directory };
  });
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
  return downloadPinnedPdf(record, directory, fetchImpl);
}

async function downloadPinnedPdf(record, directory, fetchImpl = fetch) {
  if (await verifyDatasheet(record, directory)) return 'cached';
  let url = record.datasheet.source_url;
  const signal = AbortSignal.timeout(60000);
  let response;
  const source = new URL(record.datasheet.source_url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.origin !== source.origin ||
      parsed.username ||
      parsed.password ||
      !parsed.pathname.startsWith(
        source.origin === 'https://www.ti.com'
          ? '/lit/'
          : source.origin === 'https://www.st.com'
            ? '/resource/en/datasheet/'
            : '/754058/',
      )
    )
      throw new Error(
        'Datasheet download must remain on the official TI/ST or pinned distributor HTTPS literature origin',
      );
    response = await fetchImpl(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === 3)
      throw new Error('Invalid or excessive vendor datasheet redirects');
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
  const controllers = await loadDatasheetCatalog();
  const catalog = [...controllers, ...(await loadSupplementalDatasheets())];
  for (const { record, directory } of catalog) {
    if (args[0] === '--download') {
      console.log(`${record.ic.family}: ${await downloadPinnedPdf(record, directory)}`);
    } else if (!(await verifyDatasheet(record, directory))) {
      throw new Error(`${record.ic.family}: PDF missing. Run npm run datasheets:download.`);
    }
  }
  const count = controllers.reduce(
    (total, { record }) => total + Object.keys(record.parameters).length,
    0,
  );
  console.log(
    `Verified ${controllers.length} controller records, ${count} parameters and ${catalog.length} pinned IC PDFs.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
