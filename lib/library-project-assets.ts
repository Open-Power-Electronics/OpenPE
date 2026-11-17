import {
  projectNativeFiles,
  validateKiCadProjectFiles,
  type KiCadProjectFile,
} from './kicad-project';
import { footprintModels } from './pcb-models';
import type { FootprintSource } from './pcb-sync';
import type { Project } from './project';
import { child, children, parseSExpr, quote, val, writeSExpr, type SExpr } from './sexpr';

const tableName = 'fp-lib-table';
const libraryDirectory = 'footprints/NextPCB.pretty';
const libraryUri = '${KIPRJMOD}/' + libraryDirectory;

function fail(message: string): never {
  throw new Error(`NextPCB project library: ${message}`);
}

function packageName(id: string) {
  const name = id.slice('NextPCB:'.length);
  if (
    !id.startsWith('NextPCB:') ||
    !name ||
    name.length + '.kicad_mod'.length > 160 ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(name) ||
    /[. ]$/.test(name) ||
    ['.', '..'].includes(name) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  )
    fail('the component identity cannot be represented by a supported native footprint filename.');
  return `${libraryDirectory}/${name}.kicad_mod`;
}

function libraryTable(files: readonly KiCadProjectFile[]) {
  const file = files.find((item) => item.name === tableName);
  const tree = file ? parseSExpr(file.source) : ['fp_lib_table', ['version', '7']];
  if (tree[0] !== 'fp_lib_table')
    fail('fp-lib-table must contain a native footprint library table.');
  const entries = children(tree, 'lib').filter(
    (entry) => val(child(entry, 'name')).toLowerCase() === 'nextpcb',
  );
  if (
    entries.length > 1 ||
    entries.some(
      (entry) =>
        ['name', 'type', 'uri'].some(
          (name) => children(entry, name).length !== 1 || child(entry, name)!.length !== 2,
        ) ||
        val(child(entry, 'name')) !== 'NextPCB' ||
        val(child(entry, 'type')) !== 'KiCad' ||
        val(child(entry, 'uri')) !== libraryUri,
    )
  )
    fail('preserve the existing NextPCB library mapping before adding a downloaded package.');
  return { file, tree: tree as SExpr, entry: entries[0] };
}

function packageTree(id: string, footprint: SExpr): void {
  if (footprint[0] !== 'footprint' || val(footprint) !== id.slice('NextPCB:'.length))
    fail('the native package does not match its component identity.');
  for (const model of footprintModels(footprint))
    if (!/^\$\{KIPRJMOD\}\/models\/[a-f0-9]{64}\.step$/.test(model.path))
      fail('prepare the package 3D models as project-relative STEP assets before placement.');
}

/** Add only a host-prepared package to the same native document transaction.
 * Existing library files and mappings remain authoritative and are never replaced.
 */
export function attachNextPcbFootprint(project: Project, detail: FootprintSource): Project {
  if (!detail.id.startsWith('NextPCB:') || detail.projectAssets !== true) return project;
  const name = packageName(detail.id);
  packageTree(detail.id, detail.footprint);
  const bundle = project.nativeFiles ?? projectNativeFiles(project);
  const { file: table, tree, entry } = libraryTable(bundle.files);
  const existing = bundle.files.find((file) => file.name.toLowerCase() === name.toLowerCase());
  const source = writeSExpr(detail.footprint) + '\n';
  if (
    existing &&
    (existing.name !== name || writeSExpr(parseSExpr(existing.source)) !== source.trimEnd())
  )
    fail(`preserve the existing changed footprint ${name} before downloading it again.`);
  if (existing && entry) return project;
  const libraryEntry: SExpr = [
    'lib',
    ['name', quote('NextPCB')],
    ['type', quote('KiCad')],
    ['uri', quote(libraryUri)],
    ['options', quote('')],
    ['descr', quote('NextPCB project footprints')],
  ];
  let tableSource: string | undefined;
  if (!entry) {
    if (table) {
      // Parsing above establishes that the final parenthesis closes this root.
      // Insert only our entry so unrelated native library bytes remain intact.
      const closing = table.source.lastIndexOf(')');
      tableSource =
        table.source.slice(0, closing) +
        '\n  ' +
        writeSExpr(libraryEntry, 1) +
        '\n' +
        table.source.slice(closing);
    } else tableSource = writeSExpr([...tree, libraryEntry]) + '\n';
    parseSExpr(tableSource);
  }
  const files = bundle.files.map((file) =>
    file === table && tableSource !== undefined ? { ...file, source: tableSource } : file,
  );
  if (!table) files.push({ name: tableName, source: tableSource! });
  if (!existing) files.push({ name, source });
  const nativeFiles = { ...bundle, files };
  validateKiCadProjectFiles(nativeFiles);
  return { ...project, nativeFiles };
}

/** Read this project's explicit local library before requesting another package.
 * Missing component files may be downloaded; a conflicting mapping cannot be replaced.
 */
export function projectFootprintSource(project: Project, id: string): FootprintSource | undefined {
  if (!id.startsWith('NextPCB:')) return undefined;
  const name = packageName(id);
  const files = project.nativeFiles?.files ?? [];
  const { entry } = libraryTable(files);
  if (!entry) return undefined;
  const file = files.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!file) return undefined;
  if (file.name !== name) fail(`the native filename does not match ${id}.`);
  const footprint = parseSExpr(file.source);
  packageTree(id, footprint);
  return { id, footprint, projectAssets: true };
}
