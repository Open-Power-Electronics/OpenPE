/** Native field names represented by typed canonical component simulation properties. */
export const simulationFieldNames = {
  device: 'Sim.Device',
  type: 'Sim.Type',
  name: 'Sim.Name',
  library: 'Sim.Library',
  pins: 'Sim.Pins',
  parameters: 'Sim.Params',
  seriesResistance: 'OpenPE.SeriesResistance',
  initialVoltage: 'OpenPE.InitialVoltage',
  coupling: 'OpenPE.Coupling',
} as const;

const nativeSimulationFields = new Set<string>(Object.values(simulationFieldNames));

export function isSimulationField(name: string): boolean {
  return /^Sim\./i.test(name) || nativeSimulationFields.has(name);
}
