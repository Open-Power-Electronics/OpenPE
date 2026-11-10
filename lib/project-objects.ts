import type { EditorDocument } from './project-document';
import type { Project } from './project';
import type { BoardZone, Footprint, FootprintModel, PCB } from './pcb';
import { documentPhysicalPinKey, projectNetGroups } from './project-net-groups';
import { simulationFieldNames } from './simulation-fields';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from './immutable-project';

type Sheet = EditorDocument['schematic'];
type Component = NonNullable<Sheet['components']>[number];
type Ordered<T> = T & { order: number };
type Model = Omit<FootprintModel, 'offset' | 'scale' | 'rotation'> &
  Partial<Pick<FootprintModel, 'offset' | 'scale' | 'rotation'>>;
export type ObjectFootprint = Ordered<
  Omit<Footprint, 'symbolId' | 'models'> & { models?: Model[] }
>;
export type ObjectSimulation = Partial<Record<keyof typeof simulationFieldNames, string>> & {
  valueFormat?: string;
  excluded?: boolean;
  nativeOrder?: number;
  fields?: Record<string, string>;
};
export type ObjectComponent = Omit<Component, 'simulation'> & {
  simulation?: ObjectSimulation;
  footprints?: ObjectFootprint[];
  /** Only needed for source fields interleaved across design and simulation. */
  fieldOrder?: string[];
};
type NetworkDrawing = {
  wires?: Ordered<NonNullable<Sheet['wires']>[number]>[];
  junctions?: Ordered<NonNullable<Sheet['junctions']>[number]>[];
  labels?: Ordered<NonNullable<Sheet['labels']>[number]>[];
};
const ownedOrderedDrawings = new WeakMap<object, { order: number; packet: object }>();
const ownedNetworkDrawings = new WeakMap<object, NetworkDrawing>();
function packDrawing<T extends object>(item: T, order: number, reuse: boolean): Ordered<T> {
  if (!reuse || !isOwnedProjectNode(item)) return { ...item, order };
  const cached = ownedOrderedDrawings.get(item);
  if (cached?.order === order) return cached.packet as Ordered<T>;
  const packet = ownProjectData({ ...item, order });
  ownedOrderedDrawings.set(item, { order, packet });
  return packet;
}
function retainNetworkDrawing(drawing: NetworkDrawing, reuse: boolean): NetworkDrawing {
  const first = drawing.wires?.[0] ?? drawing.labels?.[0] ?? drawing.junctions?.[0];
  if (!reuse || !first || !isOwnedProjectNode(first)) return drawing;
  const cached = ownedNetworkDrawings.get(first);
  if (
    cached &&
    (['wires', 'junctions', 'labels'] as const).every((key) => {
      const before = cached[key] ?? [],
        after = drawing[key] ?? [];
      return before.length === after.length && before.every((item, index) => item === after[index]);
    })
  )
    return cached;
  const owned = ownProjectData(drawing);
  ownedNetworkDrawings.set(first, owned);
  return owned;
}
export type ObjectNet = {
  id: string;
  name?: string;
  schematic?: NetworkDrawing;
  pcb?: {
    order: number;
    tracks?: Ordered<Omit<PCB['tracks'][number], 'netId'>>[];
    vias?: Ordered<Omit<PCB['vias'][number], 'netId'>>[];
    zones?: Ordered<Omit<BoardZone, 'netId'>>[];
  };
};
export type ObjectSchematic = Omit<Sheet, 'components' | 'wires' | 'junctions' | 'labels'> & {
  components?: ObjectComponent[];
  nets?: ObjectNet[];
};
export type ObjectBoard = Pick<PCB, 'id' | 'thickness' | 'layers'> & {
  /** Only unlinked mechanical packages remain at board level. */
  footprints?: ObjectFootprint[];
  graphics?: PCB['graphics'];
  /** Netless keepouts and drawing zones. Electrical zones belong to their net. */
  zones?: Ordered<Omit<BoardZone, 'netId'>>[];
};
export type ProjectDocument = Omit<
  EditorDocument,
  'version' | 'schematic' | 'pcb' | 'additionalSchematics'
