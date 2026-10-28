import { importDocument, validateProject } from './project';
import { uid } from './circuit';
import { child, parseSExpr, quote, val, writeSExpr, type SExpr } from './sexpr';
import sources from './kicad-examples.json';
import manifest from '../tests/fixtures/kicad/manifest.json';
import { arrangeExampleText } from './example-layout';
import simulationProfiles from './example-simulation.json';
import { simulationModelDefinitions } from './simulation-models';

export type ExampleId = keyof typeof sources;
export const projectExamples = manifest.examples.map((entry) => ({
  ...entry,
  id: entry.id as ExampleId,
}));

export function createExample(id: ExampleId) {
  const entry = manifest.examples.find((item) => item.id === id);
  if (!entry || !Object.hasOwn(sources, id)) throw new Error('Unknown example project.');
  const root = parseSExpr(sources[id]);
  const ids = new Map<string, string>();
  function collect(n: SExpr) {
    if (n[0] === 'uuid') ids.set(val(n), uid());
    for (const v of n) if (Array.isArray(v)) collect(v);
  }
  function replace(n: SExpr) {
    if (n[0] === 'uuid') n[1] = quote(ids.get(val(n))!);
    if (n[0] === 'path')
      n[1] = quote(
        val(n)
          .split('/')
          .map((v) => ids.get(v) || v)
          .join('/'),
      );
    for (const v of n) if (Array.isArray(v)) replace(v);
  }
  collect(root);
  replace(root);
  let titleBlock = child(root, 'title_block');
  if (!titleBlock) {
    titleBlock = ['title_block'];
    root.push(titleBlock);
  }
  const title = child(titleBlock, 'title');
  if (title) title[1] = quote(entry.title);
  else titleBlock.push(['title', quote(entry.title)]);
  const project = importDocument(writeSExpr(root));
  project.schematic.title = entry.title;
  const modelIds = new Set(
    simulationProfiles.profiles
      .find((profile) => profile.id === id)
      ?.parts.map((part) => part.modelId)
      .filter(Boolean),
  );
  if (modelIds.size)
    project.simulationModels = simulationModelDefinitions
      .filter((model) => modelIds.has(model.id))
      .map((model) => ({ ...model }));
  arrangeExampleText(project.schematic, id);
  project.extensions['org.openpe.example'] = {
    id,
    upstream: `${manifest.repository}/blob/${manifest.commit}/${entry.path}`,
    release: manifest.release,
    license: manifest.license,
    attribution: 'KiCad demo contributors',
    changes:
      'Imported into a private OpenPE project snapshot; fresh UUIDs and display title; instance text repositioned and made upright, with source parameters displayed once. Embedded symbols, wiring, field contents and schematic text retained. Schematic only; no simulation executed.',
  };
  validateProject(project);
  return project;
}
