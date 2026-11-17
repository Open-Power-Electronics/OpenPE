import spice from './spice-simulation/manifest.json' with { type: 'json' };
import thermal from './layout-thermal/manifest.json' with { type: 'json' };
import guidance from './pe-layout-skill/manifest.json' with { type: 'json' };
import parasitics from './layout-parasitics/manifest.json' with { type: 'json' };
import emc from './emc-analysis/manifest.json' with { type: 'json' };
import { createPluginCatalog } from './runtime/manifest.mjs';

export const bundledPlugins = createPluginCatalog([spice, thermal, guidance, parasitics, emc]);
export const SPICE_PLUGIN_ID = spice.id;
export const THERMAL_PLUGIN_ID = thermal.id;
export const PCB_DESIGN_PLUGIN_ID = guidance.id;
export const LAYOUT_PARASITICS_PLUGIN_ID = parasitics.id;
export const EMC_PLUGIN_ID = emc.id;
