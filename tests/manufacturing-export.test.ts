import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { crc32 } from 'node:zlib';
import { uid } from '../lib/circuit';
import { exportProjectFile } from '../lib/manufacturing-export';
import { exportZip } from '../lib/export-zip';
import { serializeProject } from '../lib/project';
import { manufacturingProject } from './manufacturing-fixture';
import { GerberLayer } from '../lib/manufacturing-gerber';
import { projectNativeFiles, projectFromNativeFiles } from '../lib/kicad-project';
const yauzl = createRequire(import.meta.url)('yauzl');

function nativeBoard(edit: (source: string) => string) {
  const files = projectNativeFiles(manufacturingProject());
  const pcb = files.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  pcb.source = edit(pcb.source);
  return projectFromNativeFiles(files);
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, string>> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error: Error | null, zip: any) => {
      if (error) return reject(error);
      const files = new Map<string, string>();
      zip.on('error', reject);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry: any) =>
        zip.openReadStream(entry, (error: Error | null, stream: any) => {
          if (error) return reject(error);
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            const data = Buffer.concat(chunks);
            assert.equal(crc32(data), entry.crc32);
            files.set(entry.fileName, data.toString('utf8'));
            zip.readEntry();
          });
        }),
      );
      zip.readEntry();
    }),
  );
}

test('Gerber manufacturing archive has actual layers, analytic rounded pads, separate drills and no native design files', async () => {
  const project = manufacturingProject(),
    before = serializeProject(project);
  const output = exportProjectFile(project, 'gerber', 'Power stage.kicad_pro');
  assert.equal(output.name, 'Power stage-gerber.zip');
  const files = await unzip(output.bytes);
  assert.equal(files.size, 12);
  assert.ok([...files.keys()].every((name) => !/kicad_/.test(name)));
  assert.match(files.get('Power stage.gtl')!, /%TF.FileFunction,Copper,L1,Top\*%/);
  assert.match(files.get('Power stage.gts')!, /%TF.FilePolarity,Negative\*%/);
  assert.match(files.get('Power stage.gtp')!, /%TF.FilePolarity,Positive\*%/);
  assert.match(files.get('Power stage.gtl')!, /G02X/); // Roundrect arcs survive as circular interpolation.
  assert.match(files.get('Power stage.gto')!, /D01\*/); // Generated native reference text is plotted.
  assert.match(files.get('Power stage-NPTH.drl')!, /T1C2\n%\nG90\nG05\nT1\nX5\.000000Y-5\.000000/);
  assert.doesNotMatch(files.get('Power stage-PTH.drl')!, /X5\.000000/);
  assert.equal(serializeProject(project), before);
});

test('JLCPCB CSV uses matching designators, quoted values, native origins, top/bottom and CCW rotations', async () => {
  const project = manufacturingProject();
  project.pcb!.footprints[0].value = '10k, "1%"';
  project.pcb!.footprints[0].side = 'back';
  const files = await unzip(exportProjectFile(project, 'jlcpcb', 'supply').bytes);
  assert.match(
    files.get('supply-bom.csv')!,
    /"Comment","Designator","Footprint","LCSC Part #"\r\n/,
  );
  assert.match(files.get('supply-bom.csv')!, /"10k, ""1%""","R1"/);
  assert.match(files.get('supply-positions.csv')!, /"R1","10mm","-12mm","Bottom","90"/);
  for (const [format, suffix] of [
    ['bom', 'bom'],
    ['placement', 'positions'],
  ] as const) {
    const output = exportProjectFile(project, format, 'supply');
    assert.equal(output.name, `supply-${suffix}.csv`);
    assert.equal(new TextDecoder().decode(output.bytes), files.get(output.name));
  }
});

test('manufacturing rejects open outlines and unfilled zones without mutating the project', () => {
  const project = manufacturingProject();
  project.pcb!.graphics.pop();
  assert.throws(() => exportProjectFile(project, 'gerber', 'x'), /outline is open/);
  const filled = manufacturingProject();
  filled.pcb!.zones = [
    {
      id: uid(),
      netId: null,
      layer: 'F.Cu',
      outline: [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
        { x: 1, y: 3 },
      ],
      clearance: 0.2,
      minThickness: 0.1,
      thermalGap: 0.2,
      thermalBridge: 0.3,
    },
  ];
  const before = serializeProject(filled);
  assert.throws(() => exportProjectFile(filled, 'gerber', 'x'), /Fill all enabled zones/);
  assert.equal(serializeProject(filled), before);
  assert.doesNotThrow(() => exportProjectFile(filled, 'bom', 'x'));
});

test('four copper layers and through vias retain layer order and metric drill positions', async () => {
  const project = manufacturingProject(),
    netId = uid();
  project.pcb!.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  project.pcb!.nets = [{ id: netId, name: 'GND' }];
  project.pcb!.vias = [{ id: uid(), x: -2, y: 3, diameter: 0.6, drill: 0.3, netId }];
  const files = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  assert.match(files.get('x.g1')!, /Copper,L2,Inr/);
  assert.match(files.get('x.g2')!, /Copper,L3,Inr/);
  assert.match(files.get('x.gbl')!, /Copper,L4,Bot/);
  assert.match(files.get('x.g1')!, /X-2000000Y-3000000D03\*/);
  assert.match(files.get('x-PTH.drl')!, /T1C0.3[\s\S]*X-2\.000000Y-3\.000000/);
});

