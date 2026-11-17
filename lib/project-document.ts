import { materializedCircuitTree, type Part, type Point } from './circuit';
import { child, children, num, quote, val, type SExpr } from './sexpr';
import { schematicTexts } from './schematic-text';
import { KICAD_SCHEMATIC_VERSION } from './kicad-version';
import type { Project } from './project';
import { isOwnedCircuit, isOwnedProjectNode, ownProjectData } from './immutable-project';
import { singleSimulationParameter } from './library';
import {
  groupProjectDocument,
  ungroupProjectDocument,
  type ProjectDocument,
} from './project-objects';
export type { ProjectDocument } from './project-objects';

type NativeDetails = { kicad?: SExpr[] };
type Located = NativeDetails & { id: string; position: Point };
/** Private normalized mapping content, never accepted as a project file. */
export type EditorDocument = {
  format: 'openpe';
  version: 1;
  units: 'mm';
  project: { id: string; name: string };
  schematic: {
    id: string;
    name: string;
    components?: (Located & {
      symbol: string;
      libraryId?: string;
      reference: string;
      value: string;
      simulation?: { valueFormat: string };
      rotation?: number;
      unit?: number;
      mirror?: 'x' | 'y';
      fields?: Record<string, string>;
      fieldLayout?: Record<string, SExpr[]>;
    })[];
    wires?: (NativeDetails & { id: string; start: Point; end: Point })[];
    junctions?: Located[];
    noConnects?: Located[];
    labels?: (Located & {
      text: string;
      rotation?: number;
      scope?: 'local' | 'global';
      shape?: 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive';
    })[];
    texts?: {
      id: string;
      text: string;
      position: Point;
      size: number;
      anchor: 'start' | 'middle' | 'end';
      vertical: 'top' | 'middle' | 'bottom';
      excludeFromSimulation?: boolean;
      color?: [number, number, number, number];
      bold?: boolean;
      italic?: boolean;
      href?: string;
    }[];
    kicad?: SExpr[];
  };
  pcb?: Project['pcb'];
  libraries?: { symbols: Project['schematic']['libraries'] };
  extensions?: Project['extensions'];
  simulationModels?: Project['simulationModels'];
  nativeFiles?: Project['nativeFiles'];
  additionalSchematics?: {
    schematic: EditorDocument['schematic'];
    libraries?: EditorDocument['libraries'];
  }[];
};

const details = (node: SExpr, excluded: string[]): SExpr[] => {
  const offset =
    node[0] === 'property' ? 3 : ['label', 'global_label'].includes(String(node[0])) ? 2 : 1;
  return node.slice(offset).flatMap((v): SExpr[] => {
    if (Array.isArray(v)) return excluded.includes(String(v[0])) ? [] : [v];
    if (node[0] === 'property' && v === 'hide') return [['hide', 'yes']];
    throw new Error(
      `Unsupported KiCad metadata atom in ${node[0]}. Remove the unsupported attribute before importing.`,
    );
  });
};
const position = (node: SExpr): Point => ({
  x: num(child(node, 'at')),
  y: num(child(node, 'at'), 2),
});
const located = (node: SExpr, excluded: string[] = []): Located => ({
  id: val(child(node, 'uuid')),
  position: position(node),
  kicad: details(node, ['uuid', 'at', ...excluded]),
});

