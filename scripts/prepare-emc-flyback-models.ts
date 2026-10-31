import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseProject,
  projectNativeFiles,
  projectFromNativeFiles,
  serializeProject,
} from '../lib/project';
import models from '../resources/emc-flyback-models-lock.json';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { writeGeneratedFile } from './write-generated-file.mjs';
import {
  prepareEmcFlybackModelBindings,
  prepareEmcFlybackNativeModelBindings,
} from './emc-flyback-model-bindings';
import {
  prepareEmcFlybackTestbench,
  prepareEmcFlybackNativeTestbench,
} from './emc-flyback-testbench';

export async function verifyEmcFlybackModels() {
  const filename = 'examples/emc-flyback/emc-flyback.kicad_pro';
  const signal = new AbortController().signal;
  for (const model of models.models) {
    signal.throwIfAborted();
    if (!(await readProjectModelFile(path.resolve(filename), model)))
      throw new Error(`Missing EMC Flyback library ${model.file}. Restore the checked-in file.`);
  }
}

/** Publish model references without re-running the native KiCad geometry converter. */
export async function prepareEmcFlybackModels() {
  await verifyEmcFlybackModels();
  const filename = 'examples/emc-flyback/emc-flyback.kicad_pro';
  const snapshot = 'lib/emc-flyback-example.json';
  const template = JSON.parse(await readFile(snapshot, 'utf8'));
  template.simulationModels = models.models.map((model) => ({ ...model }));
  const projectFile = template.nativeFiles.files.find(
    (file: { name: string }) => file.name === template.nativeFiles.entry,
  );
  const settings = JSON.parse(projectFile.source);
  settings.text_variables.OPENPE_SIMULATION_MODELS = JSON.stringify(
    models.models.map((model) => model.file),
  );
  projectFile.source = JSON.stringify(settings, null, 2) + '\n';
  const project = parseProject(JSON.stringify(template));
  prepareEmcFlybackModelBindings(project.schematic);
  prepareEmcFlybackTestbench(project.schematic);
  const native = projectNativeFiles(project, path.basename(filename));
  const schematic = native.files.find((file) => file.name === 'emc-flyback.kicad_sch')!;
  schematic.source = prepareEmcFlybackNativeTestbench(
    prepareEmcFlybackNativeModelBindings(
      await readFile(path.join(path.dirname(filename), schematic.name), 'utf8'),
    ),
  );
  project.nativeFiles = native;
  project.schematic = projectFromNativeFiles(native).schematic;
  await writeGeneratedFile(snapshot, serializeProject(project) + '\n');
  for (const file of native.files.filter((file) => /\.kicad_(?:pro|sch)$/.test(file.name)))
    await writeGeneratedFile(path.join(path.dirname(filename), file.name), file.source);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareEmcFlybackModels();
