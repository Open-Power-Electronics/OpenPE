import { validateProject, type Project } from './project';
import type { Point } from './circuit';
import { projectNativeFiles } from './kicad-project';
import { parseKiCadPCB } from './kicad-pcb';
import { child, children, parseSExpr, val, type SExpr } from './sexpr';
import {
  hasNativeCustomPads,
  hasNativePCBPadMachining,
  hasNativePCBTableOutput,
  hasPCBGraphicMask,
  hasPCBTrackMask,
  isNativePCBEdgeCutFill,
  pcbTrackMaskOpeningWidth,
  resolvePCBGraphic,
  type BoardLayer,
  type Footprint,
  type PCB,
} from './pcb';
import { footprintPoint, padDrillLine } from './pcb-layout';
import { transformPCBGraphic } from './pcb-geometry';
import { prepareFabricationOutline, worldZones } from './pcb-polygons';
import { GerberLayer } from './manufacturing-gerber';
import { padApertureLayers, padSilkscreenLayers } from './pcb-pad-role';
import { pcbViaCopperLayers, pcbViaHasTreatment } from './pcb-native-via';
import { pcbPadOnLayer, pcbViaDiameter } from './pcb-padstack';
import { pcbFillRuleContext } from './pcb-clearance-sources';
import { exportModelCadScad } from './model-cad-scad';
import { modelCadFromProject } from './model-cad';
import { exportZip } from './export-zip';
import { exportBoardOutlineDxf } from './pcb-dxf';
import { exportSchematicNetlist } from './schematic-netlist-export';
import { projectExportFormats, type ProjectExportFormat } from './export-formats';
export { projectExportFormats } from './export-formats';
type ManufacturingFile = { name: string; source: string };
type DrillHit = { line: [Point, Point]; diameter: number; slot: boolean };
const number = (n: number) => String(Number(n.toFixed(6)));
const csv = (rows: (string | number)[][]) =>
  rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n') +
  '\r\n';
