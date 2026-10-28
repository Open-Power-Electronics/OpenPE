import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { engineeringResources } from './engineering-resources.mjs';
import { createStepParserPool } from './libraries.mjs';
import {
  modelCadGeometryKey,
  modelCadSelectableEdges,
  modelCadShape,
  validateModelCadObject,
  validateModelCadShape,
} from './model-cad-format.mjs';

const failure = (message) => new Error(`Model CAD: ${message}`);

/** Intrinsic XYZ pose: apply local Z, Y, X rotations, then translation. */
export function appendModelCadPose(lines, volumes, position, rotation) {
  for (const [axis, angle] of [
    [[0, 0, 1], rotation.z],
    [[0, 1, 0], rotation.y],
    [[1, 0, 0], rotation.x],
  ])
    if (angle !== 0)
      lines.push(
        `Rotate {{${axis.join(',')}}, {0,0,0}, ${angle}*Pi/180} { Volume{${volumes}()}; }`,
      );
  lines.push(
    `Translate {${[position.x, position.y, position.z].join(',')}} { Volume{${volumes}()}; }`,
  );
}

/** Fixed OCC construction, receiving finite validated shape data, never user script text. */
export function appendModelCadShape(lines, input, prefix = 'cad') {
  const shape = validateModelCadShape(input);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(prefix)) throw failure('Invalid geometry namespace.');
  let serial = 0;
  const name = (kind) => `${prefix}_${kind}${++serial}`;
  const allocate = (kind, next) => {
    const variable = name(kind);
    lines.push(`${variable} = ${next};`);
    return variable;
  };
  const ensureVolume = (result) => {
    lines.push(
      `If (#${result}() == 0)`,
      '  Error("The CAD operation produced no solid.");',
      'EndIf',
      `For ${result}_i In {0:#${result}()-1}`,
      `  ${result}_mass() = Mass Volume{${result}(${result}_i)};`,
      `  If (${result}_mass(0) < 1e-9)`,
      '    Error("The CAD operation produced an empty solid.");',
      '  EndIf',
      'EndFor',
    );
  };
  const selectedEdges = (result, body) => {
    const treatment = body.edgeTreatment;
    const catalog = modelCadSelectableEdges(body);
    const stem = name('selectedEdges');
    lines.push(
      `${stem}_faces() = Boundary{ Volume{${result}()}; };`,
      `${stem}_curves() = {};`,
      `${stem}_surfaces() = {};`,
    );
    for (const identity of treatment.edges) {
      const edge = catalog.find((candidate) => candidate.id === identity);
      if (!edge) throw failure('A selected edge is unavailable on this base shape.');
      const min =
        edge.kind === 'line'
          ? {
              x: Math.min(edge.start.x, edge.end.x),
              y: Math.min(edge.start.y, edge.end.y),
              z: Math.min(edge.start.z, edge.end.z),
            }
          : {
              x: edge.center.x - edge.radiusMm,
              y: edge.center.y - edge.radiusMm,
              z: edge.center.z,
            };
      const max =
        edge.kind === 'line'
          ? {
              x: Math.max(edge.start.x, edge.end.x),
              y: Math.max(edge.start.y, edge.end.y),
              z: Math.max(edge.start.z, edge.end.z),
            }
          : {
              x: edge.center.x + edge.radiusMm,
              y: edge.center.y + edge.radiusMm,
              z: edge.center.z,
            };
      const expected = [min.x, min.y, min.z, max.x, max.y, max.z];
      lines.push(
        `${stem}_match = -1;`,
        `${stem}_surface = -1;`,
        `${stem}_ambiguous = 0;`,
        `For ${stem}_i In {0:#${stem}_faces()-1}`,
        `  ${stem}_face = Fabs(${stem}_faces(${stem}_i));`,
        `  ${stem}_edges() = Boundary{ Surface{${stem}_face}; };`,
        `  For ${stem}_j In {0:#${stem}_edges()-1}`,
        `    ${stem}_curve = Fabs(${stem}_edges(${stem}_j));`,
        `    ${stem}_box() = BoundingBox Curve{${stem}_curve};`,
        `    If (${expected.map((value, index) => `Fabs(${stem}_box(${index})-(${value}))<1e-5`).join(' && ')})`,
        `      If (${stem}_match == -1)`,
        `        ${stem}_match = ${stem}_curve;`,
        `        ${stem}_surface = ${stem}_face;`,
        `      ElseIf (${stem}_match != ${stem}_curve)`,
        `        ${stem}_ambiguous = 1;`,
        '      EndIf',
        '    EndIf',
        '  EndFor',
        'EndFor',
        `If (${stem}_match == -1 || ${stem}_ambiguous)`,
        '  Error("The selected edge is missing or ambiguous on the base solid.");',
        'EndIf',
        `${stem}_curves() += {${stem}_match};`,
        `${stem}_surfaces() += {${stem}_surface};`,
      );
    }
    const next = name('edgeResult');
    lines.push(
      treatment.kind === 'fillet'
        ? `${next}() = Fillet{${result}()}{${stem}_curves()}{${treatment.distanceMm}};`
        : `${next}() = Chamfer{${result}()}{${stem}_curves()}{${stem}_surfaces()}{${treatment.distanceMm}};`,
    );
    ensureVolume(next);
    return next;
  };
  const build = (body) => {
    const { size } = body;
    let result = name('solid');
    if (body.kind === 'boolean') {
      const [first, second] = body.boolean.operands.map((operand) => {
        const item = build(operand.shape);
        appendModelCadPose(lines, item, operand.position, operand.rotation);
        return item;
      });
      const operation = {
        union: 'BooleanUnion',
        difference: 'BooleanDifference',
        intersection: 'BooleanIntersection',
      }[body.boolean.operation];
      lines.push(
        `${result}() = ${operation}{ Volume{${first}()}; Delete; }{ Volume{${second}()}; Delete; };`,
      );
    } else if (body.kind === 'extrusion') {
      const z = -size.z / 2;
      let surface;
      if (body.profile.kind === 'rectangle' || body.profile.kind === 'circle') {
        surface = allocate('surface', 'news');
        lines.push(
          body.profile.kind === 'circle'
            ? `Disk(${surface}) = {0,0,${z},${size.x / 2},${size.y / 2}};`
            : `Rectangle(${surface}) = {${-size.x / 2},${-size.y / 2},${z},${size.x},${size.y}};`,
        );
      } else {
        const points = body.profile.points.map((point) => {
          const tag = allocate('point', 'newp');
          lines.push(`Point(${tag}) = {${point.x},${point.y},${z}};`);
          return tag;
        });
        const curves = points.map((point, index) => {
          const tag = allocate('curve', 'newl');
          lines.push(`Line(${tag}) = {${point},${points[(index + 1) % points.length]}};`);
          return tag;
        });
        const loop = allocate('loop', 'newcl');
        surface = allocate('surface', 'news');
        lines.push(
          `Curve Loop(${loop}) = {${curves.join(',')}};`,
          `Plane Surface(${surface}) = {${loop}};`,
        );
      }
      const extrude = name('extrude');
      lines.push(
        `${extrude}() = Extrude {0,0,${size.z}} { Surface{${surface}}; };`,
        `${result}() = {${extrude}(1)};`,
      );
    } else {
      const tag = allocate('volume', 'newv');
      lines.push(
        body.kind === 'cylinder'
          ? `Cylinder(${tag}) = {0,0,${-size.z / 2},0,0,${size.z},${size.x / 2},2*Pi};`
          : `Box(${tag}) = {${[-size.x / 2, -size.y / 2, -size.z / 2, size.x, size.y, size.z].join(',')}};`,
        `${result}() = {${tag}};`,
      );
    }
    ensureVolume(result);
    if (body.holes.length) {
      const tools = body.holes.map((hole) => {
        const tag = allocate('hole', 'newv');
        lines.push(
          `Cylinder(${tag}) = {${hole.x},${hole.y},${-size.z / 2 - 0.01},0,0,${size.z + 0.02},${hole.diameterMm / 2},2*Pi};`,
        );
        return tag;
      });
      const next = name('cut');
      lines.push(
        `${next}() = BooleanDifference{ Volume{${result}()}; Delete; }{ Volume{${tools.join(',')}}; Delete; };`,
      );
      result = next;
      ensureVolume(result);
    }
    if (body.edgeTreatment) result = selectedEdges(result, body);
    return result;
  };
  return build(shape);
}

