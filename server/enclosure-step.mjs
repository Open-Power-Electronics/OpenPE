import { modelCadFromProject, modelCadShape } from './model-cad-format.mjs';
import { appendModelCadPose, appendModelCadShape, runModelCadStep } from './model-cad-kernel.mjs';

/** Fixed OpenCASCADE operations built only from finite domain-validated solids. */
export function enclosureStepGeometry(project) {
  if (!project.pcb) throw new Error('Open a PCB before exporting a model.');
  const bodies = modelCadFromProject(project)?.objects ?? [];
  if (!bodies.length) throw new Error('Create a CAD object in Model before exporting STEP.');
  const lines = ['SetFactory("OpenCASCADE");'];
  let next = 1;
  for (const body of bodies) {
    const variable = appendModelCadShape(lines, modelCadShape(body), `cad${next++}`);
    appendModelCadPose(lines, variable, body.position, body.rotation);
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
