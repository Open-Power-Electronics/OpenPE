import { emptyCircuit } from './circuit';
import { MODEL_CAD_EXTENSION, type ModelCAD } from './model-cad';
import { createEmptyPCB } from './pcb-layout';
import { createProject, type Project } from './project';

const DEFAULT_PROJECT_NAME = 'Untitled project';
export const DEFAULT_PROJECT_FILENAME = 'untitled.kicad_pro';

export function createBlankProject(): Project {
  const schematic = emptyCircuit();
  schematic.title = 'Schematic 1';
  return {
    ...createProject(schematic),
    name: DEFAULT_PROJECT_NAME,
    pcb: createEmptyPCB(),
    extensions: { [MODEL_CAD_EXTENSION]: { version: 1, objects: [] } satisfies ModelCAD },
  };
}
