import { validateProject, type Project } from './project';
import { projectNativeFiles } from './kicad-project';
import { parseKiCadPCBTree } from './kicad-pcb';
import { child, children, parseSExpr, val, type SExpr } from './sexpr';
import { resolvePCBGraphic, type BoardLayer, type Footprint, type PCB } from './pcb';
import { footprintPoint, padDrillPosition } from './pcb-layout';
import { transformPCBGraphic } from './pcb-geometry';
import { boardPolygons, worldZones } from './pcb-polygons';
import { GerberLayer } from './manufacturing-gerber';
import { exportModelCadScad } from './model-cad-scad';
import { modelCadFromProject } from './model-cad';
import { exportZip } from './export-zip';
import { exportBoardOutlineDxf } from './pcb-dxf';
import { exportSchematicNetlist } from './schematic-netlist-export';
import { projectExportFormats, type ProjectExportFormat } from './export-formats';
export { projectExportFormats } from './export-formats';
type ManufacturingFile = { name: string; source: string };
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
  const root = parseSExpr(file.source);
  const { board } = parseKiCadPCBTree(root, project.schematic, project.id);
  return { board, root };
}

function assemblyFiles(
  project: Project,
  board: PCB,
  root: SExpr,
  stem: string,
  format: 'bom' | 'placement' | 'jlcpcb',
): ManufacturingFile[] {
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

/** Split native filled-polygon cut-ins into exact, non-overlapping contours.
 * A repeated bridge is a zero-area ring and is discarded; no coordinates move.
 */
function contours(points: { x: number; y: number }[]) {
  const result: (typeof points)[] = [],
    path: typeof points = [],
    indices = new Map<string, number>();
  for (const p of [...points, points[0]]) {
    const key = `${p.x},${p.y}`,
      prior = indices.get(key);
    if (prior !== undefined) {
      const ring = path.slice(prior);
      if (ring.length >= 3) result.push(ring);
      for (const removed of path.splice(prior + 1)) indices.delete(`${removed.x},${removed.y}`);
    } else {
      indices.set(key, path.length);
      path.push(p);
    }
  }
  return result;
}

function gerberFiles(
  project: Project,
  board: PCB,
  root: SExpr,
  stem: string,
  stencil = false,
): ManufacturingFile[] {
  boardPolygons(board); // Reject open/ambiguous outlines before publishing any file.
  const setup = child(root, 'setup') ?? [];
  const setting = (key: string) => Number(val(child(setup, key)) || 0);
  const zones = stencil
    ? []
    : worldZones(board).filter((z) => !z.keepout && z.fillEnabled !== false);
  if (!stencil) {
    for (const key of ['covering', 'plugging'])
      if (['front', 'back'].some((side) => val(child(child(setup, key) ?? [], side)) === 'yes'))
        throw new Error(`Gerber export does not support enabled via ${key}.`);
    if (['capping', 'filling'].some((key) => val(child(setup, key)) === 'yes'))
      throw new Error('Gerber export does not support capped or filled vias.');
    if (setting('solder_mask_min_width'))
      throw new Error('Gerber export does not support a nonzero minimum solder-mask web.');
    if (zones.some((z) => z.filledPolygons === undefined))
      throw new Error('Fill all enabled zones in Layout before exporting Gerber files.');
    if (
      board.footprints.some((f) => f.pads.some((p) => p.removeUnusedLayers)) ||
      children(root, 'via').some((v) => val(child(v, 'remove_unused_layers')) === 'yes')
    )
      throw new Error('Gerber export does not support removing unused pad or via copper layers.');
  }
  // Font faces and text knockout need native glyph outlines not held by this exporter.
  const textLayers = stencil ? /^[FB]\.Paste$/ : /\.(?:Cu|Mask|Paste|SilkS)$/;
  const checkText = (node: SExpr) => {
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
    for (const zone of zones.filter((z) => z.layer === layer))
      for (const polygon of zone.filledPolygons!) {
        const rings = contours(polygon.points);
        if (rings.length) plot.region(rings);
      }
    for (const track of board.tracks.filter((t) => t.layer === layer))
      plot.line(track.start, track.end, track.width);
    if (layer.endsWith('.Cu')) for (const via of board.vias) plot.circle(via, via.diameter);
    if (
      layer.endsWith('.Mask') &&
      val(child(child(setup, 'tenting') ?? [], layer === 'F.Mask' ? 'front' : 'back')) !== 'yes'
    )
      for (const via of board.vias) plot.circle(via, via.diameter);
    for (const f of board.footprints) {
      for (const p of f.pads) {
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
              (l === '*.Mask' && layer.endsWith('.Mask')),
          )
        )
          continue;
        if (layer.endsWith('.Mask')) {
          const margin =
            p.solderMaskMargin ?? f.solderMaskMargin ?? setting('pad_to_mask_clearance');
          plot.pad(f, p, margin);
        } else if (layer.endsWith('.Paste')) {
          const margin =
            p.solderPasteMargin ?? f.solderPasteMargin ?? setting('pad_to_paste_clearance');
          const ratio =
            p.solderPasteMarginRatio ??
            f.solderPasteMarginRatio ??
            setting('pad_to_paste_clearance_ratio');
          plot.pad(f, p, margin + p.size.x * ratio, margin + p.size.y * ratio);
        } else plot.pad(f, p);
      }
      const part = f.symbolId ? parts.get(f.symbolId) : undefined;
      for (const g of f.graphics.filter((g) => g.layer === layer))
        plot.graphic(
          transformPCBGraphic(
            resolvePCBGraphic(g, part?.ref ?? f.reference ?? '', part?.value ?? f.value ?? ''),
            (p) => footprintPoint(f, p),
            (a) => a + f.rotation,
          ),
        );
    }
    for (const g of board.graphics.filter((g) => g.layer === layer)) plot.graphic(g);
    files.push({ name: `${stem}.${extension}`, source: plot.finish() });
  }
  return files;
}