> & {
  version: 1;
  schematic: ObjectSchematic;
  pcb?: ObjectBoard;
  additionalSchematics?: { schematic: ObjectSchematic; libraries?: EditorDocument['libraries'] }[];
};

function invalid(message: string): never {
  throw new Error(`Invalid OpenPE project: ${message}`);
}
function ordered<T extends { order: number }>(items: T[], name: string): Omit<T, 'order'>[] {
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.order)) invalid(`duplicate ${name} order ${item.order}.`);
    seen.add(item.order);
  }
  return items.sort((a, b) => a.order - b.order).map(({ order: _order, ...item }) => item);
}
const vector = (value: { x: number; y: number; z: number }, n: number) =>
  value.x === n && value.y === n && value.z === n;
const ownedPackedFootprints = new WeakMap<Footprint, ObjectFootprint>();
function packFootprint(
  footprint: Footprint,
  order: number,
  shareGeometry = false,
): ObjectFootprint {
  const reusable = shareGeometry && isOwnedProjectNode(footprint);
  const cached = reusable ? ownedPackedFootprints.get(footprint) : undefined;
  if (cached?.order === order) return cached;
  const {
    symbolId: _symbolId,
    models,
    ...body
  } = shareGeometry ? footprint : structuredClone(footprint);
  const result: ObjectFootprint = {
    ...body,
    order,
    ...(models
      ? {
          models: models.map((model) => {
            const { offset, scale, rotation, ...rest } = model;
            return {
              ...rest,
              ...(!vector(offset, 0) ? { offset } : {}),
              ...(!vector(scale, 1) ? { scale } : {}),
              ...(!vector(rotation, 0) ? { rotation } : {}),
            };
          }),
        }
      : {}),
  };
  if (reusable) {
    const owned = ownProjectData(result);
    ownedPackedFootprints.set(footprint, owned);
    return owned;
  }
  return result;
}
function unpackFootprint(footprint: ObjectFootprint, symbolId: string | null): Ordered<Footprint> {
  const { models, ...body } = structuredClone(footprint);
  return {
    ...body,
    symbolId,
    ...(models
      ? {
          models: models.map((model) => ({
            ...model,
            offset: model.offset ?? { x: 0, y: 0, z: 0 },
            scale: model.scale ?? { x: 1, y: 1, z: 1 },
            rotation: model.rotation ?? { x: 0, y: 0, z: 0 },
          })),
        }
      : {}),
  };
}
const ownedPackedComponents = new WeakMap<Component, ObjectComponent>();
const ownedAttachedComponents = new WeakMap<
  Component,
  { footprints: ObjectFootprint[]; component: ObjectComponent }
