const dashArrays = new Map([
  ['dash', '1.5 1'],
  ['dot', '0.2 0.8'],
  ['dash_dot', '1.5 0.8 0.2 0.8'],
  ['dash_dot_dot', '1.5 0.8 0.2 0.8 0.2 0.8'],
]);

export function schematicStrokeDasharray(type: string) {
  return dashArrays.get(type);
}
