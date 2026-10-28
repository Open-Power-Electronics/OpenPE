import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  thermalGeometry,
  parseThermalPlanarMesh,
  extrudeThermalMesh,
} from '../server/thermal-mesh.mjs';
import {
  thermalResultFromVtu,
  thermalSif,
  runThermalSimulation,
  detectThermal,
  readThermalGmshLog,
} from '../server/thermal-runtime.mjs';

const polygon = {
  outer: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ],
  holes: [],
};
const model = {
  version: 1,
  boardId: 'board',
  units: 'mm',
  basis: 'thermal-test',
  board: [polygon],
  layers: [
    { layer: 'F.Cu', zMin: 0.465, zMax: 0.5, polygons: [polygon] },
    { layer: 'B.Cu', zMin: -0.5, zMax: -0.465, polygons: [polygon] },
  ],
  dielectricLayers: [{ zMin: -0.465, zMax: 0.465 }],
  barrels: [],
  config: {
    ambientC: 25,
    convection: { top: 10, bottom: 10, edge: 0 },
    copperThicknessMm: [0.035, 0.035],
    dielectricConductivity: 0.3,
    copperConductivity: 400,
    viaPlatingMm: 0.025,
    meshSizeMm: 2,
    heatSources: [{ footprintId: 'heater', powerW: 0.1 }],
  },
  sources: [
    {
      footprintId: 'heater',
      powerW: 0.1,
      reference: 'R1',
      side: 'front',
      polygons: [polygon],
      areaMm2: 100,
    },
  ],
  assumptions: ['Test material assumptions.'],
  notices: [],
};
const planar =
  '$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n4\n1 0 0 0\n2 10 0 0\n3 10 10 0\n4 0 10 0\n$EndNodes\n$Elements\n2\n1 2 0 1 2 3\n2 2 0 1 3 4\n$EndElements\n';

