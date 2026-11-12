import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSolverPlatform } from './solver-platform.mjs';

const bundledSpiceRoot = fileURLToPath(
  new URL('../resources/ngspice/47/Spice64/', import.meta.url),
);
const executableNames = {
  'win32-x64': 'ngspice_con.exe',
  'darwin-arm64': 'ngspice',
};

/** This root comes only from Electron/service startup, never a request or environment override. */
export function spiceRuntime(root = bundledSpiceRoot) {
  const platform = hostSolverPlatform();
  const executableName = executableNames[platform];
  if (!executableName) throw new Error(`Unsupported OpenPE solver platform ${platform}.`);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^SPICE_|^NGSPICE|^OPENPE_NGSPICE$|^DYLD_|^LD_LIBRARY_PATH$|^LD_PRELOAD$/i.test(key))
      delete env[key];
  // macOS gets a fixed system PATH. Inherited DYLD_* was removed above so the
  // executable's own rpath is the only extra library path.
  if (platform === 'darwin-arm64') env.PATH = ['/usr/bin', '/bin', path.join(root, 'bin')].join(':');
  return {
    executable: path.join(root, 'bin', executableName),
    env: {
      ...env,
      SPICE_LIB_DIR: path.join(root, 'share', 'ngspice'),
      SPICE_SCRIPTS: path.join(root, 'share', 'ngspice', 'scripts'),
      OMP_NUM_THREADS: '2',
    },
  };
}
