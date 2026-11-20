import { createHash } from 'node:crypto';
import { lm2596AdjustableDerivedModel as model } from '../../../server/reference-model-format.mjs';

function fail(detail) {
  throw new Error(`LM2596 adjustable derived-model preparation failed: ${detail}`);
}

function replaceOne(source, pattern, replacement, name) {
  if ((source.match(new RegExp(pattern.source, pattern.flags + 'g')) || []).length !== 1)
    fail(`Expected exactly one original ${name}.`);
  return source.replace(pattern, replacement);
}

/** Deterministic standalone derivative; Latin-1 preserves every original notice byte. */
export function deriveLm2596AdjustableModel(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    createHash('sha256').update(bytes).digest('hex') !== model.sourceSha256
  )
    fail('The original TI 5 V model does not match its pinned SHA-256.');
  let source = bytes.toString('latin1');
  source = replaceOne(
    source,
    /^\.SUBCKT LM2596_5P0_TRANS VIN FB OUT GND ON_OFF_N\r?$/m,
    `.SUBCKT ${model.subcircuit} VIN FB OUT GND ON_OFF_N`,
    'controller declaration',
  );
  source = replaceOne(
    source,
    /^\.ENDS LM2596_5P0_TRANS\r?$/m,
    `.ENDS ${model.subcircuit}`,
    'controller end',
  );
  source = replaceOne(
    source,
    /^E_U1_E5[ \t]+U1_N16912605 0 VALUE \{ V\(FB_INT, GND\) \}[ \t]*\r?$/m,
    'E_U1_E5 U1_N16912605 0 VALUE { V(FB, GND) }',
    'feedback sense',
  );
  source = replaceOne(
    source,
    /^R_RFB2[ \t]+FB FB_INT[ \t]+7\.63k TC=0,0[ \t]*\r?\n/m,
    '',
    'upper internal feedback resistor',
  );
  source = replaceOne(
    source,
    /^R_RFB1[ \t]+GND FB_INT[ \t]+2\.5k TC=0,0[ \t]*\r?\n/m,
    '',
    'lower internal feedback resistor',
  );
  if (/\bFB_INT\b/.test(source)) fail('Unexpected remaining internal feedback node.');
  const notice = [
    '* OpenPE-derived LM2596 adjustable transient model; NOT a TI-issued ADJ model.',
    `* Source: TI SNVMA62 / ${model.sourceSubcircuit}, SHA-256 ${model.sourceSha256}.`,
    '* Changes: renamed controller; removed R_RFB1/R_RFB2; sense external FB directly.',
    '* Original 1.235 V reference, oscillator, compensation, soft start and current limit retained.',
    '* Original vendor copyright/warranty notices and helper subcircuits follow unchanged.',
    '* This derivative does not establish equivalence to a physical LM2596-ADJ.',
    '',
  ].join('\n');
  return Buffer.from(notice + source, 'latin1');
}

/** Select only the compiled, allowlisted derived call; fixed TI controllers stay untouched. */
export function adaptLm2596Adjustable(deck, modelBytesMap) {
  if (!new RegExp(`\\b${model.subcircuit}\\b`, 'i').test(deck.netlist)) return deck;
  const ids = deck.modelIds || [];
  if (ids.filter((id) => id === model.sourceModelId).length !== 1)
    fail('The original TI 5 V model must be referenced exactly once.');
  const derived = deriveLm2596AdjustableModel(modelBytesMap.get(model.sourceModelId)).toString(
    'latin1',
  );
  const include = `example-model-${ids.indexOf(model.sourceModelId)}.lib`;
  const includePattern = new RegExp(
    `^\\.include[ \\t]+${include.replaceAll('.', '\\.')}[ \\t]*$`,
    'gmi',
  );
  if ((deck.netlist.match(includePattern) || []).length !== 1)
    fail('The unchanged original model include is missing or duplicated.');
  if (
    (deck.netlist.match(/^\.save[ \t]/gim) || []).length !== 1 ||
    new RegExp(`^\\.(?:subckt|ends)[ \\t]+${model.subcircuit}\\b`, 'mi').test(deck.netlist)
  )
    fail('Unexpected generated deck structure or pre-existing derivative.');
  let calls = 0;
  for (const line of deck.netlist.match(/^X[^\r\n]+/gim) || []) {
    const words = line.trim().split(/\s+/);
    if (!words.some((word) => word.toUpperCase() === model.subcircuit)) continue;
    if (words.length !== 7 || words.at(-1).toUpperCase() !== model.subcircuit)
      fail('Unexpected generated controller terminal mapping.');
    calls++;
  }
  if (!calls) fail('The generated adjustable controller call is missing.');
  const controller = new RegExp(
    `^\\.SUBCKT ${model.subcircuit}[^\\n]*[\\s\\S]*?^\\.ENDS ${model.subcircuit}[^\\n]*`,
    'mi',
  ).exec(derived)?.[0];
  if (!controller) fail('The generated adjustable controller is missing.');
  return {
    ...deck,
    // The derived subcircuit is inline; apply PSpice conversion to the entire
    // private deck as well as included files, without changing solver options.
    compatibility: 'psa',
    netlist: deck.netlist.replace(
      /^\.save[ \t]/im,
      `* ${model.description}\n* Verified original SHA-256: ${model.sourceSha256}\n${controller}\n.save `,
    ),
    assumptions: [...deck.assumptions, model.description],
  };
}
