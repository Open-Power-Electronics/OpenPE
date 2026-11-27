import type { PCB } from './pcb';

type Copper = {
  id: string;
  kind: string;
  netId: string | null;
  layers: readonly string[];
  minX: number;
  maxX: number;
};

type Footprint = PCB['footprints'][number];
type Pad = Footprint['pads'][number];
type Group = Set<string>;
type Owner = { footprint: Footprint; pad?: Pad; group?: Group };
type Tie = { pads: Set<string>; nets: Set<string> };

const key = (kind: string, id: string) => `${kind}:${id}`;
const artwork = (copper: Copper) => copper.kind === 'graphic' || copper.kind === 'zone';

/** Associate native net-tie allowances with physical footprint copper. Each
 * layer is independent, and a declaration does not merge board-wide nets.
 */
export function preparePCBNetTies<T extends Copper>(
  board: PCB,
  bodies: readonly T[],
  touches: (a: T, b: T) => boolean,
  spend: () => void,
  reportShort: (footprint: Footprint, first: Pad, second: Pad, bridge?: T) => void,
) {
  const owners = new Map<string, Owner>();
  for (const footprint of board.footprints) {
    if (!footprint.netTiePadGroups?.length) continue;
    const byNumber = new Map<string, Group>();
    for (const declaration of footprint.netTiePadGroups) {
      const group = new Set(declaration.split(',').map((number) => number.trim()));
      for (const number of group) byNumber.set(number, group);
    }
    for (const pad of footprint.pads)
      owners.set(key('pad', pad.id), { footprint, pad, group: byNumber.get(pad.number) });
    for (const graphic of footprint.graphics) owners.set(key('graphic', graphic.id), { footprint });
    for (const zone of footprint.zones ?? []) owners.set(key('zone', zone.id), { footprint });
  }

  const byFootprint = new Map<Footprint, Map<string, T[]>>();
  const owner = (copper: T) => owners.get(key(copper.kind, copper.id));
  for (const copper of bodies) {
    const item = owner(copper);
    if (!item) continue;
    let layers = byFootprint.get(item.footprint);
    if (!layers) byFootprint.set(item.footprint, (layers = new Map()));
    for (const layer of copper.layers) {
      let items = layers.get(layer);
      if (!items) layers.set(layer, (items = []));
      items.push(copper);
    }
  }

  const membership = new Map<T, Map<string, Tie>>();
  const entries = new Map<T, Map<string, Set<string>>>();
  const recognizeEntry = (graphic: T, candidate: T, layer: string) => {
    const terminal = owner(candidate);
    if (!artwork(graphic) || !terminal?.group || !candidate.netId) return;
    let layers = entries.get(graphic);
    if (!layers) entries.set(graphic, (layers = new Map()));
    let nets = layers.get(layer);
    if (!nets) layers.set(layer, (nets = new Set()));
    nets.add(candidate.netId);
  };
  const reportedShorts = new Set<string>();
  for (const [footprint, layers] of byFootprint) {
    for (const [layer, items] of layers) {
      items.sort((a, b) => a.minX - b.minX);
      const parent = items.map((_, index) => index);
      const root = (index: number) => {
        while (parent[index] !== index) {
          parent[index] = parent[parent[index]];
          index = parent[index];
        }
        return index;
      };
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length && items[j].minX <= items[i].maxX + 0.00001; j++) {
          spend();
          const a = items[i];
          const b = items[j];
          const first = root(i),
            second = root(j);
          if (
            first === second &&
            !((artwork(a) && b.kind === 'pad') || (artwork(b) && a.kind === 'pad'))
          )
            continue;
          if (!touches(a, b)) continue;
          parent[second] = first;
          recognizeEntry(a, b, layer);
          recognizeEntry(b, a, layer);
        }
      }
      const components = new Map<number, T[]>();
      for (const [index, copper] of items.entries()) {
        const id = root(index);
        let component = components.get(id);
        if (!component) components.set(id, (component = []));
        component.push(copper);
      }
      for (const copper of components.values()) {
        const terminals = new Map<string, Owner & { pad: Pad }>();
        for (const item of copper) {
          const binding = owner(item)!;
          if (binding.pad) terminals.set(binding.pad.id, { ...binding, pad: binding.pad });
        }
        const pads = [...terminals.values()];
        const first = pads.find((binding) => binding.group);
        const bridge = copper.find(artwork);
        if (!first) continue;
        const foreign = pads.filter((binding) => binding.group !== first.group);
        if (foreign.length) {
          for (const binding of foreign) {
            const pair = [first.pad.id, binding.pad.id].sort().join(':');
            if (reportedShorts.has(pair)) continue;
            reportedShorts.add(pair);
            reportShort(footprint, first.pad, binding.pad, bridge);
          }
          continue;
        }
        const nets = new Set(pads.flatMap(({ pad }) => (pad.netId ? [pad.netId] : [])));
        if (copper.some((item) => item.netId && !nets.has(item.netId))) continue;
        const tie = { pads: new Set(terminals.keys()), nets };
        for (const item of copper) {
          let ties = membership.get(item);
          if (!ties) membership.set(item, (ties = new Map()));
          ties.set(layer, tie);
        }
      }
    }
  }

  const tieOn = (item: T, layer: string) => membership.get(item)?.get(layer);
  const allows = (a: T, b: T) => {
    const group = owner(a)?.group;
    if (a.kind === 'pad' && b.kind === 'pad' && group && group === owner(b)?.group) return true;
    return a.layers.every((layer) => {
      if (!b.layers.includes(layer)) return true;
      const first = tieOn(a, layer),
        second = tieOn(b, layer);
      return Boolean(
        (first && first === second) ||
        (first && b.netId && entries.get(a)?.get(layer)?.has(b.netId)) ||
        (second && a.netId && entries.get(b)?.get(layer)?.has(a.netId)),
      );
    });
  };
  const hasKnownNet = (a: T, b: T) =>
    Boolean(a.netId) ||
    a.layers.some((layer) => b.layers.includes(layer) && Boolean(tieOn(a, layer)?.nets.size));
  const allowsPlatedHole = (copper: T, holeId: string, layers: readonly string[]) =>
    copper.layers.every(
      (layer) => !layers.includes(layer) || Boolean(tieOn(copper, layer)?.pads.has(holeId)),
    );

  return { allows, hasKnownNet, allowsPlatedHole };
}
