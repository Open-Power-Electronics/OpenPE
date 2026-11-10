import { portableExampleModelSource } from '../lib/example-model-paths';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  importDocument,
  projectNativeFiles,
  projectFromNativeFiles,
  serializeProject,
  validateProject,
} from '../lib/project';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { runSchematicERC } from '../lib/schematic-erc';
import { libraries, type Circuit } from '../lib/circuit';
import { createLibraryPart } from '../lib/library';
import { offsetPolygons } from '../lib/pcb-polygons';
import { parseSExpr, child, children, val, quote, writeSExpr, type SExpr } from '../lib/sexpr';
import { KICAD_SCHEMATIC_VERSION } from '../lib/kicad-version';
import { MODEL_CAD_EXTENSION } from '../lib/model-cad';
import { arrangeExampleText } from '../lib/example-layout';
import { emcFlybackModelCad } from './emc-flyback-model-cad';
import { emcFlybackPassiveValue, prepareEmcFlybackValues } from './emc-flyback-values';
import { homeExampleNativePath } from '../lib/home-examples';
import models from '../resources/emc-flyback-models-lock.json';
import { prepareEmcFlybackModelBindings } from './emc-flyback-model-bindings';
import { prepareEmcFlybackTestbench } from './emc-flyback-testbench';
import layout from './emc-flyback-layout.json';
import { writeHomeExampleNativeFiles, writeExampleFile as writeFile } from './example-native-files';

