import { createHash } from 'node:crypto';

const id = 'reference-lm25017';
const hash = '0d72432077ca4d5049d1bc6ffa76b56abee9a054860cd5fc6ad0c919139b8351';
const name = 'OPENPE_COMPAT_LM25017';
const fail = (reason) => {
  throw new Error(`LM25017 compatibility preparation failed: ${reason}`);
};

// The original instantaneous cross-coupled NOR equations have two held states.
// Preserve their reset/set gates and all downstream 1 kΩ / 50 pF timing networks;
// represent only the held state through ngspice's event latch. The 1 ps event
// transition is an explicit approximation, not a change to external components.
export const lm25017Latch = `
E_OPENPE_S openpe_sv 0 value={if(v(U2_SET)>2.5 & v(U2_RESET)<=2.5,1,0)}
E_OPENPE_R openpe_rv 0 value={if(v(U2_RESET)>2.5,1,0)}
V_OPENPE_EN openpe_en 0 1
A_OPENPE_ADC [openpe_sv openpe_rv openpe_en] [openpe_sd openpe_rd openpe_end] OPENPE_LATCH_ADC
A_OPENPE_STATE openpe_sd openpe_rd openpe_end null null openpe_qd openpe_qbd OPENPE_LATCH_STATE
A_OPENPE_DAC [openpe_qd openpe_qbd] [openpe_q openpe_qb] OPENPE_LATCH_DAC
.model OPENPE_LATCH_ADC adc_bridge(in_low=0.25 in_high=0.75 rise_delay=1p fall_delay=1p)
.model OPENPE_LATCH_STATE d_srlatch(sr_delay=1p enable_delay=1p set_delay=1p reset_delay=1p rise_delay=1p fall_delay=1p ic=0 sr_load=0 enable_load=0 set_load=0 reset_load=0)
.model OPENPE_LATCH_DAC dac_bridge(out_low=0 out_high=5 out_undef=0 input_load=0 t_rise=1p t_fall=1p)
E_OPENPE_QB U2_QB_ND 0 value={if(v(U2_SET)>=2.5,0,v(openpe_qb))}
E_OPENPE_Q U2_Q_ND 0 value={if(v(U2_RESET)>2.5,0,v(openpe_q))}
`;

export function adaptLm25017(deck, models) {
  const ids = deck.modelIds ?? [];
  if (!ids.includes(id)) return deck;
  if (ids.filter((value) => value === id).length !== 1)
    fail('Expected one original model identity.');
  const bytes = models.get(id);
  if (!Buffer.isBuffer(bytes) || createHash('sha256').update(bytes).digest('hex') !== hash)
    fail('The original model does not match its pinned SHA-256.');
  if (/\bOPENPE_COMPAT_LM25017\b/i.test(deck.netlist)) fail('The deck is already adapted.');
  const original = bytes.toString('utf8');
  const matches = [...original.matchAll(/^\.subckt LM25017\b[\s\S]*?^\.ends LM25017\b[^\n]*/gim)];
  if (matches.length !== 1) fail('Expected one original controller definition.');
  let prototype = matches[0][0];
  const gates = [/^E_U2_E7[^\n]*\n\+[^\n]*$/im, /^E_U2_E8[^\n]*\n\+[^\n]*$/im];
  for (const gate of gates) if (!gate.test(prototype)) fail('Missing original feedback gate.');
  prototype = prototype
    .replace(gates[0], lm25017Latch)
    .replace(gates[1], '')
    .replace(/\bLM25017\b/g, name);
  const include = `.include example-model-${ids.indexOf(id)}.lib`;
  if (deck.netlist.split(/\r?\n/).filter((line) => line.trim() === include).length !== 1)
    fail('The original model include is missing or duplicated.');
  if ((deck.netlist.match(/^\.save\s/gim) ?? []).length !== 1)
    fail('Expected one save declaration.');
  let calls = 0;
  const netlist = deck.netlist.replace(/^X[^\r\n]+/gim, (line) => {
    const words = line.trim().split(/\s+/);
    if (!words.some((word) => /^LM25017$/i.test(word))) return line;
    if (words.length !== 11 || !/^LM25017$/i.test(words.at(-1)))
      fail('Unexpected controller terminals.');
    calls++;
    return line.replace(/LM25017\s*$/i, name);
  });
  if (!calls) fail('Missing controller call.');
  return {
    ...deck,
    netlist: netlist.replace(/^\.save\s/im, `${prototype}\n.save `),
    compatibility: 'psa',
    assumptions: [
      ...deck.assumptions,
      'LM25017 uses an approximate 1 ps event-state closure for its ideal NOR latch; original timing RC networks, terminal mapping and vendor model bytes are retained.',
    ],
  };
}
