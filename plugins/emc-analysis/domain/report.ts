import { compileCapabilitySchema } from '../../../api/capability-schema';
import { validateEmcReviewResult, type EmcReviewResult } from './review';

/** Original manual review prompts. These are not automated checks or standards. */
export const EMC_MANUAL_CHECKS: readonly {
  id: string;
  title: string;
  prompt: string;
}[] = Object.freeze(
  [
    {
      id: 'switch-current-loop',
      title: 'Switching current loops',
      prompt:
        'Review the complete high-current switching and return paths against the actual operating states. Record supporting circuit and layout evidence; track length alone does not establish loop area.',
    },
    {
      id: 'return-path',
      title: 'Return-path continuity',
      prompt:
        'Confirm the intended return conductors, plane connections and reference changes along each critical signal path. Geometric copper coverage alone does not establish the return-current path.',
    },
    {
      id: 'decoupling-loop',
      title: 'Decoupling connections',
      prompt:
        'Review the assigned capacitors, their supply and return connections, component characteristics and placement. A distance measurement alone does not verify effective decoupling.',
    },
    {
      id: 'external-interface',
      title: 'Cables, filters and shields',
      prompt:
        'Review external cable routes, filtering and protection boundaries, shield terminations and chassis connections in their intended installation. Connector placement alone cannot verify these paths.',
    },
    {
      id: 'stack-up-evidence',
      title: 'Stack-up evidence',
      prompt:
        'Compare the intended layer roles, dielectric properties and layer spacing with the fabrication stack-up. Record missing material or manufacturing evidence rather than assuming it.',
    },
    {
      id: 'differential-evidence',
      title: 'Differential signal paths',
      prompt:
        'Review complete source-to-load paths, pair coupling, termination and reference changes using the signal requirements. Net-length totals are not a differential path or impedance verification.',
    },
    {
      id: 'transient-review',
      title: 'Transient and protection review',
      prompt:
        'Review the intended ESD and transient protection paths and arrange any required electrical safety review separately. This layout review does not qualify protection performance or safety.',
    },
    {
      id: 'measurement-plan',
      title: 'EMC measurement plan',
      prompt:
        'Record the representative hardware configuration, cables, operating modes and measurement plan. Arrange applicable EMC measurements; checklist completion is not a compliance result.',
    },
  ].map((check) => Object.freeze(check)),
);

export type EmcManualReview = {
  checkId: string;
  status: 'unreviewed' | 'reviewed' | 'needs-work';
  notes: string;
};
export type EmcException = { findingId: string; reason: string };
export type EmcReportInput = {
  boardId: string;
  revision: number;
  result: EmcReviewResult;
  manualReviews: EmcManualReview[];
  exceptions: EmcException[];
};
export type EmcReport = EmcReportInput & {
  format: 'openpe-emc-review';
  version: 1;
};

export const EMC_REPORT_LIMITS = Object.freeze({
  jsonBytes: 2 * 1024 * 1024,
  htmlBytes: 8 * 1024 * 1024,
  nodes: 100_000,
  depth: 32,
  noteCharacters: 2000,
  reasonCharacters: 1000,
});

const identity = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const findingIdentity = { ...identity, maxLength: 1800 };
const inputProperties = {
  boardId: identity,
  revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  result: { type: 'object' },
  manualReviews: {
    type: 'array',
    minItems: EMC_MANUAL_CHECKS.length,
    maxItems: EMC_MANUAL_CHECKS.length,
    items: {
      type: 'object',
      required: ['checkId', 'status', 'notes'],
      additionalProperties: false,
      properties: {
        checkId: identity,
        status: { enum: ['unreviewed', 'reviewed', 'needs-work'] },
        notes: { type: 'string', maxLength: EMC_REPORT_LIMITS.noteCharacters },
      },
    },
  },
  exceptions: {
    type: 'array',
    maxItems: 500,
    items: {
      type: 'object',
      required: ['findingId', 'reason'],
      additionalProperties: false,
      properties: {
        findingId: findingIdentity,
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: EMC_REPORT_LIMITS.reasonCharacters,
          pattern: '\\S',
        },
      },
    },
  },
};
const required = Object.keys(inputProperties);
const checkInput = compileCapabilitySchema({
  type: 'object',
  required,
  additionalProperties: false,
  properties: inputProperties,
});
const checkReport = compileCapabilitySchema({
  type: 'object',
  required: ['format', 'version', ...required],
  additionalProperties: false,
  properties: { format: { const: 'openpe-emc-review' }, version: { const: 1 }, ...inputProperties },
});
const encoder = new TextEncoder();

