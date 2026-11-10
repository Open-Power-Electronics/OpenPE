import { createLucideIcon } from 'lucide-react';
export { Cpu as FootprintIcon } from 'lucide-react';

// Adapted from Microsoft VS Code Codicons source-control.svg.
// Round nodes and balanced branch spacing use the shared 2-unit stroke.
// Attribution and pinned source: public/licenses/vscode-codicons.txt (CC BY 4.0).
export const GitIcon = createLucideIcon('Git', [
  ['path', { d: 'M5.5 8v8', key: 'stem' }],
  ['path', { d: 'M5.5 16a2.5 2.5 0 0 1 2.5-2.5h8a2.5 2.5 0 0 0 2.5-2.5', key: 'branch' }],
  ['circle', { cx: '5.5', cy: '5.5', r: '2.5', key: 'head' }],
  ['circle', { cx: '5.5', cy: '18.5', r: '2.5', key: 'base' }],
  ['circle', { cx: '18.5', cy: '8.5', r: '2.5', key: 'fork' }],
]);

// KiCad 10 add_line.svg (Draw Wires), adapted to the shared monochrome palette.
// Attribution and source: public/licenses/kicad-icons.txt (CC BY-SA 4.0).
export const WireIcon = createLucideIcon('Wire', [['path', { d: 'M21 3 3 21', key: 'wire' }]]);

export const SchematicIcon = createLucideIcon('Schematic', [
  ['path', { d: 'M5 3h8v6H5z', key: 'resistor' }],
  ['path', { d: 'M2 6h3m8 0h9m-4 0v6m-4 0h8m-8 4h8m-4 0v4', key: 'circuit' }],
  ['path', { d: 'M14 20h8l-4 3Z', key: 'ground' }],
]);

// An IEC resistor and leads identify an electrical symbol rather than a physical package.
export const SymbolIcon = createLucideIcon('Symbol', [
  ['rect', { x: '7', y: '8', width: '10', height: '8', key: 'resistor' }],
  ['path', { d: 'M2 12h5m10 0h5', key: 'terminals' }],
]);

export const ModelIcon = createLucideIcon('Model', [
  ['path', { d: 'M3 8h7v8h5v5H3Z', key: 'profile' }],
  ['path', { d: 'm3 8 6-5h7v8h5v5l-6 5', key: 'extrusion' }],
  ['path', { d: 'm10 8 6-5m-6 13 6-5m-1 5 6-5', key: 'edges' }],
]);

export const ExtrudeIcon = createLucideIcon('Extrude', [
  ['path', { d: 'm3 13 9-5 9 5-9 5Z', key: 'profile' }],
  ['path', { d: 'M3 13v5l9 5 9-5v-5m-9 5v5', key: 'depth' }],
  ['path', { d: 'M12 11V2m-4 4 4-4 4 4', key: 'direction' }],
]);
