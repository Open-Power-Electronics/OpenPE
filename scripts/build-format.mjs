import Ajv from 'ajv';
import { loadDatasheetCatalog, loadSupplementalDatasheets } from './example-datasheets.mjs';
import standalone from 'ajv/dist/standalone/index.js';
import { build as compile } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ownedValidatorSource } from './owned-validator-source.mjs';
import { optimizeStaticMaxLength } from './ajv-length-guard.mjs';
import { pruneValidatorSchemaSource } from './prune-validator-schema-source.mjs';
import { writeGeneratedFile } from './write-generated-file.mjs';

// Schema/identity validation only: runtime bundles need no PDFs or network.
await loadDatasheetCatalog();
await loadSupplementalDatasheets();
await import('./build-manufacturing-font.mjs');

// Service bundles share the project boundary instead of embedding another copy
// of both validators and serializers in every consumer.
const sharedProject = {
  name: 'shared-project-format',
  setup(builder) {
    builder.onResolve({ filter: /^(?:\.\/|\.\.\/).*project(?:\.ts)?$/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path).replace(/\.ts$/, '');
      if (resolved === path.resolve('lib/project'))
        return { path: './project-format.mjs', external: true };
    });
  },
};
const sharedOwnedValidation = {
  name: 'shared-owned-validation',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/owned-validation\.mjs$/ }, () => ({
      path: './owned-validation.mjs',
      external: true,
    }));
  },
};

async function build(options) {
  const result = await compile({ ...options, write: false });
  for (const output of result.outputFiles) await writeGeneratedFile(output.path, output.contents);
  return result;
}

