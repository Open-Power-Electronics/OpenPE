import type { ComponentType } from 'react';
import SpiceIcon from './spice-simulation/renderer/Icon';
import ThermalIcon from './layout-thermal/renderer/Icon';
import GuidanceIcon from './pe-layout-skill/renderer/Icon';
import ParasiticsIcon from './layout-parasitics/renderer/Icon';
import {
  SPICE_PLUGIN_ID,
  THERMAL_PLUGIN_ID,
  PCB_DESIGN_PLUGIN_ID,
  LAYOUT_PARASITICS_PLUGIN_ID,
} from './catalog.mjs';

export const pluginIcons: Record<string, ComponentType> = {
  [SPICE_PLUGIN_ID]: SpiceIcon,
  [THERMAL_PLUGIN_ID]: ThermalIcon,
  [PCB_DESIGN_PLUGIN_ID]: GuidanceIcon,
  [LAYOUT_PARASITICS_PLUGIN_ID]: ParasiticsIcon,
};
