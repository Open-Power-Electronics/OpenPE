import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createDatasheetService,
  fetchDatasheet,
  renderDatasheetPage,
} from '../server/datasheets.mjs';
import { datasheetRecord } from '../lib/example-datasheets';
import { agentCapabilityContent } from '../server/agent-capabilities.mjs';
import { startAgentMCP } from '../server/agent-mcp.mjs';
import { runAgent } from '../server/agents.mjs';
import { startServer } from '../server/index.mjs';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { readLibraryDatasheet, readLibraryPrice } from '../lib/library-references';
import { createProject } from '../lib/project';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';

// A real, self-contained two-page PDF: text and vector diagrams exercise extraction/rasterization.
function pdf() {
  const streams = [
    'BT /F1 16 Tf 40 160 Td (Ripple injection circuit) Tj ET\n40 90 m 160 90 l 160 50 l S',
    'BT /F1 16 Tf 40 160 Td (Second page: feedback) Tj ET\n40 50 80 40 re S',
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = source.length;
  source += `xref\n0 8\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}
const bytes = pdf();
const record = datasheetRecord('reference-lm25017-wson8-flybuck')!;
record.datasheet = {
  ...record.datasheet,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  page_count: 2,
};
const signal = () => AbortSignal.timeout(10000);

test('full PDF reads text and actual diagram pixels from first and last pages', async () => {
  const first: any = await renderDatasheetPage(bytes, 1, true, 2, signal());
  const last: any = await renderDatasheetPage(bytes, 2, false, 2, signal());
  assert.match(first.text, /Ripple injection circuit/);
  assert.match(last.text, /Second page: feedback/);
  assert.equal(last.pageCount, 2);
  assert.equal(last.image, undefined);
  const { loadImage, createCanvas } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(first.image.data, 'base64'));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  assert.ok(context.getImageData(80, 220, 1, 1).data[0] < 100, 'diagram line is rendered');
  assert.equal(first.image.width, 480);
  await assert.rejects(renderDatasheetPage(bytes, 1, false, 3, signal()), /page count/);
  await assert.rejects(renderDatasheetPage(bytes, 3, false, 2, signal()), /page/i);
});

test('chooser previews switch suppliers by exact part identity and isolate PDF bytes per source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-library-datasheet-'));
  const next = 'https://file.elecfans.com/web2/M00/27/D5/fixture.pdf';
  const jlc = 'https://jlc-prod-smt.oss-eu-central-1.aliyuncs.com/smtDataManualFile/123-C123.pdf?signature=fixture';
  const downloads: string[] = [];
  const nextRecords = new Map([
    ['Exact/Part', next.replace('https:', 'http:')],
    ['Blocked', 'https://127.0.0.1/manual.pdf'],
    ['NoPdf', 'https://www.ti.com/product/fixture'],
    ['Redirect', next.replace('fixture', 'redirect')],
    ['Large', next.replace('fixture', 'large')],
    ['Retry', next.replace('fixture', 'retry')],
    ['Cancel', next.replace('fixture', 'cancel')],
  ]);
  let retry = false;
  let cancelStarted!: () => void;
  let cancelObserved!: () => void;
  const started = new Promise<void>((resolve) => (cancelStarted = resolve));
  const cancelled = new Promise<void>((resolve) => (cancelObserved = resolve));
  await mkdir(path.join(root, 'symbols'));
  await mkdir(path.join(root, 'footprints'));
  await writeFile(
    path.join(root, 'symbols', 'Device.kicad_sym'),
    [
      '(kicad_symbol_lib (version 20241209)',
      '(symbol "Fixture" (property "Reference" "U") (property "Value" "Fixture")',
      '(property "MPN" "Exact/Part") (property "Manufacturer" "Fixture Devices"))',
      '(symbol "Multiple" (property "Reference" "U") (property "Value" "Multiple")',
      '(property "MPN" "Ambiguous")))',
    ].join(' '),
  );
  const host = await startServer({
    dataDir: path.join(root, 'app'),
    libraryRoot: root,
    nextpcbFetcher: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith('/queryPage')) {
        assert.match(body.desc, /^(Exact\/Part|Ambiguous)$/);
        return Response.json({
          code: 200000,
          total: 2,
          result: [
            { manufacturer_id: '9729', manufacturer: 'Different Devices', mpn: body.desc },
            { manufacturer_id: '9728', manufacturer: 'Fixture Devices', mpn: body.desc },
          ],
        });
      }
      assert.match(String(url), /\/productDetail$/);
      const { manufacturer_id, mpn } = body;
      assert.equal(manufacturer_id, '9728');
      return Response.json({
        code: 200000,
        result: {
          mfgId: 9728,
          mpn: mpn === 'Mismatched' ? 'Different' : mpn,
          mfg: 'Fixture Devices',
          datasheet: nextRecords.get(mpn),
        },
      });
    },
    jlcpcbFetcher: async (url, init) => {
      assert.match(String(url), /\/selectSmtComponentList\/v2$/);
      const { keyword } = JSON.parse(String(init?.body));
      const list = [
        { componentCode: 'C124', componentModelEn: 'Exact/Part', componentBrandEn: 'Other Devices', dataManualFileAccessIdUrl: jlc },
        { componentCode: 'C123', componentModelEn: 'Exact/Part', componentBrandEn: 'Fixture Devices', dataManualFileAccessIdUrl: jlc },
      ];
      assert.match(keyword, /^(C12[34]|Exact\/Part)$/);
      return Response.json({ code: 200, data: { componentPageInfo: {
        list, pageNum: 1, pageSize: 100, total: list.length,
      } } });
    },
    datasheetFetcher: async (url, init) => {
      downloads.push(String(url));
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.credentials, 'omit');
      if (String(url).includes('redirect'))
        return Response.redirect('https://foreign.example/document.pdf');
      if (String(url).includes('large'))
        return new Response(bytes, { headers: { 'Content-Length': String(33 * 1024 * 1024) } });
      if (String(url).includes('retry') && !retry) {
        retry = true;
        return new Response('<html>Temporary provider page</html>');
      }
      if (String(url).includes('cancel')) {
        const requestSignal = init?.signal;
        assert.ok(requestSignal);
        cancelStarted();
        return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => {
          cancelObserved();
          reject(requestSignal.reason);
        }, { once: true }));
      }
      return new Response(bytes);
    },
  });
  const request = (body: object, token = host.token, requestSignal?: AbortSignal) =>
    fetch(`${host.base}/api/library-datasheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPE-Token': token },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  const nextInput = { id: 'NextPCB:9728_Exact%2FPart', kind: 'symbols', source: 'huaqiu', page: 1 };
  const withoutSource = { id: nextInput.id, kind: nextInput.kind, page: 1 };
  try {
    assert.equal((await request(nextInput, '')).status, 401);
    assert.equal((await request({ ...nextInput, url: next })).status, 400);
    assert.equal((await request({ ...nextInput, page: 0 })).status, 400);
    assert.equal((await request({ ...nextInput, source: 'lcsc' })).status, 400);
    assert.equal((await request(withoutSource)).status, 400);
    assert.deepEqual(downloads, []);
    for (const [page, source] of [[1, 'huaqiu'], [1, 'jlcpcb'], [2, 'huaqiu'], [2, 'jlcpcb']]) {
      const response = await request({ id: 'Device:Fixture', kind: 'symbols', source, page });
      assert.equal(response.status, 200, `${source} page ${page}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const preview = await response.json();
      assert.deepEqual(Object.keys(preview).sort(), ['image', 'page', 'pageCount']);
      assert.equal(preview.page, page);
      assert.equal(preview.pageCount, 2);
      assert.equal(preview.image.mimeType, 'image/png');
      assert.match(preview.image.data, /^iVBORw0KGgo/);
    }
    assert.deepEqual(downloads, [next, jlc]);
    for (const [id, kind, source, url] of [
      [nextInput.id, 'symbols', 'huaqiu', next],
      [nextInput.id, 'symbols', 'jlcpcb', jlc],
      ['JLCPCB:C123', 'footprints', 'jlcpcb', jlc],
      ['JLCPCB:C123', 'footprints', 'huaqiu', next],
    ]) {
      const response = await request({ id, kind, source, page: 1 });
      assert.equal(response.status, 200, `${id} via ${source}`);
      assert.equal((await response.json()).pageCount, 2);
      assert.equal(downloads.at(-1), url);
    }
    const beforeEmpty = [...downloads];
    for (const [id, source] of [
      ['NextPCB:9728_Blocked', 'huaqiu'],
      ['NextPCB:9728_NoPdf', 'huaqiu'],
      ['Device:Multiple', 'huaqiu'],
      ['JLCPCB:C124', 'jlcpcb'],
    ]) {
      const response = await request({ ...nextInput, id, source });
      assert.equal(response.status, 200);
      assert.equal(await response.json(), null);
    }
    assert.deepEqual(downloads, beforeEmpty);
    for (const name of ['Mismatched', 'Redirect', 'Large', 'Retry']) {
      assert.equal((await request({ ...nextInput, id: 'NextPCB:9728_' + name })).status, 422);
    }
    assert.equal((await request({ ...nextInput, id: 'NextPCB:9728_Retry' })).status, 200);
    const controller = new AbortController();
    const pending = assert.rejects(
      request({ ...nextInput, id: 'NextPCB:9728_Cancel' }, host.token, controller.signal),
      { name: 'AbortError' },
    );
    await started;
    controller.abort();
    await Promise.all([pending, cancelled]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('vendor downloads reject redirects, changed revisions, oversized responses and cancellation', async () => {
  assert.deepEqual(await fetchDatasheet(record, async () => new Response(bytes), signal()), bytes);
  await assert.rejects(
    fetchDatasheet(
      record,
      async () => new Response(Buffer.concat([bytes, Buffer.from('x')])),
      signal(),
    ),
    /byte count/,
  );
  await assert.rejects(
    fetchDatasheet(record, async () => new Response(Buffer.alloc(bytes.length)), signal()),
    /differs/,
  );
  await assert.rejects(
    fetchDatasheet(
      record,
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.test/manual.pdf' } }),
      signal(),
    ),
    /pinned vendor/,
  );
  await assert.rejects(
    fetchDatasheet(
      record,
      async () => new Response(null, { status: 302, headers: { location: '/lit/loop.pdf' } }),
      signal(),
    ),
    /redirect/,
  );
  const control = new AbortController();
  control.abort();
  await assert.rejects(
    fetchDatasheet(record, () => assert.fail(), control.signal),
    { name: 'AbortError' },
  );
});

test('service uses verified local originals, preserves altered files and retries failed downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-datasheet-'));
  const directory = path.join(root, record.example.file, 'datasheets');
  const resolveRecord = (id: string) => (id === record.example.id ? structuredClone(record) : null);
  try {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, record.datasheet.filename);
    await writeFile(file, bytes);
    const local = createDatasheetService({
      roots: { examples: root },
      resolveRecord,
      request: () => assert.fail('local original needs no network'),
    });
    const result: any = await local.page(
      { exampleId: record.example.id, page: 2, image: false },
      signal(),
    );
    assert.match(result.text, /Second page/);
    assert.equal(result.document.sha256, record.datasheet.sha256);
    await writeFile(file, Buffer.alloc(bytes.length));
    const changed = createDatasheetService({
      roots: { examples: root },
      resolveRecord,
      request: () => assert.fail('never replace altered originals'),
    });
    await assert.rejects(
      changed.page({ exampleId: record.example.id, page: 1 }, signal()),
      /differs/,
    );
    let calls = 0;
    const service = createDatasheetService({
      resolveRecord,
      request: async () => new Response(++calls === 1 ? Buffer.alloc(bytes.length) : bytes),
    });
    const input = { exampleId: record.example.id, page: 1, image: false };
    await assert.rejects(service.page(input, signal()), /differs/);
    await service.page(input, signal());
    await service.page({ ...input, page: 2 }, signal());
    assert.equal(calls, 2, 'only successfully verified bytes are cached');
    for (const input of [
      { exampleId: 'foreign', page: 1 },
      { exampleId: record.example.id, page: 3 },
      { exampleId: record.example.id, page: 1, url: 'https://evil.test' },
    ])
      await assert.rejects(service.page(input, signal()));
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('service shutdown cancels active page work and rejects late results and new reads', async () => {
  let release!: () => void;
  let started!: () => void;
  let workerSignal!: AbortSignal;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = createDatasheetService({
    resolveRecord: () => structuredClone(record),
    request: async () => new Response(bytes),
    render: async (
      _bytes: unknown,
      _page: number,
      _image: boolean,
      _count: number,
      signal: AbortSignal,
    ) => {
      workerSignal = signal;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { page: 1, text: 'late data' };
    },
  });
  const input = { exampleId: record.example.id, page: 1 };
  const pending = service.page(input, signal());
  await ready;
  service.close();
  assert.equal(workerSignal.aborted, true);
  release();
  await assert.rejects(pending, /service closed/);
  await assert.rejects(service.page(input, signal()), /service closed/);
});

test('page query is discoverable, validates input, defaults to images and propagates cancellation', async () => {
  const host = createCapabilityHost();
  const calls: unknown[] = [];
  registerWorkbenchCapabilities(
    host,
    () =>
      ({
        revision: () => '1',
        datasheetPage: async (page: number, image: boolean, signal: AbortSignal) => {
          calls.push({ page, image });
          signal.throwIfAborted();
          return { page };
        },
      }) as WorkbenchCapabilityPorts,
  );
  assert.deepEqual(await host.query('project.datasheet.page', { page: 2 }), { page: 2 });
  assert.deepEqual(calls, [{ page: 2, image: true }]);
  await assert.rejects(host.query('project.datasheet.page', { page: 0 }));
  await assert.rejects(host.query('project.datasheet.page', { page: 1, url: 'https://evil.test' }));
  const control = new AbortController();
  control.abort();
  await assert.rejects(
    host.query('project.datasheet.page', { page: 1 }, { signal: control.signal }),
  );
  host.dispose();
});

test('native tool and MCP results deliver actual PNG content without base64 in model text', async () => {
  const result: any = await renderDatasheetPage(bytes, 1, true, 2, signal());
  const args = { name: 'project.datasheet.page', input: { page: 1 } };
  const content = agentCapabilityContent('openpe_query', args, result);
  assert.equal(content.image, result.image.data);
  assert.equal(JSON.parse(content.text).image.data, undefined);
  assert.deepEqual(
    agentCapabilityContent('openpe_query', { name: 'library.datasheet.page' }, result),
    content,
  );
  assert.equal(
    agentCapabilityContent('openpe_query', { name: 'other.query' }, result).image,
    undefined,
  );
  assert.throws(
    () =>
      agentCapabilityContent('openpe_query', args, {
        ...result,
        image: { ...result.image, mimeType: 'text/html' },
      }),
    /Invalid/,
  );
  const input = new PassThrough(),
    output = new PassThrough();
  const response = new Promise<any>((resolve) => {
    let buffer = '';
    output.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) resolve(JSON.parse(buffer.split('\n')[0]));
    });
  });
  const adapter = startAgentMCP({
    input,
    output,
    env: {
      OPENPE_AGENT_BRIDGE_URL:
        'http://127.0.0.1:12345/api/agent-tools/11111111-1111-1111-1111-111111111111',
      OPENPE_AGENT_BRIDGE_TOKEN: 'a'.repeat(64),
    },
    request: async () => new Response(JSON.stringify({ result })),
  });
  try {
    input.write(
      JSON.stringify({
        id: 1,
        method: 'tools/call',
        params: { name: 'openpe_query', arguments: args },
      }) + '\n',
    );
    const message = await response;
    assert.equal(message.result.content[0].type, 'text');
    assert.deepEqual(message.result.content[1], {
      type: 'image',
      mimeType: 'image/png',
      data: result.image.data,
    });
  } finally {
    adapter.close();
    input.end();
    output.end();
  }
});

test('Agent library references use the same bounded catalog reads as the chooser', async (t) => {
  const page = await renderDatasheetPage(bytes, 1, true, 2, signal(), { includeText: false });
  const price = { source: 'lcsc' as const, currency: 'USD', checkedAt: 1, offers: [] };
  const part = { id: 'JLCPCB:C123', kind: 'symbols' as const };
  const quoteInput = { ...part, source: 'lcsc' as const };
  const pageInput = { ...part, source: 'jlcpcb' as const, page: 1 };
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url === '/api/browser-preview/session') return Response.json({ token: 'f'.repeat(64) });
    assert.ok(options.signal);
    if (url === '/api/browser-preview/price') {
      assert.deepEqual(JSON.parse(String(options.body)), quoteInput);
      return Response.json(price);
    }
    assert.equal(url, '/api/browser-preview/datasheet');
    assert.deepEqual(JSON.parse(String(options.body)), pageInput);
    return Response.json(page);
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  const core = new ProjectCore(createProject());
  const host = createCapabilityHost();
  t.after(() => {
    host.dispose();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  registerLibraryCapabilities(host, core);
  const before = core.getSnapshot();
  const actor = { actor: 'agent' } as const;
  assert.deepEqual(
    await host.query('library.price', quoteInput, actor),
    await readLibraryPrice(quoteInput, signal()),
  );
  assert.deepEqual(
    await host.query('library.datasheet.page', pageInput, actor),
    await readLibraryDatasheet(pageInput, signal()),
  );
  await assert.rejects(host.query('library.price', { ...quoteInput, source: 'jlcpcb' }, actor));
  await assert.rejects(host.query('library.datasheet.page', { ...pageInput, page: 0 }, actor));
  await assert.rejects(host.query('library.datasheet.page', { ...pageInput, url: 'invalid' }, actor));
  assert.equal(core.getSnapshot(), before);
});

test('Codex protocol delivers the rendered PDF page as inputImage', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'openpe-pdf-protocol-'));
  try {
    const page = await renderDatasheetPage(bytes, 1, true, 2, signal());
    const events: any[] = [];
    const result = await runAgent(
      'codex',
      { prompt: 'Read the controller datasheet', context: {}, history: [] },
      cwd,
      (event: any) => events.push(event),
      signal(),
      {
        resolve: async () => ({
          file: process.execPath,
          args: [path.resolve('tests/fixtures/agent-datasheet-cli.mjs')],
          env: process.env,
        }),
        capabilities: {
          call: async (tool: string, args: any) => {
            assert.equal(tool, 'openpe_query');
            assert.equal(args.name, 'project.datasheet.page');
            return page;
          },
        },
      },
    );
    assert.equal(result.outcome, 'completed');
    assert.ok(
      events.some(
        (event) => event.type === 'text-delta' && event.delta.includes('PDF image received'),
      ),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('PDF HTTP route requires authentication and rejects foreign origins and arbitrary resource selectors before network I/O', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-pdf-http-'));
  const server = await startServer({
    dataDir,
    datasheetFetcher: () => assert.fail('invalid requests cannot fetch PDFs'),
  });
  const url = `${server.base}/api/datasheets/page`;
  const headers = { 'Content-Type': 'application/json', 'X-OpenPE-Token': server.token };
  try {
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.test' },
          body: '{}',
        })
      ).status,
      403,
    );
    for (const body of [
      { exampleId: 'unknown', page: 1 },
      { exampleId: record.example.id, page: 1, url: 'https://evil.test' },
    ])
      assert.equal(
        (await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status,
        422,
      );
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
