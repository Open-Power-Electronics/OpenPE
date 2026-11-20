import { serializeCircuit, snap, type Circuit } from './circuit';
import { partFields } from './library';
import { child, children, parseSExpr, val, type SExpr } from './sexpr';

type Placement = [x: number, y: number, align?: 'left' | 'right'];

// Curated Home example instance fields, checked against rendered glyphs and wiring.
const homeLayouts: Record<
  string,
  Record<string, Partial<Record<'Reference' | 'Value', Placement>>>
> = {
  'emc-flyback-demo': {
    I1: { Value: [383.54, -19.05, 'right'] },
    '#PWR088': { Value: [78.74, 63.5] },
    '#PWR089': { Value: [86.36, 63.5] },
    '#PWR090': { Value: [99.06, 73.66] },
    '#PWR091': { Value: [106.68, 69.85] },
    '#PWR093': { Value: [134.62, 63.5] },
    '#PWR094': { Value: [148.59, 63.5] },
    '#PWR095': { Value: [162.56, 63.5] },
    '#PWR096': { Value: [165.1, 93.98] },
    '#PWR099': { Value: [259.08, 111.76] },
    '#PWR100': { Value: [237.49, 120.65] },
    '#PWR101': { Value: [326.39, 110.49] },
    '#PWR102': { Value: [317.5, 114.3] },
    '#PWR103': { Value: [330.2, 120.65] },
    '#PWR104': { Value: [269.24, 68.58] },
    '#PWR105': { Value: [300.99, 83.82] },
    '#PWR106': { Value: [314.96, 83.82] },
    '#PWR107': { Value: [328.93, 83.82] },
    '#PWR108': { Value: [342.9, 83.82] },
    '#PWR109': { Value: [356.87, 83.82] },
    '#PWR110': { Value: [370.84, 93.98] },
    '#PWR111': { Value: [383.54, 96.52] },
    '#PWR114': { Value: [33.02, 157.48] },
    '#PWR115': { Value: [50.8, 157.48] },
    '#PWR117': { Value: [68.58, 157.48] },
    '#PWR118': { Value: [83.82, 157.48] },
    '#PWR119': { Value: [78.74, 175.26] },
    '#PWR120': { Value: [93.98, 170.18] },
    '#PWR121': { Value: [88.9, 185.42] },
    '#PWR122': { Value: [109.22, 195.58] },
    '#PWR123': { Value: [127, 182.88] },
    '#PWR124': { Value: [142.24, 185.42] },
    '#PWR126': { Value: [203.2, 198.12] },
    '#PWR127': { Value: [238.76, 193.04] },
    '#PWR128': { Value: [254, 167.64] },
    '#PWR129': { Value: [294.64, 156.21] },
    '#PWR130': { Value: [302.26, 158.75] },
    '#PWR131': { Value: [317.5, 173.99] },
    '#PWR132': { Value: [317.5, 184.15] },
    '#PWR133': { Value: [350.52, 176.53] },
    '#PWR134': { Value: [297.18, 198.12] },
    '#PWR135': { Value: [62.23, 86.36] },
    '#PWR136': { Value: [132.08, 116.84] },
    '#PWR137': { Value: [144.78, 116.84] },
    '#PWR138': { Value: [157.48, 116.84] },
    '#PWR139': { Value: [170.18, 116.84] },
    C14: { Value: [320.04, 120.14] },
    C15: { Value: [194.31, 54.61, 'right'], Reference: [201.93, 50.8, 'right'] },
    C17: { Value: [290.83, 65.53] },
    C18: { Value: [303.53, 78.74, 'left'] },
    C19: { Value: [318.77, 77.47, 'left'] },
    C23: { Value: [322.58, 170.94] },
    C24: { Value: [322.58, 181.1] },
    CASE: { Value: [300.99, 113.03] },
    CHAS: { Reference: [170.18, 103.63] },
    CM1: { Value: [74.93, 35.56, 'right'], Reference: [67.31, 33.02, 'left'] },
    CM2: { Value: [69.85, 82.55] },
    CS: { Reference: [81.28, 103.63] },
    D2: { Value: [241.3, 62.23, 'left'] },
    D5: { Value: [170.18, 86.36, 'right'] },
    D6: { Value: [378.46, 86.36, 'right'] },
    DM: { Value: [128.27, 35.56, 'right'], Reference: [118.11, 38.1, 'left'] },
    DRAIN: { Reference: [55.88, 103.63] },
    GATE: { Reference: [68.58, 103.63] },
    HS: { Reference: [93.98, 103.63] },
    J1: { Reference: [22.86, 54.61] },
    J2: { Reference: [22.86, 69.85] },
    J3: { Value: [391.16, 74.93] },
    J4: { Value: [391.16, 92.71] },
    J5: { Value: [304.8, 194.31] },
    L2: { Reference: [124.46, 48.77] },
    MH1: { Reference: [330.2, 181.61] },
    MH2: { Reference: [347.98, 181.61] },
    MH3: { Reference: [365.76, 181.61] },
    MH4: { Reference: [383.54, 181.61] },
    MH5: { Reference: [284.48, 91.44] },
    PGND1: { Reference: [132.08, 103.63] },
    PGND2: { Reference: [144.78, 103.63] },
    Q1: { Reference: [243.84, 98.42, 'left'] },
    R3: { Reference: [153.67, 169.42] },
    R9: { Value: [203.2, 54.61, 'right'], Reference: [209.55, 50.8, 'right'] },
    R10: { Value: [214.63, 57.15, 'right'], Reference: [220.98, 50.8, 'right'] },
    R11: { Reference: [262.89, 101.6, 'left'], Value: [262.89, 104.14, 'left'] },
    R20: { Value: [233.68, 57.15, 'right'], Reference: [231.14, 50.8, 'right'] },
    RG: { Value: [196.85, 107.95] },
    SGND: { Reference: [157.48, 103.63] },
    U3: { Value: [237.49, 187.96, 'right'] },
    U4: { Value: [241.3, 163.83] },
    VBUS: { Reference: [106.68, 103.63] },
    VOUT: { Reference: [119.38, 103.63] },
    YPS: { Value: [341.63, 172.72] },
  },
  'reference-tps61046-bga6-boost': {
    TP1: {
      Reference: [67.31, 69.85, 'right'],
      Value: [67.31, 72.39, 'right'],
    },
    C2: {
      Reference: [96.52, 59.69, 'left'],
      Value: [96.52, 62.23, 'left'],
    },
    C3: {
      Reference: [109.22, 59.69, 'left'],
      Value: [109.22, 62.23, 'left'],
    },
  },
  'reference-lm2735-msop8-sepic': {
    C3: {
      Reference: [133.35, 53.34, 'left'],
      Value: [133.35, 55.88, 'left'],
    },
    L2: {
      Reference: [91.44, 53.34, 'left'],
      Value: [91.44, 55.88, 'left'],
    },
  },
  'reference-lm25017-wson8-flybuck': {
    L1: {
      Reference: [134.62, 54.61],
      Value: [134.62, 57.15],
    },
    R4: {
      Reference: [128.27, 77.47],
      Value: [128.27, 80.01],
    },
    C1: {
      Reference: [38.1, 76.2, 'left'],
      Value: [38.1, 78.74, 'left'],
    },
    R2: {
      Reference: [62.23, 95.25, 'left'],
      Value: [62.23, 97.79, 'left'],
    },
    R3: {
      Reference: [81.28, 76.2],
      Value: [81.28, 78.74],
    },
    R1: {
      Reference: [62.23, 85.09, 'left'],
      Value: [62.23, 87.63, 'left'],
    },
    C6: {
      Reference: [135.89, 67.31, 'right'],
      Value: [135.89, 69.85, 'right'],
    },
    D1: {
      Reference: [123.19, 77.47],
      Value: [123.19, 80.01],
    },
  },
  'reference-lm5001-soic8-boost': {
    R1: {
      Reference: [52.07, 63.5, 'left'],
      Value: [52.07, 66.04, 'left'],
    },
    R2: {
      Reference: [52.07, 77.47, 'left'],
      Value: [52.07, 80.01, 'left'],
    },
    R5: {
      Reference: [160.02, 68.58, 'left'],
      Value: [160.02, 71.12, 'left'],
    },
    R6: {
      Reference: [160.02, 88.9, 'left'],
      Value: [160.02, 91.44, 'left'],
    },
    R3: {
      Reference: [68.58, 93.98, 'left'],
      Value: [68.58, 96.52, 'left'],
    },
    C2: {
      Reference: [101.6, 88.9, 'left'],
      Value: [101.6, 91.44, 'left'],
    },
  },
  'reference-lmr12010-sot236-buck': {
    C2: {
      Reference: [45.72, 72.39, 'left'],
      Value: [45.72, 74.93, 'left'],
    },
    C4: {
      Reference: [149.86, 85.09, 'left'],
      Value: [149.86, 87.63, 'left'],
    },
  },
  'reference-lmr70503-bga8-buckboost': {
    C3: {
      Reference: [97.79, 63.5, 'left'],
      Value: [97.79, 66.04, 'left'],
    },
    C2: {
      Reference: [85.09, 71.12, 'left'],
      Value: [85.09, 73.66, 'left'],
    },
    C4: {
      Reference: [109.22, 63.5, 'left'],
      Value: [109.22, 66.04, 'left'],
    },
    '#PWR05': {
      Value: [120.65, 59.69, 'left'],
    },
  },
  'reference-lm2598-to220-7-buck': {
    R2: {
      Reference: [130.81, 63.5, 'left'],
      Value: [130.81, 66.04, 'left'],
    },
    R3: {
      Reference: [130.81, 83.82, 'left'],
      Value: [130.81, 86.36, 'left'],
    },
    R4: {
      Reference: [146.05, 63.5, 'left'],
      Value: [146.05, 66.04, 'left'],
    },
    C5: {
      Reference: [146.05, 72.39, 'left'],
      Value: [146.05, 74.93, 'left'],
    },
    C4: {
      Reference: [93.98, 76.2, 'left'],
      Value: [93.98, 78.74, 'left'],
    },
  },
};