>();
const ownedBoardNetworks = new WeakMap<PCB, Map<string, NonNullable<ObjectNet['pcb']>>>();
const ownedCopperRecords = new WeakMap<object, { order: number; packet: object }>();
const ownedNetPackets = new WeakMap<object, NonNullable<ObjectNet['pcb']>>();
function packCopper<T extends { netId: string | null }>(
  item: T,
  order: number,
): Ordered<Omit<T, 'netId'>> {
  const cached = ownedCopperRecords.get(item);
  if (cached?.order === order) return cached.packet as Ordered<Omit<T, 'netId'>>;
  const { netId: _netId, ...data } = item;
  const packet = ownProjectData({ ...data, order });
  ownedCopperRecords.set(item, { order, packet });
  return packet;
}
function retainNetPacket(
  net: PCB['nets'][number],
  packet: NonNullable<ObjectNet['pcb']>,
): NonNullable<ObjectNet['pcb']> {
  const cached = ownedNetPackets.get(net);
  if (
    cached?.order === packet.order &&
    (['tracks', 'vias', 'zones'] as const).every((key) => {
      const previous = cached[key] ?? [],
        next = packet[key] ?? [];
      return (
        previous.length === next.length && previous.every((item, index) => item === next[index])
      );
    })
  )
    return cached;
  const owned = ownProjectData(packet);
  ownedNetPackets.set(net, owned);
  return owned;
}
const ownedBoardDocuments = new WeakMap<PCB, ObjectBoard>();
function packComponent(component: Component): ObjectComponent {
  const reusable = isOwnedProjectNode(component);
  const cached = reusable ? ownedPackedComponents.get(component) : undefined;
  if (cached) return { ...cached };
  const copy = structuredClone(component);
  const simulation: ObjectSimulation = { ...copy.simulation };
  const fields: Record<string, string> = {};
  const nativeNames = new Map<string, keyof typeof simulationFieldNames>(
    Object.entries(simulationFieldNames).map(([key, name]) => [
      name,
      key as keyof typeof simulationFieldNames,
    ]),
  );
  for (const [key, value] of Object.entries(copy.fields ?? {})) {
    if (nativeNames.has(key)) simulation[nativeNames.get(key)!] = value;
    else if (key.startsWith('Sim.')) (simulation.fields ??= {})[key] = value;
    else fields[key] = value;
  }
  const flags = copy.kicad?.filter((node) => node[0] === 'exclude_from_sim') ?? [];
  if (flags.length > 1)
    invalid(`${copy.reference}: duplicate simulation participation attributes.`);
  if (flags.length) {
    simulation.excluded = flags[0][1] === 'yes';
    const index = copy.kicad!.indexOf(flags[0]);
    if (index) simulation.nativeOrder = index;
    copy.kicad = copy.kicad!.filter((node) => node[0] !== 'exclude_from_sim');
    if (!copy.kicad.length) delete copy.kicad;
  }
  delete copy.fields;
  delete copy.simulation;
  const result: ObjectComponent = {
    ...copy,
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(Object.keys(simulation).length ? { simulation } : {}),
  };
  const originalOrder = Object.keys(component.fields ?? {});
  const normalizedOrder = Object.keys(unpackComponent(result).fields ?? {});
  if (JSON.stringify(originalOrder) !== JSON.stringify(normalizedOrder))
    result.fieldOrder = originalOrder;
  if (reusable) {
    const owned = ownProjectData(result);
    ownedPackedComponents.set(component, owned);
    return { ...owned };
  }
  return result;
}
function unpackComponent(component: ObjectComponent): Component {
  // Linked PCB geometry is reconstructed independently below. Copying it here
  // duplicates every saved copper contour just to discard it immediately.
  const { footprints: _footprints, ...schematic } = component;
  const { simulation, fieldOrder, ...body } = structuredClone(schematic);
  const fields = { ...body.fields };
  if (
    simulation?.nativeOrder !== undefined &&
    (simulation.excluded === undefined || simulation.nativeOrder > (body.kicad?.length ?? 0))
  )
    invalid(`${component.reference}: invalid simulation native metadata order.`);
  for (const [key, name] of Object.entries(simulationFieldNames)) {
    const value = simulation?.[key as keyof typeof simulationFieldNames];
    if (value !== undefined) {
      if (Object.hasOwn(fields, name))
        invalid(`${component.reference}: duplicate simulation field ${name}.`);
      fields[name] = value;
    }
  }
  for (const [name, value] of Object.entries(simulation?.fields ?? {})) {
    if (
      Object.values(simulationFieldNames).includes(
        name as (typeof simulationFieldNames)[keyof typeof simulationFieldNames],
      ) ||
      !name.startsWith('Sim.') ||
      Object.hasOwn(fields, name)
    )
      invalid(`${component.reference}: invalid simulation field ${name}.`);
    fields[name] = value;
  }
  if (simulation?.valueFormat && Object.hasOwn(fields, 'Sim.Params'))
    invalid(`${component.reference}: simulation.valueFormat replaces Sim.Params; edit value only.`);
  const result: Component = { ...body, ...(Object.keys(fields).length ? { fields } : {}) };
  if (fieldOrder) {
    if (
      new Set(fieldOrder).size !== fieldOrder.length ||
      fieldOrder.length !== Object.keys(fields).length ||
      fieldOrder.some((name) => !Object.hasOwn(fields, name))
    )
      invalid(`${component.reference}: fieldOrder must name each stored field exactly once.`);
    result.fields = Object.fromEntries(fieldOrder.map((name) => [name, fields[name]]));
  }
  if (simulation?.valueFormat !== undefined)
    result.simulation = { valueFormat: simulation.valueFormat };
  if (simulation?.excluded !== undefined) {
    if (body.kicad?.some((node) => node[0] === 'exclude_from_sim'))
      invalid(`${component.reference}: duplicate simulation participation.`);
    (result.kicad ??= []).splice(simulation.nativeOrder ?? 0, 0, [
      'exclude_from_sim',
      simulation.excluded ? 'yes' : 'no',
    ]);
  }
  return result;
}

