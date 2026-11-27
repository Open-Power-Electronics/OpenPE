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
import { flipPCBFootprint } from '../lib/pcb-layout';
import { solderMaskOpenings } from '../lib/pcb-solder-mask';
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

test('drill-sized round mechanical holes with copper markers produce no copper flash', async () => {
  const project = manufacturingProject();
  const pad = project.pcb!.footprints[1].pads[0];
  for (const marker of ['F&B.Cu', '*.Cu'] as const) {
    pad.layers = [marker, '*.Mask'];
    const files = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
    for (const name of ['x.gtl', 'x.gbl'])
      assert.doesNotMatch(files.get(name)!, /X5000000Y-5000000D03/);
    for (const name of ['x.gts', 'x.gbs']) assert.match(files.get(name)!, /X5000000Y-5000000D03/);
    assert.match(files.get('x-NPTH.drl')!, /X5\.000000Y-5\.000000/);
  }
});

test('mask and paste apertures use their exact native size in Gerber and stencil files', async () => {
  const project = manufacturingProject();
  const footprint = project.pcb!.footprints[0];
  footprint.solderPasteMargin = -0.4;
  footprint.solderPasteMarginRatio = -0.5;
  footprint.pads.push(
    ...(['F.Paste', 'B.Paste', 'B.Mask'] as const).map((layer, index) => ({
      id: uid(),
      x: 0,
      y: 2 + index,
      rotation: 0,
      number: '',
      type: 'smd' as const,
      shape: 'circle' as const,
      size: { x: 0.8125, y: 0.8125 },
      layers: [layer],
      netId: null,
      solderPasteMargin: 0.125,
      solderMaskMargin: 0.25,
    })),
  );
  const gerber = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  const stencil = await unzip(exportProjectFile(project, 'stencil', 'x').bytes);
  const frontFlash = /X12000000Y-12000000D03\*/;
  const backFlash = /X13000000Y-12000000D03\*/;
  for (const [name, flash, otherFlash] of [
    ['x.gtp', frontFlash, backFlash],
    ['x.gbp', backFlash, frontFlash],
  ] as const) {
    const paste = gerber.get(name)!;
    assert.match(paste, /%ADD\d+C,0\.8125\*%/);
    assert.match(paste, flash);
    assert.doesNotMatch(paste, otherFlash);
    assert.equal(stencil.get(name), paste);
  }
  for (const name of ['x.gtl', 'x.gbl', 'x.gts', 'x.gbs']) {
    assert.doesNotMatch(gerber.get(name)!, frontFlash);
    assert.doesNotMatch(gerber.get(name)!, backFlash);
  }
  const maskFlash = /X14000000Y-12000000D03\*/;
  assert.match(gerber.get('x.gbs')!, /%ADD\d+C,0\.8125\*%/);
  assert.match(gerber.get('x.gbs')!, maskFlash);
  for (const name of ['x.gtl', 'x.gbl', 'x.gts', 'x.gtp', 'x.gbp'])
    assert.doesNotMatch(gerber.get(name)!, maskFlash);
  const mask = solderMaskOpenings(project.pcb!, 'back').openings[0].outer;
  assert.equal(Math.max(...mask.map(({ x }) => x)), 14.40625);
});

test('straight chamfers keep their copper corners and export uniform mask and paste margins', () => {
  const base = manufacturingProject().pcb!.footprints[0];
  const footprint = { ...base, x: 0, y: 0, rotation: 0 };
  const pad = {
    ...base.pads[0],
    x: 0,
    y: 0,
    size: { x: 2, y: 2 },
    roundrectRatio: 0,
    chamferRatio: 0.125,
    chamfer: ['top_left' as const],
  };
  const plot = (margin: number) => {
    const layer = new GerberLayer('Paste,Top');
    layer.pad(footprint, pad, margin);
    return layer.finish();
  };
  assert.match(plot(0), /X-1000000Y750000D01\*\nX-750000Y1000000D01\*/);
  assert.match(plot(0.1), /X-1100000Y750000D0[12]\*/);
  assert.match(plot(-0.1), /X-900000Y675000D0[12]\*/);
  assert.doesNotMatch(plot(-1), /G36\*/);
});