const fabricationNotes =
  'OpenPE manufacturing export\n\nGerber X2 and metric Excellon through drills. All files use native board X and negated board Y, in millimetres. No board translation or bottom-side mirroring is applied. Copper uses saved fills; no refill or DRC is run. Review the CAM layers, holes and outline before ordering.\n';
const assemblyNotes =
  '\nAssembly CSV uses footprint origins, CCW degrees and Top/Bottom as viewed from the top. LCSC numbers are copied only from explicit component fields; missing numbers require supplier selection. Native DNP/BOM/position exclusions are retained. Package-specific rotation/centroid corrections are not inferred. Review assembly orientation before ordering.\n';

function drillFiles(board: PCB, stem: string): ManufacturingFile[] {
  const files: ManufacturingFile[] = [];
  for (const plated of [true, false]) {
    const holes = board.footprints.flatMap((f) =>
      f.pads
        .filter((p) => p.drill && (p.type !== 'np_thru_hole') === plated)
        .map((p) => ({ ...padDrillPosition(f, p), diameter: p.drill! })),
    );
    if (plated) holes.push(...board.vias.map((v) => ({ ...v, diameter: v.drill })));
    const diameters = [...new Set(holes.map((h) => number(h.diameter)))].sort(
      (a, b) => Number(a) - Number(b),
    );
    const commands = [
      'M48',
      '; OpenPE metric Excellon; absolute XY; explicit decimals',
      `; ${plated ? 'Plated' : 'Non-plated'} through holes`,
      'METRIC,TZ',
      ...diameters.map((d, i) => `T${i + 1}C${d}`),
      '%',
      'G90',
      'G05',
    ];
    for (const [i, d] of diameters.entries()) {
      commands.push(`T${i + 1}`);
      for (const h of holes.filter((h) => number(h.diameter) === d))
        commands.push(`X${h.x.toFixed(6)}Y${(-h.y).toFixed(6)}`);
    }
    files.push({
      name: `${stem}-${plated ? 'PTH' : 'NPTH'}.drl`,
      source: [...commands, 'M30', ''].join('\n'),
    });
  }
  return files;
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
  const { board, root } = boardData(project);
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
    files = gerberFiles(project, board, root, stem, true);
  } else {
    files = [
      ...gerberFiles(project, board, root, stem),
      ...drillFiles(board, stem),
      {
        name: 'README.txt',
        source: format === 'jlcpcb' ? fabricationNotes + assemblyNotes : fabricationNotes,
      },
    ];
    if (format === 'jlcpcb') files.push(...assemblyFiles(project, board, root, stem, format));
  }
  return { name: filename, bytes: exportZip(files), mime: 'application/zip' };
}
