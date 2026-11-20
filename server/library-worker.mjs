import { parentPort, workerData } from 'node:worker_threads';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { exampleFootprintSearchCatalog } from './example-footprints.mjs';
import {
  parseLibrary,
  propertyValue,
  resolveSymbol,
  symbolUnits,
  parseSExpr,
  children,
  child,
  num,
  val,
  createProject,
  validateProject,
  createLibraryPart,
  libraryPackageQuery,
  matchesNativeFootprintPackage,
  searchLibrary,
} from './library-format.mjs';

const root = workerData.root;
const catalogs = { symbols: [], footprints: [] };
const files = new Map();
const cache = new Map();
// Catalogs are immutable after indexing. Keep only the last ranked result per
// kind so scrolling pages does not rescan and sort the whole catalog.
const searches = new Map();
const libraryNames = new Map();
async function readSafe(file, limit = 64_000_000) {
  const resolved = await realpath(file);
  const relative = path.relative(await realpath(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Library path escapes the bundled resource directory.');
  if ((await stat(resolved)).size > limit) throw new Error('Library file exceeds its size limit.');
  return readFile(resolved, 'utf8');
}
async function symbols(file) {
  if (cache.has(file)) return cache.get(file);
  const result = (await stat(file)).isDirectory()
    ? (
        await Promise.all(
          (await readdir(file))
            .filter((n) => n.endsWith('.kicad_sym'))
            .map(async (n) => parseLibrary(await readSafe(path.join(file, n)))),
        )
      ).flat()
    : parseLibrary(await readSafe(file));
  if (cache.size >= 2) cache.delete(cache.keys().next().value);
  cache.set(file, result);
  return result;
}
let indexed, footprintSearchCatalog;
async function index() {
  try {
    const saved = JSON.parse(await readSafe(path.join(root, 'library-index.json'), 30_000_000));
    if (saved.version !== 1 || !Array.isArray(saved.files) || saved.files.length > 100000)
      throw new Error('Invalid bundled library index.');
    for (const kind of ['symbols', 'footprints']) {
      if (
        !Array.isArray(saved.catalogs?.[kind]) ||
        saved.catalogs[kind].some(
          (e) =>
            !e ||
            ['id', 'name', 'library', 'description', 'keywords'].some(
              (k) => typeof e[k] !== 'string',
            ),
        )
      )
        throw new Error('Invalid bundled catalog.');
      catalogs[kind] = saved.catalogs[kind];
    }
    for (const [id, file] of saved.files) {
      if (
        typeof id !== 'string' ||
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.split(/[\\/]/).includes('..')
      )
        throw new Error('Invalid index path.');
      files.set(id, path.join(root, file));
    }
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const entry of await readdir(path.join(root, 'symbols'), { withFileTypes: true })) {
    if (
      !(entry.isFile() && entry.name.endsWith('.kicad_sym')) &&
      !(entry.isDirectory() && entry.name.endsWith('.kicad_symdir'))
    )
      continue;
    const library = entry.name.replace(/\.kicad_sym(?:dir)?$/, '');
    const file = path.join(root, 'symbols', entry.name);
    const all = await symbols(file);
    const byName = new Map(all.map((s) => [val(s), s]));
    const field = (s, key, seen = new Set()) => {
      const value = propertyValue(s, key);
      const parent = val(child(s, 'extends'));
      if (value || !parent || seen.has(parent) || !byName.has(parent)) return value;
      seen.add(parent);
      return field(byName.get(parent), key, seen);
    };
    for (const s of all) {
      const name = val(s),
        id = `${library}:${name}`;
      files.set(`symbols:${id}`, file);
      catalogs.symbols.push({
        id,
        name,
        library,
        description: field(s, 'Description') || field(s, 'ki_description'),
        keywords: field(s, 'ki_keywords'),
        footprint: field(s, 'Footprint'),
      });
    }
  }
  for (const entry of await readdir(path.join(root, 'footprints'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.pretty')) continue;
    const library = entry.name.slice(0, -7);
    for (const f of await readdir(path.join(root, 'footprints', entry.name), {
      withFileTypes: true,
    })) {
      if (!f.isFile() || !f.name.endsWith('.kicad_mod')) continue;
      const name = f.name.slice(0, -10),
        id = `${library}:${name}`;
      const file = path.join(root, 'footprints', entry.name, f.name);
      files.set(`footprints:${id}`, file);
      const source = await readSafe(file, 8_000_000);
      const field = (key) => {
        const match = source.match(new RegExp(`\\(${key}\\s+("(?:\\\\.|[^"\\\\])*")`));
        return match ? JSON.parse(match[1]) : '';
      };
      catalogs.footprints.push({
        id,
        name,
        library,
        description: field('descr'),
        keywords: field('tags'),
      });
    }
  }
  for (const entries of Object.values(catalogs)) entries.sort((a, b) => a.id.localeCompare(b.id));
}
parentPort.on(
  'message',
  async ({ requestId, action, kind, query = '', library = '', id, offset = 0 }) => {
    try {
      indexed ??= index();
      await indexed;
      let result;
      if (action === 'snapshot')
        result = {
          version: 1,
          catalogs,
          files: [...files].map(([id, file]) => [id, path.relative(root, file)]),
        };
      else if (action === 'status')
        result = {
          version: '10.0.0',
          symbols: catalogs.symbols.length,
          footprints: catalogs.footprints.length,
        };
      else if (action === 'search') {
        if (!Object.hasOwn(catalogs, kind)) throw new Error('Unknown library kind.');
        const entries =
          kind === 'footprints'
            ? (footprintSearchCatalog ??= exampleFootprintSearchCatalog(catalogs.footprints))
            : catalogs[kind];
        let search = searches.get(kind);
        if (!search || search.query !== query || search.library !== library) {
          const packageQuery = libraryPackageQuery(query);
          const matches =
            packageQuery === undefined
              ? searchLibrary(entries, query, library)
              : searchLibrary(
                  entries.filter((entry) =>
                    matchesNativeFootprintPackage(
                      kind === 'symbols' ? entry.footprint : entry.id,
                      packageQuery,
                    ),
                  ),
                  '',
                  library,
                );
          search = { query, library, matches };
          searches.set(kind, search);
        }
        const { matches } = search;
        if (!libraryNames.has(kind)) {
          const names = [...new Set(entries.map((entry) => entry.library))];
          libraryNames.set(kind, names.sort((a, b) => a.localeCompare(b)));
        }
        result = {
          entries: matches.slice(offset, offset + 100),
          total: matches.length,
          libraries: libraryNames.get(kind),
        };
      } else if (action === 'detail') {
        const file = files.get(`${kind}:${id}`);
        if (!file) throw new Error('Unknown library entry.');
        const entry = catalogs[kind].find((e) => e.id === id);
        if (kind === 'symbols') {
          const symbol = resolveSymbol(await symbols(file), entry.name, entry.library);
          result = { ...entry, symbol, units: symbolUnits(symbol) };
          try {
            const project = createProject();
            project.schematic.libraries = { [id]: symbol };
            project.schematic.parts = [createLibraryPart(project.schematic, symbol, 0, 0)];
            validateProject(project);
          } catch (e) {
            result.error = e.message;
          }
        } else {
          const footprint = parseSExpr(await readSafe(file, 8_000_000));
          if (footprint[0] !== 'footprint' || num(child(footprint, 'version')) > 20260206)
            throw new Error('Unsupported footprint version.');
          result = {
            ...entry,
            description: val(child(footprint, 'descr')),
            footprint,
            pads: [
              ...new Set(
                children(footprint, 'pad')
                  .map((p) => val(p))
                  .filter(Boolean),
              ),
            ],
            models: children(footprint, 'model').map((m) => ({
              path: val(m),
              offset: child(m, 'offset'),
              scale: child(m, 'scale'),
              rotate: child(m, 'rotate'),
            })),
          };
        }
      } else throw new Error('Unknown library operation.');
      parentPort.postMessage({ requestId, result });
    } catch (e) {
      parentPort.postMessage({
        requestId,
        error:
          e.code === 'ENOENT'
            ? 'Bundled KiCad libraries are missing. Run npm run libraries:download before building OpenPE.'
            : e.message,
      });
    }
  },
);