export function groupProjectDocument(
  document: EditorDocument,
  project: Project,
  reuseOwnedGeometry = false,
): ProjectDocument {
  // The private serializer never exposes this intermediate document. Public
  // conversions continue to return independent mutable copies.
  const shareGeometry = reuseOwnedGeometry && !!project.pcb && isOwnedPCB(project.pcb);
  const groupSheet = (
    sheet: Sheet,
    circuit: Project['schematic'],
    board?: PCB | null,
  ): ObjectSchematic => {
    const { components, wires: _wires, junctions: _junctions, labels: _labels, ...rest } = sheet;
    const result: ObjectSchematic = {
      ...rest,
      ...(components ? { components: components.map(packComponent) } : {}),
    };
    const groups = projectNetGroups(circuit);
    const pins = new Map(
      groups.flatMap((group, index) => group.pins.map((pin) => [pin, index] as const)),
    );
    const references = new Map(circuit.parts.map((part) => [part.id, part.ref]));
    const boardGroups = new Map<string, Set<number>>(),
      groupBoards = new Map<number, Set<string>>();
    for (const footprint of board?.footprints ?? [])
      for (const pad of footprint.pads) {
        if (!footprint.symbolId || !pad.netId || pad.unconnected) continue;
        const reference = references.get(footprint.symbolId);
        const index =
          reference === undefined
            ? undefined
            : pins.get(documentPhysicalPinKey(reference, pad.number));
        if (index === undefined) continue;
        if (!boardGroups.has(pad.netId)) boardGroups.set(pad.netId, new Set());
        boardGroups.get(pad.netId)!.add(index);
        if (!groupBoards.has(index)) groupBoards.set(index, new Set());
        groupBoards.get(index)!.add(pad.netId);
      }
    const cachedNetworks = shareGeometry && board ? ownedBoardNetworks.get(board) : undefined;
    const networks: ObjectNet[] = (board?.nets ?? []).map((net, order) => ({
      ...net,
      pcb: cachedNetworks?.get(net.id) ?? { order },
    }));
    const byId = new Map(networks.map((net) => [net.id, net]));
    const positions = {
      wires: new Map((sheet.wires ?? []).map((item, order) => [item.id, order])),
      junctions: new Map((sheet.junctions ?? []).map((item, order) => [item.id, order])),
      labels: new Map((sheet.labels ?? []).map((item, order) => [item.id, order])),
    };
    for (const [index, group] of groups.entries()) {
      let drawing: NetworkDrawing = {};
      for (const key of ['wires', 'junctions', 'labels'] as const) {
        if (group[key].length)
          (drawing[key] as unknown[]) = group[key].map((index) => {
            const order = positions[key].get(circuit[key][index].id)!;
            return packDrawing(sheet[key]![order], order, reuseOwnedGeometry);
          });
      }
      if (!Object.keys(drawing).length) continue;
      drawing = retainNetworkDrawing(drawing, reuseOwnedGeometry);
      const linked = groupBoards.get(index);
      const boardId = linked?.size === 1 ? [...linked][0] : undefined;
      const net = boardId && boardGroups.get(boardId)?.size === 1 ? byId.get(boardId) : undefined;
      if (net) net.schematic = drawing;
      else {
        const first = [
          ...(drawing.wires ?? []),
          ...(drawing.labels ?? []),
          ...(drawing.junctions ?? []),
        ]
          .map((item) => item.id)
          .sort()[0];
        networks.push({ id: `schematic:${first}`, schematic: drawing });
      }
    }
    if (board) {
      if (!cachedNetworks)
        for (const key of ['tracks', 'vias', 'zones'] as const)
          board[key].forEach((item, order) => {
            if (!item.netId) return;
            const net = byId.get(item.netId)!;
            let packet: object;
            if (shareGeometry) packet = packCopper(item, order);
            else {
              const { netId: _netId, ...data } = structuredClone(item);
              packet = { ...data, order };
            }
            ((net.pcb![key] ??= []) as unknown[]).push(packet);
          });
      const componentsById = new Map(
        result.components?.map((component) => [component.id, component]),
      );
      board.footprints.forEach((footprint, order) => {
        if (footprint.symbolId)
          (componentsById.get(footprint.symbolId)!.footprints ??= []).push(
            packFootprint(footprint, order, shareGeometry),
          );
      });
      if (shareGeometry && !cachedNetworks) {
        const packets = new Map<string, NonNullable<ObjectNet['pcb']>>();
        for (const net of networks)
          if (net.pcb) {
            net.pcb = retainNetPacket(board.nets[net.pcb.order], net.pcb);
            packets.set(net.id, net.pcb);
          }
        ownedBoardNetworks.set(board, packets);
      }
    }
    if (reuseOwnedGeometry && result.components)
      result.components = result.components.map((component, index) => {
        const source = components![index];
        if (!isOwnedProjectNode(source)) return component;
        if (!component.footprints) return ownedPackedComponents.get(source)!;
        const cached = ownedAttachedComponents.get(source);
        if (
          cached &&
          cached.footprints.length === component.footprints.length &&
          cached.footprints.every((footprint, index) => footprint === component.footprints![index])
        )
          return cached.component;
        const owned = ownProjectData(component);
        ownedAttachedComponents.set(source, { footprints: owned.footprints!, component: owned });
        return owned;
      });
    if (networks.length) result.nets = networks;
    return result;
  };
  const { schematic, pcb, additionalSchematics } = document;
  let board: ObjectBoard | undefined;
  if (pcb) {
    const cached = shareGeometry ? ownedBoardDocuments.get(pcb) : undefined;
    board = cached ?? { id: pcb.id, thickness: pcb.thickness, layers: pcb.layers };
    if (!cached) {
      const footprints = pcb.footprints.flatMap((footprint, order) =>
        footprint.symbolId ? [] : [packFootprint(footprint, order, shareGeometry)],
      );
      const zones = pcb.zones.flatMap(({ netId, ...zone }, order) =>
        netId ? [] : [{ ...zone, order }],
      );
      if (footprints.length) board.footprints = footprints;
      if (pcb.graphics.length)
        board.graphics = shareGeometry ? pcb.graphics : structuredClone(pcb.graphics);
      if (zones.length) board.zones = shareGeometry ? zones : structuredClone(zones);
      if (shareGeometry) {
        board = ownProjectData(board);
        ownedBoardDocuments.set(pcb, board);
      }
    }
  }
  const result = { ...document } as unknown as ProjectDocument;
  result.version = 1;
  result.schematic = groupSheet(schematic, project.schematic, project.pcb);
  if (board) result.pcb = board;
  else delete result.pcb;
  if (additionalSchematics?.length)
    result.additionalSchematics = additionalSchematics.map((file, index) => ({
      ...file,
      schematic: groupSheet(file.schematic, project.additionalSchematics![index]),
    }));
  return result;
}

