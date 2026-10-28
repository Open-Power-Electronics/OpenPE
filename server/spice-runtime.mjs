import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledSpiceRoot = fileURLToPath(
  new URL('../resources/ngspice/47/Spice64/', import.meta.url),
);

/** This root comes only from Electron/service startup, never a request or environment override. */
export function spiceRuntime(root = bundledSpiceRoot) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^SPICE_|^NGSPICE|^OPENPE_NGSPICE$/i.test(key)) delete env[key];
  return {
    executable: path.join(root, 'bin', 'ngspice_con.exe'),
    env: {
      ...env,
      SPICE_LIB_DIR: path.join(root, 'share', 'ngspice'),
      SPICE_SCRIPTS: path.join(root, 'share', 'ngspice', 'scripts'),
      OMP_NUM_THREADS: '2',
    },
  };
}
