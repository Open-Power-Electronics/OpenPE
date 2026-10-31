import { createLucideIcon } from 'lucide-react';

export const SchematicIcon = createLucideIcon('Schematic', [
  ['path', { d: 'M5 3h8v6H5z', key: 'resistor' }],
  ['path', { d: 'M2 6h3m8 0h9m-4 0v6m-4 0h8m-8 4h8m-4 0v4', key: 'circuit' }],
  ['path', { d: 'M14 20h8l-4 3Z', key: 'ground' }],
]);

export const ModelIcon = createLucideIcon('Model', [
  ['path', { d: 'M3 8h7v8h5v5H3Z', key: 'profile' }],
  ['path', { d: 'm3 8 6-5h7v8h5v5l-6 5', key: 'extrusion' }],
  ['path', { d: 'm10 8 6-5m-6 13 6-5m-1 5 6-5', key: 'edges' }],
]);
