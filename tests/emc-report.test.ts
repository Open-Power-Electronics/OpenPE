import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMC_MANUAL_CHECKS,
  EMC_REPORT_LIMITS,
  createEmcReport,
  renderEmcReportHtml,
  serializeEmcReportJson,
  type EmcReport,
  type EmcReportInput,
} from '../plugins/emc-analysis/domain/report';
import {
  EMC_REVIEW_CHECKS,
  EMC_REVIEW_DEFAULT_LIMITS,
  type EmcReviewResult,
} from '../plugins/emc-analysis/domain/review';

function review(): EmcReviewResult {
  return {
    completeness: 'partial',
    input: {
      nets: [{ netId: 'switch', role: 'switching' }],
      limits: { ...EMC_REVIEW_DEFAULT_LIMITS },
      decoupling: [],
      edgeConnectorIds: [],
    },
    findings: [
      {
        id: 'finding-one',
        checkId: 'route-length',
        category: 'routing',
        severity: 'warning',
        confidence: 'geometric',
        title: 'Track length review',
        message: 'A selected network exceeds the user length budget.',
        recommendation: 'Review the complete signal and return path.',
        netIds: ['switch'],
        objectIds: ['track-one'],
        location: { x: 3, y: 4 },
        measured: { value: 120, unit: 'mm' },
        limit: { value: 100, unit: 'mm' },
      },
    ],
    checks: EMC_REVIEW_CHECKS.map((check) => ({ ...check, status: 'checked', notes: [] })),
    summary: { warning: 1, info: 0, notVerified: 0 },
    truncated: false,
    notes: ['Geometry does not establish an EMC measurement.'],
  };
}
function input(): EmcReportInput {
  return {
    boardId: 'board-one',
    revision: 12,
    result: review(),
    exceptions: [],
    manualReviews: EMC_MANUAL_CHECKS.map((check) => ({
      checkId: check.id,
      status: 'unreviewed',
      notes: '',
    })),
  };
}

test('EMC report preserves captured evidence and explicit manual state in detached JSON', () => {
  const source = input();
  source.manualReviews[0] = {
    ...source.manualReviews[0],
    status: 'needs-work',
    notes: 'Review loop on next revision.',
  };
  const before = structuredClone(source);
  const report = createEmcReport(source);
  assert.deepEqual(source, before);
  assert.equal(report.format, 'openpe-emc-review');
  assert.equal(report.version, 1);
  assert.deepEqual(report.result, source.result);
  assert.deepEqual(report.manualReviews, source.manualReviews);
  assert.equal(report.boardId, 'board-one');
  assert.equal(report.revision, 12);
  assert.notEqual(report.result, source.result);
  assert.notEqual(report.manualReviews[0], source.manualReviews[0]);
  report.result.findings[0].objectIds.push('consumer-only');
  report.manualReviews[0].notes = 'consumer-only';
  assert.deepEqual(source, before);
  const serialized = serializeEmcReportJson(createEmcReport(source));
  assert.deepEqual(JSON.parse(serialized), createEmcReport(source));
  assert.equal(serialized.includes('nativeFiles'), false);
  assert.equal(serialized.includes('kicad_pcb'), false);
});

test('manual reviews and justified exceptions never upgrade automated missing coverage or remove counts', () => {
  const source = input();
  source.result.findings.push({
    id: 'missing-reference',
    checkId: 'reference-fill',
    category: 'reference',
    severity: 'not-verified',
    confidence: 'missing',
    title: 'Reference evidence missing',
    message: 'No reference evidence was supplied.',
    recommendation: 'Provide current evidence.',
    netIds: ['switch'],
    objectIds: [],
  });
  source.result.summary.notVerified = 1;
  source.result.checks.find((check) => check.id === 'reference-fill')!.status = 'not-verified';
  source.manualReviews = source.manualReviews.map((item) => ({ ...item, status: 'reviewed' }));
  source.exceptions = [
    { findingId: 'finding-one', reason: 'The complete path is reviewed separately.' },
  ];
  const report = createEmcReport(source);
  assert.equal(report.result.completeness, 'partial');
  assert.deepEqual(report.result.summary, { warning: 1, info: 0, notVerified: 1 });
  assert.equal(report.result.findings.length, 2);
  assert.equal(
    report.result.checks.find((check) => check.id === 'reference-fill')!.status,
    'not-verified',
  );
  const html = renderEmcReportHtml(report);
  assert.match(html, /Warnings: 1/);
  assert.match(html, /Not verified: 1/);
  assert.match(html, /Justified exception/);
  assert.match(html, /original finding and summary count remain unchanged/);
  assert.match(html, /Manual review does not change automated coverage/);
});

