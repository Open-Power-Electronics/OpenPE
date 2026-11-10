export const projectExportFormats = [
  { id: 'netlist', label: 'Schematic netlist (XML)', extension: 'xml', suffix: '-netlist' },
  { id: 'dxf', label: 'Board outline (DXF)', extension: 'dxf', suffix: '-outline' },
  { id: 'gerber', label: 'Gerbers', extension: 'zip', suffix: '-gerber' },
  { id: 'drill', label: 'Excellon drill files', extension: 'zip', suffix: '-drill' },
  { id: 'stencil', label: 'Stencil Gerbers', extension: 'zip', suffix: '-stencil' },
  { id: 'jlcpcb', label: 'JLCPCB', extension: 'zip', suffix: '-jlcpcb' },
  { id: 'bom', label: 'BOM', extension: 'csv', suffix: '-bom' },
  { id: 'placement', label: 'CPL', extension: 'csv', suffix: '-positions' },
  { id: 'scad', label: 'OpenSCAD model', extension: 'scad', suffix: '' },
] as const;
export type ProjectExportFormat = (typeof projectExportFormats)[number]['id'];
