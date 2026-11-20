import { createHash } from 'node:crypto';
import { adaptLm2596Adjustable } from './spice-lm2596-adj.mjs';
import { adaptLm25017 } from './spice-lm25017.mjs';

const modelId = 'reference-lmr70503';
const modelSha256 = '1d661a243a8a44cab8f6e67448dfdafcc96249dea54f35927b25283e01e7aba9';
const compatibilityName = 'OPENPE_COMPAT_LMR70503_TRANS';

function fail(detail) {
  throw new Error(`LMR70503 compatibility preparation failed: ${detail}`);
}

function block(source, name) {
  const starts = source.match(new RegExp(`^\\.subckt[ \\t]+${name}\\b`, 'gmi')) || [];
  const ends = source.match(new RegExp(`^\\.ends[ \\t]+${name}\\b`, 'gmi')) || [];
  if (starts.length !== 1 || ends.length !== 1)
    fail(`Expected exactly one original ${name} subcircuit.`);
  const result = new RegExp(
    `^\\.subckt[ \\t]+${name}\\b[\\s\\S]*?^\\.ends[ \\t]+${name}\\b[^\\n]*`,
    'mi',
  ).exec(source)?.[0];
  if (!result || (result.match(/^\.subckt\b/gim) || []).length !== 1)
    fail(`Unexpected original ${name} subcircuit boundaries.`);
  return result;
}

function replaceOne(source, pattern, replacement, name) {
  const matches = source.match(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'));
  if (matches?.length !== 1) fail(`Expected exactly one ${name}.`);
  return source.replace(pattern, replacement);
}

function controllerAdapter(source) {
  const controller = block(source, 'LMR70503_TRANS')
    .replace(/\bLMR70503_TRANS\b/gi, compatibilityName)
    .replace(/\bONE_SHOT\b/gi, 'OPENPE_COMPAT_ONE_SHOT')
    .replace(/\bCtrl_one_shot\b/gi, 'OPENPE_COMPAT_CTRL_ONE_SHOT');
  const controlled = block(source, 'Ctrl_one_shot')
    .replace(/\bCtrl_one_shot\b/gi, 'OPENPE_COMPAT_CTRL_ONE_SHOT')
    .replace(/\bONE_SHOT\b/gi, 'OPENPE_COMPAT_ONE_SHOT');
  let timer = block(source, 'one_shot').replace(/\bone_shot\b/gi, 'OPENPE_COMPAT_ONE_SHOT');
  timer = replaceOne(
    timer,
    /^e_abm1\s+ch\s+0[^\n]+/im,
    'e_abm1 ch 0 value={ if( v(in)>0.5 | v(q)>0.5,1,0)}',
    'timer charge gate',
  );
  timer = replaceOne(
    timer,
    /^e_abm3\s+out\s+0[^\n]+/im,
    'e_abm3 out 0 value={ if( v(meas)<0.5 & v(q)>0.5,1,0)}',
    'timer output gate',
  );
  // Retain the vendor timing/reset R,C and switch. Event state closes the
  // instantaneous feedback loop; this is an approximation, especially near reset.
  timer = replaceOne(
    timer,
    /^\.ends /im,
    `
* OpenPE approximate event-state closure; original timer/reset R,C,switch retained.
E_SET set_v 0 value={if(v(in)>0.5 & v(meas)<0.5,1,0)}
E_RESET reset_v 0 value={if(v(meas)>=0.5,1,0)}
V_ENABLE enable_v 0 1
A_ADC [set_v reset_v enable_v] [set_d reset_d enable_d] OPENPE_COMPAT_ADC
A_STATE set_d reset_d enable_d null null state_d statebar_d OPENPE_COMPAT_STATE
A_DAC [state_d] [q] OPENPE_COMPAT_DAC
.model OPENPE_COMPAT_ADC adc_bridge(in_low=0.25 in_high=0.75 rise_delay=1p fall_delay=1p)
.model OPENPE_COMPAT_STATE d_srlatch(sr_delay=1p enable_delay=1p set_delay=1p reset_delay=1p
+ rise_delay=1p fall_delay=1p ic=0 sr_load=0 enable_load=0 set_load=0 reset_load=0)
.model OPENPE_COMPAT_DAC dac_bridge(out_low=0 out_high=1 out_undef=0.5 input_load=0 t_rise=1p t_fall=1p)
.ends `,
    'timer end',
  );
  return `\n* OpenPE compatibility approximation derived from the unchanged, separately included TI model.\n${controller}\n${controlled}\n${timer}\n`;
}

/**
 * Service-only preparation after resolving and verifying original model files.
 * No project flag, renderer netlist, or alternate model bytes select this adapter.
 * Original files, notices, physical terminals, timing, and numerical options stay
 * in their owners; only private generated controller subcircuits are adapted here.
 * @param {import('../domain/spice').SpiceDeck} deck
 * @param {Map<string, Buffer>} modelBytesMap
 * @returns {import('../domain/spice').SpiceDeck}
 */
export function adaptSpiceModels(deck, modelBytesMap) {
  deck = adaptLm2596Adjustable(deck, modelBytesMap);
  deck = adaptLm25017(deck, modelBytesMap);
  const ids = deck.modelIds || [];
  if (!ids.includes(modelId)) return deck;
  if (ids.filter((id) => id === modelId).length !== 1)
    fail('The official model must be referenced exactly once.');
  const bytes = modelBytesMap.get(modelId);
  if (!Buffer.isBuffer(bytes)) fail('The verified original model bytes are missing.');
  if (createHash('sha256').update(bytes).digest('hex') !== modelSha256)
    fail('The original model does not match its pinned SHA-256.');
  if (/\bOPENPE_COMPAT_[A-Z0-9_]+\b/i.test(deck.netlist))
    fail('The generated deck already contains compatibility subcircuits.');
  if ((deck.netlist.match(/^\.save[ \t]/gim) || []).length !== 1)
    fail('Expected exactly one generated save declaration.');
  const include = `example-model-${ids.indexOf(modelId)}.lib`;
  const includePattern = new RegExp(
    `^\\.include[ \\t]+${include.replaceAll('.', '\\.')}[ \\t]*$`,
    'gmi',
  );
  if ((deck.netlist.match(includePattern) || []).length !== 1)
    fail('The unchanged original model include is missing or duplicated.');
  let calls = 0;
  const netlist = deck.netlist.replace(/^X[^\r\n]+/gim, (line) => {
    const words = line.trim().split(/\s+/);
    if (!words.some((word) => /^LMR70503_TRANS$/i.test(word))) return line;
    if (words.length !== 9 || !/^LMR70503_TRANS$/i.test(words.at(-1)))
      fail('Unexpected generated controller terminal mapping.');
    calls++;
    return line.replace(/LMR70503_TRANS[ \t]*$/i, compatibilityName);
  });
  if (!calls) fail('The generated controller call is missing.');
  const prototype = controllerAdapter(bytes.toString('utf8'));
  return {
    ...deck,
    netlist: netlist.replace(/^\.save[ \t]/im, `${prototype}\n.save `),
    compatibility: 'psa',
    assumptions: [
      ...deck.assumptions,
      'LMR70503 uses an approximate ngspice event-state closure with the original timing RC/reset network; near-reset pulse timing may differ from PSpice.',
    ],
  };
}
