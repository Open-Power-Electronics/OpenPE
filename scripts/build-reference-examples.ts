import { exampleModelPath } from '../lib/example-model-paths';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../resources/example-catalog/manifest.json';
import { importDocument, parseProject, projectNativeFiles, serializeProject } from '../lib/project';
import { parseSExpr, child, children, quote, val, writeSExpr, type SExpr } from '../lib/sexpr';
import { convertExamplePCB } from './example-pcb';
import { prepareReferenceSimulation, referenceProfile } from './reference-simulation';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { createLibraryPart, partFields, unitGraphics } from '../lib/library';
import { libraries, pinPositions, snap, type Circuit, type Point } from '../lib/circuit';
import { samePoint } from '../lib/wiring';
import { runSchematicERC } from '../lib/schematic-erc';
import footprintAssets from '../resources/example-catalog/footprints/manifest.json';
import { arrangeExampleText } from '../lib/example-layout';
import { referenceZoneInset, insetReferenceZoneBoundaries } from './reference-zone-boundaries';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import {
  prepareHomeExampleCustomFootprints,
  writeHomeExampleNativeFiles,
  writeExampleFile as writeFile,
} from './example-native-files';

const directory = 'resources/example-catalog';
const tpsClearance = 0.25;
const tpsKiCadVersion = '10.0.1';

async function refillTPSBoard(boardSource: string, settingsSource: string, stem: string) {
  await mkdir('test-results', { recursive: true });
  const scratch = await mkdtemp(path.resolve('test-results/tps61046-generation-'));
  const filename = path.join(scratch, `${stem}.kicad_pcb`);
  const kicad = (...args: string[]) => {
    const result = spawnSync(process.env.KICAD_CLI || 'kicad-cli', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90_000,
      env: { ...process.env, KICAD_CONFIG_HOME: path.join(scratch, 'config') },
    });
    if (result.status !== 0)
      throw new Error(`TPS61046 KiCad refill failed. ${result.error?.message || result.stderr}`);
    return result.stdout.trim();
  };
  const version = kicad('--version');
  if (version !== tpsKiCadVersion)
    throw new Error(`TPS61046 refill requires KiCad ${tpsKiCadVersion}. Found ${version}.`);
  await writeFile(filename, boardSource);
  await writeFile(path.join(scratch, `${stem}.kicad_pro`), settingsSource);
  kicad(
    'pcb',
    'drc',
    '--refill-zones',
    '--save-board',
    '--format',
    'json',
    '--all-track-errors',
    '--severity-all',
    '--output',
    path.join(scratch, 'drc.json'),
    filename,
  );

  const board = parseSExpr(boardSource);
  const zones = children(board, 'zone');
  const filledZones = children(parseSExpr(await readFile(filename, 'utf8')), 'zone');
  const fills = new Map(filledZones.map((zone) => [val(child(zone, 'uuid')), zone]));
  if (zones.length !== 3 || fills.size !== zones.length || filledZones.length !== fills.size)
    throw new Error('TPS61046 refill changed the zone set.');
  // Transfer only the native fill records. KiCad may rewrite unrelated board metadata.
  for (const zone of zones) {
    const id = val(child(zone, 'uuid'));
    const filled = fills.get(id);
    if (!filled || val(child(filled, 'layer')) !== val(child(zone, 'layer')))
      throw new Error(`TPS61046 refill changed zone identity ${id}.`);
    for (const old of children(zone, 'filled_polygon')) zone.splice(zone.indexOf(old), 1);
    zone.push(...children(filled, 'filled_polygon'));
  }
  return writeSExpr(board) + '\n';
}

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

