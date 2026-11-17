export const solverPlatforms = ['win32-x64', 'darwin-arm64', 'linux-x64'];

export function hostSolverPlatform() {
  const id = `${process.platform}-${process.arch}`;
  if (!solverPlatforms.includes(id))
    throw new Error(
      `Unsupported OpenPE solver platform ${id}. Supported platforms: ${solverPlatforms.join(', ')}.`,
    );
  return id;
}

export function assertSolverPlatforms(platforms) {
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms))
    throw new Error('Solver lock is missing platforms.');
  const keys = Object.keys(platforms);
  for (const key of keys)
    if (!solverPlatforms.includes(key)) throw new Error(`Unknown solver platform ${key}.`);
  for (const key of solverPlatforms)
    if (!platforms[key] || typeof platforms[key] !== 'object' || Array.isArray(platforms[key]))
      throw new Error(`Solver lock is missing platform ${key}.`);
  return platforms[hostSolverPlatform()];
}
