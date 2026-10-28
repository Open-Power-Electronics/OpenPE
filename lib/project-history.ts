export type HistoryEntry = { id: string; date: string; message: string };
export type HistoryPage = {
  version: string;
  commits: HistoryEntry[];
  more: boolean;
  needsSave?: boolean;
};
export type ProjectDifference = {
  path: string;
  before: string;
  after: string;
  kind: 'added' | 'removed' | 'changed';
};

function nativeComparisonDocument(value: unknown): unknown {
  const object = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item);
  if (!object(value)) return value;
  const document = value;
  const files = object(document.nativeFiles) ? document.nativeFiles.files : undefined;
  if (
    !Array.isArray(files) ||
    !files.every((file) => object(file) && typeof file.name === 'string')
  )
    return document;
  // A native file set has no file-order meaning. Retain every filename, byte and
  // encoding, so changed supporting files still appear in the complete diff.
  files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const schematic = object(document.schematic) ? document.schematic : undefined;
  const networks = schematic?.nets;
  if (!Array.isArray(networks)) return document;
  const boardNets = networks.filter(
    (net): net is Record<string, unknown> =>
      object(net) && object(net.pcb) && typeof net.id === 'string' && typeof net.name === 'string',
  );
  if (new Set(boardNets.map((net) => net.name)).size !== boardNets.length) return document;
  // KiCad stores net names/numbers, not these private UUIDs. A synchronized net
  // can retain its former derived UUID until reopen. Compare its unique native
  // name while retaining connectivity, object order and the actual name itself.
  const ids = new Map(boardNets.map((net) => [net.id, `native-net:${JSON.stringify(net.name)}`]));
  for (const net of boardNets) net.id = ids.get(net.id);
  const components = Array.isArray(schematic?.components) ? schematic.components : [];
  const board = object(document.pcb) ? document.pcb : undefined;
  const footprints = components.flatMap((part) =>
    object(part) && Array.isArray(part.footprints) ? part.footprints : [],
  );
  if (Array.isArray(board?.footprints)) footprints.push(...board.footprints);
  for (const footprint of footprints)
    if (object(footprint) && Array.isArray(footprint.pads))
      for (const pad of footprint.pads)
        if (object(pad) && ids.has(pad.netId)) pad.netId = ids.get(pad.netId);
  return document;
}

// Compare the complete canonical document, including libraries, PCB and extensions.
// Stable object IDs keep insertion/removal from appearing as many unrelated edits.
export function compareProjectVersions(before: string, after: string, limit = 300) {
  const differences: ProjectDifference[] = [];
  let truncated = false;
  const display = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value, null, 2));
  const record = (path: string, a: unknown, b: unknown) => {
    if (differences.length >= limit) {
      truncated = true;
      return;
    }
    differences.push({
      path,
      before: display(a),
      after: display(b),
      kind: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed',
    });
  };
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = (value: unknown): string | null => {
    if (!object(value)) return null;
    if (typeof value.id === 'string') return value.id;
    if (object(value.schematic) && typeof value.schematic.id === 'string')
      return value.schematic.id;
    return null;
  };
  const name = (value: unknown, id: string) => {
    if (!object(value)) return id;
    return typeof value.reference === 'string' ? `${value.reference} (${id})` : id;
  };
  const visit = (a: unknown, b: unknown, path: string, depth: number) => {
    if (truncated || a === b) return;
    if (depth > 60) {
      if (JSON.stringify(a) !== JSON.stringify(b)) record(path, a, b);
      return;
    }
    if (object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        visit(
          Object.hasOwn(a, key) ? a[key] : undefined,
          Object.hasOwn(b, key) ? b[key] : undefined,
          `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          depth + 1,
        );
        if (truncated) break;
      }
    } else if (Array.isArray(a) && Array.isArray(b)) {
      const idsA = a.map(identity),
        idsB = b.map(identity);
      if (
        idsA.every((id) => id !== null) &&
        idsB.every((id) => id !== null) &&
        new Set(idsA).size === a.length &&
        new Set(idsB).size === b.length
      ) {
        const left = new Map(idsA.map((id, i) => [id, a[i]])),
          right = new Map(idsB.map((id, i) => [id, b[i]]));
        for (const id of new Set([...idsA, ...idsB])) {
          visit(
            left.get(id),
            right.get(id),
            `${path}/${name(right.get(id) ?? left.get(id), id!)}`,
            depth + 1,
          );
          if (truncated) break;
        }
        const sharedA = idsA.filter((id) => right.has(id)),
          sharedB = idsB.filter((id) => left.has(id));
        if (!truncated && JSON.stringify(sharedA) !== JSON.stringify(sharedB))
          record(`${path}/order`, idsA, idsB);
      } else {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          visit(a[i], b[i], `${path}/${i}`, depth + 1);
          if (truncated) break;
        }
      }
    } else record(path || '/', a, b);
  };
  visit(
    nativeComparisonDocument(JSON.parse(before)),
    nativeComparisonDocument(JSON.parse(after)),
    '',
    0,
  );
  return { differences, truncated };
}