// Correct the project-local copies against the TI datasheets. Keep pad numbers
// and simulation pin maps independent of these electrical declarations.
const controllerPinTypes: Record<string, Record<string, string>> = {
  'reference-lm25017-wson8-flybuck': {
    '1': 'power_in', // RTN
    '2': 'power_in', // VIN
    '4': 'input', // RON
    '6': 'power_out', // VCC
    '7': 'input', // BST
    '8': 'power_out', // SW
  },
  'reference-lm2596-to220-5-buck': { '5': 'input' }, // ON/OFF
  'reference-lm2598-to220-7-buck': {
    '3': 'open_collector', // FLAG
    '4': 'power_in', // GND
    '6': 'input', // FB
    '7': 'input', // SD/SS
  },
  'reference-lmr70503-bga8-buckboost': {
    A1: 'output', // VREF
    A2: 'input', // FB
    B1: 'input', // EN
    C1: 'power_in', // GND
    C2: 'power_in', // GND
    D1: 'power_out', // SW
    D2: 'power_in', // VIN
  },
  'reference-tps61046-bga6-boost': { B1: 'input', C2: 'power_out' }, // FB, VOUT
};

function prepareReferenceERC(d: Circuit, id: string) {
  const controller = d.parts.find((part) => part.ref === 'U1')!;
  const pins = unitGraphics(d.libraries[controller.libId], controller.unit).flatMap((unit) =>
    children(unit, 'pin'),
  );
  for (const [number, type] of Object.entries(controllerPinTypes[id] ?? {})) {
    const pin = pins.find((candidate) => val(child(candidate, 'number')) === number);
    if (!pin) throw new Error(`${id}: missing U1 pin ${number}.`);
    pin[1] = type;
  }
  if (id === 'reference-lm2735-msop8-sepic') {
    // Shorten the two unused left-facing pins so their tips clear the EN wire.
    for (const pin of pins.filter((candidate) => val(candidate) === 'no_connect')) {
      child(pin, 'at')![1] = '-6.35';
      child(pin, 'length')![1] = '1.27';
    }
    // The grounded thermal pad is a hidden power pin with an implicit net name.
    const pad = pins.find((candidate) => val(child(candidate, 'number')) === '9')!;
    child(pad, 'name')![1] = quote('GND');
  }

  const flagLibrary = 'power:PWR_FLAG';
  d.libraries[flagLibrary] = structuredClone(libraries[flagLibrary]);
  const flag = (rail: string, anchor: Point, lead = 0) => {
    const position = { x: snap(anchor.x - lead), y: anchor.y };
    const part = createLibraryPart(d, d.libraries[flagLibrary], position.x, position.y);
    part.id = stable(`${id}:power-flag:${rail}`);
    d.parts.push(part);
    if (lead) d.wires.push({ id: stable(`${id}:power-flag:${rail}:lead`), a: position, b: anchor });
  };
  const source = d.parts.find((part) => part.ref === 'V1')!;
  const [positive, negative] = pinPositions(source, d.libraries[source.libId]).map((pin) => {
    const lead = d.wires.find((wire) => samePoint(wire.a, pin));
    if (!lead) throw new Error(`${id}: missing supply lead.`);
    return lead.b;
  });
  flag('VIN', positive);
  flag('GND', negative, 7.62);
  if (id === 'reference-lm25017-wson8-flybuck') {
    // The isolated secondary gets its own return declaration.
    const secondaryGround = d.parts.find(
      (part) => part.ref === '#PWR010' && part.value === 'GND2',
    )!;
    const [anchor] = pinPositions(secondaryGround, d.libraries[secondaryGround.libId]);
    flag('GND2', anchor, 7.62);
  }
}

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
  prepareReferenceERC(project.schematic, entry.id);
  project.simulationModels = simulationModelDefinitions
    .filter((model) => model.id === entry.modelId)
    .map((model) => ({ ...model }));
  const prepared = preparePCB(await readFile(entry.source.pcb.path, 'utf8'));
  const conversion = convertExamplePCB(prepared.source, project.schematic, entry.id);
  const zoneBoundaryAdjustments = insetReferenceZoneBoundaries(conversion.board);
  project.pcb = zoneBoundaryAdjustments.board;
  const regeneratedCopper = entry.id === 'reference-tps61046-bga6-boost';
  if (regeneratedCopper)
    project.pcb.zones = project.pcb.zones.map((zone) => ({
      ...zone,
      clearance: Math.max(zone.clearance, tpsClearance),
    }));
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
    changes: `Input schematic imported with embedded source symbols and explicit ${simulation.derivedModel ? 'OpenPE-derived adjustable' : 'TI'} model pin assignments. Terminal assemblies and virtual sources/output loads form evenly spaced columns spanning the lower circuit. All virtual output loads are ${project.schematic.parts.find((part) => part.ref === simulation.testbench.loads[0])!.value} ohms. Virtual components have no Footprint and use 2.54 mm source leads with load leads extended to matching rail-label and official triangular-GND levels; completed electrical values and series resistance are recorded in simulation provenance. Reference and Value instance text is arranged clear of symbols and wiring. Supply and return power flags and reviewed pin declarations support bounded ERC. Board-edge copper-zone boundaries are clipped to a ${referenceZoneInset} mm board inset; internal partitions, local zones, expert PCB placement and routed copper are retained. ${regeneratedCopper ? 'TPS61046 enabled copper zones are refilled by KiCad 10.0.1 with a 0.25 mm minimum clearance. Native island removal and saved contours are preserved.' : 'Native filled polygons are retained.'} Printing settings omitted.`,
    simulation,
  };
  const preparedNativeProject = await prepareHomeExampleCustomFootprints(project, entry.id);
  const native = projectNativeFiles(preparedNativeProject, `${entry.file}.kicad_pro`);
  if (regeneratedCopper) {
    const board = native.files.find((file) => file.name === `${entry.file}.kicad_pcb`)!;
    const settings = native.files.find((file) => file.name === native.entry)!;
    const source = await refillTPSBoard(board.source, settings.source, entry.file);
    const schematic = preparedNativeProject.schematic;
    const refilled = parseKiCadPCB(source, schematic, schematic.id).board;
    const fills = new Map(refilled.zones.map((zone) => [zone.id, zone.filledPolygons]));
    for (const zone of preparedNativeProject.pcb!.zones) {
      const fill = fills.get(zone.id);
      if (fill === undefined) delete zone.filledPolygons;
      else zone.filledPolygons = fill;
    }
    board.source = projectNativeFiles(preparedNativeProject, native.entry).files.find(
      (file) => file.name === board.name,
    )!.source;
    const saved = parseKiCadPCB(board.source, schematic, schematic.id).board;
    assert.deepEqual(
      new Map(saved.zones.map((zone) => [zone.id, zone.filledPolygons])),
      fills,
      'TPS61046 publication must preserve every KiCad contour and island marker.',
    );
  }
  const libraryPath = `symbols/${entry.file}.kicad_sym`;
  native.files.push(
    {
      name: libraryPath,
      source: writeSExpr([
        'kicad_symbol_lib',
        ['version', '20251024'],
        ['generator', quote('openpe')],
        preparedNativeProject.schematic.libraries[controller.libId],
      ]),
    },
    {
      name: 'sym-lib-table',
      source: writeSExpr([
        'sym_lib_table',
        ['version', '7'],
        [
          'lib',
          ['name', quote('Reference')],
          ['type', quote('KiCad')],
          ['uri', quote('${KIPRJMOD}/' + libraryPath)],
          ['options', quote('')],
          ['descr', quote('Curated reference controller')],
        ],
      ]),
    },
  );
  preparedNativeProject.nativeFiles = native;
  const reopened = parseProject(serializeProject(preparedNativeProject));
  const canonical = serializeProject(reopened);
  const erc = runSchematicERC(reopened.schematic);
  if (!erc.complete || erc.issues.length)
    throw new Error(
      `${entry.id}: ERC did not pass.\n${erc.issues.map((issue) => issue.message).join('\n')}`,
    );
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
      ? {
          copperFill: {
            operation: 'KiCad refill',
            version: tpsKiCadVersion,
            minimumClearanceMm: tpsClearance,
          },
        }
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
