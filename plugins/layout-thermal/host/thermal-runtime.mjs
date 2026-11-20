import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, readdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { thermalGeometry, parseThermalPlanarMesh, extrudeThermalMesh } from './thermal-mesh.mjs';
import { validateThermalResult } from './thermal-format.mjs';
import { engineeringResources as resources } from '../../../server/engineering-resources.mjs';
import { hostSolverPlatform } from '../../../server/solver-platform.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checkAbort = (signal) => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Thermal analysis cancelled.', 'AbortError');
};

export async function detectThermal(signal, resourceRoot) {
  try {
    const runtime = await resources(signal, resourceRoot);
    return { available: true, ...solverIdentity(runtime) };
  } catch (error) {
    checkAbort(signal);
    return {
      available: false,
      diagnostic: `${error.message} Run npm run thermal:prepare to repair the bundled thermal resources.`,
    };
  }
}

function solverIdentity(runtime) {
  return {
    gmsh: runtime.lock.gmshVersion,
    elmer: runtime.lock.elmerVersion,
    identity: digest(JSON.stringify(runtime.lock)),
  };
}

/** Scan the complete native Gmsh log while retaining only its bounded diagnostic tail. */
export async function readThermalGmshLog(file, signal) {
  checkAbort(signal);
  const handle = await open(file, 'r').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return { tail: '', hasError: false };
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  let tail = '',
    scanTail = '',
    hasError = false;
  const append = (text) => {
    const scan = scanTail + text;
    hasError ||= /Error\s*:/i.test(scan);
    const pending = scan.match(/(?:error\s*|erro|err|er|e)$/i)?.[0] ?? '';
    // Collapse pending whitespace, so even an error prefix spanning many chunks stays bounded.
    scanTail = /^error/i.test(pending) ? `Error${pending.length > 5 ? ' ' : ''}` : pending;
    tail = (tail + text).slice(-100000);
  };
  try {
    while (true) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      append(decoder.write(buffer.subarray(0, bytesRead)));
    }
    append(decoder.end());
    checkAbort(signal);
    return { tail, hasError };
  } finally {
    await handle.close();
  }
}

function solverEnvironment(runtime, cwd) {
  const platform = hostSolverPlatform();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(ELMER|GMSH|PYTHON|OMP_|OPENBLAS_|GFORTRAN_|LD_|DYLD_|PATH$)/i.test(key)) delete env[key];
  env.ELMER_HOME = path.join(runtime.root, 'elmer');
  env.ELMER_LIB = path.join(runtime.root, 'elmer', 'share', 'elmersolver', 'lib');
  // Gmsh parses session/options files from its home directory at startup.
  // Isolate them in the owned empty job directory, never the user's profile.
  env.GMSH_HOME = cwd;
  const directories = [
    path.join(runtime.root, 'elmer', 'bin'),
    path.join(runtime.root, 'elmer', 'lib'),
  ];
  if (platform === 'win32-x64') {
    if (!process.env.SystemRoot)
      throw new Error('Windows SystemRoot is required for bundled Elmer and Gmsh.');
    directories.push(path.join(process.env.SystemRoot, 'System32'));
  } else if (platform === 'darwin-arm64' || platform === 'linux-x64') {
    directories.push('/usr/bin', '/bin');
  } else {
    throw new Error(`Unsupported OpenPE solver platform ${platform}.`);
  }
  env.PATH = directories.join(path.delimiter);
  env.OMP_NUM_THREADS = '2';
  env.OPENBLAS_NUM_THREADS = '2';
  return env;
}