/** References into the document, useful for Source-aware inspection and tests. */
export function schematicDocumentItems<K extends keyof NetworkDrawing>(
  schematic: ObjectSchematic,
  key: K,
): NonNullable<NetworkDrawing[K]> {
  const items: { order: number }[] = [];
  for (const net of schematic.nets ?? []) items.push(...(net.schematic?.[key] ?? []));
  return items.sort((a, b) => a.order - b.order) as NonNullable<NetworkDrawing[K]>;
}
export function projectDocumentFootprints(document: ProjectDocument): ObjectFootprint[] {
  return [
    ...(document.schematic.components ?? []).flatMap((component) => component.footprints ?? []),
    ...(document.pcb?.footprints ?? []),
  ].sort((a, b) => a.order - b.order);
}
/** Flatten just one sheet for validation without rebuilding unrelated PCB geometry. */
const ownedFlatComponents = new WeakMap<ObjectComponent, Component>();
export function ungroupProjectSchematic(
  sheet: ObjectSchematic,
  reuseOwnedComponents = false,
): Sheet {
  const { nets, components, ...rest } = sheet;
  const ids = new Set<string>();
  for (const net of nets ?? []) {
    if (ids.has(net.id)) invalid(`duplicate network identity ${net.id}.`);
    ids.add(net.id);
    if (net.pcb && !net.name) invalid('PCB networks require a name.');
    if (!net.pcb && net.name !== undefined)
      invalid('Schematic network names belong to labels or power symbols.');
  }
  const result: Sheet = {
    ...rest,
    ...(components
      ? {
          components: components.map((component) => {
            if (!reuseOwnedComponents || !isOwnedProjectNode(component))
              return unpackComponent(component);
            const cached = ownedFlatComponents.get(component);
            if (cached) return cached;
            const owned = ownProjectData(unpackComponent(component));
            ownedFlatComponents.set(component, owned);
            return owned;
          }),
        }
      : {}),
  };
  for (const key of ['wires', 'junctions', 'labels'] as const) {
    const items = schematicDocumentItems(sheet, key);
    if (items.length) (result[key] as unknown[]) = ordered<{ order: number }>(items, key);
  }
  return result;
}
export function ungroupProjectDocument(document: ProjectDocument): EditorDocument {
  const { version: _version, schematic, pcb, additionalSchematics, ...rest } = document;
  const boardNets = (schematic.nets ?? []).filter((net) => net.pcb);
  if (!pcb && (boardNets.length || projectDocumentFootprints(document).length))
    invalid('Component footprints and PCB networks require a project board.');
  for (const file of additionalSchematics ?? [])
    if (
      file.schematic.nets?.some((net) => net.pcb) ||
      file.schematic.components?.some((part) => part.footprints?.length)
    )
      invalid('Only the primary schematic can own PCB objects.');
  let board: PCB | undefined;
  if (pcb) {
    const footprints: Ordered<Footprint>[] = (schematic.components ?? []).flatMap((component) =>
      (component.footprints ?? []).map((footprint) => unpackFootprint(footprint, component.id)),
    );
    footprints.push(...(pcb.footprints ?? []).map((footprint) => unpackFootprint(footprint, null)));
    const nets = ordered(
      boardNets.map((net) => ({ id: net.id, name: net.name!, order: net.pcb!.order })),
      'PCB network',
    );
    board = {
      id: pcb.id,
      thickness: pcb.thickness,
      layers: pcb.layers,
      nets,
      footprints: ordered(footprints, 'footprint'),
      graphics: structuredClone(pcb.graphics ?? []),
      tracks: [],
      vias: [],
      zones: [],
    };
    for (const key of ['tracks', 'vias', 'zones'] as const) {
      const items: (
        Ordered<PCB['tracks'][number]> | Ordered<PCB['vias'][number]> | Ordered<BoardZone>
      )[] = boardNets.flatMap((net) =>
        (net.pcb![key] ?? []).map((item) => ({ ...structuredClone(item), netId: net.id })),
      );
      if (key === 'zones')
        items.push(
          ...(pcb.zones ?? []).map((zone) => ({
            ...structuredClone(zone),
            netId: null,
          })),
        );
      (board[key] as unknown[]) = ordered(items, `PCB ${key}`);
    }
  }
  return {
    ...rest,
    version: 1,
    schematic: ungroupProjectSchematic(schematic),
    ...(board ? { pcb: board } : {}),
    ...(additionalSchematics?.length
      ? {
          additionalSchematics: additionalSchematics.map((file) => ({
            ...file,
            schematic: ungroupProjectSchematic(file.schematic),
          })),
        }
      : {}),
  };
}