test('Gerber manufacturing archive has actual layers, analytic rounded pads, separate drills and no native design files', async () => {
  const project = manufacturingProject(),
    before = serializeProject(project);
  const output = exportProjectFile(project, 'gerber', 'Power stage.kicad_pro');
  assert.equal(output.name, 'Power stage-gerber.zip');
  const files = await unzip(output.bytes);
  assert.equal(files.size, 12);
  assert.ok([...files.keys()].every((name) => !/kicad_/.test(name)));
  assert.doesNotMatch(files.get('README.txt')!, /Assembly CSV/);
  assert.match(files.get('Power stage.gtl')!, /%TF.FileFunction,Copper,L1,Top\*%/);
  assert.match(files.get('Power stage.gts')!, /%TF.FilePolarity,Negative\*%/);
  assert.match(files.get('Power stage.gtp')!, /%TF.FilePolarity,Positive\*%/);
  assert.match(files.get('Power stage.gtl')!, /G02X/); // Roundrect arcs survive as circular interpolation.
  assert.match(files.get('Power stage.gto')!, /D01\*/); // Generated native reference text is plotted.
  assert.match(files.get('Power stage-NPTH.drl')!, /T1C2\n%\nG90\nG05\nT1\nX5\.000000Y-5\.000000/);
  assert.doesNotMatch(files.get('Power stage-PTH.drl')!, /X5\.000000/);
  assert.equal(serializeProject(project), before);
});

test('Excellon export matches fabrication drills and works before the outline is closed', async () => {
  const project = manufacturingProject(),
    board = project.pcb!,
    netId = uid();
  board.nets.push({ id: netId, name: 'GND' });
  board.vias.push({ id: uid(), x: -2, y: 3, diameter: 0.6, drill: 0.3, netId });
  const gerbers = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  board.graphics.pop();
  const output = exportProjectFile(project, 'drill', 'x.kicad_pro');
  assert.equal(output.name, 'x-drill.zip');
  const drills = await unzip(output.bytes);
  assert.deepEqual([...drills.keys()], ['x-PTH.drl', 'x-NPTH.drl']);
  for (const [name, source] of drills) assert.equal(source, gerbers.get(name));
  assert.match(drills.get('x-PTH.drl')!, /T1C0\.3[\s\S]*X-2\.000000Y-3\.000000/);
  assert.match(drills.get('x-NPTH.drl')!, /T1C2[\s\S]*X5\.000000Y-5\.000000/);
  assert.throws(() => exportProjectFile(project, 'stencil', 'x'), /outline is open/);
});

test('manufacturing exports retain a native PCB name with an uppercase extension', () => {
  const original = manufacturingProject();
  const files = projectNativeFiles(original);
  files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.name = 'Board.KICAD_PCB';
  const reopened = projectFromNativeFiles(files);
  assert.ok(projectNativeFiles(reopened).files.some((file) => file.name === 'Board.KICAD_PCB'));
  for (const format of ['drill', 'dxf'] as const)
    assert.deepEqual(
      exportProjectFile(reopened, format, 'supply').bytes,
      exportProjectFile(original, format, 'supply').bytes,
    );
});

test('stencil export matches fabrication paste and outline without checking unrelated mask settings', async () => {
  const paste = (source: string) =>
    source.replace(
      '(pad_to_mask_clearance 0)',
      '(pad_to_mask_clearance 0) (pad_to_paste_clearance 0.1)',
    );
  const project = nativeBoard(paste);
  const gerbers = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  const maskSetting = nativeBoard((source) =>
    paste(source).replace(
      '(pad_to_mask_clearance 0)',
      '(pad_to_mask_clearance 0) (solder_mask_min_width 0.1)',
    ),
  );
  assert.throws(() => exportProjectFile(maskSetting, 'gerber', 'x'), /minimum solder-mask web/);
  const output = exportProjectFile(maskSetting, 'stencil', 'x');
  assert.equal(output.name, 'x-stencil.zip');
  const stencil = await unzip(output.bytes);
  assert.deepEqual([...stencil.keys()], ['x.gtp', 'x.gbp', 'x.gko']);
  for (const [name, source] of stencil) assert.equal(source, gerbers.get(name));
  const noMargin = await unzip(exportProjectFile(manufacturingProject(), 'stencil', 'x').bytes);
  assert.notEqual(stencil.get('x.gtp'), noMargin.get('x.gtp'));
  project.pcb!.graphics.push({
    id: uid(),
    layer: 'F.Paste',
    width: 0.1,
    stroke: 'dash',
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  });
  assert.throws(() => exportProjectFile(project, 'stencil', 'x'), /dashed artwork/);
});

