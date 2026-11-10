import type { Point } from './circuit';
import type { PCB } from './pcb';
import { pcbArc } from './pcb-geometry';
import { prepareBoardOutline } from './pcb-polygons';

type DxfValue = string | number;
const outlineLayer = 'Edge.Cuts';
const modelSpace = {
  block: '*Model_Space',
  record: '13',
  begin: '15',
  end: '16',
  tab: 'Model',
  layout: '23',
};
const paperSpace = {
  block: '*Paper_Space',
  record: '14',
  begin: '17',
  end: '18',
  tab: 'Layout1',
  layout: '24',
};
const spaces = [modelSpace, paperSpace];

function writeDxfTables(pairs: DxfValue[]): void {
  const table = (name: string, handle: string, count: number) =>
    pairs.push(0, 'TABLE', 2, name, 5, handle, 330, '0', 100, 'AcDbSymbolTable', 70, count);
  const endTable = () => pairs.push(0, 'ENDTAB');
  const record = (name: string, handle: string, owner: string, subclass: string) => {
    pairs.push(0, name, name === 'DIMSTYLE' ? 105 : 5, handle, 330, owner);
    pairs.push(100, 'AcDbSymbolTableRecord', 100, subclass);
  };

  pairs.push(0, 'SECTION', 2, 'TABLES');
  table('VPORT', '1', 0);
  endTable();
  table('LTYPE', '2', 3);
  for (const [handle, name] of [
    ['B', 'ByBlock'],
    ['C', 'ByLayer'],
    ['D', 'Continuous'],
  ]) {
    record('LTYPE', handle, '2', 'AcDbLinetypeTableRecord');
    pairs.push(2, name, 70, 0, 3, '', 72, 65, 73, 0, 40, 0);
  }
  endTable();
  table('LAYER', '3', 2);
  for (const [handle, name] of [
    ['E', '0'],
    ['F', outlineLayer],
  ]) {
    record('LAYER', handle, '3', 'AcDbLayerTableRecord');
    pairs.push(2, name, 70, 0, 62, 7, 6, 'Continuous', 370, -3);
  }
  endTable();
  table('STYLE', '4', 1);
  record('STYLE', '10', '4', 'AcDbTextStyleTableRecord');
  pairs.push(2, 'Standard', 70, 0, 40, 0, 41, 1, 50, 0, 71, 0, 42, 2.5, 3, 'txt', 4, '');
  endTable();
  table('VIEW', '5', 0);
  endTable();
  table('UCS', '6', 0);
  endTable();
  table('APPID', '7', 1);
  record('APPID', '11', '7', 'AcDbRegAppTableRecord');
  pairs.push(2, 'ACAD', 70, 0);
  endTable();
  table('DIMSTYLE', '8', 1);
  pairs.push(100, 'AcDbDimStyleTable', 71, 1, 340, '12');
  record('DIMSTYLE', '12', '8', 'AcDbDimStyleTableRecord');
  pairs.push(2, 'Standard', 70, 0, 340, '10');
  endTable();
  table('BLOCK_RECORD', '9', spaces.length);
  for (const space of spaces) {
    record('BLOCK_RECORD', space.record, '9', 'AcDbBlockTableRecord');
    pairs.push(2, space.block, 340, space.layout);
  }
  endTable();
  pairs.push(0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS');
  for (const space of spaces) {
    pairs.push(0, 'BLOCK', 5, space.begin, 330, space.record, 100, 'AcDbEntity', 8, '0');
    pairs.push(
      100,
      'AcDbBlockBegin',
      2,
      space.block,
      70,
      0,
      10,
      0,
      20,
      0,
      30,
      0,
      3,
      space.block,
      1,
      '',
    );
    pairs.push(0, 'ENDBLK', 5, space.end, 330, space.record, 100, 'AcDbEntity', 8, '0');
    pairs.push(100, 'AcDbBlockEnd');
  }
  pairs.push(0, 'ENDSEC');
}

function writeDxfObjects(pairs: DxfValue[]): void {
  const dictionary = (handle: string, owner: string) =>
    pairs.push(0, 'DICTIONARY', 5, handle, 330, owner, 100, 'AcDbDictionary', 281, 1);

  pairs.push(0, 'SECTION', 2, 'OBJECTS');
  dictionary('20', '0');
  pairs.push(3, 'ACAD_GROUP', 350, '21', 3, 'ACAD_LAYOUT', 350, '22');
  dictionary('21', '20');
  dictionary('22', '20');
  for (const space of spaces) pairs.push(3, space.tab, 350, space.layout);
  for (const [index, space] of spaces.entries()) {
    pairs.push(0, 'LAYOUT', 5, space.layout, 330, '22', 100, 'AcDbPlotSettings');
    pairs.push(100, 'AcDbLayout', 1, space.tab, 70, 1, 71, index, 330, space.record);
  }
  pairs.push(0, 'ENDSEC', 0, 'EOF', '');
}

function dxfAngle(nativeRadians: number): number {
  const degrees = ((-nativeRadians * 180) / Math.PI) % 360;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** PCB outline centerlines in metric, upward-Y CAD coordinates. */
export function exportBoardOutlineDxf(board: PCB): string {
  // Reuse the outline owner's closure, area and geometry limits. Plot the
  // original primitives so the validation tessellation cannot enter the DXF.
  const { edges } = prepareBoardOutline(board);
  const pairs: DxfValue[] = [];
  pairs.push(0, 'SECTION', 2, 'HEADER');
  pairs.push(9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 9, '$MEASUREMENT', 70, 1);
  pairs.push(9, '$HANDSEED', 5, (0x100 + edges.length).toString(16).toUpperCase());
  pairs.push(0, 'ENDSEC', 0, 'SECTION', 2, 'CLASSES', 0, 'ENDSEC');
  writeDxfTables(pairs);
  pairs.push(0, 'SECTION', 2, 'ENTITIES');

  let handle = 0x100;
  const entity = (name: string, subclass: string) => {
    pairs.push(0, name, 5, (handle++).toString(16).toUpperCase(), 330, modelSpace.record);
    pairs.push(100, 'AcDbEntity', 8, outlineLayer, 100, subclass);
  };
  const point = ({ x, y }: Point, offset = 0) => {
    pairs.push(10 + offset, x, 20 + offset, -y, 30 + offset, 0);
  };
  const endpointCounts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.stroke && edge.stroke !== 'solid' && edge.stroke !== 'default')
      throw new Error('DXF export requires solid board outline graphics.');
    const { start, end } = edge;
    // Native outline validation allows tiny endpoint discrepancies. The DXF
    // centerlines must close without relying on a CAD reader's snap tolerance.
    if (!edge.kind || edge.kind === 'arc') {
      for (const { x, y } of [start, end]) {
        const key = `${x},${y}`;
        endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
      }
    }
    switch (edge.kind) {
      case 'arc': {
        const arc = pcbArc(edge);
        if (!arc) throw new Error('The board outline contains a degenerate arc.');
        const first = dxfAngle(arc.start);
        const last = dxfAngle(arc.start + arc.delta);
        entity('ARC', 'AcDbCircle');
        point(arc.center);
        pairs.push(40, arc.radius, 100, 'AcDbArc');
        // Negating Y reverses the sweep. DXF arcs always run CCW.
        pairs.push(50, arc.delta > 0 ? last : first, 51, arc.delta > 0 ? first : last);
        break;
      }
      case 'circle': {
        const radius = Math.hypot(end.x - start.x, end.y - start.y);
        if (!radius) throw new Error('The board outline contains a degenerate circle.');
        entity('CIRCLE', 'AcDbCircle');
        point(start);
        pairs.push(40, radius);
        break;
      }
      case 'polygon': {
        const vertices = [start, ...(edge.points ?? []), end];
        if (start.x === end.x && start.y === end.y) vertices.pop();
        if (vertices.length < 3)
          throw new Error('The board outline contains a degenerate polygon.');
        entity('LWPOLYLINE', 'AcDbPolyline');
        pairs.push(90, vertices.length, 70, 1);
        for (const { x, y } of vertices) pairs.push(10, x, 20, -y);
        break;
      }
      case undefined:
        if (start.x === end.x && start.y === end.y)
          throw new Error('The board outline contains a zero-length line.');
        entity('LINE', 'AcDbLine');
        point(start);
        point(end, 1);
        break;
      default:
        throw new Error('Unsupported board outline geometry.');
    }
  }
  if ([...endpointCounts.values()].some((count) => count !== 2))
    throw new Error('DXF export requires exact joins between board outline lines and arcs.');
  pairs.push(0, 'ENDSEC');
  writeDxfObjects(pairs);
  return pairs.join('\r\n');
}
