import { modelCadFromProject, modelCadShape } from './model-cad-format.mjs';
import { appendModelCadPose, appendModelCadShape, runModelCadStep } from './model-cad-kernel.mjs';

/** Fixed OpenCASCADE operations built only from finite domain-validated solids. */
export function enclosureStepGeometry(project) {
  if (!project.pcb) throw new Error('Open a PCB before exporting a model.');
  const bodies = modelCadFromProject(project)?.objects ?? [];
  if (!bodies.length) throw new Error('Create a CAD object in Model before exporting STEP.');
  const lines = ['SetFactory("OpenCASCADE");'];
  let next = 1;
  // OCC Boolean operations allocate tags themselves. Resolve each later primitive
  // with newv so an earlier cut/union can never collide with a generated tag.
  const volume = () => {
    const name = `volume${next++}`;
    lines.push(`${name} = newv;`);
    return name;
  };
  const cut = (tag, holes, z, height) => {
    const tools = [];
    for (const hole of holes) {
      const tool = volume();
      tools.push(tool);
      lines.push(
        `Cylinder(${tool}) = {${[hole.x, hole.y, z - 0.01, 0, 0, height + 0.02, hole.diameterMm / 2].join(',')}, 2*Pi};`,
      );
    }
    const variable = `solid${next++}`;
    if (tools.length)
      lines.push(
        `${variable}() = BooleanDifference{ Volume{${tag}}; Delete; }{ Volume{${tools.join(',')}}; Delete; };`,
      );
    else lines.push(`${variable}() = {${tag}};`);
    return variable;
  };
  for (const body of bodies) {
    if (body.kind === 'extrusion' || body.kind === 'boolean' || body.edgeTreatment) {
      const variable = appendModelCadShape(lines, modelCadShape(body), `cad${next++}`);
      appendModelCadPose(lines, variable, body.position, body.rotation);
      continue;
    }
    const tag = volume(),
      { size, rotation, position } = body;
    if (body.kind === 'box')
      lines.push(
        `Box(${tag}) = {${[-size.x / 2, -size.y / 2, -size.z / 2, size.x, size.y, size.z].join(',')}};`,
      );
    else
      lines.push(
        `Cylinder(${tag}) = {${[0, 0, -size.z / 2, 0, 0, size.z, size.x / 2].join(',')}, 2*Pi};`,
      );
    const variable = cut(tag, body.holes, -size.z / 2, size.z);
    // Match the intrinsic XYZ Euler convention used by the Model renderer:
    // Rx * Ry * Rz applies Z first, then Y, then X to each local point.
    for (const [axis, angle] of [
      [[0, 0, 1], rotation.z],
      [[0, 1, 0], rotation.y],
      [[1, 0, 0], rotation.x],
    ])
      if (angle !== 0)
        lines.push(
          `Rotate {{${axis.join(',')}}, {0,0,0}, ${angle}*Pi/180} { Volume{${variable}()}; }`,
        );
    lines.push(
      `Translate {${[position.x, position.y, position.z].join(',')}} { Volume{${variable}()}; }`,
    );
  }
  // No global Coherence: independently editable CAD bodies may overlap and must
  // stay separate solids.
  lines.push('Save "enclosure.step";', '');
  return lines.join('\n');
}

/** Host-only CAD export; no solver input, script, executable or destination comes from requests. */
export async function createEnclosureStep(
  project,
  signal = new AbortController().signal,
  resourceRoot,
) {
  return runModelCadStep(enclosureStepGeometry(project), signal, resourceRoot);
}