function run(executable, args, cwd, runtime, signal, onProgress) {
  checkAbort(signal);
  const env = solverEnvironment(runtime, cwd);
  return new Promise((resolve, reject) => {
    let log = '',
      complete = false;
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abort = () => {
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const append = (bytes) => {
      const value = bytes.toString('utf8');
      log = (log + value).slice(-100000);
      onProgress?.({ stage: 'solver', message: value.slice(-1000) });
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => {
      if (!complete) {
        complete = true;
        signal?.removeEventListener('abort', abort);
        reject(error);
      }
    });
    child.once('close', (code) => {
      if (complete) return;
      complete = true;
      signal?.removeEventListener('abort', abort);
      try {
        checkAbort(signal);
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0 || /(^|\n)\s*(?:ERROR|FATAL)\s*:/i.test(log))
        reject(new Error(`${path.basename(executable)} failed (${code}). ${log.slice(-6000)}`));
      else resolve(log);
    });
  });
}

export function thermalSif(model, mesh) {
  const conductivity = model.config;
  const blocks = [
    'Header\n CHECK KEYWORDS Warn\n Mesh DB "." "mesh"\n Include Path ""\n Results Directory "."\nEnd',
    'Simulation\n Max Output Level = 4\n Coordinate System = Cartesian 3D\n Simulation Type = Steady State\n Steady State Max Iterations = 1\n Output Intervals = 1\nEnd',
    'Body 1\n Target Bodies(1) = 1\n Equation = 1\n Material = 1\nEnd',
    'Body 2\n Target Bodies(1) = 2\n Equation = 1\n Material = 2\nEnd',
    'Equation 1\n Active Solvers(2) = 1 2\nEnd',
    'Solver 1\n Equation = "Heat Equation"\n Procedure = "HeatSolve" "HeatSolver"\n Variable = Temperature\n Variable DOFs = 1\n Linear System Solver = Direct\n Linear System Direct Method = UMFPACK\n Nonlinear System Max Iterations = 1\n Nonlinear System Convergence Tolerance = 1.0e-8\n Steady State Convergence Tolerance = 1.0e-8\nEnd',
    'Solver 2\n Exec Solver = after all\n Equation = "ResultOutput"\n Procedure = "ResultOutputSolve" "ResultOutputSolver"\n Output File Name = "thermal"\n Vtu Format = Logical True\n Binary Output = Logical True\n Single Precision = Logical False\n Scalar Field 1 = String Temperature\nEnd',
    `Material 1\n Heat Conductivity = ${conductivity.dielectricConductivity}\n Density = 1850\n Heat Capacity = 1000\nEnd`,
    `Material 2\n Heat Conductivity = ${conductivity.copperConductivity}\n Density = 8960\n Heat Capacity = 385\nEnd`,
    ...mesh.groups.map(
      (group, i) =>
        `Boundary Condition ${i + 1}\n Target Boundaries(1) = ${group.tag}\n Heat Flux BC = Logical True\n Heat Transfer Coefficient = ${model.config.convection[group.side]}\n External Temperature = ${model.config.ambientC + 273.15}\n Heat Flux = ${group.heatFluxWm2}\nEnd`,
    ),
  ];
  return blocks.join('\n\n') + '\n';
}

function dataArrays(text, raw, maximumValues) {
  const result = [];
  for (const match of text.matchAll(/<DataArray\b([^>]*?)(?:\/>|>([\s\S]*?)<\/DataArray>)/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map((part) => [part[1], part[2]]),
    );
    let values;
    if (attributes.format?.toLowerCase() === 'appended' && raw && attributes.type === 'Float64') {
      const offset = /^(?:0|[1-9]\d*)$/.test(attributes.offset ?? '')
        ? Number(attributes.offset)
        : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > raw.length)
        throw new Error('Elmer returned an invalid VTU binary offset.');
      const size = raw.readUInt32LE(offset);
      if (size % 8 || size / 8 > maximumValues || offset + 4 + size > raw.length)
        throw new Error('Elmer returned an invalid VTU binary array length.');
      values = Array.from({ length: size / 8 }, (_, i) => raw.readDoubleLE(offset + 4 + i * 8));
    }
    result.push({ attributes, values });
  }
  return result;
}