// Keep the distributable JSON Schema and CSP-safe validator from one definition.
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const text = { type: 'string', maxLength: 4096 };
const name = { ...text, minLength: 1 };
const uuid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};
const number = { type: 'number', minimum: -100000, maximum: 100000, multipleOf: 0.0001 };
const positive = { type: 'number', minimum: 0.0001, maximum: 1000, multipleOf: 0.0001 };
const angle = { type: 'number', minimum: -360, maximum: 360, multipleOf: 0.0001 };
const array = (items, maxItems = 10000) => ({ type: 'array', items, maxItems });
const object = (properties, optional = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const xy = { x: number, y: number };
const simulationModels = array(
  object({
    id: { type: 'string', minLength: 1, maxLength: 128 },
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    file: { type: 'string', minLength: 1, maxLength: 256 },
  }),
  32,
);
const raw = ref('sexpr');
// Private recovery/IPC snapshots retain original KiCad files. This schema is
// never a user project format; native files are written by the Electron adapter.
const nativeFiles = object({
  entry: { type: 'string', minLength: 1, maxLength: 256 },
  files: array(
    object(
      {
        name: { type: 'string', minLength: 1, maxLength: 256 },
        source: { type: 'string', maxLength: 8000000 },
        encoding: { const: 'latin1' },
      },
      ['encoding'],
    ),
    128,
  ),
});
const pcbNumber = { type: 'number', minimum: -100000, maximum: 100000, multipleOf: 0.000001 };
const pcbPositive = { ...pcbNumber, minimum: 0.000001, maximum: 1000 };
const pcbNonnegative = { ...pcbPositive, minimum: 0 };
const pcbXY = { x: pcbNumber, y: pcbNumber };
const pcbPoint = object(pcbXY);
const pcbAngle = { ...pcbNumber, minimum: -360, maximum: 360 };
const copper = { enum: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] };
const graphicLayer = {
  enum: [
    ...copper.enum,
    'F.SilkS',
    'B.SilkS',
    'F.Fab',
    'B.Fab',
    'F.CrtYd',
    'B.CrtYd',
    'Edge.Cuts',
    'F.Mask',
    'B.Mask',
    'F.Paste',
    'B.Paste',
    'F.Adhes',
    'B.Adhes',
    'Dwgs.User',
    'Cmts.User',
    'Eco1.User',
    'Eco2.User',
    'Margin',
    'User.1',
    'User.2',
    'User.3',
    'User.4',
  ],
};
const pcbTextProperties = {
  value: text,
  rotation: pcbAngle,
  size: object({ x: pcbPositive, y: pcbPositive }),
  thickness: pcbNonnegative,
  justify: {
    ...array({ enum: ['left', 'right', 'top', 'bottom', 'mirror'] }, 3),
    uniqueItems: true,
  },
  hidden: { type: 'boolean' },
  italic: { type: 'boolean' },
  bold: { type: 'boolean' },
  property: text,
};
const pcbTextOptional = ['justify', 'hidden', 'italic', 'bold', 'property'];
const line = object(
  {
    locked: { const: true },
    id: uuid,
    start: pcbPoint,
    end: pcbPoint,
    width: pcbNonnegative,
    layer: graphicLayer,
    kind: { enum: ['arc', 'circle', 'polygon', 'text', 'dimension'] },
    mid: pcbPoint,
    points: array(pcbPoint),
    fill: { type: 'boolean' },
    stroke: { enum: ['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] },
    text: object(pcbTextProperties, pcbTextOptional),
    dimension: object(
      {
        type: { enum: ['aligned', 'radial', 'leader'] },
        height: pcbNumber,
        leaderLength: pcbNumber,
        format: object(
          {
            prefix: text,
            suffix: text,
            units: { type: 'integer', minimum: 0, maximum: 3 },
            unitsFormat: { type: 'integer', minimum: 0, maximum: 3 },
            precision: { type: 'integer', minimum: 0, maximum: 6 },
            overrideValue: text,
          },
          ['overrideValue'],
        ),
        style: object(
          {
            arrowLength: pcbPositive,
            textPositionMode: { type: 'integer', minimum: 0, maximum: 2 },
            arrowDirection: { enum: ['inward', 'outward'] },
            extensionHeight: pcbNumber,
            extensionOffset: pcbNumber,
            keepTextAligned: { type: 'boolean' },
            textFrame: { type: 'integer', minimum: 0, maximum: 3 },
          },
          ['arrowDirection', 'extensionHeight', 'keepTextAligned', 'textFrame'],
        ),
        caption: object({ ...pcbXY, ...pcbTextProperties }, pcbTextOptional),
      },
      ['height', 'leaderLength'],
    ),
  },
  ['kind', 'mid', 'points', 'fill', 'stroke', 'text', 'dimension', 'locked'],
);
const zone = object(
  {
    locked: { const: true },
    id: uuid,
    netId: { anyOf: [uuid, { type: 'null' }] },
    layer: graphicLayer,
    outline: { ...array(pcbPoint), minItems: 3 },
    holes: array({ ...array(pcbPoint), minItems: 3 }, 100),
    filledPolygons: array(
      object(
        {
          points: { ...array(pcbPoint, 60000), minItems: 3 },
          island: { const: true },
        },
        ['island'],
      ),
      2000,
    ),
    clearance: pcbNonnegative,
    minThickness: pcbPositive,
    thermalGap: pcbNonnegative,
    thermalBridge: pcbNonnegative,
    priority: { type: 'integer', minimum: 0, maximum: 10000 },
    padConnection: { enum: ['yes', 'no', 'thru_hole_only'] },
    islandRemovalMode: { type: 'integer', minimum: 0, maximum: 2 },
    fillEnabled: { type: 'boolean' },
    keepout: object(
      Object.fromEntries(
        ['tracks', 'vias', 'pads', 'copperpour', 'footprints'].map((k) => [k, { type: 'boolean' }]),
      ),
    ),
  },
  [
    'locked',
    'holes',
    'filledPolygons',
    'priority',
    'padConnection',
    'islandRemovalMode',
    'fillEnabled',
    'keepout',
  ],
);
const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:openpe:editor-model:1',
  title: 'OpenPE internal editor model',
  ...object(
    {
      format: { const: 'openpe' },
      version: { const: 1 },
      units: { const: 'mm' },
      id: uuid,
      name,
      schematic: ref('schematic'),
      additionalSchematics: array(ref('schematic'), 11),
      pcb: { anyOf: [ref('pcb'), { type: 'null' }] },
      extensions: { type: 'object', additionalProperties: true },
      simulationModels,
      nativeFiles: ref('nativeFiles'),
    },
    ['additionalSchematics', 'name', 'simulationModels', 'nativeFiles'],
  ),
  $defs: {
    nativeFiles,
    point: object(xy),
    sexpr: {
      type: 'array',
      minItems: 1,
      maxItems: 50000,
      items: { anyOf: [{ type: 'string', maxLength: 100000 }, ref('sexpr')] },
    },
    schematic: object(
      {
        id: uuid,
        title: name,
        parts: array(
          object(
            {
              id: uuid,
              libId: name,
              ref: name,
              value: text,
              ...xy,
              rotation: angle,
              mirror: { enum: ['x', 'y'] },
              unit: { type: 'integer', minimum: 1, maximum: 100 },
              excludeFromSimulation: { type: 'boolean' },
              fields: {
                type: 'object',
                maxProperties: 100,
                propertyNames: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 100,
                  not: { enum: ['Reference', 'Value', '__proto__', 'prototype', 'constructor'] },
                },
                additionalProperties: text,
              },
              raw,
            },
            ['raw', 'unit', 'fields', 'mirror', 'excludeFromSimulation'],
          ),
          2000,
        ),
        wires: array(object({ id: uuid, a: ref('point'), b: ref('point'), raw }, ['raw'])),
        junctions: array(object({ id: uuid, ...xy, raw }, ['raw'])),
        noConnects: array(object({ id: uuid, ...xy, raw }, ['raw'])),
        labels: array(
          object(
            {
              id: uuid,
              text: name,
              ...xy,
              rotation: angle,
              scope: { const: 'global' },
              shape: { enum: ['input', 'output', 'bidirectional', 'tri_state', 'passive'] },
              raw,
            },
            ['rotation', 'raw', 'scope', 'shape'],
          ),
        ),
        libraries: { type: 'object', maxProperties: 2000, additionalProperties: ref('sexpr') },
        original: raw,
      },
      ['original', 'noConnects'],
    ),
    pcb: object({
      id: uuid,
      thickness: pcbPositive,
      layers: {
        enum: [
          ['F.Cu', 'B.Cu'],
          ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
        ],
      },
      nets: array(object({ id: uuid, name }), 5000),
      footprints: array(ref('footprint'), 2000),
      tracks: array(
        object(
          {
            id: uuid,
            start: pcbPoint,
            end: pcbPoint,
            width: pcbPositive,
            layer: copper,
            netId: uuid,
            locked: { const: true },
          },
          ['locked'],
        ),
      ),
      vias: array(
        object(
          {
            id: uuid,
            ...pcbXY,
            diameter: pcbPositive,
            drill: pcbPositive,
            netId: uuid,
            locked: { const: true },
          },
          ['locked'],
        ),
      ),
      graphics: array(line),
      zones: array(zone, 1000),
    }),
    footprint: object(
      {
        id: uuid,
        symbolId: { anyOf: [uuid, { type: 'null' }] },
        libraryId: name,
        locked: { const: true },
        solderMaskMargin: pcbNumber,
        solderPasteMargin: pcbNumber,
        solderPasteMarginRatio: pcbNumber,
        ...pcbXY,
        rotation: pcbAngle,
        side: { enum: ['front', 'back'] },
        pads: array(ref('pad'), 2000),
        graphics: array(line, 10000),
        reference: text,
        value: text,
        zones: array(zone, 1000),
        models: array(
          object(
            {
              path: {
                type: 'string',
                minLength: 1,
                maxLength: 4096,
                pattern: '^[^\\u0000-\\u001f]+$',
              },
              offset: object({ ...pcbXY, z: pcbNumber }),
              scale: object({
                x: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
                y: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
                z: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
              }),
              rotation: object({ ...pcbXY, z: pcbNumber }),
              hidden: { type: 'boolean' },
              opacity: { type: 'number', minimum: 0, maximum: 1 },
            },
            ['hidden', 'opacity'],
          ),
          32,
        ),
      },
      [
        'reference',
        'value',
        'zones',
        'models',
        'locked',
        'solderMaskMargin',
        'solderPasteMargin',
        'solderPasteMarginRatio',
      ],
    ),
    pad: object(
      {
        locked: { const: true },
        id: uuid,
        number: text,
        ...pcbXY,
        rotation: pcbAngle,
        type: { enum: ['smd', 'thru_hole', 'np_thru_hole'] },
        shape: { enum: ['rect', 'circle', 'oval', 'roundrect'] },
        size: object({ x: pcbPositive, y: pcbPositive }),
        drill: pcbPositive,
        netId: { anyOf: [uuid, { type: 'null' }] },
        layers: {
          ...array({ enum: [...graphicLayer.enum, '*.Cu', '*.Mask'] }, 8),
          minItems: 1,
          uniqueItems: true,
        },
        drillOffset: pcbPoint,
        roundrectRatio: { type: 'number', minimum: 0, maximum: 0.5 },
        chamferRatio: { type: 'number', minimum: 0, maximum: 0.5 },
        chamfer: {
          ...array({ enum: ['top_left', 'top_right', 'bottom_left', 'bottom_right'] }, 4),
          uniqueItems: true,
          minItems: 1,
        },
        solderMaskMargin: pcbNumber,
        solderPasteMargin: pcbNumber,
        solderPasteMarginRatio: { type: 'number', minimum: -1, maximum: 1 },
        thermalBridgeAngle: pcbAngle,
        zoneConnect: { type: 'integer', minimum: 0, maximum: 3 },
        removeUnusedLayers: { type: 'boolean' },
        unconnected: { const: true },
      },
      [
        'locked',
        'drill',
        'layers',
        'drillOffset',
        'roundrectRatio',
        'chamferRatio',
        'chamfer',
        'solderMaskMargin',
        'solderPasteMargin',
        'solderPasteMarginRatio',
        'thermalBridgeAngle',
        'zoneConnect',
        'removeUnusedLayers',
        'unconnected',
      ],
    ),
  },
};
// Command property schemas share the canonical definitions. These records have
// no recursive/native S-expressions; resolve their local refs for the bounded
// capability interpreter instead of maintaining another set of PCB shapes.
function capabilityShape(value) {
  if (Array.isArray(value)) return value.map(capabilityShape);
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    const key = value.$ref.replace(/^#\/\$defs\//, '');
    if (!schema.$defs[key] || Object.keys(value).length !== 1)
      throw new Error(`Unsupported capability shape reference: ${value.$ref}`);
    return capabilityShape(schema.$defs[key]);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, capabilityShape(item)]),
  );
}
await writeGeneratedFile(
  'core/layout-property-schemas.json',
  JSON.stringify(
    {
      graphic: capabilityShape(line),
      zone: capabilityShape(zone),
      pad: capabilityShape(schema.$defs.pad),
      footprint: capabilityShape(schema.$defs.footprint),
      via: capabilityShape(schema.$defs.pcb.properties.vias.items),
    },
    null,
    2,
  ) + '\n',
);

