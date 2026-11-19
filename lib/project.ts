import {
  emptyCircuit,
  materializedCircuitTree,
  parseCircuit,
  parseCircuitTree,
  uid,
  type Circuit,
} from './circuit';
import { child, children, decodeKiCadString, quote, val, writeSExpr, type SExpr } from './sexpr';
import { serializePCB, type BoardLine, type BoardZone, type PCB } from './pcb';
import { padDrillClearance } from './pcb-drill';
import { padHasElectricalPin } from './pcb-pad-role';
import { footprintPoint } from './pcb-layout';
import { validateCustomPad } from './pcb-custom-pad';
import { customPadWorkLimit } from './pcb-custom-pad-limits';
import validateSchema from './project-validator.mjs';
import { KICAD_SCHEMATIC_VERSION } from './kicad-version';
import { schematicTexts, schematicTextBoxes, schematicPolylines } from './schematic-text';
import { schematicImages } from './schematic-image';
import validateDocument from './project-document-validator.mjs';
import { fromProjectDocument, toProjectDocument, type ProjectDocument } from './project-document';
import { formatProjectJson } from './project-json';
import { exceedsUtf8ByteLimit } from './utf8-byte-limit';
import { ungroupProjectSchematic } from './project-objects';
export { schematicDocumentItems, projectDocumentFootprints } from './project-objects';
export { projectFootprintSource, projectPackageModelPaths } from './library-project-assets';
export { footprintModels } from './pcb-models';
export {
  projectNativeFiles,
  projectFromNativeFiles,
  replaceNativeProjectFile,
} from './kicad-project';
import { validateSimulationModels, type SimulationModelReference } from './simulation-models';
import {
  canSelectPassiveSimulationModel,
  isPassiveSimulationModel,
} from './simulation-model-source';
import { simulationFieldNames } from './simulation-fields';
import { partFields } from './library';
import { controllerModelSources } from './reference-models';
import {
  isOwnedCircuit,
  isOwnedPCB,
  isOwnedProject,
  isOwnedProjectNode,
  ownProjectData,
} from './immutable-project';
import { validateNativeSourceFiles, projectNativeFilesSnapshot } from './kicad-project';
import { MODEL_CAD_EXTENSION, modelCadFromProject } from './model-cad';