export function thermalResultFromVtu(input, model, mesh, solver) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.length > 100_000_000 || bytes.indexOf('<VTKFile') < 0)
    throw new Error('Elmer returned an invalid or oversized VTU result.');
  const appended = bytes.indexOf('<AppendedData');
  if (appended < 0) throw new Error('Elmer returned an unsupported VTU binary encoding.');
  const end = bytes.indexOf('>', appended),
    close = bytes.lastIndexOf('</AppendedData>');
  const declaration = end < 0 ? '' : bytes.subarray(appended, end + 1).toString('utf8');
  let start = end + 1;
  while (start < bytes.length && [9, 10, 13, 32].includes(bytes[start])) start++;
  const text = bytes.subarray(0, appended).toString('utf8');
  const file = text.match(/<VTKFile\b([^>]*)>/)?.[1] ?? '';
  if (
    !/\bencoding="raw"/.test(declaration) ||
    bytes[start] !== 95 ||
    close <= start ||
    !/\bbyte_order="LittleEndian"/.test(file) ||
    /\bcompressor=/.test(file) ||
    (/\bheader_type=/.test(file) && !/\bheader_type="UInt32"/.test(file))
  )
    throw new Error('Elmer returned an unsupported VTU binary encoding.');
  const raw = bytes.subarray(start + 1, close);
  const pointSection = text.match(/<Points>([\s\S]*?)<\/Points>/)?.[1];
  const pointData = text.match(/<PointData\b[^>]*>([\s\S]*?)<\/PointData>/)?.[1];
  if (!pointSection || !pointData)
    throw new Error('Elmer result has no node coordinates or temperature field.');
  const coordinates = dataArrays(pointSection, raw, mesh.nodeCount * 3)[0];
  const temperatures = dataArrays(pointData, raw, mesh.nodeCount).find(
    (array) => array.attributes.Name?.toLowerCase() === 'temperature',
  );
  if (
    !coordinates ||
    !temperatures ||
    !Array.isArray(coordinates.values) ||
    !Array.isArray(temperatures.values) ||
    coordinates.attributes.type !== 'Float64' ||
    temperatures.attributes.type !== 'Float64' ||
    coordinates.attributes.NumberOfComponents !== '3' ||
    (temperatures.attributes.NumberOfComponents !== undefined &&
      temperatures.attributes.NumberOfComponents !== '1')
  )
    throw new Error('Elmer returned an unsupported temperature encoding.');
  if (
    coordinates.values.length !== temperatures.values.length * 3 ||
    temperatures.values.length !== mesh.nodeCount ||
    [...coordinates.values, ...temperatures.values].some((value) => !Number.isFinite(value))
  )
    throw new Error('Elmer returned an incomplete or nonfinite temperature field.');
  // Binary Float64 output preserves thin contour intersections. Match uniquely
  // within the precision of the generated double-precision coordinate records.
  const scaleMm = mesh.nodes.reduce(
    (maximum, p) => Math.max(maximum, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)),
    1,
  );
  const coordinateToleranceMm = Math.max(1e-10, scaleMm * 1e-13);
  const buckets = new Map(),
    coordinatesSeen = new Set();
  const bucket = (p) => [
    Math.floor(p.x / coordinateToleranceMm),
    Math.floor(p.y / coordinateToleranceMm),
    Math.floor(p.z / coordinateToleranceMm),
  ];
  const bucketKey = (indices) => indices.join(',');
  for (let i = 0; i < temperatures.values.length; i++) {
    const point = {
      x: coordinates.values[i * 3] * 1000,
      y: coordinates.values[i * 3 + 1] * 1000,
      z: coordinates.values[i * 3 + 2] * 1000,
    };
    const exactKey = `${point.x},${point.y},${point.z}`;
    if (coordinatesSeen.has(exactKey))
      throw new Error('Elmer returned duplicate temperature nodes.');
    coordinatesSeen.add(exactKey);
    const key = bucketKey(bucket(point));
    const entries = buckets.get(key) ?? [];
    entries.push({ point, index: i, temperatureC: temperatures.values[i] - 273.15 });
    buckets.set(key, entries);
  }
  const matched = new Set();
  const points = mesh.nodes.map((point) => {
    const at = bucket(point),
      candidates = [];
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++)
          for (const entry of buckets.get(bucketKey([at[0] + x, at[1] + y, at[2] + z])) ?? [])
            if (
              Math.hypot(
                entry.point.x - point.x,
                entry.point.y - point.y,
                entry.point.z - point.z,
              ) <= coordinateToleranceMm
            )
              candidates.push(entry);
    if (candidates.length !== 1 || matched.has(candidates[0]?.index))
      throw new Error(
        `Elmer temperature nodes do not uniquely match the prepared PCB mesh within ${coordinateToleranceMm.toPrecision(4)} mm (${candidates.length} matches at ${point.x}, ${point.y}, ${point.z} mm).`,
      );
    const { temperatureC, index } = candidates[0];
    matched.add(index);
    if (!Number.isFinite(temperatureC) || temperatureC < -273.15 || temperatureC > 100000)
      throw new Error('Elmer temperature nodes do not match the prepared PCB mesh.');
    return { ...point, temperatureC };
  });
  const triangles = mesh.boundaries.flatMap(({ ids }) =>
    ids.length === 3
      ? [ids.map((id) => id - 1)]
      : [
          [ids[0] - 1, ids[1] - 1, ids[2] - 1],
          [ids[0] - 1, ids[2] - 1, ids[3] - 1],
        ],
  );
  if (triangles.length > 250000)
    throw new Error('PCB thermal boundary display exceeds 250,000 triangles. Increase Mesh size.');
  const values = points.map((point) => point.temperatureC);
  const minC = values.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  const maxC = values.reduce((maximum, value) => Math.max(maximum, value), -Infinity);
  const inputPowerW = model.sources.reduce((sum, source) => sum + source.powerW, 0);
  const outputPowerW = mesh.boundaries.reduce((sum, face) => {
    const temperatureC =
      face.ids.reduce((value, id) => value + points[id - 1].temperatureC, 0) / face.ids.length;
    return (
      sum +
      model.config.convection[face.side] * face.areaM2 * (temperatureC - model.config.ambientC)
    );
  }, 0);
  const energyImbalanceRelative = Math.abs(outputPowerW - inputPowerW) / inputPowerW;
  if (minC < model.config.ambientC - 0.05)
    throw new Error(
      'The thermal mesh produced a nonphysical temperature below ambient. Reduce Mesh size.',
    );
  if (!Number.isFinite(energyImbalanceRelative) || energyImbalanceRelative > 0.01)
    throw new Error(
      `Thermal solution failed energy conservation (${(energyImbalanceRelative * 100).toFixed(3)}% imbalance).`,
    );
  return {
    version: 1,
    status: 'completed',
    basis: model.basis,
    solver,
    points,
    triangles,
    statistics: {
      minC,
      maxC,
      meanC: values.reduce((sum, value) => sum + value, 0) / values.length,
      inputPowerW,
      outputPowerW,
      energyImbalanceRelative,
      nodeCount: points.length,
      elementCount: mesh.elementCount,
    },
    assumptions: [
      ...model.assumptions,
      'Gmsh conformal planar triangles are extruded into linear Elmer prism elements at every copper and dielectric interface.',
      'The edge convection coefficient also applies to the vertical walls of drilled holes and board cutouts.',
      'Steady board conduction with prescribed convection; radiation, air flow, package bodies and semiconductor junction temperatures are not modeled.',
    ],
    diagnostics: [
      ...model.notices,
      `Energy balance: ${inputPowerW.toPrecision(6)} W in; ${outputPowerW.toPrecision(6)} W out; ${(100 * energyImbalanceRelative).toPrecision(4)}% imbalance.`,
      `${points.length} nodes; ${mesh.elementCount} prism elements. Mean temperature is the arithmetic node mean.`,
    ],
  };
}

