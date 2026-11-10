import { emptyCircuit, parseCircuitTree, type Circuit } from './circuit';
import { parseKiCadPCB, expandNativeBoardZones } from './kicad-pcb';
import { nativeIdentity } from './kicad-project-identity';
import {
  loadKiCadPCBDesignRuleLimits,
  pcbDesignRuleLimitKeys,
  readKiCadPCBDesignRuleLimits,
  resolvePCBDesignRules,
  setKiCadPCBDesignRuleLimits,
  workbenchPCBDesignRules,
  type PCBDesignRuleThresholds,
} from './design-rule-checks';
import { toProjectDocument } from './project-document';
import { rememberNativeSourceJson } from './project-json';
import {
  isOwnedCircuit,
  isOwnedProject,
  isOwnedProjectNode,
  ownProjectData,
} from './immutable-project';
import { materializedPCBTree, serializePCB, type PCB } from './pcb';
import {
  MODEL_CAD_EXTENSION,
  MODEL_CAD_NATIVE_VARIABLE,
  modelCadFromProject,
  nativeModelCadExtensions,
  validateModelCad,
  type ModelCAD,
} from './model-cad';
import {
  simulationModelReferenceForFile,
  validateSimulationModels,
  type SimulationModelReference,
} from './simulation-models';
import {
  createProject,
  exportKiCadSchematicTree,
  MAX_PROJECT_BYTES,
  MAX_SCHEMATIC_FILES,
  projectSchematics,
  validateProject,
  type Project,
} from './project';
import {
  child,
  children,
  parseOwnedSExpr,
  parseSExpr,
  quote,
  val,
  writeSExpr,
  writeSExprJsonPayload,
  primeSExprJsonChildren,
  type SExpr,
} from './sexpr';

/** encoding is private byte-preservation metadata for non-UTF-8 vendor text. */
export type KiCadProjectFile = { name: string; source: string; encoding?: 'latin1' };
export type KiCadProjectFiles = { entry: string; files: KiCadProjectFile[] };
const MAX_NATIVE_PROJECT_FILES = 128;
const MAX_NATIVE_PROJECT_BYTES = 96_000_000;

const encoder = new TextEncoder();
// ASCII has one UTF-8 byte per code unit. Snapshot this argument once so
// mutable caller getters cannot change the text between detection and counting.
const utf8Size = (source: string) =>
  typeof source === 'string' && !/[^\x00-\x7f]/.test(source)
    ? source.length
    : encoder.encode(source).length;
// Certification covers only this exact detached packet's local text/name
// checks and encoded size. Each containing bundle still checks its complete
// names, counts, associations and aggregate byte budget below.
const ownedNativeFileSizes = new WeakMap<KiCadProjectFile, number>();
const MODEL_VARIABLE = 'OPENPE_SIMULATION_MODELS';
const PROJECT_NAME_VARIABLE = 'OPENPE_PROJECT_NAME';
const ext = (name: string, suffix: string) => name.toLowerCase().endsWith(suffix);
const stem = (name: string) => name.replace(/\.kicad_(?:pro|sch|pcb)$/i, '');
const fail = (message: string): never => {
  throw new Error(`Invalid KiCad project: ${message}`);
};
const safeName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 240 &&
  !/[\\\x00-\x1f:*?"<>|]/.test(name) &&
  name
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 160 &&
        !['.', '..'].includes(segment) &&
        !/[. ]$/.test(segment) &&
        !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
    );
const nativeName = (name: string) => {
  const segments = name.split('/');
  return (
    segments.length <= 9 &&
    !segments
      .slice(0, -1)
      .some(
        (segment) =>
          [
            '.git',
            'history.git',
            'node_modules',
            '.cache',
            'cache',
            'simulation-cache',
            'spice',
            'thermal',
            'upstream',
          ].includes(segment.toLowerCase()) || /-backups$/i.test(segment),
      ) &&
    (/\.kicad_(?:pro|sch|pcb|dru|wks|sym|mod|jobset)$/i.test(name) ||
      /\.(?:lib|cir|spice|dcm)$/i.test(name) ||
      ['sym-lib-table', 'fp-lib-table'].includes(segments.at(-1)!))
  );
};

export function validateKiCadProjectFiles(input: unknown): asserts input is KiCadProjectFiles {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('expected project files.');
  const bundle = input as KiCadProjectFiles;
  if (
    Object.keys(bundle).some((key) => !['entry', 'files'].includes(key)) ||
    !safeName(bundle.entry) ||
    !/\.kicad_(?:pro|sch|pcb)$/i.test(bundle.entry)
  )
    fail('choose a .kicad_pro, .kicad_sch or .kicad_pcb entry file.');
  if (
    !Array.isArray(bundle.files) ||
    !bundle.files.length ||
    bundle.files.length > MAX_NATIVE_PROJECT_FILES
  )
    fail(`a project supports 1–${MAX_NATIVE_PROJECT_FILES} text files.`);
  let total = 0;
  const names = new Set<string>();
  const checked: { file: KiCadProjectFile; size: number }[] = [];
  for (const file of bundle.files) {
    const owned = !!file && typeof file === 'object' && isOwnedProjectNode(file);
    const cachedSize = owned ? ownedNativeFileSizes.get(file) : undefined;
    if (
      cachedSize === undefined &&
      (!file ||
        typeof file !== 'object' ||
        Object.keys(file).some((key) => !['name', 'source', 'encoding'].includes(key)) ||
        !safeName(file.name) ||
        !nativeName(file.name) ||
        typeof file.source !== 'string' ||
        file.source.includes('\0') ||
        (file.encoding !== undefined && file.encoding !== 'latin1') ||
        (file.encoding === 'latin1' &&
          (/[^\x00-\xff]/.test(file.source) || /\.kicad_(?:pro|sch|pcb)$/i.test(file.name))))
    )
      fail(
        'files require a contained relative name and supported KiCad text. Native project, schematic and PCB sources must be UTF-8; Latin-1 vendor sources must contain representable characters.',
      );
    const key = file.name.toLowerCase();
    if (names.has(key)) fail(`duplicate file ${file.name}.`);
    names.add(key);
    if (ext(file.name, '.openpe.json'))
      fail('Private JSON snapshots are not native KiCad project files.');
    const size =
      cachedSize ?? (file.encoding === 'latin1' ? file.source.length : utf8Size(file.source));
    if (size > MAX_PROJECT_BYTES) fail(`${file.name} exceeds 8 MB.`);
    total += size;
    if (owned && cachedSize === undefined) checked.push({ file, size });
  }
  for (const name of names) {
    let separator = name.indexOf('/');
    while (separator >= 0) {
      if (names.has(name.slice(0, separator))) fail(`file and directory names overlap at ${name}.`);
      separator = name.indexOf('/', separator + 1);
    }
  }
  if (total > MAX_NATIVE_PROJECT_BYTES) fail('project text exceeds 96 MB.');
  if (!names.has(bundle.entry.toLowerCase())) fail('the entry file is missing.');
  if (bundle.files.filter((file) => ext(file.name, '.kicad_pro')).length > 1)
    fail('open one KiCad project at a time.');
  if (bundle.files.filter((file) => ext(file.name, '.kicad_pcb')).length > 1)
    fail('a project supports one PCB layout.');
  if (bundle.files.filter((file) => ext(file.name, '.kicad_sch')).length > MAX_SCHEMATIC_FILES)
    fail(`a project supports up to ${MAX_SCHEMATIC_FILES} schematic files.`);
  for (const { file, size } of checked) ownedNativeFileSizes.set(file, size);
}