// Native file schema: project content only. The editor model above is private.
const native = (excluded = []) =>
  array(
    {
      allOf: [ref('sexpr'), { not: { type: 'array', items: [{ enum: excluded }], minItems: 1 } }],
    },
    2000,
  );
const location = { id: uuid, position: ref('point') };
const docDefs = { ...schema.$defs };
docDefs.schematic = object(
  {
    id: uuid,
    name,
    components: array(
      object(
        {
          ...location,
          symbol: name,
          libraryId: name,
          reference: name,
          value: text,
          simulation: object({
            valueFormat: {
              ...text,
              description:
                'KiCad Sim.Params derived from the component value; exactly one literal ${VALUE} binding, optionally with a single parameter name.',
              pattern: '^(?:\\s*[a-zA-Z][\\w.]*\\s*=\\s*)?\\$\\{VALUE\\}\\s*$',
            },
          }),
          rotation: angle,
          unit: { type: 'integer', minimum: 1, maximum: 100 },
          mirror: { enum: ['x', 'y'] },
          fields: schema.$defs.schematic.properties.parts.items.properties.fields,
          fieldLayout: {
            type: 'object',
            description:
              'Native field placement and effects. Missing entries use a hidden 1.27 mm field at the component position. Saves omit this layout and explicit show_name/do_not_autoplace no defaults.',
            maxProperties: 102,
            propertyNames: { type: 'string', minLength: 1, maxLength: 100 },
            additionalProperties: native(['property', 'uuid', 'lib_id', 'symbol']),
          },
          kicad: {
            ...native([
              'uuid',
              'at',
              'lib_id',
              'lib_name',
              'unit',
              'mirror',
              'property',
              'instances',
            ]),
            description:
              'Complementary instance metadata. Saves omit body_style 1, exclude_from_sim no, in_bom/on_board/in_pos_files yes and dnp no; nondefault attributes and pin UUIDs are retained.',
          },
        },
        ['mirror', 'libraryId', 'rotation', 'unit', 'fields', 'fieldLayout', 'kicad', 'simulation'],
      ),
      2000,
    ),
    wires: array(
      object(
        {
          id: uuid,
          start: ref('point'),
          end: ref('point'),
          kicad: {
            ...native(['uuid', 'pts']),
            description: 'Saves omit the exact default stroke with width 0 and type default.',
          },
        },
        ['kicad'],
      ),
    ),
    junctions: array(
      object(
        {
          ...location,
          kicad: {
            ...native(['uuid', 'at']),
            description: 'Saves omit diameter 0 and the default color 0 0 0 0.',
          },
        },
        ['kicad'],
      ),
    ),
    noConnects: array(object({ ...location, kicad: native(['uuid', 'at']) }, ['kicad'])),
    labels: array(
      object(
        {
          ...location,
          text: name,
          rotation: angle,
          scope: { enum: ['local', 'global'] },
          shape: { enum: ['input', 'output', 'bidirectional', 'tri_state', 'passive'] },
          kicad: native(['uuid', 'at', 'shape']),
        },
        ['shape', 'rotation', 'scope', 'kicad'],
      ),
    ),
    texts: array(
      object(
        {
          ...location,
          text,
          size: positive,
          anchor: { enum: ['start', 'middle', 'end'] },
          vertical: { enum: ['top', 'middle', 'bottom'] },
          excludeFromSimulation: { type: 'boolean' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          href: { type: 'string', maxLength: 2048, pattern: '^https?://[^\\s\\u0000-\\u001f]+$' },
          color: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: [
              ...Array.from({ length: 3 }, () => ({ type: 'number', minimum: 0, maximum: 255 })),
              { type: 'number', minimum: 0, maximum: 1 },
            ],
          },
        },
        ['excludeFromSimulation', 'color', 'bold', 'italic', 'href'],
      ),
    ),
    kicad: native([
      'paper',
      'version',
      'generator',
      'generator_version',
      'uuid',
      'lib_symbols',
      'symbol',
      'wire',
      'junction',
      'no_connect',
      'label',
      'global_label',
      'text',
    ]),
  },
  ['components', 'wires', 'junctions', 'noConnects', 'labels', 'texts', 'kicad'],
);
// The public file groups instance simulation, attached packages and network geometry.
// The private editor schema remains independent and retains native arrays.
const order = { type: 'integer', minimum: 0, maximum: 10000 };
const ordered = (input, omitted = []) => {
  const result = structuredClone(input);
  for (const key of omitted) delete result.properties[key];
  result.properties.order = order;
  result.required = [...result.required.filter((key) => !omitted.includes(key)), 'order'];
  return result;
};
const flatSheet = docDefs.schematic;
const component = flatSheet.properties.components.items;
const valueFormat = component.properties.simulation.properties.valueFormat;
component.properties.simulation = object(
  {
    valueFormat,
    device: text,
    type: text,
    name: text,
    library: text,
    pins: text,
    parameters: text,
    seriesResistance: text,
    initialVoltage: text,
    initialCurrent: text,
    coupling: text,
    modelSource: { type: 'string', enum: ['basic', 'external'] },
    sourceType: { type: 'string', enum: ['DC', 'PULSE', 'SIN'] },
    excluded: { type: 'boolean' },
    nativeOrder: { type: 'integer', minimum: 0, maximum: 2000 },
    fields: {
      type: 'object',
      maxProperties: 100,
      propertyNames: { type: 'string', pattern: '^Sim[.]', maxLength: 100 },
      additionalProperties: text,
    },
  },
  [
    'valueFormat',
    'device',
    'type',
    'name',
    'library',
    'pins',
    'parameters',
    'seriesResistance',
    'initialVoltage',
    'initialCurrent',
    'coupling',
    'modelSource',
    'sourceType',
    'excluded',
    'nativeOrder',
    'fields',
  ],
);
component.properties.simulation.minProperties = 1;
component.properties.fields = structuredClone(component.properties.fields);
component.properties.fields.propertyNames = {
  allOf: [
    component.properties.fields.propertyNames,
    { not: { pattern: '^Sim[.]' } },
    {
      not: {
        enum: [
          'OpenPE.SeriesResistance',
          'OpenPE.InitialVoltage',
          'OpenPE.InitialCurrent',
          'OpenPE.Coupling',
          'OpenPE.ModelSource',
          'OpenPE.SourceType',
        ],
      },
    },
  ],
};
component.properties.fieldOrder = { ...array(text, 100), uniqueItems: true };
const footprint = ordered(schema.$defs.footprint, ['symbolId']);
footprint.properties.models.items.required = ['path'];
docDefs.footprint = footprint;
component.properties.footprints = array(ref('footprint'), 2000);
component.required = component.required.filter(
  (key) => !['fieldOrder', 'footprints'].includes(key),
);
docDefs.component = component;
flatSheet.properties.components.items = ref('component');
const drawing = object(
  Object.fromEntries(
    ['wires', 'junctions', 'labels'].map((key) => [
      key,
      array(ordered(flatSheet.properties[key].items)),
    ]),
  ),
  ['wires', 'junctions', 'labels'],
);
const netBoard = object(
  {
    order,
    tracks: array(ordered(schema.$defs.pcb.properties.tracks.items, ['netId'])),
    vias: array(ordered(schema.$defs.pcb.properties.vias.items, ['netId'])),
    zones: array(ordered(zone, ['netId']), 1000),
  },
  ['tracks', 'vias', 'zones'],
);
docDefs.netBoard = netBoard;
const objectNet = object(
  {
    id: {
      anyOf: [
        uuid,
        { type: 'string', pattern: `^schematic:${uuid.pattern.slice(1)}`, maxLength: 46 },
      ],
    },
    name,
    schematic: drawing,
    pcb: ref('netBoard'),
  },
  ['name', 'schematic', 'pcb'],
);
objectNet.anyOf = [
  { properties: { schematic: {} }, required: ['schematic'] },
  { properties: { pcb: {} }, required: ['pcb'] },
];
for (const key of ['wires', 'junctions', 'labels']) delete flatSheet.properties[key];
flatSheet.properties.nets = array(objectNet, 15000);
flatSheet.required = flatSheet.required.filter(
  (key) => !['wires', 'junctions', 'labels', 'nets'].includes(key),
);
docDefs.pcb = object(
  {
    id: uuid,
    thickness: pcbPositive,
    layers: schema.$defs.pcb.properties.layers,
    footprints: array(ref('footprint'), 2000),
    graphics: array(line),
    zones: array(ordered(zone, ['netId']), 1000),
  },
  ['footprints', 'graphics', 'zones'],
);
const documentSchema = {
  $schema: schema.$schema,
  $id: 'urn:openpe:internal-project-snapshot:1',
  title: 'OpenPE private IPC and recovery snapshot',
  ...object(
    {
      format: { const: 'openpe' },
      version: { const: 1 },
      units: { const: 'mm' },
      project: object({ id: uuid, name }),
      schematic: ref('schematic'),
      pcb: { anyOf: [ref('pcb'), { type: 'null' }] },
      libraries: object({ symbols: schema.$defs.schematic.properties.libraries }),
      simulationModels,
      nativeFiles,
      additionalSchematics: array(
        object(
          {
            schematic: ref('schematic'),
            libraries: object({ symbols: schema.$defs.schematic.properties.libraries }),
          },
          ['libraries'],
        ),
        11,
      ),
      extensions: {
        type: 'object',
        description: 'Project-specific extension data and provenance only.',
        additionalProperties: true,
      },
    },
    ['additionalSchematics', 'pcb', 'libraries', 'extensions', 'simulationModels', 'nativeFiles'],
  ),
  $defs: docDefs,
};
await mkdir('schemas', { recursive: true });
const banner = { js: '// Generated by scripts/build-format.mjs; do not edit.' };
const declaration = (source) =>
  `// Generated by scripts/build-format.mjs; do not edit.\nexport * from "${source}";\n`;