/** Input is the domain-prepared read-only model. Only host startup supplies a resource root. */
export async function runThermalSimulation(model, signal, resourceRoot, onProgress, onCompleted) {
  checkAbort(signal);
  const runtime = await resources(signal, resourceRoot);
  const stage = await mkdtemp(path.join(tmpdir(), 'openpe-thermal-'));
  const ownedStage = path.resolve(stage);
  try {
    onProgress?.({ stage: 'mesh', message: 'Generating the conformal PCB mesh with Gmsh.' });
    await writeFile(path.join(stage, 'board.geo'), thermalGeometry(model));
    const gmshOutput = await run(
      runtime.gmsh,
      [
        'board.geo',
        '-2',
        '-format',
        'msh2',
        '-o',
        'planar.msh',
        '-v',
        '3',
        '-nopopup',
        '-log',
        'gmsh.log',
      ],
      stage,
      runtime,
      signal,
      onProgress,
    );
    await writeFile(path.join(stage, 'gmsh-output.log'), gmshOutput);
    const gmshLog = await readThermalGmshLog(path.join(stage, 'gmsh.log'), signal);
    await writeFile(path.join(stage, 'gmsh.log'), gmshLog.tail);
    if (gmshLog.hasError)
      throw new Error(`Gmsh could not mesh this PCB. ${gmshLog.tail.slice(-6000)}`);
    checkAbort(signal);
    const mesh = extrudeThermalMesh(
      parseThermalPlanarMesh(await readFile(path.join(stage, 'planar.msh'), 'utf8')),
      model,
    );
    await writeFile(path.join(stage, 'board.msh'), mesh.msh);
    await writeFile(path.join(stage, 'case.sif'), thermalSif(model, mesh));
    onProgress?.({ stage: 'mesh', message: 'Converting the extruded mesh with ElmerGrid.' });
    const gridLog = await run(
      runtime.elmerGrid,
      ['14', '2', 'board.msh', '-out', 'mesh', '-decimals', '17'],
      stage,
      runtime,
      signal,
      onProgress,
    );
    await writeFile(path.join(stage, 'elmer-grid.log'), gridLog);
    checkAbort(signal);
    onProgress?.({ stage: 'solve', message: 'Solving steady board temperature with Elmer.' });
    const log = await run(runtime.elmer, ['case.sif'], stage, runtime, signal, onProgress);
    await writeFile(path.join(stage, 'solver.log'), log);
    checkAbort(signal);
    if (/Failed to converge|did not converge|not converged/i.test(log))
      throw new Error(`Elmer did not converge. ${log.slice(-4000)}`);
    const results = (
      await Promise.all(
        [stage, path.join(stage, 'mesh')].map(async (folder) =>
          (await readdir(folder))
            .filter((name) => /^thermal.*\.vtu$/.test(name))
            .map((name) => path.join(folder, name)),
        ),
      )
    ).flat();
    if (results.length !== 1)
      throw new Error(
        `Elmer did not produce exactly one steady temperature result. ${log.slice(-6000)}`,
      );
    const solver = solverIdentity(runtime);
    const result = validateThermalResult(
      thermalResultFromVtu(await readFile(results[0]), model, mesh, {
        gmsh: solver.gmsh,
        elmer: solver.elmer,
      }),
    );
    if (result.basis !== model.basis)
      throw new Error('Thermal results do not match this board and its settings.');
    checkAbort(signal);
    if (onCompleted) await onCompleted({ directory: stage, result, solver });
    checkAbort(signal);
    return result;
  } finally {
    if (
      path.dirname(ownedStage) !== path.resolve(tmpdir()) ||
      !path.basename(ownedStage).startsWith('openpe-thermal-')
    )
      throw new Error('Refusing to remove an invalid thermal working directory.');
    await rm(ownedStage, { recursive: true, force: true });
  }
}
