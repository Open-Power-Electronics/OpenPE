// Declaration discovery only: no body statements, includes or control commands
// from an external library become executable through this parser.
const { createHash } = require('node:crypto');
const { reviewedModelEntries } = require('../server/spice-model-entrypoints.cjs');
const reviewedEntries = new Map(
  reviewedModelEntries.map(({ sha256, names }) => [
    sha256,
    new Set(names.map((name) => name.toLowerCase())),
  ]),
);
const MAX_MODEL_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 256;
const MAX_PORTS = 64;
const token = /^[A-Za-z0-9_+.$:#-]{1,128}$/;
const modelName = /^[A-Za-z0-9_][A-Za-z0-9_.$:#-]{0,127}$/;
const intrinsicPorts = {
  R: ['1', '2'],
  C: ['1', '2'],
  L: ['1', '2'],
  D: ['A', 'K'],
  NPN: ['C', 'B', 'E'],
  PNP: ['C', 'B', 'E'],
  NMOS: ['D', 'G', 'S', 'B'],
  PMOS: ['D', 'G', 'S', 'B'],
  VDMOS: ['D', 'G', 'S'],
  NJF: ['D', 'G', 'S'],
  PJF: ['D', 'G', 'S'],
};

// Read only instance identifiers and model-name positions. Bodies, expressions,
// includes and control statements are never interpreted or executed.
function instanceModel(line) {
  const pieces = line.split(/\s+/);
  const kind = pieces[0][0]?.toUpperCase();
  if (kind === 'X') {
    const parameters = pieces.findIndex(
      (piece, index) => index > 0 && (/^params?:/i.test(piece) || piece.includes('=')),
    );
    const name = pieces[(parameters < 0 ? pieces.length : parameters) - 1];
    return modelName.test(name || '') ? [{ kind: 'subcircuit', name: name.toLowerCase() }] : [];
  }
  const positions =
    {
      D: [3],
      Q: [4, 5],
      M: [5],
      J: [4],
      R: [3],
      C: [3],
      L: [3],
      S: [5],
      W: [4],
      A: [pieces.length - 1],
    }[kind] || [];
  return positions.flatMap((index) => {
    const name = pieces[index]?.split('(')[0];
    return modelName.test(name || '') ? [{ kind: 'model', name: name.toLowerCase() }] : [];
  });
}

function spiceModelDeclarations(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_MODEL_BYTES)
    throw new Error('Choose a nonempty SPICE library up to 2 MiB.');
  // Declaration names and ports are ASCII. Vendor comment/body bytes are opaque
  // 8-bit text, preserving current pinned libraries without transcoding them.
  const text = bytes.toString('latin1').replace(/^\xef\xbb\xbf/, '');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new Error('Choose a text SPICE model file without binary content.');
  const logical = [];
  const physicalLines = text.split(/\r\n|\n|\r/);
  for (const [index, physical] of physicalLines.entries()) {
    const line = physical.trim();
    if (!line || line.startsWith('*')) continue;
    if (line.startsWith('+')) {
      if (!logical.length) throw new Error('Invalid SPICE continuation line.');
      logical[logical.length - 1].line += ' ' + line.slice(1).trim();
      logical[logical.length - 1].end = index;
      if (logical[logical.length - 1].line.length > 65536)
        throw new Error('SPICE declaration or statement exceeds the text limit.');
    } else {
      if (line.length > 65536)
        throw new Error('SPICE declaration or statement exceeds the text limit.');
      logical.push({ line, start: index, end: index });
    }
  }
  const models = [];
  const names = new Map();
  const ambiguous = new Set();
  const issues = [];
  const subcircuits = [];
  const dependencies = new Map();
  let control = false;
  const add = (declaration, source) => {
    const identity = declaration.name.toLowerCase();
    if (ambiguous.has(identity)) return;
    if (names.has(identity)) {
      if (names.get(identity) === source) return;
      ambiguous.add(identity);
      const previous = models.findIndex((model) => model.name.toLowerCase() === identity);
      const label = models[previous].name;
      models.splice(previous, 1);
      issues.push(`Skipped ambiguous model: ${label}.`);
      return;
    }
    if (names.size >= MAX_MODELS) throw new Error('A SPICE library may expose at most 256 models.');
    names.set(identity, source);
    models.push(declaration);
  };
  for (const entry of logical) {
    const line = entry.line
      .replace(/;.*$/, '')
      .replace(/\s+\$.*$/, '')
      .trim();
    if (/^\.control(?:\s|$)/i.test(line)) {
      if (control) throw new Error('Nested SPICE control block.');
      control = true;
      continue;
    }
    if (/^\.endc(?:\s|$)/i.test(line)) {
      if (!control) throw new Error('Unmatched SPICE control end.');
      control = false;
      continue;
    }
    if (control) continue;
    if (/^\.subckt(?:\s|$)/i.test(line)) {
      const pieces = line.split(/\s+/);
      const name = pieces[1];
      if (!name || !modelName.test(name)) throw new Error('Invalid SPICE subcircuit name.');
      const pins = [];
      for (const pin of pieces.slice(2)) {
        if (/^params?:/i.test(pin) || pin.includes('=')) break;
        if (!token.test(pin)) throw new Error(`Invalid port in SPICE subcircuit ${name}.`);
        if (pins.some((existing) => existing.toLowerCase() === pin.toLowerCase()))
          throw new Error(`Duplicate port in SPICE subcircuit ${name}.`);
        if (pins.length >= MAX_PORTS)
          throw new Error('A SPICE subcircuit may expose at most 64 ports.');
        pins.push(pin);
      }
      if (!pins.length) throw new Error(`SPICE subcircuit ${name} has no declared ports.`);
      if (subcircuits.length >= 16) throw new Error('SPICE subcircuit nesting exceeds the limit.');
      subcircuits.at(-1)?.locals.add(`subcircuit:${name.toLowerCase()}`);
      subcircuits.push({
        name,
        declaration: { name, kind: 'subcircuit', pins },
        start: entry.start,
        locals: new Set(),
        references: new Set(),
      });
    } else if (/^\.ends(?:\s|$)/i.test(line)) {
      const name = line.split(/\s+/)[1];
      const current = subcircuits.pop();
      if (!current || (name && name.toLowerCase() !== current.name.toLowerCase()))
        throw new Error('Unmatched SPICE subcircuit end.');
      const references = [...current.references].filter(
        (reference) => !current.locals.has(reference),
      );
      if (!subcircuits.length) {
        add(current.declaration, physicalLines.slice(current.start, entry.end + 1).join('\n'));
        dependencies.set(current.name.toLowerCase(), references);
      } else {
        for (const reference of references) subcircuits.at(-1).references.add(reference);
      }
    } else if (/^\.model(?:\s|$)/i.test(line)) {
      const match = /^\.model\s+(\S+)\s+([A-Za-z][A-Za-z0-9_]{0,31})(?=\s|\(|$)/i.exec(line);
      if (!match || !modelName.test(match[1])) throw new Error('Invalid SPICE model declaration.');
      const device = match[2].toUpperCase();
      if (subcircuits.length) subcircuits.at(-1).locals.add(`model:${match[1].toLowerCase()}`);
      else
        add(
          { name: match[1], kind: 'model', device, pins: [...(intrinsicPorts[device] || [])] },
          physicalLines.slice(entry.start, entry.end + 1).join('\n'),
        );
    } else if (subcircuits.length && !line.startsWith('.')) {
      for (const reference of instanceModel(line))
        subcircuits.at(-1).references.add(`${reference.kind}:${reference.name}`);
    }
  }
  if (subcircuits.length) throw new Error('Unterminated SPICE subcircuit.');
  if (control) throw new Error('Unterminated SPICE control block.');
  if (!models.length)
    throw new Error('No unambiguous .MODEL or .SUBCKT declarations were found in this file.');
  const reviewed = reviewedEntries.get(createHash('sha256').update(bytes).digest('hex'));
  const referenced = new Set(
    models.flatMap((model) => dependencies.get(model.name.toLowerCase()) || []),
  );
  const devices = models.filter((model) =>
    reviewed
      ? reviewed.has(model.name.toLowerCase())
      : !referenced.has(`${model.kind}:${model.name.toLowerCase()}`),
  );
  return { models: devices, issues };
}

module.exports = { MAX_MODEL_BYTES, spiceModelDeclarations };
