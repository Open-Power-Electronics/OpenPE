import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertDatasheetRecord,
  loadDatasheetCatalog,
  downloadDatasheet,
  verifyDatasheet,
  loadSupplementalDatasheets,
} from '../scripts/example-datasheets.mjs';

const catalog = await loadDatasheetCatalog();

test('all EMC ICs have distinct pinned PDFs matching the fitted native identities', async () => {
  const supplemental = await loadSupplementalDatasheets();
  assert.deepEqual(supplemental.map(({ record }) => record.ic.reference), ['U2', 'U3', 'U4']);
  assert.deepEqual(supplemental.map(({ record }) => record.datasheet.filename),
    ['l78l12.pdf', 'tl431.pdf', 'ltv817s.pdf']);
  assert.equal(supplemental[2].record.ic.schematic_value, 'LTV-817S');
});

async function temporaryDirectory(t: TestContext) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'datasheets-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(`${parent}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function smallPdfRecord() {
  // Tiny PDF-like bytes exercise pinning and atomic publishing without vendor downloads.
  const bytes = Buffer.from('%PDF-1.7\nreviewed test bytes\n%%EOF\n');
  const record = structuredClone(catalog[0].record);
  record.datasheet.bytes = bytes.length;
  record.datasheet.sha256 = createHash('sha256').update(bytes).digest('hex');
  return { record, bytes };
}

test('every Home example has schema-valid metadata bound to its actual controller', () => {
  assert.equal(catalog.length, 10);
  assert.equal(
    catalog.reduce((sum, { record }) => sum + Object.keys(record.parameters).length, 0),
    145,
  );
  const byFamily = Object.fromEntries(catalog.map(({ record }) => [record.ic.family, record]));
  assert.equal(byFamily.LM2735.ic.schematic_value, 'LM2735Y');
  assert.equal(byFamily.LMR12010.ic.schematic_value, 'LMR12010X');
  assert.equal(byFamily.LM2735.parameters.switching_frequency.values.typ, 520000);
  assert.equal(byFamily.LMR12010.parameters.switching_frequency.values.typ, 1600000);
  assert.equal(byFamily.LM2598.parameters.operating_junction_temperature.values.min, -25);
  assert.equal(byFamily.LMR70503.parameters.output_voltage.values.min, -5.5);
  assert.equal(byFamily.LMR70503.parameters.output_voltage.values.max, -0.9);
  assert.equal(byFamily.LM27761.parameters.output_current.values.max, 0.25);
  assert.equal(byFamily.LM27761.parameters.output_current_absolute_maximum.values.max, 0.3);
  assert.ok(!Object.hasOwn(byFamily.LMR70503.parameters, 'feedback_reference_voltage'));
  assert.equal(byFamily.UC3845B.ic.manufacturer, 'STMicroelectronics');
  assert.equal(byFamily.UC3845B.parameters.maximum_duty_cycle.values.max, 0.5);
  assert.equal(byFamily.UC3845B.parameters.undervoltage_start_threshold.values.typ, 8.4);
  assert.equal(byFamily.UC3845B.parameters.oscillator_frequency.values.typ, 52000);
  assert.ok(!Object.hasOwn(byFamily.UC3845B.parameters, 'input_voltage'));
});

test('schema rejects wrong units, rating categories, unknown fields and empty quantities', () => {
  for (const mutate of [
    (r: any) => {
      r.parameters.input_voltage.unit = 'mV';
    },
    (r: any) => {
      r.parameters.input_voltage.category = 'absolute_maximum_rating';
    },
    (r: any) => {
      r.parameters.unknown = r.parameters.input_voltage;
    },
    (r: any) => {
      r.parameters.input_voltage.values = { min: null, typ: null, max: null };
    },
    (r: any) => {
      r.datasheet.filename = '../other.pdf';
    },
    (r: any) => {
      r.parameters.input_voltage.source.page = 0;
    },
  ]) {
    const record = structuredClone(catalog[0].record);
    mutate(record);
    assert.throws(() => assertDatasheetRecord(record), /Invalid datasheet JSON/);
  }
});

test('semantic validation rejects reversed limits, percentages and invalid evidence', () => {
  const record = structuredClone(catalog[0].record);
  record.parameters.input_voltage.values.min = 41;
  assert.throws(() => assertDatasheetRecord(record), /min <= typ <= max/);
  record.parameters.input_voltage.values.min = 4.5;
  record.parameters.maximum_duty_cycle.values.typ = 100;
  assert.throws(() => assertDatasheetRecord(record), /fraction/);
  record.parameters.maximum_duty_cycle.values.typ = 1;
  record.parameters.input_voltage.source.page = record.datasheet.page_count + 1;
  assert.throws(() => assertDatasheetRecord(record), /page count/);
  record.parameters.input_voltage.source.page = 5;
  record.datasheet.downloaded_on = '2026-02-30';
  assert.throws(() => assertDatasheetRecord(record), /invalid calendar date/);
});

test('download publishes only pinned bytes and reuses a verified local PDF offline', async (t) => {
  const directory = await temporaryDirectory(t);
  const { record, bytes } = smallPdfRecord();
  let calls = 0;
  const fetchPdf = async () => {
    calls++;
    return new Response(bytes);
  };
  assert.equal(await downloadDatasheet(record, directory, fetchPdf), 'downloaded');
  assert.equal(await verifyDatasheet(record, directory), true);
  assert.equal(await downloadDatasheet(record, directory, fetchPdf), 'cached');
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(path.join(directory, record.datasheet.filename)), bytes);
  assert.deepEqual(await readdir(directory), [record.datasheet.filename]);
});

test('changed vendor bytes fail without publishing; existing differing files are preserved', async (t) => {
  const directory = await temporaryDirectory(t);
  const { record, bytes } = smallPdfRecord();
  const different = Buffer.from(bytes);
  different[different.length - 2] ^= 1;
  await assert.rejects(
    downloadDatasheet(record, directory, async () => new Response(different)),
    /differs/,
  );
  assert.deepEqual(await readdir(directory), []);
  const file = path.join(directory, record.datasheet.filename);
  await writeFile(file, different);
  await assert.rejects(
    downloadDatasheet(record, directory, async () => {
      throw new Error('must not fetch');
    }),
    /differs/,
  );
  assert.deepEqual(await readFile(file), different);
});

test('download bounds response bytes and rejects redirects outside TI literature', async (t) => {
  const directory = await temporaryDirectory(t);
  const { record, bytes } = smallPdfRecord();
  await assert.rejects(
    downloadDatasheet(record, directory, async () => new Response(Buffer.concat([bytes, bytes]))),
    /exceeds/,
  );
  await assert.rejects(
    downloadDatasheet(
      record,
      directory,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.invalid/replacement.pdf' },
        }),
    ),
    /official TI/,
  );
  assert.deepEqual(await readdir(directory), []);
});

test('verification is read-only and linked directories cannot receive downloads', async (t) => {
  const directory = await temporaryDirectory(t);
  const { record } = smallPdfRecord();
  const missing = path.join(directory, 'missing', 'nested');
  assert.equal(await verifyDatasheet(record, missing), false);
  assert.deepEqual(await readdir(directory), []);
  const destination = path.join(directory, 'destination');
  const linked = path.join(directory, 'linked');
  await mkdir(destination);
  await symlink(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(downloadDatasheet(record, linked), /ordinary directory/);
  assert.deepEqual(await readdir(destination), []);
});