/** Reject coercion, cycles, accessors and unsupported containers before serialization. */
function detachedJson(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > EMC_REPORT_LIMITS.nodes || depth > EMC_REPORT_LIMITS.depth)
      throw new Error('EMC report data exceeds the supported complexity.');
    if (typeof item === 'string') {
      if (
        item.length > EMC_REPORT_LIMITS.jsonBytes ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(item)
      )
        throw new Error('EMC report text is too large or contains unsupported control characters.');
      bytes += encoder.encode(item).byteLength + 2;
    } else if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('EMC report numbers must be finite.');
      bytes += 24;
    } else if (typeof item === 'object') {
      if (ancestors.has(item)) throw new Error('EMC report data must not contain cycles.');
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new Error('EMC report data must contain only plain JSON objects.');
      if (Object.getOwnPropertySymbols(item).length)
        throw new Error('EMC report data must contain only JSON fields.');
      ancestors.add(item);
      let result: unknown;
      if (Array.isArray(item)) {
        if (
          item.length > EMC_REPORT_LIMITS.nodes ||
          Object.keys(item).length !== item.length ||
          Object.getOwnPropertyNames(item).length !== item.length + 1
        )
          throw new Error('EMC report arrays must be bounded and contain explicit JSON entries.');
        result = Array.from({ length: item.length }, (_, index) => {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !('value' in property))
            throw new Error('EMC report data must not contain accessors.');
          return visit(property.value, depth + 1);
        });
      } else {
        const entries = Object.entries(Object.getOwnPropertyDescriptors(item));
        result = Object.fromEntries(
          entries.map(([key, property]) => {
            if (!property.enumerable || !('value' in property))
              throw new Error(
                'EMC report data must contain explicit JSON fields without accessors.',
              );
            visit(key, depth + 1);
            return [key, visit(property.value, depth + 1)];
          }),
        );
      }
      ancestors.delete(item);
      bytes += 2;
      if (bytes > EMC_REPORT_LIMITS.jsonBytes) throw new Error('EMC report JSON exceeds 2 MiB.');
      return result;
    } else throw new Error('EMC report data must contain only JSON values.');
    if (bytes > EMC_REPORT_LIMITS.jsonBytes) throw new Error('EMC report JSON exceeds 2 MiB.');
    return item;
  }
  return visit(value, 0);
}

function jsonText(report: EmcReport): string {
  const text = JSON.stringify(report, null, 2);
  if (encoder.encode(text).byteLength > EMC_REPORT_LIMITS.jsonBytes)
    throw new Error('EMC report JSON exceeds 2 MiB.');
  return text;
}

/** Caller binds this captured result and session state to the checked board/revision. */
export function createEmcReport(input: EmcReportInput): EmcReport {
  const copied = detachedJson(input) as EmcReportInput;
  const validation = checkInput(copied);
  if (!validation.valid) throw new Error(`Invalid EMC report input: ${validation.error}.`);
  const result = validateEmcReviewResult(copied.result);
  const manualIds = new Set(EMC_MANUAL_CHECKS.map((check) => check.id));
  for (const review of copied.manualReviews) {
    if (!manualIds.delete(review.checkId))
      throw new Error('EMC manual reviews must name every current checklist item exactly once.');
  }
  if (manualIds.size)
    throw new Error('EMC manual reviews must explicitly include every current checklist item.');
  const findingIds = new Set(result.findings.map((finding) => finding.id));
  const exceptionIds = new Set<string>();
  for (const exception of copied.exceptions) {
    if (!findingIds.has(exception.findingId))
      throw new Error('An EMC exception must name a finding in this captured result.');
    if (exceptionIds.has(exception.findingId))
      throw new Error('Each EMC finding may have only one justified exception.');
    exceptionIds.add(exception.findingId);
  }
  const report: EmcReport = { format: 'openpe-emc-review', version: 1, ...copied, result };
  jsonText(report);
  return report;
}

function validatedReport(input: EmcReport): EmcReport {
  const copied = detachedJson(input) as EmcReport;
  const validation = checkReport(copied);
  if (!validation.valid) throw new Error(`Invalid EMC report: ${validation.error}.`);
  const { format: _format, version: _version, ...body } = copied;
  return createEmcReport(body);
}

export function serializeEmcReportJson(report: EmcReport): string {
  return jsonText(validatedReport(report));
}

const escapeHtml = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
const list = (items: readonly string[]) =>
  items.length
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>None recorded.</p>';
const label = (value: string) => value.replaceAll('-', ' ');