// These are instance defaults, never library definitions or arbitrary design data.
// Match the complete node so unknown attributes and duplicate keys stay intact.
const componentDefaults: SExpr[] = [
  ['body_style', '1'],
  ['exclude_from_sim', 'no'],
  ['in_bom', 'yes'],
  ['on_board', 'yes'],
  ['in_pos_files', 'yes'],
  ['dnp', 'no'],
];
const fieldDefaults: SExpr[] = [
  ['show_name', 'no'],
  ['do_not_autoplace', 'no'],
];
const wireDefaults: SExpr[] = [['stroke', ['width', '0'], ['type', 'default']]];
const junctionDefaults: SExpr[] = [
  ['diameter', '0'],
  ['color', '0', '0', '0', '0'],
];
function omitNativeDefaults(nodes: SExpr[] | undefined, defaults: SExpr[]): SExpr[] {
  const counts = new Map<string, number>();
  for (const node of nodes ?? []) {
    const key = String(node[0]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const signatures = new Set(defaults.map((node) => JSON.stringify(node)));
  return (nodes ?? []).filter(
    (node) => counts.get(String(node[0])) !== 1 || !signatures.has(JSON.stringify(node)),
  );
}
const defaultFieldLayout = (p: Point): SExpr[] => [
  ['at', String(p.x), String(p.y), '0'],
  ['effects', ['font', ['size', '1.27', '1.27']], 'hide'],
];
function isDefaultFieldLayout(layout: SExpr[], p: Point): boolean {
  const signature = JSON.stringify(layout);
  return (
    signature === JSON.stringify(defaultFieldLayout(p)) ||
    signature ===
      JSON.stringify([
        ['at', String(p.x), String(p.y), '0'],
        ['hide', 'yes'],
        ['effects', ['font', ['size', '1.27', '1.27']]],
      ])
  );
}

// File data is deliberately separate from the editor's KiCad-compatible working model.
// Materialize current edits first: stale raw positions/values must not enter the file.
const ownedSheetDocuments = new WeakMap<
  Project['schematic'],
  Pick<EditorDocument, 'schematic' | 'libraries'>
>();
type EditorComponent = NonNullable<EditorDocument['schematic']['components']>[number];
const ownedComponentDocuments = new WeakMap<Part, { library: SExpr; component: EditorComponent }>();
const ownedDrawingDocuments = new WeakMap<SExpr, NativeDetails>();
function freezeSheetDocument(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeSheetDocument(child);
  Object.freeze(value);
}
function projectDocumentFields(
  project: Project,
  reuseOwnedGeometry: boolean,
  sheet: Pick<EditorDocument, 'schematic' | 'libraries'>,
): EditorDocument {
  return {
    format: 'openpe',
    version: 1,
    units: 'mm',
    project: { id: project.id, name: project.name ?? project.schematic.title },
    schematic: sheet.schematic,
    ...(project.pcb ? { pcb: project.pcb } : {}),
    ...(sheet.libraries ? { libraries: sheet.libraries } : {}),
    ...(Object.keys(project.extensions).length ? { extensions: project.extensions } : {}),
    ...(project.nativeFiles
      ? {
          nativeFiles: reuseOwnedGeometry
            ? project.nativeFiles
            : structuredClone(project.nativeFiles),
        }
      : {}),
    ...(project.simulationModels?.length
      ? {
          simulationModels: reuseOwnedGeometry
            ? project.simulationModels
            : structuredClone(project.simulationModels),
        }
      : {}),
    ...(project.additionalSchematics?.length
      ? {
          additionalSchematics: project.additionalSchematics.map((schematic) => {
            const file = toEditorDocument(
              { ...project, schematic, additionalSchematics: undefined, pcb: null },
              reuseOwnedGeometry,
            );
            return { schematic: file.schematic, libraries: file.libraries };
          }),
        }
      : {}),
  };
}

function documentTexts(root: SExpr): EditorDocument['schematic']['texts'] {
  // Validate every text before looking up participation metadata, matching the
  // original mapping's error order. Repeated UUIDs retain find's first match.
  const texts = schematicTexts(root);
  if (!texts.length) return [];
  const byId = new Map<string, SExpr>();
  for (const node of children(root, 'text')) {
    const id = val(child(node, 'uuid'));
    if (!byId.has(id)) byId.set(id, node);
  }
  return texts.map(({ x, y, vertical, ...text }) => {
    const excluded = child(byId.get(text.id)!, 'exclude_from_sim');
    return {
      ...text,
      position: { x, y },
      vertical: vertical as 'top' | 'middle' | 'bottom',
      ...(excluded ? { excludeFromSimulation: val(excluded) === 'yes' } : {}),
    };
  });
}

function toEditorDocument(project: Project, reuseOwnedGeometry = false): EditorDocument {
  const reusable = reuseOwnedGeometry && isOwnedCircuit(project.schematic);
  const cached = reusable ? ownedSheetDocuments.get(project.schematic) : undefined;
  if (cached) return projectDocumentFields(project, reuseOwnedGeometry, cached);
  const root = materializedCircuitTree(project.schematic);
  const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
  const componentOwners = new Map<EditorComponent, { part: Part; library: SExpr }>();
  const drawingOwners = new Map<NativeDetails, SExpr>();
  const drawing = <T extends NativeDetails>(node: SExpr, create: () => T): T => {
    const owned = reusable && isOwnedProjectNode(node);
    const cached = owned ? ownedDrawingDocuments.get(node) : undefined;
    if (cached) return cached as T;
    const value = create();
    if (owned) drawingOwners.set(value, node);
    return value;
  };
  const retainDrawings = <T extends NativeDetails>(items: T[] | undefined): T[] | undefined =>
    items?.map((item) => {
      const node = drawingOwners.get(item);
      if (!node) return item;
      // Defaults have been normalized below. Cache only exact owned native
      // records, independently of the sheet's other geometry and pin groups.
      const owned = ownProjectData(item);
      ownedDrawingDocuments.set(node, owned);
      return owned;
    });
  for (const component of children(root, 'symbol')) {
    const names = children(component, 'property').map((p) => val(p));
    if (new Set(names).size !== names.length)
      throw new Error(
        'Duplicate KiCad component fields are not supported. Give each field a unique name before importing.',
      );
  }
  const title = child(root, 'title_block');
  const metadata = details(root, [
    'paper',
    'version',
    'generator',
    'generator_version',
    'uuid',
    'title_block',
    'lib_symbols',
    'symbol',
    'wire',
    'junction',
    'no_connect',
    'label',
    'global_label',
    'text',
  ]);
  if (title && title.length > 2) {
    const rest = details(title, ['title']);
    if (rest.length) metadata.push(['title_block', ...rest]);
  }
  const document: EditorDocument = {
    format: 'openpe',
    version: 1,
    units: 'mm',
    project: { id: project.id, name: project.name ?? project.schematic.title },
    schematic: {
      id: project.schematic.id,
      name: project.schematic.title,
      components: children(root, 'symbol').map((node) => {
        const part = parts.get(val(child(node, 'uuid')));
        const library = part && project.schematic.libraries[part.libId];
        const cachedComponent = reusable && part ? ownedComponentDocuments.get(part) : undefined;
        if (cachedComponent && cachedComponent.library === library)
          return cachedComponent.component;
        const component: EditorComponent = {
          ...located(node, ['lib_id', 'lib_name', 'unit', 'mirror', 'property', 'instances']),
          symbol: val(child(node, 'lib_name') ?? child(node, 'lib_id')),
          ...(child(node, 'lib_name') ? { libraryId: val(child(node, 'lib_id')) } : {}),
          reference: val(
            children(node, 'property').find((p) => val(p) === 'Reference'),
            2,
          ),
          value: val(
            children(node, 'property').find((p) => val(p) === 'Value'),
            2,
          ),
          rotation: num(child(node, 'at'), 3),
          unit: num(child(node, 'unit')) || 1,
          ...(child(node, 'mirror') ? { mirror: val(child(node, 'mirror')) as 'x' | 'y' } : {}),
          fields: Object.fromEntries(
            children(node, 'property')
              .filter((p) => !['Reference', 'Value'].includes(val(p)))
              .map((p) => [val(p), val(p, 2)]),
          ),
          fieldLayout: Object.fromEntries(
            children(node, 'property').map((p) => [val(p), details(p, [])]),
          ),
        };
        if (reusable && part && library) componentOwners.set(component, { part, library });
        return component;
      }),
      wires: children(root, 'wire').map((node) =>
        drawing(node, () => {
          const pts = children(child(node, 'pts')!, 'xy');
          return {
            id: val(child(node, 'uuid')),
            start: { x: num(pts[0]), y: num(pts[0], 2) },
            end: { x: num(pts[1]), y: num(pts[1], 2) },
            kicad: details(node, ['uuid', 'pts']),
          };
        }),
      ),
      junctions: children(root, 'junction').map((node) => drawing(node, () => located(node))),
      noConnects: children(root, 'no_connect').map((node) => drawing(node, () => located(node))),
      labels: [...children(root, 'label'), ...children(root, 'global_label')].map((node) =>
        drawing(node, () => ({
          ...located(node, ['shape']),
          text: val(node),
          rotation: num(child(node, 'at'), 3),
          scope: node[0] === 'global_label' ? ('global' as const) : ('local' as const),
          ...(node[0] === 'global_label'
            ? {
                shape: val(child(node, 'shape')) as NonNullable<
                  EditorDocument['schematic']['labels']
                >[number]['shape'],
              }
            : {}),
        })),
      ),
      texts: documentTexts(root),
      kicad: metadata,
    },
    pcb: project.pcb,
    libraries: { symbols: project.schematic.libraries },
    extensions: project.extensions,
    ...(project.nativeFiles
      ? {
          nativeFiles: reuseOwnedGeometry
            ? project.nativeFiles
            : structuredClone(project.nativeFiles),
        }
      : {}),
    ...(project.simulationModels?.length
      ? {
          simulationModels: reuseOwnedGeometry
            ? project.simulationModels
            : structuredClone(project.simulationModels),
        }
      : {}),
    ...(project.additionalSchematics?.length
      ? {
          additionalSchematics: project.additionalSchematics.map((schematic) => {
            const file = toEditorDocument(
              {
                ...project,
                schematic,
                additionalSchematics: undefined,
                pcb: null,
              },
              reuseOwnedGeometry,
            );
            return { schematic: file.schematic, libraries: file.libraries };
          }),
        }
      : {}),
  };
  // Omit only documented defaults, never arbitrary empty values in design data.
  const schematic = document.schematic;
  for (const component of schematic.components ?? []) {
    if (isOwnedProjectNode(component)) continue;
    component.kicad = omitNativeDefaults(component.kicad, componentDefaults);
    for (const [name, layout] of Object.entries(component.fieldLayout ?? {})) {
      const compact = omitNativeDefaults(layout, fieldDefaults);
      if (isDefaultFieldLayout(compact, component.position)) delete component.fieldLayout![name];
      else component.fieldLayout![name] = compact;
    }
  }
  for (const wire of schematic.wires ?? [])
    if (!isOwnedProjectNode(wire)) wire.kicad = omitNativeDefaults(wire.kicad, wireDefaults);
  for (const junction of schematic.junctions ?? [])
    if (!isOwnedProjectNode(junction))
      junction.kicad = omitNativeDefaults(junction.kicad, junctionDefaults);
  for (const item of [
    ...(schematic.components ?? []),
    ...(schematic.wires ?? []),
    ...(schematic.junctions ?? []),
    ...(schematic.noConnects ?? []),
    ...(schematic.labels ?? []),
  ]) {
    if (isOwnedProjectNode(item)) continue;
    if (!item.kicad?.length) delete item.kicad;
  }
  for (const component of schematic.components ?? []) {
    if (isOwnedProjectNode(component)) continue;
    // Store the electrical value once. The private working model retains KiCad's
    // inverse Value -> Sim.Params link; native export materializes that model.
    const params = component.fields?.['Sim.Params'];
    if (component.value === '${SIM.PARAMS}' && params) {
      const parameter = singleSimulationParameter(params);
      component.value = parameter?.value ?? params;
      component.simulation = {
        valueFormat: parameter ? `${parameter.prefix}\${VALUE}${parameter.suffix}` : '${VALUE}',
      };
      delete component.fields!['Sim.Params'];
    }
    if (component.rotation === 0) delete component.rotation;
    if (component.unit === 1) delete component.unit;
    if (!Object.keys(component.fields ?? {}).length) delete component.fields;
    // Field content determines ordering, including the derived Sim.Params field.
    // Omitting a layout must not shuffle either map on subsequent saves.
    component.fieldLayout = Object.fromEntries(
      [
        ...new Set([
          'Reference',
          'Value',
          ...Object.keys(component.fields ?? {}),
          ...(component.simulation ? ['Sim.Params'] : []),
          ...Object.keys(component.fieldLayout ?? {}),
        ]),
      ]
        .filter((name) => Object.hasOwn(component.fieldLayout ?? {}, name))
        .map((name) => [name, component.fieldLayout![name]]),
    );
    if (!Object.keys(component.fieldLayout ?? {}).length) delete component.fieldLayout;
  }
  if (reusable && schematic.components)
    schematic.components = schematic.components.map((component) => {
      const owner = componentOwners.get(component);
      if (!owner) return component;
      const detached = ownProjectData(component);
      ownedComponentDocuments.set(owner.part, { library: owner.library, component: detached });
      return detached;
    });
  for (const label of schematic.labels ?? []) {
    if (isOwnedProjectNode(label)) continue;
    if (label.rotation === 0) delete label.rotation;
    if (label.scope === 'local') delete label.scope;
  }
  if (reusable) {
    schematic.wires = retainDrawings(schematic.wires);
    schematic.junctions = retainDrawings(schematic.junctions);
    schematic.noConnects = retainDrawings(schematic.noConnects);
    schematic.labels = retainDrawings(schematic.labels);
  }
  for (const key of [
    'components',
    'wires',
    'junctions',
    'noConnects',
    'labels',
    'texts',
    'kicad',
  ] as const)
    if (!schematic[key]?.length) delete schematic[key];
  if (!Object.keys(document.libraries?.symbols ?? {}).length) delete document.libraries;
  if (document.pcb === null) delete document.pcb;
  if (!Object.keys(document.extensions ?? {}).length) delete document.extensions;
  if (reusable) {
    freezeSheetDocument(document.schematic);
    freezeSheetDocument(document.libraries);
    ownedSheetDocuments.set(project.schematic, {
      schematic: document.schematic,
      ...(document.libraries ? { libraries: document.libraries } : {}),
    });
  }
  return document;
}

function fromEditorDocument(document: EditorDocument): Project {
  const d = document.schematic;
  const at = (p: Point, rotation?: number): SExpr => [
    'at',
    String(p.x),
    String(p.y),
    ...(rotation === undefined ? [] : [String(rotation)]),
  ];
  const raw = (kind: string, p: Located): SExpr => [
    kind,
    at(p.position),
    ['uuid', quote(p.id)],
    ...(p.kicad ?? []),
  ];
  const original: SExpr = [
    'kicad_sch',
    ['version', KICAD_SCHEMATIC_VERSION],
    ['generator', '"openpe"'],
    ['uuid', quote(d.id)],
    ...structuredClone(d.kicad ?? []),
  ];
  let title = child(original, 'title_block');
  if (!title) {
    title = ['title_block'];
    original.push(title);
  }
  title.push(['title', quote(d.name)]);
  for (const text of d.texts ?? []) {
    const justify = [
      text.anchor === 'start' ? 'left' : text.anchor === 'end' ? 'right' : '',
      text.vertical === 'middle' ? '' : text.vertical,
    ].filter(Boolean);
    original.push([
      'text',
      quote(text.text),
      at(text.position, 0),
      ['uuid', quote(text.id)],
      [
        'effects',
        [
          'font',
          ['size', String(text.size), String(text.size)],
          ...(text.color ? [['color', ...text.color.map(String)] as SExpr] : []),
          ...(text.bold ? ['bold'] : []),
          ...(text.italic ? ['italic'] : []),
        ],
        ...(justify.length ? [['justify', ...justify] as SExpr] : []),
        ...(text.href ? [['href', quote(text.href)] as SExpr] : []),
      ],
      ...(text.excludeFromSimulation === undefined
        ? []
        : [['exclude_from_sim', text.excludeFromSimulation ? 'yes' : 'no'] as SExpr]),
    ]);
  }
  return {
    format: 'openpe',
    version: 1,
    units: 'mm',
    id: document.project.id,
    name: document.project.name,
    schematic: {
      id: d.id,
      title: d.name,
      original,
      libraries: structuredClone(document.libraries?.symbols ?? {}),
      parts: (d.components ?? []).map((p) => {
        const value = p.simulation ? '${SIM.PARAMS}' : p.value;
        const fields = { ...p.fields };
        if (p.simulation)
          fields['Sim.Params'] = p.simulation.valueFormat.replace('${VALUE}', () => p.value);
        const properties = { Reference: p.reference, Value: value, ...fields };
        // Layout is optional and must not control field order: derived hidden
        // layouts would otherwise move fields on the next load/save cycle.
        const propertyNames = Object.keys(properties);
        return {
          id: p.id,
          libId: p.symbol,
          ref: p.reference,
          value,
          ...p.position,
          rotation: p.rotation ?? 0,
          unit: p.unit ?? 1,
          ...(p.mirror ? { mirror: p.mirror } : {}),
          fields,
          raw: [
            'symbol',
            ['lib_id', quote(p.libraryId ?? p.symbol)],
            ...(p.libraryId === undefined ? [] : [['lib_name', quote(p.symbol)] as SExpr]),
            at(p.position, p.rotation ?? 0),
            ['unit', String(p.unit ?? 1)],
            ...(p.mirror ? [['mirror', p.mirror] as SExpr] : []),
            ['uuid', quote(p.id)],
            ...structuredClone(p.kicad ?? []),
            [
              'instances',
              [
                'project',
                quote(d.name.replace(/[^\p{L}\p{N}_-]/gu, '_')),
                [
                  'path',
                  quote('/' + d.id),
                  ['reference', quote(p.reference)],
                  ['unit', String(p.unit ?? 1)],
                ],
              ],
            ],
            ...propertyNames.map((name): SExpr => [
              'property',
              quote(name),
              quote(properties[name as keyof typeof properties]),
              ...structuredClone(p.fieldLayout?.[name] ?? defaultFieldLayout(p.position)),
            ]),
          ],
        };
      }),
      wires: (d.wires ?? []).map((w) => ({
        id: w.id,
        a: w.start,
        b: w.end,
        raw: [
          'wire',
          [
            'pts',
            ['xy', String(w.start.x), String(w.start.y)],
            ['xy', String(w.end.x), String(w.end.y)],
          ],
          ['uuid', quote(w.id)],
          ...(w.kicad ?? []),
        ],
      })),
      junctions: (d.junctions ?? []).map((p) => ({
        id: p.id,
        ...p.position,
        raw: raw('junction', p),
      })),
      noConnects: (d.noConnects ?? []).map((p) => ({
        id: p.id,
        ...p.position,
        raw: raw('no_connect', p),
      })),
      labels: (d.labels ?? []).map((p) => ({
        id: p.id,
        ...p.position,
        text: p.text,
        rotation: p.rotation ?? 0,
        ...(p.scope === 'global' ? { scope: 'global' as const, shape: p.shape } : {}),
        raw: [
          p.scope === 'global' ? 'global_label' : 'label',
          quote(p.text),
          at(p.position, p.rotation ?? 0),
          ['uuid', quote(p.id)],
          ...(p.shape ? [['shape', p.shape] as SExpr] : []),
          ...(p.kicad ?? []),
        ],
      })),
    },
    pcb: structuredClone(document.pcb ?? null),
    extensions: structuredClone(document.extensions ?? {}),
    ...(document.nativeFiles ? { nativeFiles: structuredClone(document.nativeFiles) } : {}),
    ...(document.simulationModels?.length
      ? { simulationModels: structuredClone(document.simulationModels) }
      : {}),
    ...(document.additionalSchematics?.length
      ? {
          additionalSchematics: document.additionalSchematics.map(
            (file) =>
              fromEditorDocument({
                ...document,
                schematic: file.schematic,
                libraries: file.libraries,
                additionalSchematics: undefined,
                pcb: null,
              }).schematic,
          ),
        }
      : {}),
  };
}

/** The public file groups design objects; the editor retains its native working topology. */
export function toProjectDocument(project: Project, reuseOwnedGeometry = false): ProjectDocument {
  const document = groupProjectDocument(
    toEditorDocument(project, reuseOwnedGeometry),
    project,
    reuseOwnedGeometry,
  );
  // Native metadata/libraries may still refer to the materialized immutable tree.
  // Only the private serializer may share them; public callers receive a fully
  // independent mutable document, including nested S-expression arrays.
  return reuseOwnedGeometry ? document : structuredClone(document);
}
export function fromProjectDocument(document: ProjectDocument): Project {
  return fromEditorDocument(ungroupProjectDocument(document));
}