test('JLCPCB CSV uses matching designators, quoted values, native origins, top/bottom and CCW rotations', async () => {
  const project = manufacturingProject();
  project.pcb!.footprints[0].value = '10k, "1%"';
  project.pcb!.footprints[0].side = 'back';
  const files = await unzip(exportProjectFile(project, 'jlcpcb', 'supply').bytes);
  assert.match(files.get('README.txt')!, /Assembly CSV uses footprint origins/);
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
  const gap = manufacturingProject();
  const edge = gap.pcb!.graphics.find((graphic) => graphic.layer === 'Edge.Cuts')!;
  edge.end = { ...edge.end, x: edge.end.x - 0.0001 };
  for (const format of ['gerber', 'stencil', 'dxf'] as const)
    assert.throws(() => exportProjectFile(gap, format, 'x'), /requires exact joins/);
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
  assert.doesNotThrow(() => exportProjectFile(filled, 'stencil', 'x'));
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

test('via spans and backdrills export distinct metric programs and retain the native Gerber lands', async () => {
  const name = 'vias.kicad_pcb';
  const source = `(kicad_pcb
    (version 20260206) (generator pcbnew)
    (general (thickness 1.6))
    (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal)
      (8 "In3.Cu" signal) (10 "In4.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
    (setup (pad_to_mask_clearance 0))
    (gr_rect (start 0 0) (end 50 50) (stroke (width 0.05) (type default))
      (fill no) (layer "Edge.Cuts"))
    (via (at 10 20) (size 0.6) (drill 0.3)
      (backdrill (size 0.33) (layers "F.Cu" "In1.Cu"))
      (tertiary_drill (size 0.42) (layers "B.Cu" "In4.Cu"))
      (layers "F.Cu" "B.Cu") (net "GND"))
    (via (at 20 30) (size 0.6) (drill 0.3)
      (tertiary_drill (size 0.44) (layers "B.Cu" "In4.Cu"))
      (layers "F.Cu" "B.Cu") (net "GND"))
    (via blind (at 31 21) (size 0.62) (drill 0.21) (layers "F.Cu" "In2.Cu")
      (start_end_only yes) (net "GND"))
    (via buried (at 32 22) (size 0.52) (drill 0.22) (layers "In2.Cu" "In4.Cu") (net "GND"))
    (via micro (at 33 23) (size 0.37) (drill 0.13) (layers "In4.Cu" "B.Cu") (net "GND"))
  )\n`;
  const open = (sourceText = source) =>
    projectFromNativeFiles({ entry: name, files: [{ name, source: sourceText }] });
  const project = open();
  const gerber = await unzip(exportProjectFile(project, 'gerber', name).bytes);
  const drill = await unzip(exportProjectFile(project, 'drill', name).bytes);

  assert.deepEqual([...drill.keys()].sort(), [
    'vias-Backdrill-L1-L2.drl',
    'vias-Backdrill-L6-L5.drl',
    'vias-Blind-L1-L3.drl',
    'vias-Buried-L3-L5.drl',
    'vias-Microvia-L5-L6.drl',
    'vias-NPTH.drl',
    'vias-PTH.drl',
  ]);
  for (const [file, contents] of drill) assert.equal(gerber.get(file), contents);
  const through = drill.get('vias-PTH.drl')!;
  assert.match(through, /TF\.FileFunction,Plated,1,6,PTH/);
  assert.match(through, /T1C0\.3\n[\s\S]*X10\.000000Y-20\.000000\nX20\.000000Y-30\.000000/);
  assert.doesNotMatch(through, /X3[123]\.000000/);
  const front = drill.get('vias-Backdrill-L1-L2.drl')!;
  assert.match(front, /from L1 \(F\.Cu\) through must-cut L2 \(In1\.Cu\)/);
  assert.match(front, /TF\.FileFunction,NonPlated,1,2,Blind/);
  assert.match(front, /T1C0\.33\n[\s\S]*X10\.000000Y-20\.000000/);
  assert.doesNotMatch(front, /X20\.000000/);
  const back = drill.get('vias-Backdrill-L6-L5.drl')!;
  assert.match(back, /from L6 \(B\.Cu\) through must-cut L5 \(In4\.Cu\)/);
  assert.match(back, /TF\.FileFunction,NonPlated,6,5,Blind/);
  assert.match(
    back,
    /T1C0\.42\nT2C0\.44\n[\s\S]*T1\nX10\.000000Y-20\.000000\nT2\nX20\.000000Y-30\.000000/,
  );
  assert.match(gerber.get('README.txt')!, /fabricator determines machine depths and tolerances/);
  for (const [file, fileFunction, tool, hit] of [
    ['Blind-L1-L3', 'Plated,1,3,Blind', '0.21', 'X31.000000Y-21.000000'],
    ['Buried-L3-L5', 'Plated,3,5,Buried', '0.22', 'X32.000000Y-22.000000'],
    ['Microvia-L5-L6', 'Plated,5,6,Blind', '0.13', 'X33.000000Y-23.000000'],
  ]) {
    const program = drill.get(`vias-${file}.drl`)!;
    assert.ok(program.includes(`TF.FileFunction,${fileFunction}\n`));
    assert.ok(program.includes(`\nT1C${tool}\n`));
    assert.ok(program.includes(`\n${hit}\n`));
  }
  for (const extension of ['gtl', 'g1', 'g2', 'g3', 'g4', 'gbl']) {
    const copper = gerber.get(`vias.${extension}`)!;
    assert.match(copper, /X10000000Y-20000000D03\*/);
    assert.match(copper, /X20000000Y-30000000D03\*/);
    assert.equal(copper.includes('X31000000Y-21000000D03*'), ['gtl', 'g2'].includes(extension));
    assert.equal(
      copper.includes('X32000000Y-22000000D03*'),
      ['g2', 'g3', 'g4'].includes(extension),
    );
    assert.equal(copper.includes('X33000000Y-23000000D03*'), ['g4', 'gbl'].includes(extension));
  }
  assert.match(gerber.get('vias.gts')!, /X31000000Y-21000000D03\*/);
  assert.doesNotMatch(gerber.get('vias.gbs')!, /X31000000Y-21000000D03\*/);
  assert.match(gerber.get('vias.gbs')!, /X33000000Y-23000000D03\*/);
  assert.doesNotMatch(gerber.get('vias.gts')!, /X33000000Y-23000000D03\*/);
  assert.throws(
    () => exportProjectFile(open(source.replace('(size 0.33)', '(size 0.3)')), 'drill', name),
    /backdrill cutter must be larger/,
  );
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

test('supplier metadata is validated only for exported BOM rows', async () => {
  const withSupplier = (excluded: boolean) =>
    nativeBoard((source) =>
      source.replace(
        '(attr smd)',
        `(attr smd${excluded ? ' exclude_from_bom' : ''}) (property "LCSC" "invalid")`,
      ),
    );
  const included = withSupplier(false);
  assert.throws(() => exportProjectFile(included, 'bom', 'x'), /Invalid LCSC part number for R1/);
  assert.throws(
    () => exportProjectFile(included, 'jlcpcb', 'x'),
    /Invalid LCSC part number for R1/,
  );
  const placement = new TextDecoder().decode(exportProjectFile(included, 'placement', 'x').bytes);
  assert.match(placement, /"R1"/);
  const excluded = withSupplier(true);
  const bom = new TextDecoder().decode(exportProjectFile(excluded, 'bom', 'x').bytes);
  assert.doesNotMatch(bom, /"R1"/);
  const archive = await unzip(exportProjectFile(excluded, 'jlcpcb', 'x').bytes);
  assert.equal(archive.get('x-bom.csv'), bom);
  assert.equal(archive.get('x-positions.csv'), placement);
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

test('Excellon places round hits and slot centreline moves in the proper drill files after a native round trip', async () => {
  const project = manufacturingProject();
  const board = project.pcb!;
  const [connector, mounting] = board.footprints;
  Object.assign(connector.pads[0], {
    type: 'thru_hole',
    drill: 0.5,
    drillSlot: { axis: 'y', length: 1 },
    drillOffset: { x: 0.1, y: 0.1 },
  });
  board.footprints[0] = flipPCBFootprint(connector);
  Object.assign(mounting.pads[0], {
    number: 'MH1',
    rotation: 90,
    shape: 'oval',
    size: { x: 4, y: 1 },
    drill: 0.5,
    drillSlot: { axis: 'x', length: 3 },
    drillOffset: { x: 0.25, y: 0.1 },
    layers: ['*.Mask'],
  });
  const netId = uid();
  board.nets.push({ id: netId, name: 'GND' });
  board.vias.push({ id: uid(), x: 11, y: 12, diameter: 0.8, drill: 0.5, netId });
  const reopened = projectFromNativeFiles(projectNativeFiles(project));
  assert.deepEqual(reopened.pcb!.footprints[1].pads[0], mounting.pads[0]);
  const files = await unzip(exportProjectFile(reopened, 'drill', 'slots').bytes);
  const pth = files.get('slots-PTH.drl')!;
  const npth = files.get('slots-NPTH.drl')!;
  assert.match(pth, /T1C0\.5/);
  assert.match(
    pth,
    /X10\.350000Y-11\.100000G85X9\.850000Y-11\.100000\nG05\nX11\.000000Y-12\.000000/,
  );
  assert.doesNotMatch(pth, /X5\.100000/);
  assert.match(npth, /T1C0\.5/);
  assert.match(npth, /X5\.100000Y-6\.000000G85X5\.100000Y-3\.500000/);
  assert.doesNotMatch(npth, /X11\.000000/);
});

test('saved zone holes stay clear while overlapping pads and rotated drill offsets are retained', async () => {
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
  const copper = files.get('x.gtl')!;
  const [dark, remainder] = copper.split('%LPC*%');
  assert.match(dark, /G36\*[\s\S]*X1000000Y-1000000D0[12]\*[\s\S]*G37\*/);
  const [hole, pads] = remainder.split('%LPD*%');
  assert.match(hole, /G36\*[\s\S]*X4000000Y-4000000D0[12]\*[\s\S]*G37\*/);
  assert.match(pads, /G36\*[\s\S]*G37\*/);
  assert.match(files.get('x-PTH.drl')!, /X10\.300000Y-12\.800000/);
});

test('saved Edge.Cuts artwork plots separately from the routed profile and stencil archive', async () => {
  const project = nativeBoard((source) =>
    source.replace(
      /\)\s*$/,
      `  (zone (layer "Edge.Cuts") (hatch edge 0.5)
          (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.3) (thermal_bridge_width 0.3))
          (polygon (pts (xy 60 20) (xy 70 20) (xy 70 25) (xy 60 25)))
          (filled_polygon (layer "Edge.Cuts") (pts (xy 61 21) (xy 69 21) (xy 69 24) (xy 61 24))))
      )`,
    ),
  );
  const gerber = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  const stencil = await unzip(exportProjectFile(project, 'stencil', 'x').bytes);
  const drawing = gerber.get('x-edge-cuts-fill.gbr')!;
  assert.match(drawing, /%TF.FileFunction,OtherDrawing,EdgeCutsFill\*%/);
  assert.match(drawing, /G36\*[\s\S]*X61000000Y-21000000D0[12]\*[\s\S]*G37\*/);
  const profile = gerber.get('x.gko')!;
  assert.match(profile, /%TF.FileFunction,Profile,NP\*%/);
  assert.doesNotMatch(profile, /X61000000|G36\*/);
  assert.equal(stencil.get('x.gko'), profile);
  assert.ok(!stencil.has('x-edge-cuts-fill.gbr'));
  assert.match(gerber.get('README.txt')!, /Use x\.gko as the routed board profile/);
});

test('paired masks keep native route geometry and use signed local or board expansion', async () => {
  const project = nativeBoard((source) =>
    source.replace('(pad_to_mask_clearance 0)', '(pad_to_mask_clearance 0.25)').replace(
      /\)\s*$/,
      `  (segment (start 1 5) (end 3 5) (width 0.3) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.15) (net ""))
         (arc (start 5 6) (mid 7 8) (end 9 6) (width 0.2) (layers "B.Cu" "B.Mask") (net ""))
         (segment (start 2 7) (end 4 7) (width 0.4) (layers "B.Cu" "B.Mask") (solder_mask_margin -0.3) (net ""))
         (gr_rect (start 2 2) (end 6 4) (stroke (width 0.2) (type default)) (fill yes)
           (layers "F.Cu" "F.Mask") (solder_mask_margin -0.3))
         (gr_circle (center 8 3) (end 9 3) (stroke (width 0.1) (type default)) (fill yes)
           (layers "F.Cu" "F.Mask") (solder_mask_margin -0.25))
       )`,
    ),
  );
  const gerbers = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  const frontMask = gerbers.get('x.gts')!;
  const backMask = gerbers.get('x.gbs')!;
  const frontCopper = gerbers.get('x.gtl')!;
  const backCopper = gerbers.get('x.gbl')!;
  assert.match(
    frontMask,
    /%ADD(\d+)C,0\.6\*%[\s\S]*D\1\*\nG01\*\nX1000000Y-5000000D02\*\nX3000000Y-5000000D01\*/,
  );
  assert.match(frontCopper, /%ADD(\d+)C,0\.3\*%[\s\S]*D\1\*\nG01\*\nX1000000Y-5000000D02\*/);
  assert.match(
    backMask,
    /%ADD(\d+)C,0\.7\*%[\s\S]*D\1\*\nX5000000Y-6000000D02\*\nG03X9000000Y-6000000I2000000J0D01\*/,
  );
  assert.doesNotMatch(backMask, /X2000000Y-7000000D02\*/);
  assert.match(backCopper, /X2000000Y-7000000D02\*/);
  assert.match(frontMask, /G36\*\nX2400000Y-2400000D02\*/);
  assert.match(frontMask, /%ADD(\d+)C,1\.6\*%[\s\S]*D\1\*\nX8000000Y-3000000D03\*/);
});

test('native plated padstacks plot individual lands and preserve the shared drill anchor', async () => {
  const project = manufacturingProject();
  const board = project.pcb!;
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  const footprint = board.footprints[0];
  footprint.rotation = 0;
  delete footprint.pads[0].roundrectRatio;
  footprint.pads[0] = {
    ...footprint.pads[0],
    type: 'thru_hole',
    shape: 'circle',
    size: { x: 1.8, y: 1.8 },
    drill: 0.8,
    layers: ['*.Cu', '*.Mask', 'F.Paste', 'B.Paste'],
    padstack: {
      inner: { shape: 'circle', size: { x: 1.3, y: 1.3 } },
      back: { shape: 'circle', size: { x: 2.4, y: 2.4 }, offset: { x: 1, y: 0 } },
    },
  };
  const files = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  for (const name of ['x.gtl', 'x.gts', 'x.gtp'])
    assert.match(files.get(name)!, /%ADD(\d+)C,1\.8\*%[\s\S]*D\1\*\nX9000000Y-12000000D03\*/);
  for (const name of ['x.g1', 'x.g2'])
    assert.match(files.get(name)!, /%ADD(\d+)C,1\.3\*%[\s\S]*D\1\*\nX9000000Y-12000000D03\*/);
  for (const name of ['x.gbl', 'x.gbs', 'x.gbp'])
    assert.match(files.get(name)!, /%ADD(\d+)C,2\.4\*%[\s\S]*D\1\*\nX10000000Y-12000000D03\*/);
  assert.match(files.get('x-PTH.drl')!, /X9\.000000Y-12\.000000/);
  const stencil = await unzip(exportProjectFile(project, 'stencil', 'x').bytes);
  for (const name of ['x.gtp', 'x.gbp']) assert.equal(stencil.get(name), files.get(name));
});

test('Gerber uses circular interpolation for native curved polygon art and the routed profile', async () => {
  const project = nativeBoard((source) =>
    source.replace(
      /\)\s*$/,
      `  (gr_poly (pts (arc (start 1 1) (mid 2 0) (end 3 1)) (xy 3 3) (xy 1 3))
           (stroke (width 0.05) (type default)) (fill yes) (layer "F.Cu"))
         (gr_poly (pts (arc (start 11 11) (mid 12 10) (end 13 11)) (xy 13 13) (xy 11 13))
           (stroke (width 0.05) (type default)) (fill yes) (layer "Edge.Cuts"))
       )`,
    ),
  );
  const files = await unzip(exportProjectFile(project, 'gerber', 'x').bytes);
  assert.match(
    files.get('x.gtl')!,
    /G36\*\nX1000000Y-1000000D02\*\nG02X3000000Y-1000000I1000000J0D01\*/,
  );
  assert.match(
    files.get('x.gko')!,
    /X11000000Y-11000000D02\*\nG02X13000000Y-11000000I1000000J0D01\*/,
  );
  assert.doesNotMatch(files.get('x.gko')!, /G36\*/);
});

test('manufacturing rejects intersecting native curved board outlines before writing a profile', () => {
  const project = nativeBoard((source) =>
    source.replace(
      /\)\s*$/,
      ` (gr_poly (pts (arc (start 0 0) (mid 1.6 2.4) (end 4 4)) (xy 0 4) (xy 4 0))
           (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
       )`,
    ),
  );
  for (const format of ['gerber', 'stencil', 'dxf'] as const)
    assert.throws(() => exportProjectFile(project, format, 'x'), /board outline intersects/);
});