/** Standalone, inert review artifact; it contains no native project snapshot or executable content. */
export function renderEmcReportHtml(input: EmcReport): string {
  const report = validatedReport(input);
  const { result } = report;
  const exceptions = new Map(
    report.exceptions.map((exception) => [exception.findingId, exception.reason]),
  );
  const manual = new Map(report.manualReviews.map((review) => [review.checkId, review]));
  const findings = result.findings
    .map(
      (finding) => `<article>
<h3>${escapeHtml(finding.title)}</h3>
<p class="meta">${escapeHtml(label(finding.severity))} · ${escapeHtml(label(finding.category))} · ${escapeHtml(finding.confidence)} confidence</p>
<p>${escapeHtml(finding.message)}</p>
${finding.measured ? `<p><strong>Measured:</strong> ${escapeHtml(finding.measured.value)} ${escapeHtml(finding.measured.unit)}${finding.limit ? ` · <strong>User budget:</strong> ${escapeHtml(finding.limit.value)} ${escapeHtml(finding.limit.unit)}` : ''}</p>` : finding.limit ? `<p><strong>User budget:</strong> ${escapeHtml(finding.limit.value)} ${escapeHtml(finding.limit.unit)}</p>` : ''}
<p><strong>Review action:</strong> ${escapeHtml(finding.recommendation)}</p>
<dl><dt>Check / finding</dt><dd>${escapeHtml(finding.checkId)} / ${escapeHtml(finding.id)}</dd><dt>Networks</dt><dd>${escapeHtml(finding.netIds.join(', ') || 'None recorded')}</dd><dt>Objects</dt><dd>${escapeHtml(finding.objectIds.join(', ') || 'None recorded')}</dd>${finding.location ? `<dt>Location, mm</dt><dd>${escapeHtml(finding.location.x)}, ${escapeHtml(finding.location.y)}</dd>` : ''}</dl>
${exceptions.has(finding.id) ? `<div class="exception"><strong>Justified exception:</strong><p>${escapeHtml(exceptions.get(finding.id)!)}</p><p>The original finding and summary count remain unchanged.</p></div>` : ''}
</article>`,
    )
    .join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>OpenPE EMC layout review</title>
<style>body{font:15px/1.55 "Segoe UI",Arial,sans-serif;color:#292929;background:#fff;margin:0}main{max-width:960px;margin:auto;padding:32px 20px}h1{font-size:28px;line-height:1.2}h2{font-size:21px;margin:32px 0 12px}h3{font-size:17px;margin:0 0 8px}p{margin:8px 0}article,section{border-top:1px solid #dbdbdb;padding:16px 0}dl{display:grid;grid-template-columns:minmax(100px,1fr) minmax(0,3fr);gap:4px 16px}dt,.meta{color:#5c5c5c}dd{margin:0}dd,li,p,pre{overflow-wrap:anywhere}pre{font:13px/1.5 Consolas,monospace;white-space:pre-wrap;border:1px solid #dbdbdb;border-radius:10px;padding:12px}.summary{display:flex;flex-wrap:wrap;gap:8px 24px}.exception{margin:12px 0;padding:12px;border-left:3px solid #848484;background:#fafafa}footer{margin-top:32px;padding-top:16px;border-top:1px solid #dbdbdb;color:#5c5c5c}@media print{main{padding:0}article{break-inside:avoid}}</style></head>
<body><main><header><h1>OpenPE EMC layout review</h1>
<p>Partial geometric coverage. This review does not establish EMC compliance.</p>
<dl><dt>Board</dt><dd>${escapeHtml(report.boardId)}</dd><dt>Checked revision</dt><dd>${escapeHtml(report.revision)}</dd><dt>Report format</dt><dd>openpe-emc-review · 1</dd></dl>
</header>
<section><h2>Automated findings</h2><div class="summary"><span>Warnings: ${escapeHtml(result.summary.warning)}</span><span>Information: ${escapeHtml(result.summary.info)}</span><span>Not verified: ${escapeHtml(result.summary.notVerified)}</span></div>
<p>Counts include justified exceptions. Manual review does not change automated coverage.</p>${result.truncated ? '<p>Finding details are truncated. Summary counts include all findings; this report is incomplete.</p>' : ''}
${findings || '<p>No findings were returned for the evaluated inputs. Coverage remains partial.</p>'}</section>
<section><h2>Checks and coverage</h2>${result.checks.map((check) => `<article><h3>${escapeHtml(check.title)}</h3><p class="meta">${escapeHtml(label(check.category))} · ${escapeHtml(label(check.status))}</p>${list(check.notes)}</article>`).join('')}${list(result.notes)}</section>
<section><h2>Manual review</h2>${EMC_MANUAL_CHECKS.map((check) => {
    const review = manual.get(check.id)!;
    return `<article><h3>${escapeHtml(check.title)}</h3><p class="meta">${escapeHtml(label(review.status))}</p><p>${escapeHtml(check.prompt)}</p>${review.notes ? `<p><strong>Reviewer notes:</strong> ${escapeHtml(review.notes)}</p>` : ''}</article>`;
  }).join('')}</section>
<section><h2>Captured design intent</h2><p>Identifiers and budgets below belong to this captured review. Budgets are engineering inputs, not standards limits.</p><pre>${escapeHtml(JSON.stringify(result.input, null, 2))}</pre></section>
<footer>OpenPE · Electrical Engineering Studio. This standalone report is not a native design file, electromagnetic simulation or product qualification. Session exceptions apply only to this captured board, revision and result.</footer>
</main></body></html>`;
  if (encoder.encode(html).byteLength > EMC_REPORT_LIMITS.htmlBytes)
    throw new Error('EMC report HTML exceeds 8 MiB.');
  return html;
}