test('report rejects incomplete, duplicate or unsupported session states without inventing entries', () => {
  const variants: unknown[] = [];
  let next = input();
  next.manualReviews.pop();
  variants.push(next);
  next = input();
  next.manualReviews[1] = { ...next.manualReviews[0] };
  variants.push(next);
  next = input();
  next.manualReviews[0].checkId = 'unknown';
  variants.push(next);
  next = input();
  next.manualReviews[0].notes = 'x'.repeat(2001);
  variants.push(next);
  variants.push({ ...input(), revision: -1 });
  variants.push({ ...input(), revision: 1.5 });
  variants.push({ ...input(), revision: Number.MAX_SAFE_INTEGER + 1 });
  variants.push({ ...input(), boardId: '   ' });
  variants.push({ ...input(), path: '/private' });
  next = input();
  (next.manualReviews[0] as unknown as { status: string }).status = 'passed';
  variants.push(next);
  next = input();
  (next.manualReviews[0] as unknown as Record<string, unknown>).author = 'extra';
  variants.push(next);
  for (const value of variants) assert.throws(() => createEmcReport(value as EmcReportInput));
  assert.equal(
    createEmcReport(input()).manualReviews.every((item) => item.status === 'unreviewed'),
    true,
  );
});

test('exceptions require one nonblank bounded reason and a current captured finding', () => {
  for (const exceptions of [
    [{ findingId: 'missing', reason: 'Reviewed' }],
    [{ findingId: 'finding-one', reason: '' }],
    [{ findingId: 'finding-one', reason: ' \n\t ' }],
    [{ findingId: 'finding-one', reason: 'x'.repeat(1001) }],
    [
      { findingId: 'finding-one', reason: 'Reviewed' },
      { findingId: 'finding-one', reason: 'Again' },
    ],
    [{ findingId: 'finding-one', reason: 'Reviewed', author: 'unsupported' }],
  ])
    assert.throws(() => createEmcReport({ ...input(), exceptions } as EmcReportInput));
  const reason = '  Deliberate\nreviewed choice.  ';
  const report = createEmcReport({
    ...input(),
    exceptions: [{ findingId: 'finding-one', reason }],
  });
  assert.equal(report.exceptions[0].reason, reason, 'Validation never trims a justification.');
});