/** One object's local shape; world pose is applied by its retained renderer mesh. */
export function modelCadStepGeometry(input) {
  const object = validateModelCadObject(input);
  const lines = ['SetFactory("OpenCASCADE");'];
  appendModelCadShape(lines, modelCadShape(object));
  lines.push('Save "enclosure.step";', '');
  return lines.join('\n');
}

/** Host-only fixed CAD execution. Script and filenames are generated by this module. */
export async function runModelCadStep(source, signal = new AbortController().signal, resourceRoot) {
  const runtime = await engineeringResources(signal, resourceRoot);
  signal.throwIfAborted();
  const stage = await mkdtemp(path.join(tmpdir(), 'openpe-model-cad-'));
  try {
    await writeFile(path.join(stage, 'enclosure.geo'), source);
    await new Promise((resolve, reject) => {
      let log = '',
        timedOut = false;
      const child = spawn(runtime.gmsh, ['enclosure.geo', '-0', '-nopopup', '-v', '3'], {
        cwd: stage,
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          PATH: `${path.dirname(runtime.gmsh)};${process.env.SystemRoot}\\System32`,
          TEMP: stage,
          TMP: stage,
          OMP_NUM_THREADS: '1',
        },
      });
      const cancel = () => child.kill();
      const timeout = setTimeout(() => {
        timedOut = true;
        cancel();
      }, 60_000);
      timeout.unref();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const append = (chunk) => {
        log = (log + chunk.toString()).slice(-12000);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) reject(signal.reason || failure('Geometry preparation cancelled.'));
        else if (timedOut) reject(failure('Geometry preparation exceeded its 60 second limit.'));
        else if (code !== 0 || /Error\s*:/i.test(log))
          reject(failure(`Geometry preparation failed. ${log}`));
        else resolve();
      });
    });
    signal.throwIfAborted();
    const file = path.join(stage, 'enclosure.step');
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 100 ||
      info.size > 30_000_000 ||
      (await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()
    )
      throw failure('The STEP artifact is not a bounded regular file.');
    const bytes = await readFile(file);
    if (
      !bytes.subarray(0, 100).toString('ascii').includes('ISO-10303-21;') ||
      !bytes.subarray(-100).toString('ascii').includes('END-ISO-10303-21;')
    )
      throw failure('Geometry preparation did not produce a complete STEP artifact.');
    return bytes;
  } finally {
    const owned = path.resolve(stage);
    if (
      path.dirname(owned).toLowerCase() !== path.resolve(tmpdir()).toLowerCase() ||
      !path.basename(owned).startsWith('openpe-model-cad-')
    )
      throw failure('Invalid CAD work directory.');
    await rm(owned, { recursive: true, force: true });
  }
}