test('Gerber arcs flip handedness with Y and unsupported physical artwork rejects explicitly', () => {
  const plot = new GerberLayer('Profile,NP');
  plot.graphic({
    id: uid(),
    layer: 'Edge.Cuts',
    width: 0.1,
    kind: 'arc',
    start: { x: 1, y: 0 },
    mid: { x: 0, y: 1 },
    end: { x: -1, y: 0 },
  });
  assert.match(plot.finish(), /G02X-1000000Y0I-1000000J0D01\*/);
  assert.throws(
    () =>
      plot.graphic({
        id: uid(),
        layer: 'F.Cu',
        width: 0.1,
        stroke: 'dash',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
      }),
    /dashed artwork/,
  );
});

test('ZIP entries round trip independently and unsafe names are rejected', async () => {
  assert.deepEqual(
    await unzip(exportZip([{ name: 'µ.csv', source: 'Ω,雪\r\n' }])),
    new Map([['µ.csv', 'Ω,雪\r\n']]),
  );
  for (const name of ['../x', '..', 'a\\b', 'a\0'])
    assert.throws(() => exportZip([{ name, source: 'x' }]), /filename/);
  assert.throws(
    () =>
      exportZip([
        { name: 'A', source: '' },
        { name: 'a', source: '' },
      ]),
    /filename/,
  );
});

test('native DNP, independent BOM/position exclusions and explicit supplier fields survive manufacturing compilation', () => {
  const text = (format: 'bom' | 'placement', edit: (s: string) => string) =>
    new TextDecoder().decode(exportProjectFile(nativeBoard(edit), format, 'x').bytes);
  for (const flag of ['dnp', 'board_only'])
    for (const format of ['bom', 'placement'] as const)
      assert.doesNotMatch(
        text(format, (s) => s.replace('(attr smd)', `(attr smd ${flag})`)),
        /"R1"/,
      );
  assert.doesNotMatch(
    text('bom', (s) => s.replace('(attr smd)', '(attr smd exclude_from_bom)')),
    /"R1"/,
  );
  assert.match(
    text('placement', (s) => s.replace('(attr smd)', '(attr smd exclude_from_bom)')),
    /"R1"/,
  );
  assert.match(
    text('bom', (s) => s.replace('(attr smd)', '(attr smd exclude_from_pos_files)')),
    /"R1"/,
  );
  assert.doesNotMatch(
    text('placement', (s) => s.replace('(attr smd)', '(attr smd exclude_from_pos_files)')),
    /"R1"/,
  );
  assert.match(
    text('bom', (s) => s.replace('(attr smd)', '(attr smd) (property "LCSC" "C12345")')),
    /"C12345"/,
  );
});

test('native board tenting masks vias by side and board mask clearance changes only mask pad apertures', async () => {
  const project = manufacturingProject(),
    netId = uid();
  project.pcb!.nets.push({ id: netId, name: 'GND' });
  project.pcb!.vias.push({ id: uid(), x: 25, y: 25, diameter: 0.6, drill: 0.3, netId });
  const files = projectNativeFiles(project),
    pcb = files.files.find((f) => f.name.endsWith('.kicad_pcb'))!;
  pcb.source = pcb.source.replace(
    '(pad_to_mask_clearance 0)',
    '(pad_to_mask_clearance 0.1) (tenting (front yes) (back no))',
  );
  const output = await unzip(exportProjectFile(projectFromNativeFiles(files), 'gerber', 'x').bytes);
  assert.doesNotMatch(output.get('x.gts')!, /X25000000Y-25000000D03/);
  assert.match(output.get('x.gbs')!, /X25000000Y-25000000D03/);
  assert.notEqual(output.get('x.gts')!.split('%LPD*%')[1], output.get('x.gtl')!.split('%LPD*%')[1]);
  assert.throws(
    () =>
      exportProjectFile(
        nativeBoard((s) =>
          s.replace(
            '(pad_to_mask_clearance 0)',
            '(pad_to_mask_clearance 0) (covering (front yes) (back no))',
          ),
        ),
        'gerber',
        'x',
      ),
    /via covering/,
  );
});

test('saved zone holes become Gerber contours without clearing overlapping pads and drill offsets rotate with their pads', async () => {
  const project = manufacturingProject(),
    board = project.pcb!;
  const netId = uid();
  board.nets.push({ id: netId, name: 'GND' });
  board.footprints[0].pads[0] = {
    ...board.footprints[0].pads[0],
    type: 'thru_hole',
    drill: 0.5,
    drillOffset: { x: 0.2, y: 0.3 },
  };
  board.zones.push({
    id: uid(),
    netId,
    layer: 'F.Cu',
    clearance: 0.2,
    minThickness: 0.1,
    thermalGap: 0.2,
    thermalBridge: 0.3,
    outline: [
      { x: 1, y: 1 },
      { x: 30, y: 1 },
      { x: 30, y: 28 },
      { x: 1, y: 28 },
    ],
    filledPolygons: [
      {
        points: [
          { x: 1, y: 1 },
          { x: 30, y: 1 },
          { x: 30, y: 28 },
          { x: 1, y: 28 },
          { x: 1, y: 1 },
          { x: 4, y: 4 },
          { x: 4, y: 8 },
          { x: 8, y: 8 },
          { x: 8, y: 4 },
          { x: 4, y: 4 },
          { x: 1, y: 1 },
        ],
      },
    ],
  });
  const files = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  const firstRegion = files.get('x.gtl')!.split('G36*')[1].split('G37*')[0];
  assert.equal((firstRegion.match(/D02\*/g) ?? []).length, 2);
  assert.doesNotMatch(files.get('x.gtl')!, /%LPC/);
  assert.match(files.get('x-PTH.drl')!, /X10\.300000Y-12\.800000/);
});