function projectSettings(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return fail('the .kicad_pro file must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return fail('the .kicad_pro file must contain a JSON object.');
  const visit = (value: unknown, depth: number) => {
    if (depth > 80) fail('project settings nesting exceeds the supported limit.');
    if (typeof value === 'number' && !Number.isFinite(value))
      fail('project settings numbers must be finite.');
    if (value && typeof value === 'object')
      for (const item of Object.values(value)) visit(item, depth + 1);
  };
  visit(parsed, 0);
  return parsed as Record<string, unknown>;
}

function referencedModels(
  settings: Record<string, unknown>,
): SimulationModelReference[] | undefined {
  const variables = settings.text_variables;
  if (variables === undefined) return undefined;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables))
    return fail('native text_variables must be an object.');
  const value = (variables as Record<string, unknown>)[MODEL_VARIABLE];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    return fail('simulation model references must be a native text variable string.');
  let files: unknown;
  try {
    files = JSON.parse(value);
  } catch {
    return fail('simulation model references are invalid.');
  }
  if (!Array.isArray(files) || files.length > 32 || files.some((file) => typeof file !== 'string'))
    return fail('simulation model references must list at most 32 pinned model files.');
  const models = files.map((file) => {
    const model = simulationModelReferenceForFile(file);
    if (!model) return fail(`unsupported simulation model file ${String(file)}.`);
    return { ...model };
  });
  validateSimulationModels(models);
  return models.length ? models : undefined;
}

function nativeProjectName(settings: Record<string, unknown>): string | undefined {
  const variables = settings.text_variables;
  if (variables === undefined) return undefined;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables))
    return fail('native text_variables must be an object.');
  const value = (variables as Record<string, unknown>)[PROJECT_NAME_VARIABLE];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 4096)
    return fail('the project name must be a native text variable string of 1–4096 characters.');
  return value;
}

function nativeModelCad(settings: Record<string, unknown>): ModelCAD | undefined {
  const variables = settings.text_variables;
  if (variables === undefined) return undefined;
  if (!variables || typeof variables !== 'object' || Array.isArray(variables))
    return fail('native text_variables must be an object.');
  const value = (variables as Record<string, unknown>)[MODEL_CAD_NATIVE_VARIABLE];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256000)
    return fail('Model CAD parameters must be a bounded native text variable string.');
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    return fail('Model CAD parameters are invalid JSON.');
  }
  return validateModelCad(input);
}

type ParsedNative = {
  schematics: { file: KiCadProjectFile; circuit: Circuit; root: SExpr; fingerprint?: string }[];
  board: ReturnType<typeof parseKiCadPCB>['board'] | null;
  boardSource?: string;
  projectFile?: KiCadProjectFile;
};
const blankNativeSchematic = (name: string): Circuit => ({
  ...emptyCircuit(),
  id: nativeIdentity(stem(name) + ':schematic'),
  title: stem(name).split('/').at(-1)!,
});
// Entries are established only after the enclosing Project has passed through
// ownProject. The detached immutable bundle can then be shared across revisions.
const ownedParsedFiles = new WeakMap<KiCadProjectFiles, ParsedNative>();
const ownedNativeSchematicFingerprints = new WeakMap<Circuit, string>();

function nativeFieldLayout(layout: SExpr[]): SExpr[] {
  const effects = layout.filter((node) => node[0] === 'effects');
  if (effects.length !== 1) return layout;
  const outer = layout.filter((node) => node[0] === 'hide');
  const inner = effects[0].filter(
    (node) => node === 'hide' || (Array.isArray(node) && node[0] === 'hide'),
  );
  if (outer.length + inner.length !== 1) return layout;
  const hidden = outer.length ? outer[0] : inner[0];
  if (hidden !== 'hide' && (!Array.isArray(hidden) || hidden.length !== 2 || hidden[1] !== 'yes'))
    return layout;
  return [
    ...layout
      .filter((node) => node !== outer[0])
      .map((node) => (node === effects[0] ? node.filter((item) => item !== inner[0]) : node)),
    ['hide', 'yes'],
  ];
}

/** Native export spells a single hidden field outside effects. Compare that
 * equivalent representation without changing private documents or dirty state. */