function place(field: SExpr, [x, y, align]: Placement) {
  const at = child(field, 'at');
  if (at) at.splice(1, at.length - 1, String(x), String(y), '0');
  const effects = child(field, 'effects');
  if (effects) {
    const justify = child(effects, 'justify');
    if (justify && align) justify.splice(1, justify.length - 1, align);
    else if (justify) effects.splice(effects.indexOf(justify), 1);
    else if (align) effects.push(['justify', align]);
  }
}

export function arrangeExampleText(d: Circuit, id: string) {
  if (id.startsWith('reference-') || id === 'emc-flyback-demo') {
    const layout = homeLayouts[id];
    if (!layout) return;
    const instances = new Map(
      children(parseSExpr(serializeCircuit(d)), 'symbol').map((symbol) => [
        val(child(symbol, 'uuid')),
        symbol,
      ]),
    );
    for (const part of d.parts) {
      const pairedTerminal = id === 'reference-lmr12010-sot236-buck' && /^J[1-4]$/.test(part.ref);
      const upperTerminal = part.ref === 'J1' || part.ref === 'J3';
      const referencePulseSource =
        id.startsWith('reference-') &&
        part.ref === 'V1' &&
        partFields(part)['Sim.Type'] === 'PULSE';
      const positions = referencePulseSource
        ? { Value: [snap(part.x + 6.35), snap(part.y - 8.89), 'left'] as Placement }
        : pairedTerminal
          ? {
              Reference: [part.x + 2.54, part.y + (upperTerminal ? -7.62 : 5.08)] as Placement,
              Value: [part.x + 2.54, part.y + (upperTerminal ? -5.08 : 7.62)] as Placement,
            }
          : layout[part.ref];
      if (!positions) continue;
      part.raw ??= instances.get(part.id);
      for (const name of ['Reference', 'Value'] as const) {
        const position = positions[name];
        if (!position) continue;
        const field = children(part.raw!, 'property').find((property) => val(property) === name);
        if (!field) throw new Error(`${id}: missing ${part.ref} ${name} field.`);
        place(field, position);
        child(field, 'at')![3] = String(part.rotation % 180);
      }
    }
    if (d.original) {
      const parts = new Map(d.parts.map((part) => [part.id, part]));
      for (let i = 0; i < d.original.length; i++) {
        const node = d.original[i];
        if (!Array.isArray(node) || node[0] !== 'symbol') continue;
        const raw = parts.get(val(child(node, 'uuid')))?.raw;
        if (raw) d.original[i] = structuredClone(raw);
      }
    }
    return;
  }
}
