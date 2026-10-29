// Declaration discovery only: no body statements, includes or control commands
// from an external library become executable through this parser.
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
      subcircuits.push({
        name,
        declaration: { name, kind: 'subcircuit', pins },
        start: entry.start,
      });
    } else if (/^\.ends(?:\s|$)/i.test(line)) {
      const name = line.split(/\s+/)[1];
      const current = subcircuits.pop();
      if (!current || (name && name.toLowerCase() !== current.name.toLowerCase()))
        throw new Error('Unmatched SPICE subcircuit end.');
      if (!subcircuits.length)
        add(current.declaration, physicalLines.slice(current.start, entry.end + 1).join('\n'));
    } else if (/^\.model(?:\s|$)/i.test(line) && !subcircuits.length) {
      const match = /^\.model\s+(\S+)\s+([A-Za-z][A-Za-z0-9_]{0,31})(?=\s|\(|$)/i.exec(line);
      if (!match || !modelName.test(match[1])) throw new Error('Invalid SPICE model declaration.');
      const device = match[2].toUpperCase();
      add(
        { name: match[1], kind: 'model', device, pins: [...(intrinsicPorts[device] || [])] },
        physicalLines.slice(entry.start, entry.end + 1).join('\n'),
      );
    }
  }
  if (subcircuits.length) throw new Error('Unterminated SPICE subcircuit.');
  if (control) throw new Error('Unterminated SPICE control block.');
  if (!models.length)
    throw new Error('No unambiguous .MODEL or .SUBCKT declarations were found in this file.');
  return { models, issues };
}

module.exports = { MAX_MODEL_BYTES, spiceModelDeclarations };