function nativeSchematicFingerprint(project: Project, circuit: Circuit): string {
  const owned = isOwnedProject(project) && isOwnedCircuit(circuit);
  const cached = owned ? ownedNativeSchematicFingerprints.get(circuit) : undefined;
  if (cached !== undefined) return cached;
  const { schematic, libraries } = toProjectDocument(
    { ...project, schematic: circuit, additionalSchematics: undefined, pcb: null },
    true,
  );
  // The canonical projection can share owned components and embedded libraries.
  // Normalize only copied field-layout containers instead of encoding, parsing
  // and copying the entire sheet/library packet before encoding it a second time.
  const components = schematic.components?.map((component) => {
    if (!component.fieldLayout) return component;
    const fieldLayout = { ...component.fieldLayout };
    for (const [name, layout] of Object.entries(component.fieldLayout)) {
      const normalized = nativeFieldLayout(layout);
      const defaultLayout = [
        ['at', String(component.position.x), String(component.position.y), '0'],
        ['effects', ['font', ['size', '1.27', '1.27']]],
        ['hide', 'yes'],
      ];
      if (JSON.stringify(normalized) === JSON.stringify(defaultLayout)) delete fieldLayout[name];
      else fieldLayout[name] = normalized;
    }
    const normalized: typeof component = { ...component, fieldLayout };
    if (!Object.keys(fieldLayout).length) delete normalized.fieldLayout;
    return normalized;
  });
  const fingerprint = JSON.stringify([
    components ? { ...schematic, components } : schematic,
    libraries,
  ]);
  if (owned && fingerprint.length <= MAX_PROJECT_BYTES)
    ownedNativeSchematicFingerprints.set(circuit, fingerprint);
  return fingerprint;
}

function parseFiles(bundle: KiCadProjectFiles, owner?: Project): ParsedNative {
  const trustedOwner =
    owner && isOwnedProject(owner) && owner.nativeFiles === bundle ? owner : undefined;
  // Imports return mutable editor models. They must never expose the private
  // parsed baseline retained for an internally owned native bundle.
  const cached = trustedOwner ? ownedParsedFiles.get(bundle) : undefined;
  if (cached) return cached;
  validateKiCadProjectFiles(bundle);
  const projectFile = bundle.files.find((file) => ext(file.name, '.kicad_pro'));
  if (projectFile) {
    const settings = projectSettings(projectFile.source);
    readKiCadPCBDesignRuleLimits(settings);
    referencedModels(settings);
    if (
      settings.text_variables &&
      typeof settings.text_variables === 'object' &&
      Object.hasOwn(settings.text_variables, 'OPENPE_ENCLOSURE')
    )
      fail('unsupported retired enclosure data. Use current Model CAD objects.');
    nativeModelCad(settings);
    nativeProjectName(settings);
  }
  const projectStem = stem(projectFile?.name ?? bundle.entry).toLowerCase();
  const schematics = bundle.files
    .filter((file) => ext(file.name, '.kicad_sch'))
    .map((file) => {
      const root = parseSExpr(file.source);
      return { file, circuit: parseCircuitTree(root), root };
    });
  const primary = schematics.findIndex(
    (item) => stem(item.file.name).toLowerCase() === projectStem,
  );
  if (primary > 0) schematics.unshift(...schematics.splice(primary, 1));
  const boardFile = bundle.files.find((file) => ext(file.name, '.kicad_pcb'));
  const schematic =
    schematics[0]?.circuit ?? blankNativeSchematic(projectFile?.name ?? bundle.entry);
  const board = boardFile ? parseKiCadPCB(boardFile.source, schematic, schematic.id).board : null;
  if (projectFile && nativeModelCad(projectSettings(projectFile.source)) && !board)
    fail('Model CAD requires its PCB layout.');
  if (!schematics.length && !board) fail('no supported schematic or PCB file was found.');
  const parsed = { schematics, board, ...(projectFile ? { projectFile } : {}) };
  if (trustedOwner) ownedParsedFiles.set(bundle, parsed);
  return parsed;
}

/** Validate retained native sources without entering project model validation again. */
export function validateNativeSourceFiles(bundle: KiCadProjectFiles, owner?: Project): void {
  parseFiles(bundle, owner);
}

export function projectFromNativeFiles(bundle: KiCadProjectFiles): Project {
  const parsed = parseFiles(bundle);
  const models = parsed.projectFile
    ? referencedModels(projectSettings(parsed.projectFile.source))
    : undefined;
  const modelCad = parsed.projectFile
    ? nativeModelCad(projectSettings(parsed.projectFile.source))
    : undefined;
  const schematic =
    parsed.schematics[0]?.circuit ?? blankNativeSchematic(parsed.projectFile?.name ?? bundle.entry);
  const project: Project = {
    ...createProject(schematic),
    id: nativeIdentity(schematic.id + ':project'),
    name:
      (parsed.projectFile && nativeProjectName(projectSettings(parsed.projectFile.source))) ??
      stem(parsed.projectFile?.name ?? bundle.entry)
        .split('/')
        .at(-1),
    ...(parsed.schematics.length > 1
      ? { additionalSchematics: parsed.schematics.slice(1).map((item) => item.circuit) }
      : {}),
    pcb: parsed.board,
    extensions: {
      ...(modelCad ? { [MODEL_CAD_EXTENSION]: modelCad } : {}),
    },
    ...(models ? { simulationModels: models } : {}),
    nativeFiles: { entry: bundle.entry, files: bundle.files.map((file) => ({ ...file })) },
  };
  validateProject(project);
  return project;
}

