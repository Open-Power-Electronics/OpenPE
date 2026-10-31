import { exampleModelPath } from '../lib/example-model-paths';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import manifest from '../resources/example-catalog/manifest.json';
import { importDocument, parseProject, serializeProject } from '../lib/project';
import { parseSExpr, child, children, val, writeSExpr, type SExpr } from '../lib/sexpr';
import { convertExamplePCB } from './example-pcb';
import { prepareReferenceSimulation, referenceProfile } from './reference-simulation';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { partFields } from '../lib/library';
import footprintAssets from '../resources/example-catalog/footprints/manifest.json';
import { arrangeExampleText } from '../lib/example-layout';
import { referenceZoneInset, insetReferenceZoneBoundaries } from './reference-zone-boundaries';
import { fillCopperZones } from '../lib/pcb-polygons';
import {
  prepareHomeExampleCustomFootprints,
  writeHomeExampleNativeFiles,
  writeExampleFile as writeFile,
} from './example-native-files';

const directory = 'resources/example-catalog';
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const stable = (seed: string) => {
  const hex = hash(seed);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
if (
  manifest.examples.length !== 9 ||
  new Set(manifest.examples.map((e) => e.id)).size !== 9 ||
  new Set(manifest.examples.map((e) => e.modelId)).size !== 9
)
  throw new Error(
    'The reference catalog requires nine distinct pinned examples and controller models.',
  );
for (const asset of footprintAssets.footprints)
  if (asset.file && hash(await readFile(`${directory}/footprints/${asset.file}`)) !== asset.sha256)
    throw new Error(`Example footprint checksum mismatch: ${asset.file}`);

// This build-only adapter omits ancillary source metadata and retains native
// filled copper polygons before the explicit TPS61046 refill. It does not broaden the runtime importer.
function preparePCB(source: string) {
  const root = parseSExpr(source);
  if (root[0] !== 'kicad_pcb') throw new Error('Expected a pinned KiCad PCB.');
  let filledPolygons = 0;
  function omit(node: SExpr, names: string[]) {
    for (let i = node.length - 1; i > 0; i--) {
      const item = node[i];
      if (Array.isArray(item) && names.includes(String(item[0]))) {
        node.splice(i, 1);
      }
    }
  }
  for (const fp of children(root, 'footprint')) {
    for (const name of ['solder_mask_margin', 'solder_paste_margin']) {
      const margin = child(fp, name);
      if (margin) {
        for (const pad of children(fp, 'pad'))
          if (!child(pad, name)) pad.push(structuredClone(margin));
        omit(fp, [name]);
      }
    }
    omit(fp, ['tags', 'path', 'sheetname', 'sheetfile', 'attr', 'units', 'locked']);
    for (let i = fp.length - 1; i > 0; i--) {
      const item = fp[i];
      if (
        Array.isArray(item) &&
        item[0] === 'property' &&
        !['Reference', 'Value'].includes(val(item))
      ) {
        fp.splice(i, 1);
      }
    }
    for (const pad of children(fp, 'pad')) omit(pad, ['pinfunction', 'pintype']);
  }
  const expanded: SExpr[] = [];
  for (const item of root) {
    if (!Array.isArray(item) || item[0] !== 'zone') {
      if (Array.isArray(item)) {
        if (String(item[0]).startsWith('gr_')) omit(item, ['locked']);
        expanded.push(item);
      }
      continue;
    }
    const owner = val(child(item, 'uuid'));
    omit(item, ['name']);
    const placement = child(item, 'placement');
    if (placement && val(child(placement, 'enabled')) === 'no') omit(item, ['placement']);
    filledPolygons += children(item, 'filled_polygon').length;
    const layers = child(item, 'layers');
    if (!layers) {
      expanded.push(item);
      continue;
    }
    const names = layers.slice(1).map((_, i) => val(layers, i + 1));
    if (!names.length || names.some((name) => !['F.Cu', 'B.Cu', 'Edge.Cuts'].includes(name)))
      throw new Error('Unsupported reference PCB zone layers.');
    for (const name of names) {
      const zone = structuredClone(item);
      zone.splice(
        zone.findIndex((n) => Array.isArray(n) && n[0] === 'layers'),
        1,
        ['layer', JSON.stringify(name)],
      );
      child(zone, 'uuid')![1] = JSON.stringify(stable(`${owner}:${name}`));
      for (let i = zone.length - 1; i > 0; i--) {
        const fill = zone[i];
        if (
          Array.isArray(fill) &&
          fill[0] === 'filled_polygon' &&
          val(child(fill, 'layer')) !== name
        )
          zone.splice(i, 1);
      }
      expanded.push(zone);
    }
  }
  return { source: writeSExpr(['kicad_pcb', ...expanded]), filledPolygons };
}

const sources: Record<string, string> = {};
const audits = [];
const profiles = [];
for (const entry of manifest.examples) {
  for (const source of [entry.source.schematic, entry.source.pcb])
    if (hash(await readFile(source.path)) !== source.sha256)
      throw new Error(`Reference circuit source checksum mismatch: ${source.path}`);
  const project = importDocument(await readFile(entry.source.schematic.path, 'utf8'));
  project.id = stable(`${entry.id}:project`);
  project.name = entry.title;
  project.schematic.title = entry.title;
  const simulation = prepareReferenceSimulation(project.schematic, entry.id, entry.modelId);
  project.simulationModels = simulationModelDefinitions
    .filter((model) => model.id === entry.modelId)
    .map((model) => ({ ...model }));
  const prepared = preparePCB(await readFile(entry.source.pcb.path, 'utf8'));
  const conversion = convertExamplePCB(prepared.source, project.schematic, entry.id);
  const zoneBoundaryAdjustments = insetReferenceZoneBoundaries(conversion.board);
  project.pcb = zoneBoundaryAdjustments.board;
  const regeneratedCopper = entry.id === 'reference-tps61046-bga6-boost';
  if (regeneratedCopper) project.pcb = fillCopperZones(project.pcb, 0.25);
  for (const footprint of project.pcb.footprints) {
    const assets = footprintAssets.footprints.find((item) => item.id === footprint.libraryId);
    if (!assets || !footprint.models?.length)
      throw new Error(`Missing example package/models: ${footprint.libraryId}`);
    for (const model of footprint.models) {
      const relative = model.path
        .replace(/^\$\{KICAD\d+_3DMODEL_DIR\}\//, '')
        .replace(/\.wrl$/i, '.step');
      if (!assets.models.includes(relative)) throw new Error(`Unpinned example model: ${relative}`);
      const asset = (footprintAssets.models as Record<string, { file: string; sha256: string }>)[
        relative
      ];
      if (hash(await readFile(`${directory}/footprints/${asset.file}`)) !== asset.sha256)
        throw new Error(`Example STEP checksum mismatch: ${relative}`);
      model.path = '\${KIPRJMOD}/' + exampleModelPath(relative);
    }
  }
  const controller = project.schematic.parts.find((p) => p.ref === 'U1')!;
  const controllerFields = partFields(controller);
  for (const property of children(project.schematic.libraries[controller.libId], 'property')) {
    const metadata: Record<string, string> = {
      Value: controller.value,
      Datasheet: controllerFields.Datasheet ?? '',
      Footprint: controllerFields.Footprint ?? '',
      ki_description:
        simulation.derivedModel?.description ??
        `TI ${controller.value}; source-embedded symbol. See project provenance.`,
    };
    const name = val(property);
    if (Object.hasOwn(metadata, name)) property[2] = JSON.stringify(metadata[name]);
  }
  arrangeExampleText(project.schematic, entry.id);
  project.extensions['org.openpe.reference-example'] = {
    id: entry.id,
    source: entry.source,
    topology: entry.topology,
    package: entry.package,
    changes: `Input schematic imported with embedded source symbols and explicit ${simulation.derivedModel ? 'OpenPE-derived adjustable' : 'TI'} model pin assignments. Terminal assemblies and virtual sources/output loads form evenly spaced columns spanning the lower circuit. All virtual output loads are ${project.schematic.parts.find((part) => part.ref === simulation.testbench.loads[0])!.value} ohms. Virtual components have no Footprint and use 2.54 mm source leads with load leads extended to matching rail-label and official triangular-GND levels; completed electrical values and series resistance are recorded in simulation provenance. Reference and Value instance text is arranged clear of symbols and wiring. Board-edge copper-zone boundaries are clipped to a ${referenceZoneInset} mm board inset; internal partitions, local zones, expert PCB placement and routed copper are retained. ${regeneratedCopper ? 'TPS61046 enabled copper zones are explicitly refilled with the shared OpenPE fill operation and a 0.25 mm minimum clearance.' : 'Native filled polygons are retained.'} Printing settings omitted. No ERC/DRC or production qualification is added.`,
    simulation,
  };
  const preparedNativeProject = await prepareHomeExampleCustomFootprints(project, entry.id);
  const canonical = serializeProject(preparedNativeProject);
  const reopened = parseProject(canonical);
  profiles.push(referenceProfile(reopened.schematic, entry.id, entry.title, entry.modelId));
  sources[entry.id] = canonical;
  await mkdir('tests/fixtures/reference', { recursive: true });
  await writeFile(`tests/fixtures/reference/${entry.file}.json`, canonical);
  await writeHomeExampleNativeFiles(reopened, entry.id);
  audits.push({
    id: entry.id,
    sha256: hash(canonical),
    bytes: Buffer.byteLength(canonical),
    schematic: {
      components: project.schematic.parts.length,
      wires: project.schematic.wires.length,
    },
    pcb: conversion.audit,
    filledPolygons: prepared.filledPolygons,
    zoneBoundaryAdjustments: {
      insetMm: referenceZoneInset,
      zones: zoneBoundaryAdjustments.changes,
    },
    ...(regeneratedCopper
      ? { copperFill: { operation: 'fillCopperZones', minimumClearanceMm: 0.25 } }
      : {}),
  });
  console.log(
    `${entry.title}: ${project.schematic.parts.length} symbols, ${project.pcb.footprints.length} footprints, ${project.pcb.tracks.length} tracks, ${zoneBoundaryAdjustments.changes.length} inset zone boundaries`,
  );
}
await writeFile('lib/reference-examples.json', JSON.stringify(sources, null, 2) + '\n');
await writeFile('lib/reference-simulation.json', JSON.stringify({ profiles }, null, 2) + '\n');
await writeFile(`${directory}/conversion-audit.json`, JSON.stringify(audits, null, 2) + '\n');
await mkdir('public/licenses/reference', { recursive: true });
await writeFile(
  'public/licenses/reference/NOTICE.txt',
  [
    'Curated power-electronics reference examples',
    '',
    `Source author: ${manifest.examples[0].source.author}`,
    `Source checkout: ${manifest.examples[0].source.commit}`,
    'Selected from the local data/train, data/val and data/test directories.',
    'The supplied checkout has no top-level dataset license. No additional license is asserted for these designs.',
    'Embedded KiCad library data retains its upstream terms; see kicad-libraries.txt.',
    'Original source files are retained in resources/example-catalog/sources/<circuit-name>; SHA-256 hashes and source paths are recorded in resources/example-catalog/manifest.json.',
    `Changes: editable OpenPE conversion and KiCad 10 exports; board-edge copper-zone boundaries are clipped to a ${referenceZoneInset} mm board inset while internal partitions and local-zone outlines are retained. TPS61046 enabled copper zones are refilled by the shared OpenPE fill operation with 0.25 mm minimum clearance; the other boards retain saved copper contours. Terminal assemblies and virtual sources/loads form evenly spaced columns spanning the lower circuit. TPS61046 uses a visible 1 kohm output load; the other virtual output resistors are 100 ohms. Virtual sources/loads have no footprints and use 2.54 mm source leads with load leads extended to matching rail-label and official triangular-GND levels, completed values, explicit ESR/DCR and initial conditions. Instance reference/value text is arranged clear of symbols and wiring. Omitted print settings.`,
    'Ancillary PCB metadata is omitted from project JSON; pinned originals retain the source records.',
    'LM2596 Buck uses LM2596T-ADJ with an OpenPE-derived adjustable model based on the hash-pinned original TI 5 V model. Only the internal feedback divider/sense and derived controller name change; original model files/notices remain unchanged. R1 = 3.09 kohm, R2 = 1.01 kohm.',
    'LM2598 Buck uses the hash-pinned original TI LM2598_ADJ_TRANS model with a 24 V source, 100 ohm output load and editable 3 V initial voltage on the soft-start capacitor C3. R1 is completed as a 4.7 kohm FLAG pull-up. The initial condition selects an enabled-controller operating point; it does not verify a discharged soft-start startup.',
    'Home defaults to 2 ms for TPS61046 and LM27761 and 10 ms for the other seven projects (LM5001 maximum step 10 ns; others 0.2 us), with a 1 kohm virtual output resistor for TPS61046 and 100 ohms for the other projects. A completed default-duration run and its final-window observations describe only that exact source/model/solver configuration. The LMR70503 compatibility adapter approximates one-shot event state while retaining its original RC/reset circuit; its original TI model file, PCB placement and saved copper remain unchanged. Simulation does not qualify hardware, control-loop stability, ERC, DRC or production designs.',
    '',
    ...manifest.examples.map(
      (e) => `${e.title}: ${e.source.schematic.upstreamPath}; ${e.source.pcb.upstreamPath}`,
    ),
    '',
  ].join('\n'),
);