const exportStem = (name: string) =>
  name
    .replace(/\.kicad_(?:pro|sch|pcb)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'project';
function exportFileName(stem: string, format: ProjectExportFormat) {
  const definition = projectExportFormats.find((entry) => entry.id === format);
  if (!definition) throw new Error('Unsupported export format.');
  return `${stem}${definition.suffix}.${definition.extension}`;
}

function boardData(project: Project) {
  if (!project.pcb) throw new Error('Create a PCB layout before exporting manufacturing files.');
  const file = projectNativeFiles(project).files.find((file) => /\.kicad_pcb$/i.test(file.name));
  if (!file) throw new Error('The project has no native PCB file.');
  // Use the same complete native backing as Save/Source, including retained
  // board setup and native assembly flags absent from the editable PCB model.
  const {
    board,
    nativeRectangleIds,
    normalized: root,
  } = parseKiCadPCB(file.source, project.schematic, project.id);
  return { board, nativeRectangleIds, root };
}

function assemblyFiles(
  project: Project,
  board: PCB,
  root: SExpr,
  stem: string,
  format: 'bom' | 'placement' | 'jlcpcb',
): ManufacturingFile[] {
  if (
    children(child(root, 'variants') ?? [], 'variant').length ||
    children(root, 'footprint').some((footprint) => child(footprint, 'variant'))
  )
    throw new Error('Assembly export for native KiCad variants is unavailable in OpenPE.');
  const includeBom = format !== 'placement';
  const includePosition = format !== 'bom';
  const native = new Map(children(root, 'footprint').map((f) => [val(child(f, 'uuid')), f]));
  const parts = new Map(project.schematic.parts.map((p) => [p.id, p]));
  const rows: {
    reference: string;
    value: string;
    footprint: string;
    lcsc: string;
    f: Footprint;
    bom: boolean;
    pos: boolean;
  }[] = [];
  const references = new Set<string>();
  for (const f of board.footprints) {
    const source = native.get(f.id),
      attr = child(source ?? [], 'attr') ?? [];
    const part = f.symbolId ? parts.get(f.symbolId) : undefined;
    if (
      attr.includes('board_only') ||
      attr.includes('dnp') ||
      (part?.raw && val(child(part.raw, 'dnp')) === 'yes')
    )
      continue;
    const bom =
      includeBom &&
      !attr.includes('exclude_from_bom') &&
      !(part?.raw && val(child(part.raw, 'in_bom')) === 'no');
    const pos =
      includePosition &&
      !attr.includes('exclude_from_pos_files') &&
      !(part?.raw && val(child(part.raw, 'in_pos_files')) === 'no');
    if (!bom && !pos) continue;
    const reference = part?.ref ?? f.reference ?? '';
    if (!reference.trim())
      throw new Error('Assign a reference to every assembly footprint before exporting.');
    if (references.has(reference.toUpperCase()))
      throw new Error(`Assembly references must be unique: ${reference}.`);
    references.add(reference.toUpperCase());
    let lcsc = '';
    if (bom) {
      const fields = {
        ...Object.fromEntries(children(source ?? [], 'property').map((p) => [val(p), val(p, 2)])),
        ...part?.fields,
      };
      lcsc =
        ['LCSC Part #', 'LCSC', 'LCSC Part', 'JLCPCB Part #']
          .map((key) => fields[key]?.trim())
          .find(Boolean) ?? '';
      if (lcsc && !/^C\d+$/i.test(lcsc))
        throw new Error(`Invalid LCSC part number for ${reference}.`);
    }
    rows.push({
      reference,
      value: part?.value ?? f.value ?? '',
      footprint: f.libraryId,
      lcsc,
      f,
      bom,
      pos,
    });
  }
  rows.sort((a, b) => a.reference.localeCompare(b.reference, 'en', { numeric: true }));
  const files: ManufacturingFile[] = [];
  if (includeBom) {
    const groups = new Map<string, typeof rows>();
    for (const row of rows.filter((row) => row.bom)) {
      const key = JSON.stringify([row.value, row.footprint, row.lcsc]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    files.push({
      name: exportFileName(stem, 'bom'),
      source: csv([
        ['Comment', 'Designator', 'Footprint', 'LCSC Part #'],
        ...[...groups.values()].map((group) => [
          group[0].value,
          group.map((r) => r.reference).join(','),
          group[0].footprint,
          group[0].lcsc,
        ]),
      ]),
    });
  }
  if (includePosition)
    files.push({
      name: exportFileName(stem, 'placement'),
      source: csv([
        ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'],
        ...rows
          .filter((row) => row.pos)
          .map(({ reference, f }) => [
            reference,
            number(f.x) + 'mm',
            number(-f.y) + 'mm',
            f.side === 'front' ? 'Top' : 'Bottom',
            number(((f.rotation % 360) + 360) % 360),
          ]),
      ]),
    });
  return files;
}

function gerberFiles(
  project: Project,
  { board, nativeRectangleIds, root }: ReturnType<typeof boardData>,
  stem: string,
  stencil = false,
): ManufacturingFile[] {
  if (hasNativePCBPadMachining(board))
    throw new Error('Gerber export for native pad machining or press-fit settings requires KiCad.');
  if (!stencil && board.barcodes?.length)
    throw new Error('Gerber plotting of native barcodes requires KiCad.');
  if (!stencil) requireSupportedViaManufacturing(board);
  if (hasNativePCBTableOutput(board))
    throw new Error('Gerber plotting of native tables on fabrication layers requires KiCad.');
  const outline = prepareFabricationOutline(board, 'Gerber');
  const setup = child(root, 'setup') ?? [];
  const setting = (key: string) => Number(val(child(setup, key)) || 0);
  const boardMaskMargin = setting('pad_to_mask_clearance');
  if (!stencil && !Number.isFinite(boardMaskMargin))
    throw new Error('The native board solder-mask margin must be finite.');
  const pairedMask = !stencil && (hasPCBGraphicMask(board) || hasPCBTrackMask(board));
  const customPads = hasNativeCustomPads(board);
  if (pairedMask || customPads) {
    const { rulesSource } = pcbFillRuleContext(project);
    if (rulesSource && /solder_(?:mask_expansion|paste_(?:abs|rel)_margin)/.test(rulesSource)) {
      const rules = parseSExpr(`(${rulesSource.replace(/^\s*#[^\r\n]*/gm, '')})`, 131072);
      const constraints = new Set(
        children(rules, 'rule').flatMap((rule) => children(rule, 'constraint').map((c) => val(c))),
      );
      if (!stencil && constraints.has('solder_mask_expansion'))
        throw new Error('Gerber export does not support custom solder-mask expansion rules.');
      if (
        customPads &&
        (constraints.has('solder_paste_abs_margin') || constraints.has('solder_paste_rel_margin'))
      )
        throw new Error(
          'Gerber export does not support solder-paste margin rules on native custom pads.',
        );
    }
  }
  const zones = stencil
    ? []
    : worldZones(board).filter((z) => !z.keepout && z.fillEnabled !== false);
  if (!stencil) {
    const plotSettings = child(setup, 'pcbplotparams') ?? [];
    if (
      val(child(plotSettings, 'subtractmaskfromsilk')) === 'yes' &&
      board.footprints.some((footprint) =>
        footprint.pads.some((pad) => padSilkscreenLayers(pad).length),
      )
    )
      throw new Error(
        'Gerber plotting of native pad silkscreen with solder-mask subtraction requires KiCad.',
      );
    for (const key of ['covering', 'plugging'])
      if (['front', 'back'].some((side) => val(child(child(setup, key) ?? [], side)) === 'yes'))
        throw new Error(`Gerber export does not support enabled via ${key}.`);
    if (['capping', 'filling'].some((key) => val(child(setup, key)) === 'yes'))
      throw new Error('Gerber export does not support capped or filled vias.');
    if (setting('solder_mask_min_width'))
      throw new Error('Gerber export does not support a nonzero minimum solder-mask web.');
    if (
      board.footprints.some((f) => f.pads.some((p) => p.removeUnusedLayers)) ||
      board.vias.some((via) => via.removeUnusedLayers)
    )
      throw new Error('Gerber export does not support removing unused pad or via copper layers.');
  }
  // Font faces and text knockout need native glyph outlines not held by this exporter.
  const textLayers = stencil ? /^[FB]\.Paste$/ : /\.(?:Cu|Mask|Paste|SilkS)$/;
  const checkText = (node: SExpr) => {
    if (
      (node[0] === 'gr_text_box' || node[0] === 'fp_text_box') &&
      textLayers.test(val(child(node, 'layer')))
    )
      throw new Error('Gerber export does not support native PCB text boxes on plotted layers.');
    if (
      (node[0] === 'gr_text' || node[0] === 'fp_text' || node[0] === 'property') &&
      textLayers.test(val(child(node, 'layer'))) &&
      val(child(node, 'hide')) !== 'yes' &&
      val(child(child(node, 'effects') ?? [], 'hide')) !== 'yes' &&
      !child(node, 'effects')?.includes('hide') &&
      !node.includes('hide')
    ) {
      if (
        child(child(child(node, 'effects') ?? [], 'font') ?? [], 'face') ||
        child(node, 'layer')?.includes('knockout')
      )
        throw new Error('Gerber export supports only the native stroke font without knockout.');
    }
    for (const nested of node) if (Array.isArray(nested)) checkText(nested);
  };
  checkText(root);
  const files: ManufacturingFile[] = [];
  const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
  const viaLayers = new Map(board.vias.map((via) => [via, pcbViaCopperLayers(board.layers, via)]));
  const layers: [BoardLayer, string, string][] = [
    ...board.layers.map((layer, i): [BoardLayer, string, string] => [
      layer,
      `Copper,L${i + 1},${i === 0 ? 'Top' : i === board.layers.length - 1 ? 'Bot' : 'Inr'}`,
      layer === 'F.Cu' ? 'gtl' : layer === 'B.Cu' ? 'gbl' : `g${i}`,
    ]),
    ['F.Mask', 'Soldermask,Top', 'gts'],
    ['B.Mask', 'Soldermask,Bot', 'gbs'],
    ['F.Paste', 'Paste,Top', 'gtp'],
    ['B.Paste', 'Paste,Bot', 'gbp'],
    ['F.SilkS', 'Legend,Top', 'gto'],
    ['B.SilkS', 'Legend,Bot', 'gbo'],
    ['Edge.Cuts', 'Profile,NP', 'gko'],
  ];
  for (const [layer, fileFunction, extension] of layers) {
    if (stencil && layer !== 'Edge.Cuts' && !layer.endsWith('.Paste')) continue;
    const plot = new GerberLayer(fileFunction);
    if (layer === 'Edge.Cuts') {
      for (const edge of outline) plot.graphic(edge);
      files.push({ name: `${stem}.${extension}`, source: plot.finish() });
      continue;
    }
    const layerZones = zones.filter((zone) => zone.layer === layer);
    if (layerZones.some((zone) => zone.filledPolygons === undefined))
      throw new Error('Fill all enabled zones in Layout before exporting Gerber files.');
    plot.zoneFills(layerZones.flatMap((zone) => zone.filledPolygons!.map((p) => p.points)));
    const trackWidth = (track: PCB['tracks'][number]) =>
      track.layer === layer
        ? track.width
        : track.maskLayer === layer
          ? pcbTrackMaskOpeningWidth({
              ...track,
              solderMaskMargin: track.solderMaskMargin ?? boardMaskMargin,
            })
          : 0;
    for (const track of board.tracks) {
      const width = trackWidth(track);
      if (width >= 0.0000005) plot.line(track.start, track.end, width);
    }
    for (const track of board.arcTracks ?? []) {
      const width = trackWidth(track);
      if (width >= 0.0000005) plot.graphic({ ...track, kind: 'arc', width });
    }
    const copperLayer = board.layers.find((candidate) => candidate === layer);
    if (copperLayer)
      for (const via of board.vias) {
        if (!viaLayers.get(via)!.includes(copperLayer)) continue;
        const diameter = pcbViaDiameter(via, copperLayer);
        if (diameter) plot.circle(via, diameter);
      }
    if (layer.endsWith('.Mask')) {
      const side = layer === 'F.Mask' ? 'front' : 'back';
      const outerLayer = side === 'front' ? 'F.Cu' : 'B.Cu';
      const defaults = val(child(child(setup, 'tenting') ?? [], side)) === 'yes';
      for (const via of board.vias) {
        if (!viaLayers.get(via)!.includes(outerLayer) || (via.tenting?.[side] ?? defaults))
          continue;
        const diameter = pcbViaDiameter(via, outerLayer);
        if (diameter && diameter + 2 * boardMaskMargin >= 0.0000005)
          plot.circle(via, diameter + 2 * boardMaskMargin);
      }
    }
    for (const f of board.footprints) {
      for (const p of f.pads) {
        if (
          layer.endsWith('.Cu') &&
          p.type === 'np_thru_hole' &&
          p.shape === 'circle' &&
          p.drill === p.size.x &&
          !p.drillOffset &&
          !p.drillSlot
        )
          continue;
        const padLayers =
          p.layers ??
          (p.type === 'smd'
            ? [
                f.side === 'front' ? 'F.Cu' : 'B.Cu',
                f.side === 'front' ? 'F.Mask' : 'B.Mask',
                f.side === 'front' ? 'F.Paste' : 'B.Paste',
              ]
            : ['*.Cu', '*.Mask']);
        if (
          !padLayers.some(
            (l) =>
              l === layer ||
              (l === '*.Cu' && layer.endsWith('.Cu')) ||
              (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu')) ||
              (l === '*.Mask' && layer.endsWith('.Mask')),
          ) &&
          !(layer.endsWith('.SilkS') && padSilkscreenLayers(p).some((silk) => silk === layer))
        )
          continue;
        const layerPad = pcbPadOnLayer(p, layer);
        if (padApertureLayers(p)) {
          plot.pad(f, layerPad);
        } else if (layer.endsWith('.Mask')) {
          const margin = p.solderMaskMargin ?? f.solderMaskMargin ?? boardMaskMargin;
          plot.pad(f, layerPad, margin);
        } else if (layer.endsWith('.Paste')) {
          const margin =
            p.solderPasteMargin ?? f.solderPasteMargin ?? setting('pad_to_paste_clearance');
          const ratio =
            p.solderPasteMarginRatio ??
            f.solderPasteMarginRatio ??
            setting('pad_to_paste_clearance_ratio');
          plot.pad(f, layerPad, margin + layerPad.size.x * ratio, margin + layerPad.size.y * ratio);
        } else plot.pad(f, layerPad);
      }
      const part = f.symbolId ? parts.get(f.symbolId) : undefined;
      const graphics: Footprint['graphics'] = f.graphics.filter(
        (graphic) => graphic.layer === layer || graphic.maskLayer === layer,
      );
      for (const g of graphics) {
        const placed = transformPCBGraphic(
          resolvePCBGraphic(g, part?.ref ?? f.reference ?? '', part?.value ?? f.value ?? ''),
          (p) => footprintPoint(f, p),
          (a) => a + f.rotation,
        );
        if (g.layer === layer) plot.graphic(placed);
        else
          plot.maskGraphic(
            placed,
            g.solderMaskMargin ?? boardMaskMargin,
            nativeRectangleIds.has(g.id),
          );
      }
    }
    for (const g of board.graphics) {
      if (g.layer === layer) plot.graphic(g);
      else if (g.maskLayer === layer)
        plot.maskGraphic(g, g.solderMaskMargin ?? boardMaskMargin, nativeRectangleIds.has(g.id));
    }
    files.push({ name: `${stem}.${extension}`, source: plot.finish() });
  }
  const edgeCutFills = zones.filter(isNativePCBEdgeCutFill);
  if (edgeCutFills.length) {
    const drawing = new GerberLayer('OtherDrawing,EdgeCutsFill');
    drawing.zoneFills(edgeCutFills.flatMap((zone) => zone.filledPolygons!.map((p) => p.points)));
    files.push({ name: `${stem}-edge-cuts-fill.gbr`, source: drawing.finish() });
  }
  return files;
}

const fabricationNotes =
  'OpenPE manufacturing export\n\nGerber X2 and metric Excellon drills. All files use native board X and negated board Y, in millimetres. No board translation or bottom-side mirroring is applied. Copper uses saved fills; no refill or DRC is run. Review the CAM layers, holes and outline before ordering.\n';
const backdrillNotes =
  '\nBackdrill files are separate after-plating operations. File names and headers give the physical entry and inclusive must-cut layers, numbered from the front copper layer. The fabricator determines machine depths and tolerances from the actual stackup.\n';
const assemblyNotes =
  '\nAssembly CSV uses footprint origins, CCW degrees and Top/Bottom as viewed from the top. LCSC numbers are copied only from explicit component fields; missing numbers require supplier selection. Native DNP/BOM/position exclusions are retained. Package-specific rotation/centroid corrections are not inferred. Review assembly orientation before ordering.\n';

function requireSupportedViaManufacturing(board: PCB) {
  for (const via of board.vias) {
    if (pcbViaHasTreatment(via.treatment))
      throw new Error('Manufacturing output for native via treatments is unsupported.');
    if (via.backdrills && Object.values(via.backdrills).some((cut) => cut.diameter <= via.drill))
      throw new Error('A backdrill cutter must be larger than its primary drill.');
  }
}

function drillProgram(holes: DrillHit[], description: string, fileFunction: string): string {
  const hitsByTool = new Map<string, DrillHit[]>();
  for (const hole of holes) {
    const diameter = number(hole.diameter);
    const hits = hitsByTool.get(diameter);
    if (hits) hits.push(hole);
    else hitsByTool.set(diameter, [hole]);
  }
  const diameters = [...hitsByTool.keys()].sort((a, b) => Number(a) - Number(b));
  const commands = [
    'M48',
    '; OpenPE metric Excellon; absolute XY; explicit decimals',
    `; ${description}`,
    `; #@! TF.FileFunction,${fileFunction}`,
    'METRIC,TZ',
    ...diameters.map((diameter, i) => `T${i + 1}C${diameter}`),
    '%',
    'G90',
    'G05',
  ];
  const coordinate = (point: Point) => `X${point.x.toFixed(6)}Y${(-point.y).toFixed(6)}`;
  for (const [i, diameter] of diameters.entries()) {
    commands.push(`T${i + 1}`);
    for (const {
      line: [start, end],
      slot,
    } of hitsByTool.get(diameter)!)
      if (slot) commands.push(`${coordinate(start)}G85${coordinate(end)}`, 'G05');
      else commands.push(coordinate(start));
  }
  return [...commands, 'M30', ''].join('\n');
}

function drillFiles(board: PCB, stem: string): ManufacturingFile[] {
  if (hasNativePCBPadMachining(board))
    throw new Error('Drill export for native pad machining or press-fit settings requires KiCad.');
  requireSupportedViaManufacturing(board);
  const programs = new Map<
    string,
    { description: string; fileFunction: string; holes: DrillHit[] }
  >();
  const throughPads = (plated: boolean): DrillHit[] =>
    board.footprints.flatMap((f) =>
      f.pads
        .filter((p) => p.drill && (p.type !== 'np_thru_hole') === plated)
        .map((p) => ({ line: padDrillLine(f, p), diameter: p.drill!, slot: !!p.drillSlot })),
    );
  const lastLayer = board.layers.length;
  const platedThrough = throughPads(true);
  programs.set(`${stem}-PTH.drl`, {
    description: 'Plated through holes',
    fileFunction: `Plated,1,${lastLayer},PTH`,
    holes: platedThrough,
  });
  programs.set(`${stem}-NPTH.drl`, {
    description: 'Non-plated through holes',
    fileFunction: `NonPlated,1,${lastLayer},NPTH`,
    holes: throughPads(false),
  });
  const append = (
    name: string,
    description: string,
    fileFunction: string,
    at: Point,
    diameter: number,
  ) => {
    const hit: DrillHit = { line: [at, at], diameter, slot: false };
    const program = programs.get(name);
    if (program) program.holes.push(hit);
    else programs.set(name, { description, fileFunction, holes: [hit] });
  };
  for (const via of board.vias) {
    if (
      !via.span ||
      (via.span.kind !== 'micro' && via.span.start === 'F.Cu' && via.span.end === 'B.Cu')
    ) {
      platedThrough.push({ line: [via, via], diameter: via.drill, slot: false });
    } else {
      const { start, end, kind } = via.span;
      const first = board.layers.indexOf(start) + 1;
      const last = board.layers.indexOf(end) + 1;
      const type =
        first === 1 && last === lastLayer
          ? 'PTH'
          : first === 1 || last === lastLayer
            ? 'Blind'
            : 'Buried';
      const program = kind === 'micro' ? 'Microvia' : type;
      append(
        `${stem}-${program}-L${first}-L${last}.drl`,
        `Plated ${program.toLowerCase()} holes from L${first} (${start}) to L${last} (${end})`,
        `Plated,${first},${last},${type}`,
        via,
        via.drill,
      );
    }
    if (!via.backdrills) continue;
    for (const { start, end, diameter } of Object.values(via.backdrills)) {
      const entry = board.layers.indexOf(start) + 1;
      const mustCut = board.layers.indexOf(end) + 1;
      append(
        `${stem}-Backdrill-L${entry}-L${mustCut}.drl`,
        `After-plating backdrill from L${entry} (${start}) through must-cut L${mustCut} (${end})`,
        `NonPlated,${entry},${mustCut},Blind`,
        via,
        diameter,
      );
    }
  }
  return Array.from(programs, ([name, { description, fileFunction, holes }]) => ({
    name,
    source: drillProgram(holes, description, fileFunction),
  }));
}

export function exportProjectFile(
  project: Project,
  format: ProjectExportFormat,
  name: string,
): { name: string; bytes: Uint8Array; mime: string } {
  validateProject(project);
  const stem = exportStem(name),
    filename = exportFileName(stem, format);
  if (format === 'netlist')
    return {
      name: filename,
      bytes: new TextEncoder().encode(exportSchematicNetlist(project)),
      mime: 'application/xml;charset=utf-8',
    };
  if (format === 'scad') {
    const model = project.pcb ? modelCadFromProject(project) : null;
    if (!model?.objects.length) throw new Error('Create a CAD solid before exporting OpenSCAD.');
    return {
      name: filename,
      bytes: new TextEncoder().encode(exportModelCadScad(model)),
      mime: 'text/plain',
    };
  }
  const native = boardData(project);
  const { board, root } = native;
  if (format === 'dxf')
    return {
      name: filename,
      bytes: new TextEncoder().encode(exportBoardOutlineDxf(board)),
      mime: 'application/dxf',
    };
  if (format === 'bom' || format === 'placement') {
    const [file] = assemblyFiles(project, board, root, stem, format);
    return {
      name: filename,
      bytes: new TextEncoder().encode(file.source),
      mime: 'text/csv;charset=utf-8',
    };
  }
  let files: ManufacturingFile[];
  if (format === 'drill') {
    files = drillFiles(board, stem);
  } else if (format === 'stencil') {
    files = gerberFiles(project, native, stem, true);
  } else {
    const gerbers = gerberFiles(project, native, stem);
    const drawing = `${stem}-edge-cuts-fill.gbr`;
    files = [
      ...gerbers,
      ...drillFiles(board, stem),
      {
        name: 'README.txt',
        source:
          fabricationNotes +
          (gerbers.some(({ name }) => name === drawing)
            ? `\n${drawing} contains saved technical artwork. Use ${stem}.gko as the routed board profile.\n`
            : '') +
          (board.vias.some((via) => via.backdrills) ? backdrillNotes : '') +
          (format === 'jlcpcb' ? assemblyNotes : ''),
      },
    ];
    if (format === 'jlcpcb') files.push(...assemblyFiles(project, board, root, stem, format));
  }
  return { name: filename, bytes: exportZip(files), mime: 'application/zip' };
}