export type Project = {
  format: 'openpe';
  version: 1;
  units: 'mm';
  id: string;
  name?: string;
  schematic: Circuit;
  additionalSchematics?: Circuit[];
  pcb: PCB | null;
  extensions: Record<string, unknown>;
  simulationModels?: SimulationModelReference[];
  /** Native source files retained for lossless saving; never renderer paths. */
  nativeFiles?: { entry: string; files: { name: string; source: string; encoding?: 'latin1' }[] };
};
export const MAX_PROJECT_BYTES = 8_000_000;
export const MAX_SCHEMATIC_FILES = 12;
export function projectSchematics(project: Project): Circuit[] {
  return [project.schematic, ...(project.additionalSchematics ?? [])];
}
export function projectBoundTiModels(project: Project) {
  const tiModelBindings = new Map(controllerModelSources.map((model) => [`TI:${model.id}`, model]));
  const reviewedIds = new Set<string>();
  const libraries = new Set<string>();
  for (const sheet of projectSchematics(project)) {
    for (const part of sheet.parts) {
      const fields = partFields(part);
      if (!fields['Sim.Library'] || !fields['Sim.Name']) continue;
      const model = tiModelBindings.get(fields['Sim.Library']);
      if (model && fields['Sim.Name'] === model.subcircuit) reviewedIds.add(model.id);
      libraries.add(fields['Sim.Library']);
    }
  }
  return { reviewedIds, libraries };
}
export function findSchematic(project: Project, id: string): Circuit | undefined {
  return projectSchematics(project).find((schematic) => schematic.id === id);
}
const ownedSchematicFingerprints = new WeakMap<Circuit, string>();
export function schematicFileFingerprint(project: Project, id: string): string {
  const schematic = findSchematic(project, id);
  if (!schematic) throw new Error('This schematic file is no longer in the project.');
  // With board data removed, these canonical fields depend only on the sheet.
  // Core shares owned sheets across board, other-sheet and project-name edits.
  const owned = isOwnedProject(project);
  const cached = owned ? ownedSchematicFingerprints.get(schematic) : undefined;
  if (cached !== undefined) return cached;
  const document = toProjectDocument(
    {
      ...project,
      schematic,
      additionalSchematics: undefined,
      pcb: null,
    },
    true,
  );
  const fingerprint = JSON.stringify([document.schematic, document.libraries]);
  if (owned) ownedSchematicFingerprints.set(schematic, fingerprint);
  return fingerprint;
}
export function replaceSchematic(project: Project, schematic: Circuit): Project {
  if (!findSchematic(project, schematic.id))
    throw new Error('This schematic file is no longer in the project.');
  return schematic.id === project.schematic.id
    ? { ...project, schematic }
    : {
        ...project,
        additionalSchematics: project.additionalSchematics!.map((item) =>
          item.id === schematic.id ? schematic : item,
        ),
      };
}
export function appendSchematic(project: Project): { project: Project; schematic: Circuit } {
  const files = projectSchematics(project);
  if (files.length >= MAX_SCHEMATIC_FILES)
    throw new Error('A project supports up to 12 schematic files.');
  const schematic = emptyCircuit();
  let index = 2;
  while (files.some((file) => file.title === `Schematic ${index}`)) index++;
  schematic.title = `Schematic ${index}`;
  const next = {
    ...project,
    additionalSchematics: [...(project.additionalSchematics ?? []), schematic],
  };
  serializeProject(next);
  return { project: next, schematic };
}
export function removeSchematic(project: Project, id: string): Project {
  if (!findSchematic(project, id))
    throw new Error('This schematic file is no longer in the project.');
  if (id === project.schematic.id && project.pcb)
    throw new Error(
      'This schematic is associated with the project PCB. Remove the PCB before deleting this file.',
    );
  const files = projectSchematics(project).filter((file) => file.id !== id);
  // The project format requires a primary schematic, including in an otherwise empty project.
  if (!files.length) {
    const blank = emptyCircuit();
    blank.title = 'Schematic 1';
    files.push(blank);
  }
  const { additionalSchematics: _files, ...rest } = project;
  const next = {
    ...rest,
    name: project.name ?? project.schematic.title,
    schematic: files[0],
    ...(files.length > 1 ? { additionalSchematics: files.slice(1) } : {}),
  };
  serializeProject(next);
  return next;
}
// A bounded single-file snapshot for independent simulation and native export.
// Additional files are separate circuits, not electrically linked hierarchical sheets.
export function schematicSnapshot(project: Project, id: string): Project {
  validateProject(project);
  const schematic = findSchematic(project, id);
  if (!schematic) throw new Error('This schematic file is no longer in the project.');
  const { additionalSchematics: _files, ...snapshot } = project;
  if (id === project.schematic.id) return { ...snapshot, schematic };
  const extensions = { ...snapshot.extensions };
  delete extensions[MODEL_CAD_EXTENSION];
  return { ...snapshot, schematic, pcb: null, extensions };
}
export function createProject(schematic: Circuit = emptyCircuit()): Project {
  return {
    format: 'openpe',
    version: 1,
    units: 'mm',
    id: uid(),
    name: schematic.title,
    schematic,
    pcb: null,
    extensions: {},
  };
}
function fail(message: string): never {
  throw new Error(`Invalid OpenPE project: ${message}`);
}

// Bound recursion before JSON Schema's recursive S-expression validator runs.
const ownedBounds = new WeakMap<object, { nodes: number; depth: number }>();
function bounded(value: unknown, depth = 0, budget = { nodes: 0 }): number {
  if (depth > 80 || ++budget.nodes > 300000)
    fail('document nesting or object count exceeds the supported limit.');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('numbers must be finite.');
  if (value && typeof value === 'object') {
    const owned = isOwnedProjectNode(value);
    const cached = owned ? ownedBounds.get(value) : undefined;
    if (cached) {
      budget.nodes += cached.nodes - 1;
      if (depth + cached.depth > 80 || budget.nodes > 300000)
        fail('document nesting or object count exceeds the supported limit.');
      return cached.depth;
    }
    const start = budget.nodes;
    let height = 0;
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      fail('only plain JSON objects are allowed.');
    for (const [key, v] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`reserved key ${key}.`);
      height = Math.max(height, 1 + bounded(v, depth + 1, budget));
    }
    if (owned) ownedBounds.set(value, { nodes: budget.nodes - start + 1, depth: height });
    return height;
  } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null)
    fail('only JSON values are allowed.');
  return 0;
}
type FootprintCertificate = {
  schematic: Circuit;
  nets: PCB['nets'];
  layers: PCB['layers'];
  ids: readonly string[];
  filledVertices: number;
};
// Copper edits retain this exact immutable collection and its local semantic
// context. Keep only its latest successful context; global IDs and the combined
// board fill budget are still checked for every new candidate below.
const ownedFootprintCertificates = new WeakMap<PCB['footprints'], FootprintCertificate>();
const validatedOwnedProjects = new WeakSet<Project>();
const validatedOwnedCircuits = new WeakMap<Circuit, { ids: string[]; pins?: string }>();
const validatedOwnedSExpressions = new WeakSet<SExpr>();
const validatedOwnedBoards = new WeakMap<
  PCB,
  { libraries: Circuit['libraries']; pins: string; ids: string[] }
