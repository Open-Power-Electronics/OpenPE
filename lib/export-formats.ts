export const projectExportFormats = [
  { id: 'gerber', label: 'Gerbers', extension: 'zip', suffix: '-gerber' },
  { id: 'jlcpcb', label: 'JLCPCB', extension: 'zip', suffix: '-jlcpcb' },
  { id: 'bom', label: 'BOM', extension: 'csv', suffix: '-bom' },
  { id: 'placement', label: 'CPL', extension: 'csv', suffix: '-positions' },
  { id: 'scad', label: 'OpenSCAD model', extension: 'scad', suffix: '' },
] as const;
export type ProjectExportFormat = (typeof projectExportFormats)[number]['id'];