test('Gmsh native log scanning bounds retained text without losing early or split errors', async () => {
  await mkdir('test-results', { recursive: true });
  const folder = await mkdtemp(path.resolve('test-results/thermal-gmsh-log-'));
  const file = path.join(folder, 'gmsh.log');
  try {
    for (const prefix of [
      'Error' + ' '.repeat(140000) + ': early failure\n',
      'x'.repeat(65535) + 'Error : split failure\n',
      'Valid meshing output\n',
    ]) {
      const text = prefix + 'successful later output\n'.repeat(10000) + 'last diagnostic\n';
      await writeFile(file, text);
      const log = await readThermalGmshLog(file, new AbortController().signal);
      assert.equal(log.tail, text.slice(-100000));
      assert.equal(log.hasError, prefix.includes('Error'));
      assert.ok(log.tail.endsWith('last diagnostic\n'));
    }
    await assert.rejects(
      readThermalGmshLog(file, AbortSignal.abort(new Error('Log scan cancelled.'))),
      /Log scan cancelled/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('thermal meshing preserves layer interfaces and exact SI heat-source normalization', () => {
  const mesh = extrudeThermalMesh(parseThermalPlanarMesh(planar), model);
  assert.equal(mesh.nodeCount, 16);
  assert.equal(mesh.elementCount, 6);
  assert.equal(mesh.sourceAreasMm2[0], 100);
  assert.equal(
    mesh.groups.find((group: { heatFluxWm2: number }) => group.heatFluxWm2 > 0).heatFluxWm2,
    1000.0000000000001,
  );
  assert.match(mesh.msh, /0\.01 0\.01 0\.0005/);
  assert.equal(mesh.msh.split('\n').filter((line: string) => /^\d+ 6 2 2 2 /.test(line)).length, 4);
  assert.equal(mesh.msh.split('\n').filter((line: string) => /^\d+ 6 2 1 1 /.test(line)).length, 2);
  const sif = thermalSif(model, mesh);
  assert.match(sif, /Procedure = "HeatSolve" "HeatSolver"/);
  assert.match(sif, /External Temperature = 298\.15/);
  assert.match(sif, /Binary Output = Logical True/);
  assert.match(thermalGeometry(model), /Physical Surface\(1\)/);
});

function binaryVtu(mesh: { nodes: { x: number; y: number; z: number }[] }, kelvin: number) {
  const block = (values: number[]) => {
    const data = Buffer.alloc(4 + values.length * 8);
    data.writeUInt32LE(values.length * 8);
    values.forEach((value, i) => data.writeDoubleLE(value, 4 + i * 8));
    return data;
  };
  // Verify coordinate matching rather than relying on ElmerGrid node order.
  const nodes = [...mesh.nodes].reverse();
  const coordinates = block(nodes.flatMap((p) => [p.x * 0.001, p.y * 0.001, p.z * 0.001]));
  const temperature = block(nodes.map(() => kelvin));
  return Buffer.concat([
    Buffer.from(
      `<VTKFile byte_order="LittleEndian"><UnstructuredGrid><Piece><Points><DataArray type="Float64" NumberOfComponents="3" format="appended" offset="0"/></Points><PointData><DataArray type="Float64" Name="temperature" format="appended" offset="${coordinates.length}"/></PointData></Piece></UnstructuredGrid><AppendedData encoding="raw">\n_`,
    ),
    coordinates,
    temperature,
    Buffer.from('\n</AppendedData></VTKFile>'),
  ]);
}

test('binary Float64 VTU preserves close distinct nodes and rejects invalid encodings and array bounds', () => {
  const mesh = extrudeThermalMesh(parseThermalPlanarMesh(planar), model);
  mesh.nodes[1] = { ...mesh.nodes[0], x: mesh.nodes[0].x + 1e-8 };
  const binary = binaryVtu(mesh, 348.15);
  const result = thermalResultFromVtu(binary, model, mesh, { gmsh: 'test', elmer: 'test' });
  assert.equal(result.points.length, mesh.nodeCount);
  assert.equal(result.points[1].x, mesh.nodes[1].x);
  assert.throws(
    () =>
      thermalResultFromVtu(
        '<VTKFile><DataArray format="ascii">1</DataArray></VTKFile>',
        model,
        mesh,
        {},
      ),
    /unsupported VTU binary encoding/,
  );
  const encoding = Buffer.from(binary);
  const endian = encoding.indexOf('LittleEndian');
  encoding.write('BigEndian   ', endian, 'utf8');
  assert.throws(
    () => thermalResultFromVtu(encoding, model, mesh, {}),
    /unsupported VTU binary encoding/,
  );
  const length = Buffer.from(binary);
  const data = length.indexOf('\n_') + 2;
  length.writeUInt32LE(0x7fffffff, data);
  assert.throws(() => thermalResultFromVtu(length, model, mesh, {}), /binary array length/);
  const negative = Buffer.from(binary);
  negative.writeDoubleLE(NaN, data + 4);
  assert.throws(
    () => thermalResultFromVtu(negative, model, mesh, {}),
    /nonfinite temperature field/,
  );
});

test('thermal result reconstructs surface topology and integrates outgoing watts in SI', () => {
  const mesh = extrudeThermalMesh(parseThermalPlanarMesh(planar), model);
  const result = thermalResultFromVtu(binaryVtu(mesh, 348.15), model, mesh, {
    gmsh: 'test',
    elmer: 'test',
  });
  assert.equal(result.points.length, 16);
  assert.equal(result.triangles.length, 28);
  assert.equal(result.statistics.minC, 75);
  assert.ok(Math.abs(result.statistics.outputPowerW - 0.1) < 1e-12);
  assert.ok(result.statistics.energyImbalanceRelative < 1e-12);
  assert.throws(
    () => thermalResultFromVtu(binaryVtu(mesh, 340), model, mesh, { gmsh: 'test', elmer: 'test' }),
    /energy conservation/,
  );
});

test('thermal parsing fails closed on unsupported encoding, unresolved heat sources and cancellation', async () => {
  assert.throws(
    () => parseThermalPlanarMesh(planar.replace('2.2 0 8', '4.1 0 8')),
    /unsupported mesh encoding/,
  );
  assert.throws(
    () =>
      extrudeThermalMesh(parseThermalPlanarMesh(planar), {
        ...model,
        sources: [{ ...model.sources[0], areaMm2: 110 }],
      }),
    /heat-source region/,
  );
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  await assert.rejects(() => runThermalSimulation(model, controller.signal), /Cancelled/);
  await assert.rejects(() => detectThermal(controller.signal), /Cancelled/);
});

test('thermal mesh rejects duplicate board coverage, unresolved copper and internal free seams', () => {
  const mesh = parseThermalPlanarMesh(planar);
  assert.throws(
    () => extrudeThermalMesh({ ...mesh, triangles: [...mesh.triangles, mesh.triangles[0]] }, model),
    /overlapping or missing board faces/,
  );
  const unresolved = {
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 1 },
      { x: 0, y: 1 },
    ],
    holes: [],
  };
  assert.throws(
    () =>
      extrudeThermalMesh(mesh, {
        ...model,
        layers: [{ ...model.layers[0], polygons: [unresolved] }, model.layers[1]],
      }),
    /does not resolve F.Cu/,
  );
  assert.throws(
    () => extrudeThermalMesh({ ...mesh, segments: [[2, 4]] }, model),
    /contour outside the conformal/,
  );
  const unjoined = {
    ...mesh,
    nodes: new Map(mesh.nodes),
    triangles: [
      [1, 2, 3],
      [5, 6, 4],
    ],
    segments: [],
  };
  unjoined.nodes.set(5, { x: 0, y: 0 });
  unjoined.nodes.set(6, { x: 10, y: 10 });
  assert.throws(() => extrudeThermalMesh(unjoined, model), /unjoined internal PCB seam/);
});

test('VTU coordinate matching rejects ambiguous, duplicate and shifted binary nodes', () => {
  const mesh = extrudeThermalMesh(parseThermalPlanarMesh(planar), model);
  mesh.nodes[0] = { ...mesh.nodes[0], x: 1.123456789123 };
  const binary = binaryVtu(mesh, 348.15);
  assert.equal(
    thermalResultFromVtu(binary, model, mesh, { gmsh: 'test', elmer: 'test' }).points[0].x,
    mesh.nodes[0].x,
  );
  const shifted = {
    ...mesh,
    nodes: mesh.nodes.map((point: { x: number; y: number; z: number }, i: number) =>
      i ? point : { ...point, x: point.x + 0.001 },
    ),
  };
  assert.throws(
    () => thermalResultFromVtu(binary, model, shifted, { gmsh: 'test', elmer: 'test' }),
    /do not uniquely match/,
  );
  const ambiguous = {
    ...mesh,
    nodes: mesh.nodes.map((point: { x: number; y: number; z: number }, i: number) =>
      i === 1 ? { ...mesh.nodes[0], x: mesh.nodes[0].x + 1e-11 } : point,
    ),
  };
  assert.throws(
    () => thermalResultFromVtu(binaryVtu(ambiguous, 348.15), model, ambiguous, {}),
    /do not uniquely match/,
  );
  const duplicate = { ...mesh, nodes: [...mesh.nodes] };
  duplicate.nodes[1] = { ...mesh.nodes[0] };
  assert.throws(
    () => thermalResultFromVtu(binaryVtu(duplicate, 348.15), model, duplicate, {}),
    /duplicate temperature nodes/,
  );
});

test(
  'bundled Elmer steady board solver agrees with the one-dimensional layered heat-flow solution',
  { skip: process.env.OPENPE_TEST_THERMAL !== '1' },
  async () => {
    // Uniform heat on an isothermal plane; no side loss. Equal top and bottom h.
    // The heat divides between top convection and the through-board bottom path.
    let workingDirectory = '';
    let published = false;
    const result = await runThermalSimulation(
      model,
      undefined,
      undefined,
      undefined,
      async ({
        directory,
        result: completed,
        solver,
      }: {
        directory: string;
        result: { basis: string; status: string };
        solver: { gmsh: string; elmer: string; identity: string };
      }) => {
        workingDirectory = directory;
        for (const name of [
          'board.geo',
          'planar.msh',
          'board.msh',
          'case.sif',
          'gmsh.log',
          'gmsh-output.log',
          'elmer-grid.log',
          'solver.log',
          'mesh/mesh.header',
          'mesh/mesh.nodes',
          'mesh/mesh.elements',
          'mesh/mesh.boundary',
        ])
          await access(path.join(directory, name));
        const outputs = (
          await Promise.all(
            [directory, path.join(directory, 'mesh')].map((folder) => readdir(folder)),
          )
        )
          .flat()
          .filter((name) => /^thermal.*\.vtu$/.test(name));
        assert.equal(outputs.length, 1);
        assert.equal(completed.status, 'completed');
        assert.equal(completed.basis, model.basis);
        assert.match(solver.identity, /^[a-f0-9]{64}$/);
        assert.match(await readFile(path.join(directory, 'solver.log'), 'utf8'), /Elmer/i);
        published = true;
      },
    );
    assert.equal(published, true);
    await assert.rejects(access(workingDirectory), /ENOENT/);
    const throughResistance = (0.00093 / 0.3 + 0.00007 / 400) / 0.0001;
    const topResistance = 1 / (10 * 0.0001);
    const bottomResistance = topResistance + throughResistance;
    const riseTop = 0.1 / (1 / topResistance + 1 / bottomResistance);
    const expectedTop = 25 + riseTop;
    const top = result.points.filter((point: { z: number }) => Math.abs(point.z - 0.5) < 1e-7);
    for (const point of top)
      assert.ok(
        Math.abs(point.temperatureC - expectedTop) < 0.02,
        `${point.temperatureC} vs ${expectedTop}`,
      );
    assert.ok(result.statistics.energyImbalanceRelative < 1e-5);
  },
);

test(
  'real Gmsh enforces overlapping copper, annular source and plated-hole contours without duplicate surfaces',
  { skip: process.env.OPENPE_TEST_THERMAL !== '1' },
  async () => {
    const square = (a: number, b: number) => [
      { x: a, y: a },
      { x: b, y: a },
      { x: b, y: b },
      { x: a, y: b },
    ];
    const body = { outer: square(0, 10), holes: [square(4, 6)] };
    const source = { outer: square(3, 7), holes: [square(4, 6)] };
    const annulus = { outer: square(3.9, 6.1), holes: [square(4, 6)] };
    const scenario = {
      ...model,
      board: [body],
      layers: [
        { ...model.layers[0], polygons: [body] },
        { ...model.layers[1], polygons: [{ outer: square(1, 9), holes: [square(4, 6)] }] },
      ],
      barrels: [
        {
          id: 'plated-hole',
          x: 5,
          y: 5,
          innerRadiusMm: 1,
          outerRadiusMm: 1.1,
          zMin: -0.5,
          zMax: 0.5,
          polygons: [annulus],
        },
      ],
      sources: [{ ...model.sources[0], polygons: [source], areaMm2: 12, powerW: 0.01 }],
      config: { ...model.config, heatSources: [{ footprintId: 'heater', powerW: 0.01 }] },
    };
    const result = await runThermalSimulation(scenario);
    assert.ok(result.statistics.energyImbalanceRelative < 1e-5);
    assert.ok(result.statistics.maxC > scenario.config.ambientC);
    assert.equal(result.statistics.inputPowerW, 0.01);
  },
);
