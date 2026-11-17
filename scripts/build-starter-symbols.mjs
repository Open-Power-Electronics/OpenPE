import { writeFile } from 'node:fs/promises';
import { createLibraryService } from '../server/libraries.mjs';

// Official snapshots for offline examples and the Agent's bounded kind aliases.
// Never draw or hand-edit symbol geometry here or in the generated JSON.
const ids = [
  'Device:R',
  'Device:C',
  'Device:L',
  'Device:D_Schottky',
  'Transistor_FET:Q_NMOS_GDS',
  'power:GND',
  'power:PWR_FLAG',
  'Connector_Generic:Conn_01x01',
  'Simulation_SPICE:VPULSE',
  'Simulation_SPICE:VDC',
  'Simulation_SPICE:IPULSE',
];
const service = createLibraryService({ dataDir: '.openpe/library-build' });
try {
  const symbols = {};
  for (const id of ids) {
    const detail = await service.request({ action: 'detail', kind: 'symbols', id });
    if (detail.error) throw new Error(`${id}: ${detail.error}`);
    symbols[id] = detail.symbol;
  }
  await writeFile('lib/kicad-starter-symbols.json', JSON.stringify(symbols, null, 2) + '\n');
  console.log(`Embedded ${ids.length} unmodified KiCad symbols for examples and Agent aliases.`);
} finally {
  service.close();
}