const baseName = (value: string) =>
  value
    .replace(/\.kicad_(?:pro|sch|pcb)$/i, '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/[. ]+$/g, '') || 'Untitled';
const newSettings = (filename: string) =>
  JSON.stringify({ meta: { filename, version: 1 } }, null, 2) + '\n';

/** The owning root gets the current native project name. Shared-sheet annotations
 * for other roots come from retained source, never the editor's reference rewrite. */
const ownedSchematicInstanceSymbols = new WeakMap<
  Circuit['parts'][number],
  Map<string, { original: SExpr | undefined; schematicId: string; input: SExpr; symbol: SExpr }>
>();
function schematicProjectInstances(
  source: string | SExpr,
  original: SExpr | undefined,
  schematic: Circuit,
  projectName: string,
  reuseOwned = false,
): string {
  const root = typeof source === 'string' ? parseSExpr(source) : source;
  const before = typeof source === 'string' ? JSON.stringify(root) : undefined;
  const originals = original
    ? new Map(children(original, 'symbol').map((node) => [val(child(node, 'uuid')), node]))
    : undefined;
  const ownerPath = '/' + schematic.id;
  const owns = (path: SExpr) => val(path).toLowerCase() === ownerPath.toLowerCase();
  const parts = new Map(schematic.parts.map((part) => [part.id, part]));
  for (const symbol of children(root, 'symbol')) {
    const id = val(child(symbol, 'uuid'));
    const part = parts.get(id);
    if (!part) continue;
    const reusable = reuseOwned && isOwnedProjectNode(part);
    const destinations = reusable ? ownedSchematicInstanceSymbols.get(part) : undefined;
    const cached = destinations?.get(projectName);
    if (
      cached &&
      cached.original === original &&
      cached.schematicId === schematic.id &&
      cached.input.length === symbol.length &&
      cached.input.every((node, index) => node === symbol[index])
    ) {
      root[root.indexOf(symbol)] = cached.symbol;
      continue;
    }
    const input = reusable ? symbol.slice() : undefined;
    const previous = originals?.get(id) ?? (!original ? part.raw : undefined);
    const foreign: SExpr[] = [];
    const owned: SExpr[] = [];
    for (const block of children(child(previous ?? [], 'instances') ?? [], 'project')) {
      owned.push(...children(block, 'path').filter(owns));
      const retained = block.filter(
        (node) => !Array.isArray(node) || node[0] !== 'path' || !owns(node),
      );
      if (retained.length > 2) foreign.push(structuredClone(retained));
    }
    const owner = foreign.find((block) => val(block) === projectName) ?? [
      'project',
      quote(projectName),
    ];
    if (!foreign.includes(owner)) foreign.push(owner);
    const paths = owned.length ? structuredClone(owned) : [['path', quote(ownerPath)]];
    for (const path of paths) {
      path[1] = quote(ownerPath);
      for (const [key, value] of [
        ['reference', quote(part.ref)],
        ['unit', String(part.unit || 1)],
      ]) {
        const field = child(path, key);
        if (field) field[1] = value;
        else path.push([key, value]);
      }
      owner.push(path);
    }
    const existing = children(symbol, 'instances');
    const index = existing.length ? symbol.indexOf(existing[0]) : symbol.length;
    for (const node of existing) symbol.splice(symbol.indexOf(node), 1);
    symbol.splice(index, 0, ['instances', ...foreign]);
    if (input) {
      const owned = ownProjectData(symbol);
      const variants = destinations ?? new Map();
      variants.set(projectName, { original, schematicId: schematic.id, input, symbol: owned });
      while (variants.size > 3) variants.delete(variants.keys().next().value!);
      ownedSchematicInstanceSymbols.set(part, variants);
      root[root.indexOf(symbol)] = owned;
    }
  }
  return typeof source === 'string' && JSON.stringify(root) === before
    ? source
    : writeSExpr(root) + '\n';
}

const ownedCleanSchematicSeeds = new WeakMap<
  Circuit,
  { original: KiCadProjectFile; destinations: Set<string> }
>();
/** Keep clean native bytes authoritative while preparing the immutable syntax
 * shared by later schematic edits. This records preparation only, never an
 * export result or semantic acceptance. Board revisions need no new preparation;
 * real exports still check every instance's current input and associations. */
function seedCleanSchematicSource(
  project: Project,
  schematic: Circuit,
  original: KiCadProjectFile,
  originalRoot: SExpr,
  projectName: string,
) {
  if (!isOwnedProject(project) || !isOwnedCircuit(schematic) || !isOwnedProjectNode(original))
    return;
  const previous = ownedCleanSchematicSeeds.get(schematic);
  if (previous?.original === original && previous.destinations.has(projectName)) return;
  try {
    schematicProjectInstances(
      exportKiCadSchematicTree(project, schematic.id),
      originalRoot,
      schematic,
      projectName,
      true,
    );
    const destinations =
      previous?.original === original ? previous.destinations : new Set<string>();
    destinations.add(projectName);
    while (destinations.size > 3) destinations.delete(destinations.values().next().value!);
    ownedCleanSchematicSeeds.set(schematic, { original, destinations });
  } catch {
    // Optional preparation cannot reject an accepted unchanged import. Do not
    // remember failure: a real edit must still validate and report its own error.
  }
}

/** Retain native board setup and non-geometrical footprint metadata when editing geometry. */
const ownedBoardSourceTrees = new WeakMap<KiCadProjectFile, SExpr>();
const ownedMergedBoardNodes = new WeakMap<
  object,
  { original: KiCadProjectFile; context: string; tree: SExpr }
>();
const ownedCleanBoardSeeds = new WeakMap<PCB, { original: KiCadProjectFile; context: string }>();
const boardMergeContext = (
  keepLayers: boolean,
  schematicId: string,
  schematic: Circuit,
  board: PCB,
) =>
  JSON.stringify([
    keepLayers,
    schematicId,
    schematic.id,
    board.layers,
    board.nets,
    schematic.parts.map((part) => [part.id, part.ref, part.value]),
  ]);
function mergeBoardSource(
  original: KiCadProjectFile,
  generated: string,
  keepLayers: boolean,
  schematicId: string,
  schematic: Circuit,
  board: PCB,
  captureJson?: (encode: () => string) => void,
): string {
  const owned = isOwnedProjectNode(original);
  let before = owned ? ownedBoardSourceTrees.get(original) : undefined;
  if (!before) {
    const expanded = expandNativeBoardZones(
      owned ? parseOwnedSExpr(original.source) : parseSExpr(original.source),
    );
    before = owned ? ownProjectData(expanded) : expanded;
    if (owned) {
      ownedBoardSourceTrees.set(original, before);
    }
  }
  const after = isOwnedProjectNode(board)
    ? [...materializedPCBTree(board, schematic)]
    : parseSExpr(generated);
  const reusable = owned && isOwnedProjectNode(board);
  const context = reusable ? boardMergeContext(keepLayers, schematicId, schematic, board) : '';
  const objects = reusable
    ? new Map<string, PCB['footprints' | 'tracks' | 'vias' | 'graphics' | 'zones'][number]>()
    : undefined;
  if (objects) {
    for (const item of board.footprints) objects.set(item.id, item);
    for (const item of board.tracks) objects.set(item.id, item);
    for (const item of board.vias) objects.set(item.id, item);
    for (const item of board.graphics) objects.set(item.id, item);
    for (const item of board.zones) objects.set(item.id, item);
  }
  const retained = ['setup', 'paper', 'title_block', 'embedded_fonts'];
  if (keepLayers) retained.push('layers');
  for (const key of retained) {
    const source = children(before, key);
    if (!source.length) continue;
    for (const node of children(after, key)) after.splice(after.indexOf(node), 1);
    after.push(...source);
  }
  const oldGeneral = child(before, 'general');
  let newGeneral = child(after, 'general');
  if (newGeneral && isOwnedProjectNode(newGeneral)) {
    const index = after.indexOf(newGeneral);
    after[index] = newGeneral = [...newGeneral];
  }
  if (oldGeneral && newGeneral)
    newGeneral.push(...oldGeneral.filter((node) => Array.isArray(node) && node[0] !== 'thickness'));
  const nativeLock = (node: SExpr) =>
    node.includes('locked') || val(child(node, 'locked')) === 'yes';
  const retain = (
    old: SExpr,
    node: SExpr,
    keys: string[],
    retainLocks = nativeLock(old) === nativeLock(node),
  ) => {
    for (const key of new Set([...keys, ...(retainLocks ? ['locked', 'unlocked'] : [])])) {
      const source = children(old, key);
      if (!source.length) continue;
      for (const item of children(node, key)) node.splice(node.indexOf(item), 1);
      node.push(...source);
    }
    if (retainLocks)
      for (const flag of ['locked', 'unlocked'])
        if (old.includes(flag)) {
          for (const item of children(node, flag)) node.splice(node.indexOf(item), 1);
          if (!node.includes(flag)) node.push(flag);
        }
    const oldLayer = child(old, 'layer');
    let newLayer = child(node, 'layer');
    // Layer modifiers such as text knockout are independent of the edited layer.
    if (oldLayer && newLayer && oldLayer.length > 2) {
      if (isOwnedProjectNode(newLayer)) {
        const index = node.indexOf(newLayer);
        node[index] = newLayer = [...newLayer];
      }
      newLayer.splice(2, newLayer.length - 2, ...oldLayer.slice(2));
    }
  };
  const matched = (
    old: SExpr[],
    generated: SExpr[],
    key: (index: number) => string,
    apply: (old: SExpr, node: SExpr, index: number) => void,
    container: SExpr,
  ) => {
    let originals: Map<string, { node: SExpr; index: number }> | undefined;
    let scanFrom = 0;
    for (const candidate of generated) {
      // Each selector preserves container order, and merges replace slots in
      // place. Resume after the previous record instead of rescanning siblings.
      let position = container.indexOf(candidate, scanFrom);
      if (position < 0) position = container.indexOf(candidate);
      scanFrom = position + 1;
      const uuid = val(child(candidate, 'uuid'));
      const item = container === after ? objects?.get(uuid) : undefined;
      const cached = item ? ownedMergedBoardNodes.get(item) : undefined;
      if (cached?.original === original && cached.context === context) {
        container[position] = cached.tree;
        continue;
      }
      // Metadata changes these containers, never their geometry leaves. Copy
      // only the frozen container; nested matched records replace their own
      // containers below, retaining the immutable parsed coordinate trees.
      const node = isOwnedProjectNode(candidate) ? [...candidate] : candidate;
      if (node !== candidate) container[position] = node;
      // A fully retained group needs no UUID lookup over the original records.
      originals ??= new Map(
        old.map((record, index) => [
          val(child(record, 'uuid')) || nativeIdentity(schematicId + ': ' + key(index)),
          { node: record, index },
        ]),
      );
      const previous = originals.get(uuid);
      if (previous) apply(previous.node, node, previous.index);
      if (item) {
        // All geometry is keyed by the exact owned record. Caption/net changes
        // and a different retained native file invalidate the derived packet.
        // Keep one context per record; public native results expose strings only.
        const tree = ownProjectData(node);
        ownedMergedBoardNodes.set(item, { original, context, tree });
        container[position] = tree;
      }
    }
  };
  const graphicNodes = (root: SExpr, footprint = false) =>
    root.filter(
      (node): node is SExpr =>
        Array.isArray(node) &&
        (footprint
          ? [
              'fp_line',
              'fp_rect',
              'fp_arc',
              'fp_circle',
              'fp_poly',
              'fp_text',
              'property',
            ].includes(String(node[0]))
          : String(node[0]).startsWith('gr_') || node[0] === 'dimension'),
    );
  const retainGraphic = (old: SExpr, node: SExpr) => retain(old, node, ['unlocked']);
  const retainZone = (old: SExpr, node: SExpr) => retain(old, node, ['hatch', 'placement', 'name']);
  matched(
    children(before, 'segment'),
    children(after, 'segment'),
    (i) => `track:${i}`,
    (old, node) => {
      const locked = (segment: SExpr) =>
        segment.includes('locked') || val(child(segment, 'locked')) === 'yes';
      retain(old, node, [], locked(old) === locked(node));
    },
    after,
  );
  matched(
    children(before, 'via'),
    children(after, 'via'),
    (i) => `via:${i}`,
    (old, node) => retain(old, node, ['free', 'remove_unused_layers']),
    after,
  );
  matched(children(before, 'zone'), children(after, 'zone'), (i) => `zone:${i}`, retainZone, after);
  matched(graphicNodes(before), graphicNodes(after), (i) => `graphic:${i}`, retainGraphic, after);
  matched(
    children(before, 'footprint'),
    children(after, 'footprint'),
    (i) => `footprint:${i}`,
    (old, node, fi) => {
      retain(old, node, [
        'attr',
        'descr',
        'tags',
        'sheetname',
        'sheetfile',
        'duplicate_pad_numbers_are_jumpers',
        'embedded_fonts',
        'units',
      ]);
      if (!child(node, 'path') && child(old, 'path')) node.push(child(old, 'path')!);
      node.push(
        ...children(old, 'property').filter(
          (property) => !child(property, 'at') && !child(property, 'effects'),
        ),
      );
      matched(
        children(old, 'pad'),
        children(node, 'pad'),
        (pi) => `fp:${fi}:pad:${pi}`,
        (oldPad, pad) => retain(oldPad, pad, ['pinfunction', 'pintype']),
        node,
      );
      matched(
        children(old, 'zone'),
        children(node, 'zone'),
        (zi) => `fp:${fi}:zone:${zi}`,
        retainZone,
        node,
      );
      matched(
        graphicNodes(old, true),
        graphicNodes(node, true),
        (gi) => `fp:${fi}:graphic:${gi}`,
        retainGraphic,
        node,
      );
    },
    after,
  );
  const source = writeSExpr(after) + '\n';
  if (reusable) {
    if (captureJson) captureJson(() => '"' + writeSExprJsonPayload(after) + '\\n"');
    else primeSExprJsonChildren(after);
  }
  return source;
}

/** A clean admission keeps the retained bytes. Prepare only the private trees,
 * record merges and their text derivations once before the first copper edit.
 * Optional preparation cannot reject an otherwise accepted unchanged import. */
function seedCleanBoardSource(
  original: KiCadProjectFile,
  generated: string,
  keepLayers: boolean,
  schematicId: string,
  project: Project,
) {
  const board = project.pcb;
  if (!board || !isOwnedProject(project) || !isOwnedProjectNode(original)) return;
  const context = boardMergeContext(keepLayers, schematicId, project.schematic, board);
  const previous = ownedCleanBoardSeeds.get(board);
  if (previous?.original === original && previous.context === context) return;
  try {
    // Never publish or cache these normalized whole-board bytes as clean Source.
    // The caller still returns original.source, including its exact whitespace.
    mergeBoardSource(original, generated, keepLayers, schematicId, project.schematic, board);
    ownedCleanBoardSeeds.set(board, { original, context });
  } catch {
    // No failed preparation is remembered. A later real edit still performs
    // the complete merge and reports its ordinary validation/geometry error.
  }
}

/** The complete text file set that is written to a native KiCad project directory. */
const ownedNativeFiles = new WeakMap<Project, Map<string | undefined, KiCadProjectFiles>>();
// The PCB text does not contain the destination stem. Default Source and a
// managed project's renamed destination share it while retaining independent
// schematic owning-instance names and project settings.
const ownedNativeBoardSources = new WeakMap<Project, string>();
const ownedRenamedSchematicSources = new WeakMap<
  Circuit,
  Map<string, { original: KiCadProjectFile; source: string }>
>();
// A destination-only rename retains the exact source and encoding. Reusing this
// detached packet across revisions also retains its successful local byte/name
// validation. The complete candidate bundle is still checked before publication.
const ownedRenamedNativeFiles = new WeakMap<KiCadProjectFile, Map<string, KiCadProjectFile>>();
const copyNativeFiles = (bundle: KiCadProjectFiles): KiCadProjectFiles => ({
  entry: bundle.entry,
  files: bundle.files.map((file) => ({ ...file })),
});
export function projectNativeFiles(project: Project, entryName?: string): KiCadProjectFiles {
  return copyNativeFiles(projectNativeFilesSnapshot(project, entryName));
}

/** Private Source/recovery assembly can retain immutable text packets. Public
 * native exports always receive independent file containers above. */
export function projectNativeFilesSnapshot(
  project: Project,
  entryName?: string,
): KiCadProjectFiles {
  const entries = ownedNativeFiles.get(project);
  const cached =
    entries?.get(entryName) ??
    (entryName === undefined
      ? undefined
      : [...(entries?.values() ?? [])].find((bundle) => bundle.entry === entryName));
  if (cached) return cached;
  validateProject(project);
  const retained = project.nativeFiles;
  const parsed = retained ? parseFiles(retained, project) : undefined;
  const oldProject = parsed?.projectFile;
  const oldStem = stem(
    oldProject?.name ?? retained?.entry ?? baseName(project.name ?? project.schematic.title),
  );
  const defaultEntry = oldProject?.name ?? oldStem + '.kicad_pro';
  const entry = entryName ?? defaultEntry;
  if (!safeName(entry) || !ext(entry, '.kicad_pro'))
    fail('the save destination must be a .kicad_pro filename.');
  // Default and explicit names can refer to exactly the same destination. A
  // Workbench requests the explicit name after Core creates its default Source.
  const sameDestination = [...(entries?.values() ?? [])].find((bundle) => bundle.entry === entry);
  if (sameDestination) return sameDestination;
  const targetStem = stem(entry);
  const projectRenamed = targetStem !== oldStem;
  const rename = (name: string) => {
    if (name.toLowerCase() === (oldStem + '.kicad_pro').toLowerCase()) return entry;
    for (const suffix of ['.kicad_sch', '.kicad_pcb', '.kicad_dru', '.kicad_sym'])
      if (name.toLowerCase() === (oldStem + suffix).toLowerCase()) return targetStem + suffix;
    if (name.toLowerCase() === `symbols/${oldStem}.kicad_sym`.toLowerCase())
      return `symbols/${targetStem}.kicad_sym`;
    for (const directory of ['', 'footprints/']) {
      const libraryPrefix = directory + oldStem + '.pretty/';
      if (name.toLowerCase().startsWith(libraryPrefix.toLowerCase()))
        return directory + targetStem + '.pretty/' + name.slice(libraryPrefix.length);
    }
    return name;
  };
  const renameLibraryTable = (file: KiCadProjectFile) => {
    if (!projectRenamed || !['fp-lib-table', 'sym-lib-table'].includes(file.name))
      return file.source;
    const paths = new Map(
      [
        ['', '.pretty'],
        ['', '.kicad_sym'],
        ['footprints/', '.pretty'],
        ['symbols/', '.kicad_sym'],
      ].flatMap(([directory, suffix]) => {
        const before = '${KIPRJMOD}/' + directory + oldStem + suffix;
        const after = quote('${KIPRJMOD}/' + directory + targetStem + suffix);
        return [
          [quote(before), after],
          [before, after],
        ];
      }),
    );
    return file.source.replace(/(\(uri\s+)("(?:[^"\\]|\\.)*"|[^\s()]+)/g, (match, prefix, uri) =>
      paths.has(uri) ? prefix + paths.get(uri) : match,
    );
  };
  const nativeSchematicNames = new Set(parsed?.schematics.map((item) => item.file.name) ?? []);
  const files = (retained?.files ?? [])
    .filter(
      (file) =>
        !nativeSchematicNames.has(file.name) &&
        !ext(file.name, '.kicad_pcb') &&
        !ext(file.name, '.kicad_pro'),
    )
    .map((file) => ({ ...file, name: rename(file.name), source: renameLibraryTable(file) }));
  let settings = oldProject?.source ?? newSettings(entry.split('/').at(-1)!);
  const data = projectSettings(settings);
  let settingsChanged = false;
  const existingName = nativeProjectName(data);
  const name = project.name ?? project.schematic.title;
  const filenameName = stem(oldProject?.name ?? entry)
    .split('/')
    .at(-1);
  if (
    existingName !== name &&
    (existingName !== undefined || (!oldProject && name !== filenameName))
  ) {
    data.text_variables = {
      ...(data.text_variables as Record<string, string> | undefined),
      [PROJECT_NAME_VARIABLE]: name,
    };
    settingsChanged = true;
  }
  if (oldProject && rename(oldProject.name) !== oldProject.name) {
    data.meta = {
      ...(data.meta && typeof data.meta === 'object' && !Array.isArray(data.meta) ? data.meta : {}),
      filename: entry.split('/').at(-1)!,
    };
    settingsChanged = true;
  }
  const existingModels = referencedModels(data);
  if (JSON.stringify(existingModels ?? []) !== JSON.stringify(project.simulationModels ?? [])) {
    const variables = { ...(data.text_variables as Record<string, string> | undefined) };
    if (project.simulationModels?.length)
      variables[MODEL_VARIABLE] = JSON.stringify(
        project.simulationModels.map((model) => model.file),
      );
    else delete variables[MODEL_VARIABLE];
    data.text_variables = variables;
    settingsChanged = true;
  }
  const existingModelCad = nativeModelCad(data),
    modelCad = modelCadFromProject(project);
  if (JSON.stringify(existingModelCad ?? null) !== JSON.stringify(modelCad)) {
    const variables = { ...(data.text_variables as Record<string, string> | undefined) };
    if (modelCad) variables[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify(modelCad);
    else delete variables[MODEL_CAD_NATIVE_VARIABLE];
    data.text_variables = variables;
    settingsChanged = true;
  }
  if (settingsChanged) settings = JSON.stringify(data, null, 2) + '\n';
  files.unshift({ name: entry, source: settings });
  const used = new Set(files.map((file) => file.name.toLowerCase()));
  const unique = (preferred: string) => {
    let name = preferred,
      index = 2;
    while (used.has(name.toLowerCase()))
      name = preferred.replace(/\.kicad_sch$/i, `-${index++}.kicad_sch`);
    used.add(name.toLowerCase());
    return name;
  };
  const renamedSchematics: {
    schematic: Circuit;
    projectName: string;
    original: KiCadProjectFile;
    source: string;
  }[] = [];
  const cleanSchematics: {
    schematic: Circuit;
    original: KiCadProjectFile;
    root: SExpr;
    projectName: string;
  }[] = [];
  for (const [index, schematic] of projectSchematics(project).entries()) {
    const previous = parsed?.schematics.find((item) => item.circuit.id === schematic.id);
    const name = unique(
      previous
        ? rename(previous.file.name)
        : index === 0
          ? targetStem + '.kicad_sch'
          : baseName(schematic.title) + '.kicad_sch',
    );
    const unchanged =
      previous &&
      (previous.fingerprint ??= nativeSchematicFingerprint(
        { ...project, schematic: previous.circuit, additionalSchematics: undefined },
        previous.circuit,
      )) === nativeSchematicFingerprint(project, schematic);
    if (unchanged)
      cleanSchematics.push({
        schematic,
        original: previous.file,
        root: previous.root,
        projectName: targetStem.split('/').at(-1)!,
      });
    let source: string | SExpr = unchanged
      ? previous.file.source
      : exportKiCadSchematicTree(project, schematic.id);
    if (previous && !unchanged) {
      const paper = child(previous.root, 'paper');
      if (paper) {
        const root = source as SExpr;
        root.push(paper);
      }
    }
    if (!unchanged || projectRenamed) {
      const projectName = targetStem.split('/').at(-1)!;
      // Layout edits retain this exact sheet and its original native packet.
      // Changing the owning destination alone must not reparse and rewrite the
      // same schematic on every new board revision.
      const reusable = unchanged && isOwnedProject(project) && isOwnedProjectNode(previous.file);
      const cached = reusable
        ? ownedRenamedSchematicSources.get(schematic)?.get(projectName)
        : undefined;
      if (cached && cached.original === previous?.file) source = cached.source;
      else {
        source = schematicProjectInstances(
          source,
          previous?.root,
          schematic,
          projectName,
          isOwnedProject(project),
        );
        if (reusable)
          renamedSchematics.push({ schematic, projectName, original: previous.file, source });
      }
    }
    files.push({ name, source: source as string });
  }
  let boardSource: string | undefined;
  let encodeBoardSource: (() => string) | undefined;
  if (project.pcb) {
    const previous = retained?.files.find((file) => ext(file.name, '.kicad_pcb'));
    boardSource = isOwnedProject(project) ? ownedNativeBoardSources.get(project) : undefined;
    if (boardSource === undefined) {
      const originalSchematic = parsed?.schematics[0]?.circuit ?? project.schematic;
      const currentBoardSource = serializePCB(project.pcb, project.schematic);
      const unchanged =
        parsed?.board &&
        (previous?.source === currentBoardSource ||
          (parsed.boardSource ??= serializePCB(parsed.board, originalSchematic)) ===
            currentBoardSource);
      boardSource = previous && unchanged ? previous.source : currentBoardSource;
      if (previous && unchanged)
        seedCleanBoardSource(
          previous,
          currentBoardSource,
          JSON.stringify(parsed?.board?.layers) === JSON.stringify(project.pcb.layers),
          originalSchematic.id,
          project,
        );
      if (previous && !unchanged)
        boardSource = mergeBoardSource(
          previous,
          boardSource,
          JSON.stringify(parsed?.board?.layers) === JSON.stringify(project.pcb.layers),
          originalSchematic.id,
          project.schematic,
          project.pcb,
          (encode) => {
            encodeBoardSource = encode;
          },
        );
    }
    files.push({
      name: previous ? rename(previous.name) : targetStem + '.kicad_pcb',
      source: boardSource,
    });
  }
  // Match before validating, so unchanged owned packets can reuse their local
  // checks. Detach all new wrappers first; caller freezing never certifies them.
  // Semantic acceptance still follows below for the complete candidate bundle.
  const owned = isOwnedProject(project);
  const previous = owned
    ? new Map(retained?.files.map((file) => [rename(file.name), file]))
    : undefined;
  const renamedFiles: { original: KiCadProjectFile; file: KiCadProjectFile }[] = [];
  const bundle = owned
    ? ownProjectData({
        entry,
        files: files.map((file) => {
          const original = previous?.get(file.name);
          if (!original || original.source !== file.source || original.encoding !== file.encoding)
            return file;
          if (original.name === file.name) return original;
          if (!isOwnedProjectNode(original)) return file;
          const cached = ownedRenamedNativeFiles.get(original)?.get(file.name);
          if (cached) return cached;
          const renamed = ownProjectData(file);
          renamedFiles.push({ original, file: renamed });
          return renamed;
        }),
      })
    : { entry, files };
  validateKiCadProjectFiles(bundle);
  if (owned && encodeBoardSource) {
    const file = bundle.files.find((file) => ext(file.name, '.kicad_pcb'));
    if (file) rememberNativeSourceJson(file, encodeBoardSource);
  }
  if (owned) {
    for (const { schematic, original, root, projectName } of cleanSchematics)
      seedCleanSchematicSource(project, schematic, original, root, projectName);
    for (const { original, file } of renamedFiles) {
      const destinations = ownedRenamedNativeFiles.get(original) ?? new Map();
      destinations.set(file.name, file);
      while (destinations.size > 3) destinations.delete(destinations.keys().next().value!);
      ownedRenamedNativeFiles.set(original, destinations);
    }
    if (boardSource !== undefined) ownedNativeBoardSources.set(project, boardSource);
    for (const { schematic, projectName, original, source } of renamedSchematics) {
      const destinations = ownedRenamedSchematicSources.get(schematic) ?? new Map();
      destinations.set(projectName, { original, source });
      while (destinations.size > 3) destinations.delete(destinations.keys().next().value!);
      ownedRenamedSchematicSources.set(schematic, destinations);
    }
    const nextEntries = entries ?? new Map<string | undefined, KiCadProjectFiles>();
    nextEntries.set(entryName, bundle);
    // Native Source, the current destination and Save as reuse the same owned
    // snapshot. Keep only a few destinations rather than retaining every name.
    while (nextEntries.size > 3) nextEntries.delete(nextEntries.keys().next().value);
    if (!entries) ownedNativeFiles.set(project, nextEntries);
    return bundle;
  }
  return bundle;
}

export function replaceNativeProjectFile(project: Project, name: string, source: string): Project {
  const bundle = projectNativeFiles(project);
  const file = bundle.files.find((item) => item.name === name);
  if (!file) return fail('the selected file is no longer in this project.');
  if (file.source === source) return project;
  return projectWithNativeFiles(project, {
    ...bundle,
    files: bundle.files.map((item) => (item === file ? { ...item, source } : item)),
  });
}

export function projectPCBDesignRules(files: KiCadProjectFiles | undefined) {
  const source = files?.files.find((file) => ext(file.name, '.kicad_pro'))?.source;
  return resolvePCBDesignRules(
    loadKiCadPCBDesignRuleLimits(source, workbenchPCBDesignRules),
    workbenchPCBDesignRules,
  );
}

/** Keep live geometry and sibling sources intact when changing native board minima. */
export function withNativePCBDesignRuleLimits(
  project: Project,
  thresholds: Partial<PCBDesignRuleThresholds>,
): Project {
  const current = projectPCBDesignRules(project.nativeFiles);
  const changed = Object.fromEntries(
    pcbDesignRuleLimitKeys
      .filter((key) => thresholds[key] !== undefined && thresholds[key] !== current[key])
      .map((key) => [key, thresholds[key]]),
  );
  if (!Object.keys(changed).length) return project;
  const bundle = project.nativeFiles?.files.some((file) => ext(file.name, '.kicad_pro'))
    ? project.nativeFiles
    : projectNativeFilesSnapshot(project);
  const file = bundle.files.find((item) => ext(item.name, '.kicad_pro'))!;
  const settings = setKiCadPCBDesignRuleLimits(projectSettings(file.source), changed);
  const source = JSON.stringify(settings, null, 2) + '\n';
  return {
    ...project,
    nativeFiles: {
      ...bundle,
      files: bundle.files.map((item) => (item === file ? { ...item, source } : item)),
    },
  };
}

/** Explicit name edits persist in project settings without renaming any native file. */
export function withNativeProjectName(project: Project): Project {
  const bundle = projectNativeFiles(project);
  const file = bundle.files.find((file) => ext(file.name, '.kicad_pro'))!;
  const settings = projectSettings(file.source);
  const name = project.name ?? project.schematic.title;
  if (nativeProjectName(settings) === name) return project;
  settings.text_variables = {
    ...(settings.text_variables as Record<string, string> | undefined),
    [PROJECT_NAME_VARIABLE]: name,
  };
  return {
    ...project,
    nativeFiles: {
      ...bundle,
      files: bundle.files.map((item) =>
        item === file ? { ...item, source: JSON.stringify(settings, null, 2) + '\n' } : item,
      ),
    },
  };
}

/** Native Source owns explicit names; ordinary file edits retain independent metadata. */
export function projectWithNativeFiles(project: Project, bundle: KiCadProjectFiles): Project {
  const next = projectFromNativeFiles(bundle);
  const explicitName = (files: KiCadProjectFiles | undefined) => {
    const file = files?.files.find((file) => ext(file.name, '.kicad_pro'));
    return file ? nativeProjectName(projectSettings(file.source)) : undefined;
  };
  return {
    ...next,
    id: project.id,
    name:
      explicitName(bundle) !== undefined || explicitName(project.nativeFiles) !== undefined
        ? next.name
        : (project.name ?? project.schematic.title),
    extensions: nativeModelCadExtensions(project.extensions, next.extensions),
  };
}