test('standalone HTML escapes arbitrary evidence, identifiers and reviewer text with no executable assets', () => {
  const source = input();
  const hostile = `<img src=x onerror="alert('x')"> & </style><script>alert(1)</script>`;
  source.boardId = `<board "one"> & 'two'`;
  source.result.findings[0].title = hostile;
  source.result.findings[0].message = hostile;
  source.result.findings[0].recommendation = hostile;
  source.result.findings[0].objectIds = [`<track-one>`];
  source.result.findings[0].netIds = [`<switch>`];
  source.result.notes = [hostile];
  source.manualReviews[0].notes = hostile;
  source.exceptions = [{ findingId: 'finding-one', reason: hostile }];
  const html = renderEmcReportHtml(createEmcReport(source));
  assert.equal(html.includes(hostile), false);
  assert.equal(/<script|<img|<iframe|<svg|<link\b/i.test(html), false);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(&#39;x&#39;\)&quot;&gt;/);
  assert.match(html, /&lt;board &quot;one&quot;&gt; &amp; &#39;two&#39;/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /Checked revision/);
  assert.match(html, />12<\/dd>/);
  assert.match(html, /Captured design intent/);
  assert.match(html, /This review does not establish EMC compliance/);
});

test('serialized reports revalidate their format, numeric values, schemas and automated counts', () => {
  const source = createEmcReport(input());
  const variants: unknown[] = [
    { ...source, version: 2 },
    { ...source, format: 'native-design' },
    { ...source, destination: 'private' },
    { ...source, revision: Infinity },
  ];
  let report = structuredClone(source);
  report.result.findings[0].measured!.value = NaN;
  variants.push(report);
  report = structuredClone(source);
  report.result.summary.warning = 0;
  variants.push(report);
  report = structuredClone(source);
  (report.result as unknown as Record<string, unknown>).unknown = true;
  variants.push(report);
  report = structuredClone(source);
  report.result.findings[0].checkId = 'unknown';
  variants.push(report);
  for (const value of variants) {
    assert.throws(() => serializeEmcReportJson(value as EmcReport));
    assert.throws(() => renderEmcReportHtml(value as EmcReport));
  }
});

test('report transport rejects non-JSON containers, hidden fields, accessors, cycles and complexity excess', () => {
  const cyclic = input() as unknown as Record<string, unknown>;
  cyclic.extra = cyclic;
  const getter = input();
  Object.defineProperty(getter, 'extra', {
    get: () => {
      throw new Error('must not execute');
    },
    enumerable: true,
  });
  const hidden = input();
  Object.defineProperty(hidden, 'extra', { value: 'private' });
  const symbol = input();
  Object.defineProperty(symbol, Symbol('extra'), { value: 'private' });
  for (const value of [
    { ...input(), revision: BigInt(1) },
    { ...input(), result: new Date() },
    { ...input(), manualReviews: new Map() },
    cyclic,
    getter,
    hidden,
    symbol,
  ])
    assert.throws(() => createEmcReport(value as EmcReportInput));
  const tooLarge = input() as unknown as Record<string, unknown>;
  tooLarge.extra = 'x'.repeat(EMC_REPORT_LIMITS.jsonBytes + 1);
  assert.throws(() => createEmcReport(tooLarge as EmcReportInput), /too large|2 MiB/);
  const tooDeep = input() as unknown as Record<string, unknown>;
  let container = tooDeep;
  for (let index = 0; index <= EMC_REPORT_LIMITS.depth; index++) {
    container.extra = {};
    container = container.extra as Record<string, unknown>;
  }
  assert.throws(() => createEmcReport(tooDeep as EmcReportInput), /complexity/);
  const notes = input();
  notes.manualReviews[0].notes = 'control\u0000text';
  assert.throws(() => createEmcReport(notes), /control characters/);
});

test('reports retain truncated finding counts and enforce limits on valid report payloads', () => {
  const source = input();
  source.result.findings = Array.from({ length: 500 }, (_, index) => ({
    ...source.result.findings[0],
    id: `retained-${index}`,
  }));
  source.result.summary.warning = 501;
  source.result.truncated = true;
  const report = createEmcReport(source);
  assert.equal(JSON.parse(serializeEmcReportJson(report)).result.findings.length, 500);
  const html = renderEmcReportHtml(report);
  assert.match(html, /Warnings: 501/);
  assert.match(html, /Finding details are truncated/);

  const oversized = input();
  oversized.result.findings = Array.from({ length: 500 }, (_, index) => ({
    ...oversized.result.findings[0],
    id: `large-${index}`,
    title: 'x'.repeat(2000),
    message: 'x'.repeat(2000),
    recommendation: 'x'.repeat(2000),
  }));
  oversized.result.summary.warning = 500;
  assert.throws(() => createEmcReport(oversized), /2 MiB/);

  const escaped = input();
  escaped.result.findings = Array.from({ length: 340 }, (_, index) => ({
    ...escaped.result.findings[0],
    id: `escaped-${index}`,
    title: "'".repeat(2000),
    message: "'".repeat(2000),
    recommendation: "'".repeat(1000),
  }));
  escaped.result.summary.warning = 340;
  const compact = createEmcReport(escaped);
  assert.ok(
    new TextEncoder().encode(serializeEmcReportJson(compact)).byteLength <
      EMC_REPORT_LIMITS.jsonBytes,
  );
  assert.throws(() => renderEmcReportHtml(compact), /8 MiB/);
});