function previewMeshes(input) {
  if (!Array.isArray(input) || !input.length || input.length > 64)
    throw failure('The operation produced no bounded solid preview.');
  let values = 0;
  const meshes = input.map((mesh, index) => {
    const positions = mesh?.attributes?.position?.array;
    const normals = mesh?.attributes?.normal?.array;
    const indices = mesh?.index?.array;
    if (
      !Array.isArray(positions) ||
      !positions.length ||
      positions.length % 3 ||
      positions.some((n) => !Number.isFinite(n) || Math.abs(n) > 1_000_000) ||
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length % 3 ||
      indices.some((n) => !Number.isInteger(n) || n < 0 || n >= positions.length / 3) ||
      (normals !== undefined &&
        (!Array.isArray(normals) ||
          normals.length !== positions.length ||
          normals.some((n) => !Number.isFinite(n))))
    )
      throw failure('The kernel returned invalid preview geometry.');
    values += positions.length + indices.length + (normals?.length ?? 0);
    if (values > 6_000_000) throw failure('The operation exceeds the preview complexity limit.');
    return {
      name: `CAD solid ${index + 1}`,
      attributes: {
        position: { array: [...positions] },
        ...(normals === undefined ? {} : { normal: { array: [...normals] } }),
      },
      index: { array: [...indices] },
    };
  });
  return { meshes, values };
}

/**
 * Bounded, retryable local preview cache; native shape data is the only input.
 * @param {{resourceRoot?: string, createStep?: typeof runModelCadStep,
 * parseStep?: (bytes: Uint8Array, signal: AbortSignal) => Promise<{meshes: unknown}>}} [options]
 */
export function createModelCadPreviewService({
  resourceRoot,
  createStep = runModelCadStep,
  parseStep,
} = {}) {
  const parsers = parseStep ? null : createStepParserPool();
  const parse = parseStep ?? ((bytes, signal) => parsers.run(bytes, signal));
  const cache = new Map();
  const active = new Set();
  let closed = false,
    cacheBytes = 0;
  return {
    async preview(input, signal = new AbortController().signal) {
      if (closed || signal.aborted) throw failure('Preview cancelled.');
      if (JSON.stringify(input)?.length > 512_000)
        throw failure('The preview request is too large.');
      const object = validateModelCadObject(structuredClone(input));
      const shapeKey = modelCadGeometryKey(object);
      const key = createHash('sha256').update(shapeKey).digest('hex');
      const cached = cache.get(key);
      if (cached && cached.result.shapeKey === shapeKey) {
        cache.delete(key);
        cache.set(key, cached);
        return structuredClone(cached.result);
      }
      if (active.size >= 2)
        throw failure('Two CAD previews are preparing. Retry after one finishes.');
      const control = new AbortController();
      const abort = () => control.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      active.add(control);
      try {
        const source = modelCadStepGeometry(object);
        const bytes = await createStep(source, control.signal, resourceRoot);
        control.signal.throwIfAborted();
        const converted = await parse(bytes, control.signal);
        control.signal.throwIfAborted();
        const { meshes, values } = previewMeshes(converted.meshes);
        const result = { shapeKey, meshes };
        const size = JSON.stringify(result).length * 2 + values * 8;
        if (size <= 64 * 1024 * 1024) {
          while (cache.size >= 16 || cacheBytes + size > 64 * 1024 * 1024) {
            const first = cache.keys().next().value;
            cacheBytes -= cache.get(first).size;
            cache.delete(first);
          }
          cache.set(key, { size, result: structuredClone(result) });
          cacheBytes += size;
        }
        return result;
      } finally {
        signal.removeEventListener('abort', abort);
        active.delete(control);
      }
    },
    close() {
      closed = true;
      for (const control of active) control.abort();
      parsers?.close();
      cache.clear();
      cacheBytes = 0;
    },
  };
}
