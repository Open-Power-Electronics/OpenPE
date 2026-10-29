export const emcFlybackCapacitorEsr: Record<string, number> = {
  C4: 0.3,
  C5: 0.005,
  C6: 0.005,
  C18: 0.06,
  C19: 0.06,
  C20: 0.003,
  C21: 0.003,
};

/** Shared execution/presentation source for the bounded bench's initial nodes. */
export function emcFlybackInitialNodeGroups(
  node: (ref: string, pin: string) => string,
): [string, number][][] {
  return [
    [
      [node('D3', '1'), 12.23],
      [node('T1', '1'), 24],
      [node('C15', '1'), 64],
      [node('U1', '8'), 5],
      [node('U1', '1'), 3.05],
      [node('U4', '1'), 10.44],
      [node('U3', '1'), 9.4],
      [node('C22', '1'), 9.4],
      [node('U3', '2'), 2.495],
    ],
    Object.keys(emcFlybackCapacitorEsr).map((ref) => [
      `emc_${ref}`,
      ['C4', 'C5', 'C6'].includes(ref) ? 24 : 12.23,
    ]),
  ];
}
