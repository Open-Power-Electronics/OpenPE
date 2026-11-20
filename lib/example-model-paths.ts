import { models as boostModels } from '../resources/example-catalog/footprints/manifest.json';
import { models as emcModels } from '../resources/example-catalog/emc-flyback-assets.json';

const records = [...Object.entries(boostModels), ...Object.entries(emcModels)];
const basenames = new Map<string, Set<string>>();
for (const [relative, entry] of records) {
  const name = relative.split('/').at(-1)!;
  const hashes = basenames.get(name) ?? new Set<string>();
  hashes.add(entry.sha256);
  basenames.set(name, hashes);
}
const files = new Map<string, string>();
const portablePaths = new Map<string, string>();
const keys = new Map<string, string>();
for (const [relative, entry] of records) {
  const name = relative.split('/').at(-1)!;
  const file =
    basenames.get(name)!.size > 1
      ? name.replace(/\.step$/i, '-' + entry.sha256.slice(0, 8) + '.step')
      : name;
  const portable = 'models/' + file;
  files.set(relative, portable);
  portablePaths.set(relative, portable);
  portablePaths.set(file, portable);
  keys.set(relative, entry.sha256);
  keys.set(file, entry.sha256);
}
function relativePath(path: string) {
  return path
    .replace(/^\$\{KICAD\d+_3DMODEL_DIR\}\//, '')
    .replace(/^\$\{KIPRJMOD\}\/(?:footprints\/)?models\//, '')
    .replace(/\.wrl$/i, '.step');
}
export function exampleModelPath(relative: string) {
  const file = files.get(relative);
  if (!file) throw new Error('Unknown pinned example model: ' + relative);
  return file;
}
export function modelReferenceKey(path: string) {
  const relative = relativePath(path);
  return keys.get(relative) ?? relative;
}
export function resolveExampleModelRelative(allowed: readonly string[], path: string) {
  const relative = relativePath(path);
  return allowed.includes(relative)
    ? relative
    : allowed.find((item) => modelReferenceKey(item) === modelReferenceKey(path));
}
export function portableExampleModelSource(source: string) {
  return source.replace(
    /\$\{KIPRJMOD\}\/(?:footprints\/)?models\/([^"\r\n]+)/g,
    (original, relative) => {
      const portable = portablePaths.get(relative);
      return portable ? '$' + '{KIPRJMOD}/' + portable : original;
    },
  );
}