const service = (entry, outfile, plugins = []) =>
  build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins,
    banner,
  });
const ajv = new Ajv({
  code: { source: true, esm: true },
  // Keep reusable schema subtrees as separate static functions. Their successful
  // checks can then follow internally owned immutable document identities.
  inlineRefs: false,
  strict: true,
  strictTuples: false,
  // PCB coordinates use micrometre fractions; tolerate binary division noise
  // at the maximum board coordinate without admitting another decimal place.
  multipleOfPrecision: 4,
});
optimizeStaticMaxLength(ajv);
const validator = (definition, outfile) =>
  build({
    stdin: {
      contents: ownedValidatorSource(
        pruneValidatorSchemaSource(standalone(ajv, ajv.compile(definition))),
      ),
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    outfile,
    plugins: [sharedOwnedValidation],
    banner,
  });
// Bundles that reach lib/project embed the generated validators, so they are
// built only after both validators have been written.
await Promise.all([
  writeGeneratedFile(
    'schemas/internal-project-snapshot.schema.json',
    JSON.stringify(documentSchema, null, 2) + '\n',
  ),
  service('lib/simulation-models.ts', 'server/simulation-model-format.mjs'),
  service('lib/ti-dcdc.ts', 'server/ti-format.mjs'),
  build({
    stdin: {
      contents:
        'import {tiModels, referenceModels} from "./lib/ti-dcdc.ts";\n' +
        'export const reviewedModelEntries = [...tiModels, ...referenceModels].map(model => ({sha256:model.modelSha256, names:[model.subcircuit]}));',
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'server/spice-model-entrypoints.cjs',
    banner,
  }),
  service('lib/agent-providers.ts', 'server/agent-provider-format.mjs'),
  service('lib/agent-annotations.ts', 'server/annotation-format.mjs'),
  build({
    stdin: {
      contents:
        'export { default as exampleModelLock } from "./resources/example-models-lock.json";\n' +
        'export { default as emcFlybackModelLock } from "./resources/emc-flyback-models-lock.json";',
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'server/example-models-lock.mjs',
    banner,
  }),
  validator(schema, 'lib/project-validator.mjs'),
  validator(documentSchema, 'lib/project-document-validator.mjs'),
]);
await Promise.all([
  service('lib/appearance.ts', 'server/appearance-format.mjs'),
  service('lib/project.ts', 'server/project-format.mjs'),
  service('lib/manufacturing-export.ts', 'server/manufacturing-format.mjs', [sharedProject]),
  writeGeneratedFile(
    'server/manufacturing-format.d.mts',
    declaration('../lib/manufacturing-export'),
  ),
  writeGeneratedFile('server/project-format.d.mts', declaration('../lib/project')),
  service('lib/library.ts', 'server/library-format.mjs', [sharedProject]),
  service('lib/spice.ts', 'server/spice-format.mjs'),
  writeGeneratedFile('server/spice-format.d.mts', declaration('../lib/spice')),
  service('lib/thermal.ts', 'server/thermal-format.mjs', [sharedProject]),
  writeGeneratedFile('server/thermal-format.d.mts', declaration('../lib/thermal')),
  service('lib/model-cad.ts', 'server/model-cad-format.mjs', [sharedProject]),
  writeGeneratedFile('server/model-cad-format.d.mts', declaration('../lib/model-cad')),
  service('lib/workspace-state.ts', 'server/workspace-format.mjs', [sharedProject]),
  writeGeneratedFile('server/workspace-format.d.mts', declaration('../lib/workspace-state')),
  service('context/agent-workspace-context.ts', 'server/agent-context-format.mjs', [sharedProject]),
]);