const root = 'resources/example-catalog/sources/emc-flyback';
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stable = (key: string) => {
  const h = digest(`emc-flyback-demo:${key}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const upstreamIds = new Set<string>();
for (const suffix of ['sch', 'pcb']) {
  const visit = (node: SExpr) => {
    if (['uuid', 'tstamp'].includes(String(node[0]))) upstreamIds.add(val(node));
    for (const item of node) if (Array.isArray(item)) visit(item);
  };
  visit(parseSExpr(await readFile(`${root}/design/emc_flyback.kicad_${suffix}`, 'utf8')));
}
// KiCad assigns UUIDs to newly explicit v10 fields. Keep upstream UUIDs and
// deterministically identify only those new records, independently of its RNG.
function stableUpgrade(source: string) {
  const tree = parseSExpr(source),
    counts = new Map<string, number>();
  const semantic = (node: SExpr): unknown =>
    node
      .filter((item) => !Array.isArray(item) || !['uuid', 'tstamp'].includes(String(item[0])))
      .map((item) => (Array.isArray(item) ? semantic(item) : item));
  const visit = (node: SExpr, owner: string) => {
    const uuid = child(node, 'uuid');
    if (uuid && !upstreamIds.has(val(uuid))) {
      const key = `${owner}:${JSON.stringify(semantic(node))}`,
        ordinal = counts.get(key) || 0;
      counts.set(key, ordinal + 1);
      uuid[1] = quote(stable(`upgrade:${key}:${ordinal}`));
    }
    for (const item of node) if (Array.isArray(item)) visit(item, uuid ? val(uuid) : owner);
  };
  visit(tree, String(tree[0]));
  return writeSExpr(tree) + '\n';
}

function prepareSchematicERC(circuit: Circuit) {
  const flagLibrary = 'power:PWR_FLAG';
  circuit.libraries[flagLibrary] = structuredClone(libraries[flagLibrary]);
  // Declare the rails at the existing test points, with room for the flags
  // beside the labels and ground symbols inside the test-point panel.
  for (const [ref, rail, x, y, rotation] of [
    ['VBUS', 'VBUS', 106.68, 114.3, 90],
    ['VOUT', 'VOUT', 119.38, 114.3, 90],
    ['PGND1', 'PGND', 137.16, 111.76, 0],
    ['SGND', 'SGND', 162.56, 111.76, 0],
    ['CHAS', 'CHASSIS', 175.26, 111.76, 0],
  ] as const) {
    const point = circuit.parts.find((part) => part.ref === ref && part.value === rail);
    if (!point) throw new Error(`Missing the EMC Flyback ${rail} test point.`);
    const flag = createLibraryPart(circuit, circuit.libraries[flagLibrary], x, y);
    flag.id = stable(`power-flag:${rail}`);
    flag.rotation = rotation;
    flag.excludeFromSimulation = true;
    circuit.parts.push(flag);
    if (rotation === 0)
      circuit.wires.push({
        id: stable(`power-flag:${rail}:lead`),
        a: { x: point.x, y: point.y },
        b: { x, y },
      });
  }

  // Publish the older embedded drawings in the project library. Keep the
  // embedded IDs that the reviewed simulation model binds to.
  return ['Device:LED', 'Reference_Voltage:TL431DBZ', 'Isolator:LTV-817S'].map((id) => {
    const symbol = structuredClone(circuit.libraries[id]);
    const name = id.split(':')[1];
    symbol[1] = quote(name);
    for (const part of circuit.parts.filter((candidate) => candidate.libId === id)) {
      const raw = part.raw!;
      child(raw, 'lib_id')![1] = quote(`EMC_Demo:${name}`);
      raw.push(['lib_name', quote(id)]);
    }
    return symbol;
  });
}

/** Build-only normalization of KiCad's upgraded demo. Every geometry
 * record reaches the strict runtime parser; unknown content still fails. */
function preparePCB(source: string) {
  const board = parseSExpr(source);
  if (val(child(board, 'version')) !== '20260206')
    throw new Error('Expected upgraded KiCad 10 PCB.');
  function visit(node: SExpr) {
    if (node[0] === 'tstamp') node[0] = 'uuid';
    if (node[0] === 'model')
      node[1] = quote(
        portableExampleModelSource(
          val(node).replace(
            '${KIPRJMOD}/EMC_Demo.3dshapes/',
            '${KIPRJMOD}/models/emc-flyback-demo/',
          ),
        ),
      );
    const unlocked = child(node, 'locked');
    if (unlocked && val(unlocked) === 'no') node.splice(node.indexOf(unlocked), 1);
    if (node[0] === 'via') {
      for (const key of ['capping', 'filling']) {
        const item = child(node, key);
        if (item?.length === 2 && val(item) === 'no') node.splice(node.indexOf(item), 1);
      }
      for (const key of ['covering', 'plugging']) {
        const item = child(node, key);
        if (
          item?.length === 3 &&
          val(child(item, 'front')) === 'no' &&
          val(child(item, 'back')) === 'no'
        )
          node.splice(node.indexOf(item), 1);
      }
    }
    for (const item of node) if (Array.isArray(item)) visit(item);
  }
  visit(board);
  for (const zone of children(board, 'zone')) {
    const layers = child(zone, 'layers');
    if (!layers) continue;
    const names = layers.slice(1).map((_, i) => val(layers, i + 1));
    if (!names.length || names.some((name) => !['F.Cu', 'B.Cu'].includes(name)))
      throw new Error('Unsupported EMC zone layers.');
    board.splice(
      board.indexOf(zone),
      1,
      ...names.map((name, index) => {
        const split = structuredClone(zone);
        split.splice(split.indexOf(child(split, 'layers')!), 1, ['layer', quote(name)]);
        if (index) child(split, 'uuid')![1] = quote(stable(val(child(zone, 'uuid')) + ':' + name));
        return split;
      }),
    );
  }
  for (const fp of children(board, 'footprint')) {
    // The enclosure belongs to Model CAD, not the PCB's footprint collection.
    const reference = children(fp, 'property').find((node) => val(node) === 'Reference');
    if (
      (val(reference, 2) === 'MECH1' && val(fp) === 'EMC_Demo:Case_UChannel_revD') ||
      (val(reference, 2) === 'MECH2' && val(fp) === 'EMC_Demo:Cover_PMMA_revD')
    ) {
      if (children(fp, 'pad').length)
        throw new Error('An enclosure placeholder contains PCB pads.');
      board.splice(board.indexOf(fp), 1);
      continue;
    }
    for (const name of ['reference', 'value']) {
      const label = children(fp, 'fp_text').find((n) => val(n) === name);
      let property = children(fp, 'property').find(
        (n) => val(n) === (name === 'reference' ? 'Reference' : 'Value'),
      );
      if (!label && property && child(property, 'at')) continue;
      if (!label || (property && val(label, 2) !== val(property, 2)))
        throw new Error('Expected matching native footprint reference/value.');
      if (!property) {
        property = ['property', quote(name === 'reference' ? 'Reference' : 'Value'), label[2]];
        fp.push(property);
      }
      property.push(...structuredClone(label.slice(3)));
      fp.splice(fp.indexOf(label), 1);
    }
    const nativeValue = children(fp, 'property').find((node) => val(node) === 'Value')!;
    const cleaned = emcFlybackPassiveValue(val(reference, 2), val(nativeValue, 2));
    nativeValue[2] = quote(cleaned.value);
    if (cleaned.specifications)
      fp.push([
        'property',
        quote('Specifications'),
        quote(cleaned.specifications),
        ['uuid', quote(stable(`specifications:${val(reference, 2)}`))],
      ]);
    // The old format stores these non-graphical fields without positions.
    // Keep them in the native export as hidden fields at the footprint origin.
    for (const property of children(fp, 'property'))
      if (!child(property, 'at')) {
        property.push(
          ['at', '0', '0', '0'],
          ['layer', quote('F.Fab')],
          ['effects', ['font', ['size', '1', '1']], ['hide', 'yes']],
        );
      }
    for (const pad of children(fp, 'pad')) {
      if (val(pad, 3) === 'custom') {
        const options = child(pad, 'options'),
          primitives = child(pad, 'primitives');
        const polygon = primitives && children(primitives, 'gr_poly')[0];
        const points =
          polygon &&
          children(child(polygon, 'pts') || [], 'xy').map((p) => [
            Number(val(p)),
            Number(val(p, 2)),
          ]);
        if (
          !options ||
          val(child(options, 'anchor')) !== 'rect' ||
          val(child(options, 'clearance')) !== 'outline' ||
          !primitives ||
          primitives.length !== 2 ||
          !polygon ||
          val(child(polygon, 'width')) !== '0' ||
          val(child(polygon, 'fill')) !== 'yes' ||
          !points ||
          points.length !== 4 ||
          new Set(points.map((p) => p[0])).size !== 2 ||
          new Set(points.map((p) => p[1])).size !== 2
        )
          throw new Error('Only the exact pinned rectangular custom-pad union is supported.');
        // Preserve its copper/aperture union exactly as two same-number rectangles.
        const xs = points.map((p) => p[0]),
          ys = points.map((p) => p[1]);
        const a = child(pad, 'at')!,
          theta = ((Number(val(a, 3)) - Number(val(child(fp, 'at'), 3))) * Math.PI) / 180;
        const x = (Math.min(...xs) + Math.max(...xs)) / 2,
          y = (Math.min(...ys) + Math.max(...ys)) / 2;
        const extra = structuredClone(pad);
        extra[3] = 'rect';
        const ea = child(extra, 'at')!;
        ea[1] = String(Number(val(a)) + x * Math.cos(theta) + y * Math.sin(theta));
        ea[2] = String(Number(val(a, 2)) - x * Math.sin(theta) + y * Math.cos(theta));
        const size = child(extra, 'size')!;
        size[1] = String(Math.max(...xs) - Math.min(...xs));
        size[2] = String(Math.max(...ys) - Math.min(...ys));
        child(extra, 'uuid')![1] = quote(stable(val(child(pad, 'uuid')) + ':rectangle'));
        for (const item of [extra, pad])
          for (const key of ['options', 'primitives'])
            item.splice(item.indexOf(child(item, key)!), 1);
        pad[3] = 'rect';
        fp.push(extra);
      }
      for (const key of ['pinfunction', 'pintype']) {
        const item = child(pad, key);
        if (item) pad.splice(pad.indexOf(item), 1);
      }
    }
  }
  return board;
}

function repairPlacement(board: SExpr) {
  const footprints = new Map(
    children(board, 'footprint').map((fp) => [
      val(
        children(fp, 'property').find((p) => val(p) === 'Reference'),
        2,
      ),
      fp,
    ]),
  );
  const segments = new Map(children(board, 'segment').map((t) => [val(child(t, 'uuid')), t]));
  function setPosition(record: SExpr | undefined, key: string, xy: number[], id: string) {
    const position = record && child(record, key);
    if (!position) throw new Error(`Missing EMC layout target ${id} (${key}).`);
    position.splice(1, 2, ...xy.map(String));
  }
  for (const [ref, xy] of Object.entries(layout.placements))
    setPosition(footprints.get(ref), 'at', xy, ref);
  for (const id of layout.removedTracks) {
    const segment = segments.get(id);
    if (!segment) throw new Error(`Missing redundant EMC segment ${id}.`);
    board.splice(board.indexOf(segment), 1);
    segments.delete(id);
  }
  const routes: Record<string, { points: number[][]; additionalIds?: string[] }> = layout.tracks;
  for (const [id, { points, additionalIds = [] }] of Object.entries(routes)) {
    const segment = segments.get(id);
    if (!segment || points.length !== additionalIds.length + 2)
      throw new Error(`Invalid EMC track path ${id}.`);
    const legs = [id, ...additionalIds].map((legId, index) => {
      const leg = structuredClone(segment);
      setPosition(leg, 'start', points[index], legId);
      setPosition(leg, 'end', points[index + 1], legId);
      child(leg, 'uuid')![1] = quote(legId);
      return leg;
    });
    board.splice(board.indexOf(segment), 1, ...legs);
  }
}

async function refillPCB(board: SExpr, stem: string, settings: string, rules: string) {
  const directory = `${conversion}/refill`;
  await mkdir(directory, { recursive: true });
  const filename = `${directory}/${stem}.kicad_pcb`;
  const scratch = structuredClone(board);
  const screwKeepouts = children(scratch, 'zone').filter(
    (zone) => val(child(zone, 'name')) === 'Q1_SCREW_KEEPOUT',
  );
  if (screwKeepouts.length !== 2) throw new Error('Expected the two Q1 screw keepouts.');
  // Leave 1 µm of fill clearance at this polygonal boundary. KiCad's refill
  // otherwise leaves small copper slivers inside the nominal keepout.
  for (const zone of screwKeepouts) {
    const pts = child(child(zone, 'polygon')!, 'pts')!;
    const outline = children(pts, 'xy').map((p) => ({ x: Number(val(p)), y: Number(val(p, 2)) }));
    const [expanded] = offsetPolygons([{ outer: outline, holes: [] }], 0.001);
    pts.splice(1, pts.length, ...expanded.outer.map(({ x, y }) => ['xy', String(x), String(y)]));
  }
  await writeFile(filename, writeSExpr(scratch) + '\n');
  await writeFile(`${directory}/${stem}.kicad_pro`, settings);
  await writeFile(`${directory}/${stem}.kicad_dru`, rules);
  runKiCad([
    'pcb',
    'drc',
    '--refill-zones',
    '--save-board',
    '--severity-error',
    '--exit-code-violations',
    '-o',
    `${directory}/drc.rpt`,
    filename,
  ]);
  const refilled = parseSExpr(await readFile(filename, 'utf8'));
  const fills = new Map(
    children(refilled, 'zone').map((zone) => [
      val(child(zone, 'uuid')),
      children(zone, 'filled_polygon'),
    ]),
  );
  // Keep the fills together because adjacent pours depend on each other.
  // Transfer no other records from the scratch board.
  for (const zone of children(board, 'zone')) {
    const id = val(child(zone, 'uuid'));
    const updated = fills.get(id);
    if (!updated) throw new Error(`Missing refilled EMC zone ${id}.`);
    for (const fill of children(zone, 'filled_polygon')) zone.splice(zone.indexOf(fill), 1);
    zone.push(...updated);
  }
  return writeSExpr(board) + '\n';
}

const manifest = JSON.parse(await readFile(`${root}/source-manifest.json`, 'utf8')) as {
  files: { path: string; sha256: string }[];
};
for (const file of manifest.files) {
  if (digest(await readFile(`${root}/${file.path}`)) !== file.sha256)
    throw new Error(`Pinned EMC source checksum mismatch: ${file.path}`);
}
// Explicit example generation uses KiCad's own upgrader; ordinary application
// startup/builds consume the checked generated template and never need KiCad.
const conversion = 'test-results/emc-kicad10/build';
function runKiCad(args: string[]) {
  const result = spawnSync(process.env.KICAD_CLI || 'kicad-cli', args, {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, KICAD_CONFIG_HOME: path.resolve(`${conversion}/config`) },
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `KiCad 10 ${args.slice(0, 2).join(' ')} failed. Check KICAD_CLI and the report. ${result.error?.message || result.stdout || result.stderr}`,
    );
}
await mkdir(conversion, { recursive: true });
for (const ext of ['pro', 'sch', 'pcb'])
  await writeFile(
    `${conversion}/emc_flyback.kicad_${ext}`,
    await readFile(`${root}/design/emc_flyback.kicad_${ext}`),
  );
for (const kind of ['sch', 'pcb'])
  runKiCad([kind, 'upgrade', '--force', `${conversion}/emc_flyback.kicad_${kind}`]);
const project = importDocument(
  stableUpgrade(await readFile(`${conversion}/emc_flyback.kicad_sch`, 'utf8')),
);
project.id = stable('project');
project.name = 'EMC Flyback';
project.simulationModels = models.models.map((model) => ({ ...model }));
project.schematic.title = 'EMC Flyback';
child(project.schematic.original!, 'version')![1] = KICAD_SCHEMATIC_VERSION;
prepareEmcFlybackValues(project.schematic);
prepareEmcFlybackModelBindings(project.schematic);
arrangeExampleText(project.schematic, 'emc-flyback-demo');
prepareEmcFlybackTestbench(project.schematic);
const localSymbols = prepareSchematicERC(project.schematic);
const erc = runSchematicERC(project.schematic);
if (!erc.complete || erc.issues.length)
  throw new Error(
    `EMC Flyback failed OpenPE ERC. ${erc.issues.map((issue) => issue.message).join(' ')}`,
  );
const filename = path.basename(homeExampleNativePath('emc-flyback-demo'));
const stem = filename.replace(/\.kicad_pro$/, '');
const settings = JSON.parse(await readFile(`${root}/design/emc_flyback.kicad_pro`, 'utf8'));
settings.meta = { ...settings.meta, filename };
const settingsSource = JSON.stringify(settings, null, 2) + '\n';
const rules = await readFile(`${root}/design/emc_flyback.kicad_dru`, 'utf8');
const board = preparePCB(
  stableUpgrade(await readFile(`${conversion}/emc_flyback.kicad_pcb`, 'utf8')),
);
repairPlacement(board);
const pcbSource = await refillPCB(board, stem, settingsSource, rules);
const parsed = parseKiCadPCB(pcbSource, project.schematic, 'emc-flyback-demo');
const drc = runPCBDesignRules(parsed.board, {}, project.schematic);
if (!drc.complete || drc.issues.length)
  throw new Error(
    `EMC Flyback failed OpenPE DRC. ${drc.issues.map((issue) => issue.message).join(' ')}`,
  );
project.pcb = parsed.board;
project.extensions[MODEL_CAD_EXTENSION] = emcFlybackModelCad(parsed.board, stable);
project.extensions['org.openpe.emc-flyback-example'] = {
  id: 'emc-flyback-demo',
  repository: 'https://github.com/ChengminLi/AI-PCB-layout',
  commit: 'e1b9a64ac9ac306647fa30094932fb792d17e373',
  path: 'examples/emc-flyback-demo',
  license: 'CC-BY-4.0',
  attribution: 'Chengmin Li and AI-PCB-layout contributors; KiCad library contributors',
  changes:
    'Native KiCad 7 board normalized to supported KiCad 10 records. Footprints are repositioned to clear courtyard overlaps and align local pad connections. Tracks use horizontal, vertical and 45-degree paths. Redundant local segments are removed and zones are refilled. Original nets, pad shapes, vias and retained track identities and locks are preserved. Passive Values retain only the nominal value; rating, dielectric, package and series text is preserved in Specifications fields. Instance Reference/Value text is arranged for legibility. Five power flags declare existing rails and the project symbol library carries the embedded LED, TL431DBZ and LTV-817S drawings. Four editable OpenPE CAD panels replace the MECH1/MECH2 enclosure placeholders, which are omitted from PCB footprints and project footprint libraries. Original source files and static enclosure assets are pinned separately. Behavioural transient model and board-only thermal analysis are bounded approximations.',
};
const native = projectNativeFiles(project, filename);
native.files.find((f) => f.name.endsWith('.kicad_pro'))!.source = settingsSource;
// Retain normalized board setup and fields in Source as well as the editor model.
native.files.find((f) => f.name.endsWith('.kicad_pcb'))!.source = pcbSource;
for (const file of await readdir(`${root}/design`, { withFileTypes: true })) {
  if (
    file.isFile() &&
    (/\.kicad_(?:sym|dru)$/.test(file.name) || /^(?:fp|sym)-lib-table$/.test(file.name))
  )
    native.files.push({
      name:
        file.name === 'emc_flyback.kicad_dru'
          ? filename.replace(/\.kicad_pro$/, '.kicad_dru')
          : file.name === 'EMC_Demo.kicad_sym'
            ? `symbols/${stem}.kicad_sym`
            : file.name,
      source: portableExampleModelSource(await readFile(`${root}/design/${file.name}`, 'utf8'))
        .replace(/\$\{KIPRJMOD\}\/EMC_Demo\.3dshapes\/([^"\r\n]+)/g, (_, name) =>
          portableExampleModelSource('${KIPRJMOD}/models/emc-flyback-demo/' + name),
        )
        .replaceAll('${KIPRJMOD}/EMC_Demo.pretty', '${KIPRJMOD}/footprints/' + stem + '.pretty')
        .replaceAll('${KIPRJMOD}/EMC_Demo.kicad_sym', '${KIPRJMOD}/symbols/' + stem + '.kicad_sym'),
    });
  if (file.isDirectory() && file.name.endsWith('.pretty'))
    for (const name of await readdir(`${root}/design/${file.name}`)) {
      if (!name.endsWith('.kicad_mod')) throw new Error('Unexpected custom footprint asset.');
      if (['Case_UChannel_revD.kicad_mod', 'Cover_PMMA_revD.kicad_mod'].includes(name)) continue;
      const footprint = parseSExpr(await readFile(`${root}/design/${file.name}/${name}`, 'utf8'));
      child(footprint, 'version')![1] = '20260206';
      native.files.push({
        name: `footprints/${stem}.pretty/${name}`,
        source: portableExampleModelSource(
          (writeSExpr(footprint) + '\n').replaceAll(
            '${KIPRJMOD}/EMC_Demo.3dshapes/',
            '${KIPRJMOD}/models/emc-flyback-demo/',
          ),
        ),
      });
    }
}
const symbolLibrary = native.files.find((file) => file.name === `symbols/${stem}.kicad_sym`)!;
symbolLibrary.source = symbolLibrary.source.replace(
  /\)\s*$/,
  localSymbols.map((symbol) => `  ${writeSExpr(symbol, 1)}\n`).join('') + ')\n',
);
project.nativeFiles = native;
validateProject(project);
project.schematic = projectFromNativeFiles(projectNativeFiles(project, filename)).schematic;
await writeHomeExampleNativeFiles(project, 'emc-flyback-demo');
await writeFile('lib/emc-flyback-example.json', serializeProject(project) + '\n');
console.log(JSON.stringify({ parts: project.schematic.parts.length, ...parsed.audit }));