>();
export function validateProject(input: unknown): asserts input is Project {
  if (validatedOwnedProjects.has(input as Project)) return;
  validateProjectContent(input);
  // A shallow freeze from a caller cannot certify any nested content. Only
  // successful validation of an internally owned tree can be reused.
  const project = input as Project;
  if (isOwnedProject(project)) validatedOwnedProjects.add(project);
}
function validateProjectContent(input: unknown): void {
  bounded(input);
  if (!validateSchema(input)) {
    const e = validateSchema.errors?.[0];
    fail(
      `${e?.instancePath || '/'} ${e?.message || 'does not match the editor model'} (${JSON.stringify(e?.params || {})}). Only project data is supported.`,
    );
  }
  const project = input as Project;
  validateSimulationModels(project.simulationModels);
  if (Object.hasOwn(project.extensions, 'org.openpe.enclosure'))
    fail('unsupported retired enclosure data. Use current Model CAD objects.');
  const modelCad = modelCadFromProject(project);
  if (modelCad && !project.pcb) fail('Model CAD requires its PCB layout.');
  if (project.nativeFiles) validateNativeSourceFiles(project.nativeFiles, project);
  const ids = new Set<string>();
  let boardIds: string[] | undefined;
  const id = (value: string) => {
    const key = value.toLowerCase();
    if (ids.has(key)) fail(`duplicate UUID ${value}.`);
    ids.add(key);
    boardIds?.push(value);
  };
  id(project.id);
  if (modelCad)
    for (const body of modelCad.objects) {
      id(body.id);
    }
  for (const d of projectSchematics(project)) {
    const owned = isOwnedCircuit(d);
    const certificate = owned ? validatedOwnedCircuits.get(d) : undefined;
    if (certificate) {
      // Local semantics depend only on this exact internally owned sheet.
      // Recheck its complete identity ledger against every other project object.
      for (const value of certificate.ids) id(value);
      continue;
    }
    const circuitIds: string[] = [];
    const circuitId = (value: string) => {
      id(value);
      circuitIds.push(value);
    };
    circuitId(d.id);
    for (const text of schematicTexts(d.original)) circuitId(text.id);
    for (const box of schematicTextBoxes(d.original)) circuitId(box.id);
    for (const image of schematicImages(d.original)) circuitId(image.id);
    for (const line of schematicPolylines(d.original)) circuitId(line.id);
    for (const v of [
      ...d.parts,
      ...d.wires,
      ...d.junctions,
      ...d.labels,
      ...(d.noConnects || []),
    ]) {
      circuitId(v.id);
      if (v.raw && val(child(v.raw, 'uuid')).toLowerCase() !== v.id.toLowerCase())
        fail(`raw UUID disagrees with ${v.id}.`);
    }
    if (d.original && val(child(d.original, 'uuid')).toLowerCase() !== d.id.toLowerCase())
      fail('original schematic UUID disagrees with schematic.id.');
    if (d.original && child(d.original, 'paper'))
      fail('schematics use an infinite canvas. Remove paper-size metadata from the schematic.');
    const refs = new Map<
      string,
      { libId: string; units: Set<number>; value: string; fields: string }
    >();
    for (const p of d.parts) {
      const previous = refs.get(p.ref);
      if (
        previous &&
        (previous.libId !== p.libId ||
          previous.units.has(p.unit || 1) ||
          previous.value !== p.value ||
          previous.fields !== JSON.stringify(p.fields || {}))
      )
        fail(`duplicate reference or inconsistent units for ${p.ref}.`);
      if (previous) previous.units.add(p.unit || 1);
      else
        refs.set(p.ref, {
          libId: p.libId,
          units: new Set([p.unit || 1]),
          value: p.value,
          fields: JSON.stringify(p.fields || {}),
        });
      if (!Object.hasOwn(d.libraries, p.libId)) fail(`missing embedded symbol ${p.libId}.`);
      const passiveField = simulationFieldNames.passiveModel;
      const rawPassive = children(p.raw ?? [], 'property').find(
        (item) => val(item) === passiveField,
      );
      const passive = p.fields?.[passiveField] ?? (rawPassive && val(rawPassive, 2));
      if (
        passive !== undefined &&
        (!isPassiveSimulationModel(passive) || !canSelectPassiveSimulationModel(p, d))
      )
        fail(`${p.ref}: a passive simulation model requires a supported two-terminal symbol.`);
    }
    // Atoms are KiCad syntax, not arbitrary interpolated source strings.
    const checkSExpr = (n: SExpr) => {
      if (validatedOwnedSExpressions.has(n)) return;
      for (const a of n) {
        if (Array.isArray(a)) checkSExpr(a);
        else if (a.startsWith('"')) {
          try {
            decodeKiCadString(a);
          } catch {
            fail('invalid quoted KiCad atom.');
          }
        } else if (!a || /[\s()"\\]/.test(a)) fail('invalid unquoted KiCad atom.');
      }
      if (isOwnedProjectNode(n)) validatedOwnedSExpressions.add(n);
    };
    for (const [key, lib] of Object.entries(d.libraries)) {
      checkSExpr(lib);
      if (lib[0] !== 'symbol' || val(lib) !== key)
        fail(`embedded symbol key disagrees with ${key}.`);
    }
    if (d.original) checkSExpr(d.original);
    for (const v of [...d.parts, ...d.wires, ...d.junctions, ...d.labels, ...(d.noConnects || [])])
      if (v.raw) checkSExpr(v.raw);
    for (const [items, tag] of [
      [d.parts, 'symbol'],
      [d.wires, 'wire'],
      [d.junctions, 'junction'],
      [d.noConnects || [], 'no_connect'],
    ] as const)
      for (const item of items)
        if (item.raw && item.raw[0] !== tag) fail('raw object type disagrees with its collection.');
    for (const l of d.labels) {
      if (l.shape && l.scope !== 'global') fail('label shapes require global scope.');
      if (l.raw && l.raw[0] !== (l.scope === 'global' ? 'global_label' : 'label'))
        fail('raw label scope disagrees with its collection.');
    }
    // Reuse the supported KiCad subset guard.
    const parsed = parseCircuitTree(materializedCircuitTree(d));
    if (
      parsed.parts.length !== d.parts.length ||
      parsed.wires.length !== d.wires.length ||
      parsed.labels.length !== d.labels.length ||
      parsed.junctions.length !== d.junctions.length ||
      (parsed.noConnects?.length || 0) !== (d.noConnects?.length || 0)
    )
      fail('raw object type disagrees with its collection.');
    for (let i = 0; i < d.parts.length; i++)
      if (parsed.parts[i].libId !== d.parts[i].libId)
        fail('raw symbol library disagrees with libId.');
    if (owned) validatedOwnedCircuits.set(d, { ids: circuitIds });
  }
  // The existing board is associated with the primary schematic only.
  const d = project.schematic;
  const board = project.pcb;
  if (!board) return;
  const reusable = isOwnedPCB(board) && isOwnedCircuit(d);
  const certificate = reusable ? validatedOwnedCircuits.get(d) : undefined;
  const pins = reusable
    ? (certificate?.pins ?? JSON.stringify(d.parts.map((part) => [part.id, part.ref, part.libId])))
    : '';
  if (certificate && certificate.pins === undefined) certificate.pins = pins;
  const cachedBoard = reusable ? validatedOwnedBoards.get(board) : undefined;
  if (cachedBoard?.libraries === d.libraries && cachedBoard.pins === pins) {
    for (const value of cachedBoard.ids) id(value);
    return;
  }
  if (reusable) boardIds = [];
  id(board.id);
  const netIds = new Set(board.nets.map((n) => n.id));
  const names = new Set<string>();
  for (const n of board.nets) {
    id(n.id);
    if (names.has(n.name)) fail(`duplicate net name ${n.name}.`);
    names.add(n.name);
  }
  const net = (value: string | null) => {
    if (value !== null && !netIds.has(value)) fail(`missing PCB net ${value}.`);
  };
  const layer = (value: string) => {
    if (value.endsWith('.Cu') && !board.layers.some((l) => l === value))
      fail(`PCB layer ${value} is not in the board copper stack.`);
  };
  const graphic = (g: BoardLine, footprint = false) => {
    id(g.id);
    layer(g.layer);
    if ((g.kind === 'arc') !== (g.mid !== undefined))
      fail('PCB arc graphics require exactly one middle point.');
    if (g.points !== undefined && g.kind !== 'polygon')
      fail('PCB polygon points require a polygon graphic.');
    if (g.kind === 'polygon' && !g.points?.length)
      fail('PCB polygon graphics require at least three vertices.');
    if ((g.kind === 'text') !== (g.text !== undefined))
      fail('PCB text graphics require text properties.');
    if (g.keepUpright !== undefined && (!footprint || g.kind !== 'text'))
      fail('Text orientation applies only to footprint text.');
    if ((g.kind === 'dimension') !== (g.dimension !== undefined))
      fail('PCB dimensions require dimension properties.');
    if (g.fill !== undefined && !['circle', 'polygon'].includes(g.kind ?? ''))
      fail('Only circle and polygon PCB graphics support fill.');
  };
  let filledVertices = 0;
  const zone = (z: BoardZone) => {
    id(z.id);
    net(z.netId);
    layer(z.layer);
    if (
      z.filledPolygons !== undefined &&
      (!z.layer.endsWith('.Cu') || z.keepout || z.fillEnabled === false)
    )
      fail('saved copper fills require an enabled copper zone without keepout rules.');
    if (z.filledPolygons?.length && !z.netId) fail('saved copper fills require an assigned net.');
    filledVertices += (z.filledPolygons ?? []).reduce((n, p) => n + p.points.length, 0);
    if (filledVertices > 60000) fail('saved copper fills exceed the 60000-vertex board limit.');
    for (const outline of [
      z.outline,
      ...(z.holes ?? []),
      ...(z.filledPolygons ?? []).map((p) => p.points),
    ]) {
      const area = outline.reduce((a, p, i) => {
        const next = outline[(i + 1) % outline.length];
        return a + p.x * next.y - next.x * p.y;
      }, 0);
      if (Math.abs(area) < 0.000000000001) fail('copper zones need a non-degenerate polygon.');
    }
  };
  const reusableFootprints =
    isOwnedProject(project) &&
    reusable &&
    isOwnedProjectNode(board.footprints) &&
    isOwnedProjectNode(board.nets) &&
    isOwnedProjectNode(board.layers);
  const footprintCertificate = reusableFootprints
    ? ownedFootprintCertificates.get(board.footprints)
    : undefined;
  let pendingFootprintCertificate: FootprintCertificate | undefined;
  if (
    footprintCertificate &&
    footprintCertificate.schematic === d &&
    footprintCertificate.nets === board.nets &&
    footprintCertificate.layers === board.layers
  ) {
    // Replay the complete original order against all other project identities,
    // including earlier sheets/CAD and later tracks, graphics and board zones.
    for (const value of footprintCertificate.ids) id(value);
    filledVertices += footprintCertificate.filledVertices;
  } else {
    const footprintIdStart = boardIds?.length ?? 0;
    const initialFilledVertices = filledVertices;
    const linked = new Set<string>();
    let customPadWork = 0;
    for (const f of board.footprints) {
      id(f.id);
      const p = d.parts.find((p) => p.id === f.symbolId);
      if (f.symbolId !== null && !p)
        fail(
          `footprint ${f.libraryId} refers to a missing schematic symbol. Remove its PCB footprint before deleting that symbol.`,
        );
      if (f.symbolId === null && (f.reference === undefined || f.value === undefined))
        fail('unlinked footprints require their own reference and value.');
      if (p && (f.reference !== undefined || f.value !== undefined))
        fail('linked footprints derive their reference and value from the schematic symbol.');
      if (p && linked.has(p.ref)) fail(`multiple footprints refer to ${p.ref}.`);
      if (p) linked.add(p.ref);
      const pins = new Set(
        d.parts
          .filter((part) => p && part.ref === p.ref)
          .flatMap((part) => children(d.libraries[part.libId], 'symbol'))
          .flatMap((s) => children(s, 'pin'))
          .map((p) => val(child(p, 'number'))),
      );
      const pinNets = new Map<string, string | null>();
      for (const pad of f.pads) {
        id(pad.id);
        net(pad.netId);
        customPadWork += (pad.outline?.length ?? 0) ** 2;
        if (customPadWork > customPadWorkLimit)
          fail('custom pads exceed the board geometry limit.');
        validateCustomPad(pad, fail);
        const electrical = padHasElectricalPin(pad);
        if (electrical && p && !pins.has(pad.number) && !pad.unconnected)
          fail(`${p.ref} has no pin ${pad.number} for its PCB pad.`);
        if (pad.unconnected && (pad.netId !== null || !p || pins.has(pad.number)))
          fail('an explicitly unconnected package pad must have no schematic pin or net.');
        if (pad.type === 'np_thru_hole') {
          if (pad.netId !== null) fail('mechanical pads cannot carry an electrical net.');
          if (!pad.drill) fail('non-plated holes require a drill.');
        } else if (electrical) {
          if (pinNets.has(pad.number) && pinNets.get(pad.number) !== pad.netId)
            fail(`${p?.ref ?? f.reference} pin ${pad.number} has conflicting PCB net assignments.`);
          pinNets.set(pad.number, pad.netId);
        } else if (pad.netId !== null) {
          fail('Mask and paste apertures cannot carry a net.');
        }
        if (
          pad.type === 'thru_hole' &&
          (!pad.drill || (!pad.outline && pad.drill >= Math.min(pad.size.x, pad.size.y)))
        )
          fail('through-hole drill must be positive and smaller than its pad.');
        if (
          pad.type === 'smd' &&
          (pad.drill !== undefined || pad.drillOffset !== undefined || pad.drillSlot)
        )
          fail('SMD pads cannot have a drill or drill offset.');
        if (pad.drillSlot && (!pad.drill || pad.drillSlot.length <= pad.drill))
          fail('slot length must exceed its tool diameter.');
        if (
          pad.type === 'thru_hole' &&
          (pad.drillSlot || pad.outline) &&
          padDrillClearance(pad) <= 1e-12
        )
          fail(
            pad.outline
              ? 'a plated drill must stay inside its copper pad.'
              : 'a plated slot must stay inside its copper pad.',
          );
        if (pad.shape === 'circle' && pad.size.x !== pad.size.y)
          fail('circular pads need equal width and height.');
        if (pad.shape === 'roundrect' && pad.roundrectRatio === undefined)
          fail('rounded rectangular pads require a corner radius ratio.');
        if (
          pad.shape !== 'roundrect' &&
          [pad.roundrectRatio, pad.chamferRatio, pad.chamfer].some((v) => v !== undefined)
        )
          fail('rounded and chamfered corners require a roundrect pad.');
        if (
          pad.layers?.includes('F&B.Cu') &&
          (pad.type !== 'np_thru_hole' ||
            pad.shape !== 'circle' ||
            pad.drill !== pad.size.x ||
            pad.drillOffset ||
            pad.drillSlot ||
            pad.layers.length !== 2 ||
            !pad.layers.includes('*.Mask'))
        )
          fail('The outer-copper layer marker requires an equal-size round mechanical hole.');
        for (const padLayer of pad.layers ?? [])
          if (padLayer !== '*.Cu' && padLayer !== 'F&B.Cu') layer(padLayer);
      }
      for (const g of f.graphics) {
        graphic(g, true);
      }
      for (const point of f.referencePoints ?? []) {
        id(point.id);
        const position = footprintPoint(f, point);
        if (Math.abs(position.x) > 100000 || Math.abs(position.y) > 100000)
          fail('footprint reference point exceeds the board coordinate limit.');
      }
      for (const z of f.zones ?? []) zone(z);
    }
    if (reusableFootprints)
      pendingFootprintCertificate = {
        schematic: d,
        nets: board.nets,
        layers: board.layers,
        ids: Object.freeze(boardIds!.slice(footprintIdStart)),
        filledVertices: filledVertices - initialFilledVertices,
      };
  }
  for (const item of [...board.tracks, ...board.vias]) {
    id(item.id);
    net(item.netId);
  }
  for (const track of board.tracks) layer(track.layer);
  for (const g of board.graphics) graphic(g);
  for (const v of board.vias)
    if (v.drill >= v.diameter) fail('via drill must be smaller than its diameter.');
  for (const z of board.zones) zone(z);
  if (reusable) validatedOwnedBoards.set(board, { libraries: d.libraries, pins, ids: boardIds! });
  // A later track/zone error must not publish a new local certificate.
  if (pendingFootprintCertificate)
    ownedFootprintCertificates.set(board.footprints, pendingFootprintCertificate);
}
export function parseProject(source: string): Project {
  if (exceedsUtf8ByteLimit(source, MAX_PROJECT_BYTES)) fail('file exceeds 8 MB.');
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch {
    fail(
      'expected a valid internal project snapshot. Open native KiCad files through Open project.',
    );
  }
  bounded(data);
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1)
    fail(
      'unsupported format version. This project format is not supported; older projects are not migrated. Re-export the schematic from KiCad or create a new project.',
    );
  if ((data as { format?: unknown }).format !== 'openpe')
    fail(
      'unsupported internal snapshot format. Retired project files are not supported. Open a native KiCad project or create a new project.',
    );
  validateFileDocument(data);
  const project = fromProjectDocument(data);
  validateProjectContent(project);
  if (exceedsUtf8ByteLimit(formatProjectJson(toProjectDocument(project, true)), MAX_PROJECT_BYTES))
    fail('canonical JSON exceeds 8 MB.');
  return project;
}
type FlatDocumentComponent = NonNullable<
  ReturnType<typeof ungroupProjectSchematic>['components']
>[number];
// These checks read only this exact detached component. Schema, sheet/network
// and project-wide validation remain independent and run for each new input.
const validatedOwnedDocumentComponents = new WeakSet<FlatDocumentComponent>();
function validateFileDocument(
  data: unknown,
  reuseOwnedData = false,
): asserts data is ProjectDocument {
  if (!validateDocument(data)) {
    const e = validateDocument.errors?.[0];
    fail(
      `${e?.instancePath || '/'} ${e?.message} (${JSON.stringify(e?.params || {})}). The internal snapshot must match schemas/internal-project-snapshot.schema.json.`,
    );
  }
  const document = data as ProjectDocument;
  const pendingComponents: FlatDocumentComponent[] = [];
  for (const schematic of [
    document.schematic,
    ...(document.additionalSchematics || []).map((file) => file.schematic),
  ].map((sheet) => ungroupProjectSchematic(sheet, reuseOwnedData))) {
    for (const p of schematic.components ?? []) {
      const reusable = reuseOwnedData && isOwnedProjectNode(p);
      if (reusable && validatedOwnedDocumentComponents.has(p)) continue;
      if (p.simulation) {
        if (Object.hasOwn(p.fields ?? {}, 'Sim.Params'))
          fail(`${p.reference}: simulation.valueFormat replaces Sim.Params; edit value only.`);
        if (
          !p.value.trim() ||
          p.value.includes('${') ||
          (p.simulation.valueFormat !== '${VALUE}' && /[=\s]/.test(p.value)) ||
          p.simulation.valueFormat.length - '${VALUE}'.length + p.value.length > 4096
        )
          fail(`${p.reference}: invalid simulation value binding. Use a literal component value.`);
      }
      for (const name of Object.keys(p.fieldLayout ?? {}))
        if (
          !['Reference', 'Value'].includes(name) &&
          !(name === 'Sim.Params' && p.simulation) &&
          !Object.hasOwn(p.fields ?? {}, name)
        )
          fail(`field layout ${name} has no matching component field.`);
      if (reusable) pendingComponents.push(p);
    }
    for (const label of schematic.labels ?? [])
      if ((label.scope === 'global') !== (label.shape !== undefined))
        fail('global labels require a shape; local labels cannot have one.');
    for (const node of schematic.kicad ?? [])
      if (node[0] === 'title_block' && child(node, 'title'))
        fail('the schematic name belongs in schematic.name, not KiCad metadata.');
  }
  // Later component/sheet failures cannot publish partially accepted documents.
  for (const component of pendingComponents) validatedOwnedDocumentComponents.add(component);
}
const ownedProjectSources = new WeakMap<Project, string>();
export function serializeProject(project: Project): string {
  const cached = ownedProjectSources.get(project);
  if (cached !== undefined) return cached;
  validateProject(project);
  const document = toProjectDocument(project, true);
  // IPC/recovery/history must carry the same native bytes that Source displays.
  // The working model may still retain the pre-edit native backing files, while
  // the private object format omits redundant native defaults and raw ordering.
  if (project.nativeFiles) document.nativeFiles = projectNativeFilesSnapshot(project);
  validateFileDocument(document, true);
  const source = formatProjectJson(document);
  if (exceedsUtf8ByteLimit(source, MAX_PROJECT_BYTES)) fail('file exceeds 8 MB.');
  if (isOwnedProject(project)) ownedProjectSources.set(project, source);
  return source;
}
export function importDocument(source: string): Project {
  if (source.trimStart().startsWith('{')) return parseProject(source);
  const project = createProject(parseCircuit(source));
  serializeProject(project);
  return project;
}
export function projectFilename(name: string): string {
  return (
    name.replace(/(?:\.openpe\.json|\.kicad_pro|\.kicad_sch|\.kicad_pcb|\.json)$/i, '') +
    '.kicad_pro'
  );
}
export function exportKiCad(
  project: Project,
  kind: 'schematic' | 'pcb',
  schematicId?: string,
): string {
  validateProject(project);
  if (kind === 'schematic' && schematicId !== undefined)
    project = schematicSnapshot(project, schematicId);
  if (kind === 'pcb') {
    if (!project.pcb)
      throw new Error('This project has no PCB layout. Create a board in Layout first.');
    return serializePCB(project.pcb, project.schematic);
  }
  return writeSExpr(exportKiCadSchematicTree(project)) + '\n';
}
/** Native-file materialization can finish instance metadata before its only
 * text write, without parsing the just-exported schematic back into a tree. */
const ownedNormalizedNativeNodes = new WeakMap<SExpr, SExpr>();
function normalizedNativeNode(node: SExpr, owned: boolean): SExpr {
  const cached = owned ? ownedNormalizedNativeNodes.get(node) : undefined;
  if (cached) return cached;
  let changed = false;
  const result = node.map((item, index) => {
    const next =
      index > 0 && item === 'hide'
        ? (['hide', 'yes'] as SExpr)
        : Array.isArray(item)
          ? normalizedNativeNode(item, owned)
          : item;
    if (next !== item) changed = true;
    return next;
  });
  if (result[0] === 'property') {
    const effects = child(result, 'effects');
    const hidden = effects && child(effects, 'hide');
    if (effects && hidden) {
      result[result.indexOf(effects)] = effects.filter((item) => item !== hidden);
      if (!child(result, 'hide')) result.push(hidden);
      changed = true;
    }
  }
  const normalized = changed ? (owned ? ownProjectData(result) : result) : node;
  if (owned) {
    ownedNormalizedNativeNodes.set(node, normalized);
  }
  return normalized;
}
export function exportKiCadSchematicTree(project: Project, schematicId?: string): SExpr {
  validateProject(project);
  if (schematicId !== undefined) project = schematicSnapshot(project, schematicId);
  const owned = isOwnedCircuit(project.schematic);
  const normalized = normalizedNativeNode(materializedCircuitTree(project.schematic), owned);
  // Native instance assembly edits only the root and symbol containers. Reuse
  // immutable libraries/metadata instead of cloning every graphic per keypress.
  const root = owned ? [...normalized] : structuredClone(normalized);
  for (let index = 0; index < root.length; index++)
    if (Array.isArray(root[index]) && root[index][0] === 'symbol') root[index] = [...root[index]];
  for (const [key, value] of [
    ['version', KICAD_SCHEMATIC_VERSION],
    ['generator', '"openpe"'],
    ['generator_version', '"0.1"'],
  ]) {
    const existing = child(root, key);
    if (existing) root[root.indexOf(existing)] = [existing[0], value, ...existing.slice(2)];
    else root.push([key, value]);
  }
  for (const s of children(root, 'symbol')) {
    const f = project.pcb?.footprints.find((f) => f.symbolId === val(child(s, 'uuid')));
    if (!f) continue;
    const part = project.schematic.parts.find((p) => p.id === f.symbolId);
    if (part?.fields && Object.hasOwn(part.fields, 'Footprint')) continue;
    const property = children(s, 'property').find((p) => val(p) === 'Footprint');
    if (property) {
      const replacement = [...property];
      replacement[2] = quote(f.libraryId);
      s[s.indexOf(property)] = replacement;
    } else
      s.push([
        'property',
        '"Footprint"',
        quote(f.libraryId),
        ['at', '0', '0', '0'],
        ['effects', ['font', ['size', '1.27', '1.27']]],
        ['hide', 'yes'],
      ]);
  }
  return root;
}
