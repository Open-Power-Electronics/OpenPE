const safeValidationMessages = new Set([
  'Save the project and complete SPICE Simulation before loading its heat sources.',
  'No matching completed SPICE result. Run SPICE Simulation for this project first.',
  'Run SPICE Simulation again to record full-resolution heat inputs over the final 20% of the transient.',
  'The SPICE heat sources are stale. Load SPICE heat sources again.',
  'SPICE heat input was changed. Reload SPICE heat sources or choose Manual.',
  'Thermal results do not match this board and its solver.',
  'Thermal results do not match this board and its settings.',
  'Saved thermal results do not match their verified inputs.',
  'The completed thermal run was not saved. Run again.',
  'PCB thermal boundary display exceeds 250,000 triangles. Increase Mesh size.',
  'The thermal mesh produced a nonphysical temperature below ambient. Reduce Mesh size.',
]);

const fallback = {
  run: 'Thermal analysis could not complete. Review the board and thermal settings, then run again.',
  resources:
    'The bundled thermal solvers are unavailable. Run npm run thermal:prepare to repair the thermal resources.',
  result:
    'Saved thermal results could not be verified. Check their integrity or run Thermal again.',
  spice:
    'SPICE heat sources could not be loaded. Complete SPICE Simulation for the current project and try again.',
};

/** Never return native output, exception details or paths from an async host failure.
 * The original Error and saved native logs remain unchanged for local diagnostics. */
export function publicThermalFailure(error, operation = 'run') {
  const detail = typeof error?.message === 'string' ? error.message : '';
  if (safeValidationMessages.has(detail)) return { message: detail };
  if (operation === 'resources') return { message: fallback.resources };
  if (detail.startsWith('Could not save the completed thermal run.'))
    return {
      message:
        'Could not save the completed thermal run. Check the project thermal folder and available disk space.',
    };
  if (/^(?:Gmsh could not mesh this PCB\.|gmsh(?:\.exe)? failed \()/i.test(detail))
    return {
      message: 'Gmsh could not mesh this PCB. Review the board contours and thermal Mesh size.',
    };
  if (/^ElmerGrid(?:\.exe)? failed \(/i.test(detail))
    return {
      message:
        'The thermal mesh could not be converted. Review the board contours and thermal Mesh size.',
    };
  if (/^Elmer did not converge\./.test(detail))
    return {
      message: 'Elmer did not converge. Review the thermal inputs and Mesh size, then run again.',
    };
  if (/^ElmerSolver(?:\.exe)? failed \(/i.test(detail))
    return {
      message:
        'Elmer could not complete this thermal analysis. Review the thermal inputs and Mesh size.',
    };
  if (
    /^Elmer (?:did not produce exactly one steady temperature result\.|returned |temperature nodes )/.test(
      detail,
    )
  )
    return {
      message:
        'Elmer returned an invalid or incomplete temperature field. Review Mesh size and run again.',
    };
  if (/^Thermal solution failed energy conservation \(/.test(detail))
    return {
      message: 'The thermal solution failed energy conservation. Reduce Mesh size and run again.',
    };
  return { message: fallback[operation] ?? fallback.run };
}
