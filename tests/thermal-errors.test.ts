import test from 'node:test';
import assert from 'node:assert/strict';
import { publicThermalFailure } from '../plugins/layout-thermal/host/thermal-errors.mjs';

const privateLog = 'PRIVATE_THERMAL_SENTINEL\n.subckt PRIVATE_MODEL 1 2\nC:/private/solver.log';

test('thermal failure projection classifies native failures without returning or changing diagnostics', () => {
  const cases: [string, RegExp][] = [
    ['gmsh.exe failed (1). ', /Gmsh.*Mesh size/],
    ['Gmsh could not mesh this PCB. ', /Gmsh.*Mesh size/],
    ['ElmerGrid.exe failed (2). ', /mesh could not be converted/],
    ['ElmerSolver failed (1). ', /Elmer could not complete/],
    ['Elmer did not converge. ', /Elmer did not converge.*thermal inputs/],
    [
      'Elmer did not produce exactly one steady temperature result. ',
      /invalid or incomplete temperature field/,
    ],
    [
      'Thermal solution failed energy conservation (5% imbalance). ',
      /energy conservation.*Reduce Mesh size/,
    ],
    ['Could not save the completed thermal run. ', /thermal folder and available disk space/],
    ['Unknown native failure: ', /Thermal analysis could not complete/],
  ];
  for (const [prefix, expected] of cases) {
    const original = prefix + privateLog,
      error = new Error(original);
    const projected = publicThermalFailure(error);
    assert.match(projected.message, expected);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|\.subckt|C:\/private|solver\.log/);
    assert.equal(
      error.message,
      original,
      'Private native diagnostics remain on the original error.',
    );
  }
});

test('thermal public validation messages are exact and cannot carry appended native output', () => {
  for (const message of [
    'Run SPICE Simulation again to record full-resolution heat inputs over the final 20% of the transient.',
    'The SPICE heat sources are stale. Load SPICE heat sources again.',
    'SPICE heat input was changed. Reload SPICE heat sources or choose Manual.',
    'PCB thermal boundary display exceeds 250,000 triangles. Increase Mesh size.',
    'Thermal results do not match this board and its settings.',
  ]) {
    assert.deepEqual(publicThermalFailure(new Error(message)), { message });
    for (const separator of [' ', '\n'])
      assert.doesNotMatch(
        publicThermalFailure(new Error(message + separator + privateLog)).message,
        /PRIVATE_|\.subckt/,
      );
  }
  for (const operation of ['resources', 'result', 'spice'])
    assert.doesNotMatch(
      publicThermalFailure(new Error(privateLog), operation).message,
      /PRIVATE_|\.subckt|C:\/private/,
    );
});
