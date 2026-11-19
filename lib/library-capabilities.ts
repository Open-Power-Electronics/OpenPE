import type { CapabilityActor, CapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { api, type SpiceModelDeclaration } from './bridge';
import { readLibrarySearch } from './library-search';
import { uid } from './circuit';
import {
  createLibraryPart,
  librarySources,
  symbolUnits,
  partFields,
  partFootprint,
  type SymbolDetail,
  displayPartValue,
} from './library';
import { findSchematic } from './project';
import { val } from './sexpr';
import { createPCBFootprint, flipPCBFootprint } from './pcb-layout';
import {
  prepareFootprintModelSelection,
  prepareSimulationLibrarySelection,
  prepareSimulationModelSelection,
} from './model-resource-preparation';
import { simulationLibraryPath } from './simulation-model-presentation';
import { externalModelBinding } from './simulation-model-binding';
import { prepareSourceConversion } from './simulation-source-conversion';
import layoutPropertySchemas from '../core/layout-property-schemas.json';
import { agentCoreResult } from './agent-project-access';
import { loadLibraryFootprint, prepareSchematicPackage } from './library-package';
import { attachOnlineFootprint } from './library-project-assets';
import { prepareSchematicSection } from './schematic-section';
import type { FootprintSource } from './pcb-sync';

const kind = { enum: ['symbols', 'footprints'] };
const identity = { type: 'string', minLength: 1, maxLength: 500 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export type SpiceModelCatalog = {
  path: string;
  models: SpiceModelDeclaration[];
  issues: string[];
};
export type LibraryCapabilityPorts = {
  /** Current originating editor availability, including busy/close/activation gates. */
  available?: () => boolean | string;
  spiceAvailable?: () => boolean | string;
  getFileId?: () => string | undefined;
  stageFootprint?: (source: FootprintSource) => () => void;
  chooseComponentModel?: (fileId: string) => Promise<{ path: string } | null>;
  chooseSpiceModel?: (fileId: string, currentLibrary?: string) => Promise<SpiceModelCatalog | null>;
  inspectSpiceModel?: (fileId: string, library: string) => Promise<SpiceModelCatalog | null>;
};

export function registerLibraryCapabilities(
  host: CapabilityHost,
  core: ProjectCore,
  ports: LibraryCapabilityPorts = {},
) {
  const detail = async (kind: string, id: string, signal: AbortSignal) => {
    const value = await (
      await api(`libraries/${kind}?id=${encodeURIComponent(id)}`, { signal })
    ).json();
    if (value.id !== id || value.error)
      throw new Error(value.error || 'The library entry is unavailable.');
    return value;
  };
  const resourceAvailability = (spice = false) => {
    const snapshot = core.getSnapshot();
    if (snapshot.editingBlocked) return snapshot.editingBlocked;
    if (snapshot.sourceDraft !== null)
      return 'Apply Source edits before preparing model resources.';
    if (!snapshot.project) return 'Open a project before preparing model resources.';
    const active = ports.available?.() ?? true;
    if (active !== true) return active;
    return spice ? (ports.spiceAvailable?.() ?? 'SPICE model controls are unavailable.') : true;
  };
  const begin = (expectedRevision?: string, spice = false) => {
    const available = resourceAvailability(spice);
    if (available !== true) throw new Error(String(available));
    const snapshot = core.getSnapshot();
    if (expectedRevision !== undefined && String(snapshot.revision) !== expectedRevision)
      throw new Error('The project changed. Query it before preparing a model.');
    return snapshot;
  };
  const recheck = (
    basis: ReturnType<typeof core.getSnapshot>,
    signal: AbortSignal,
    spice = false,
  ) => {
    signal.throwIfAborted();
    begin(String(basis.revision), spice);
  };
  const currentFile = () => {
    const fileId = ports.getFileId?.();
    if (!fileId) throw new Error('Save this project before selecting local model resources.');
    return fileId;
  };
  const nativeAvailability = (method: unknown, spice = false) =>
    resourceAvailability(spice) !== true
      ? resourceAvailability(spice)
      : !method
        ? 'The native model picker is unavailable.'
        : ports.getFileId?.()
          ? true
          : 'Save this project before selecting local model resources.';
  const component = (
    basis: ReturnType<typeof core.getSnapshot>,
    schematicId: string,
    partId: string,
  ) => {
    const schematic = basis.project && findSchematic(basis.project, schematicId);
    const part = schematic?.parts.find((item) => item.id === partId);
    if (!schematic || !part) throw new Error('Choose a component in this project.');
    return { schematic, part };
  };
  const saveFields = (
    schematicId: string,
    partId: string,
    fields: Record<string, string>,
    revision: number,
    actor: CapabilityActor,
  ) => {
    const result = core.execute(
      'part.properties',
      {
        schematicId,
        partId,
        fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
      },
      { expectedRevision: revision },
    );
    return actor === 'agent' ? agentCoreResult(result) : result;
  };
  type Observation = SpiceModelCatalog & {
    schematicId: string;
    partId: string;
    revision: number;
    fileId: string;
  };
  const observations = new Map<string, Observation>();
  const observe = (
    catalog: SpiceModelCatalog,
    schematicId: string,
    partId: string,
    fileId: string,
  ) => {
    const snapshot = core.getSnapshot(),
      { schematic, part } = component(snapshot, schematicId, partId);
    const observationId = uid();
    // Project only declaration metadata, never incidental host model bytes or logs.
    const owned: SpiceModelCatalog = {
      path: catalog.path,
      models: catalog.models.map(({ name, kind, device, pins }) => ({
        name,
        kind,
        ...(device === undefined ? {} : { device }),
        pins: [...pins],
      })),
      issues: [...catalog.issues],
    };
    observations.set(observationId, {
      ...owned,
      schematicId,
      partId,
      revision: snapshot.revision,
      fileId,
    });
    while (observations.size > 8) observations.delete(observations.keys().next().value!);
    return {
      status: 'available',
      observationId,
      revision: String(snapshot.revision),
      ...structuredClone(owned),
      bindings: owned.models.map((declaration) => {
        try {
          return { name: declaration.name, ...externalModelBinding(schematic, part, declaration) };
        } catch (error) {
          return { name: declaration.name, compatible: false, reason: (error as Error).message };
        }
      }),
    };
  };
  const modelLimit = layoutPropertySchemas.footprint.properties.models.maxItems;
  const modelSelection = {
    boardId: identity,
    footprintId: identity,
    index: { type: 'integer', minimum: 0, maximum: modelLimit - 1 },
  };
  const partSelection = { schematicId: identity, partId: identity };
  const dispose = [
    core.subscribe(() => observations.clear()),
    ...(['import', 'library'] as const).map((method) =>
      host.register<any>({
        id: `layout.model.${method}`,
        owner: 'host',
        level: 'object',
        kind: 'command',
        mutation: 'document',
        review: 'optional',
        description:
          method === 'import'
            ? 'Select and prepare a local STEP file through the native picker for the open project, then append or replace one footprint model in one undo edit. No path input is accepted.'
            : 'Prepare an official footprint model by catalog ID/index, then append or replace one footprint model in one undo edit.',
        inputSchema: object(
          {
            ...modelSelection,
            ...(method === 'library'
              ? {
                  libraryId: { type: 'string', minLength: 1, maxLength: 256 },
                  modelIndex: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                }
              : {}),
          },
          ['boardId', 'footprintId', ...(method === 'library' ? ['libraryId', 'modelIndex'] : [])],
        ),
        available: () =>
          method === 'import'
            ? nativeAvailability(ports.chooseComponentModel)
            : resourceAvailability(),
        handler: async ({ boardId, footprintId, index, libraryId, modelIndex }, context) => {
          const basis = begin(context.expectedRevision);
          const board = basis.project!.pcb;
          const footprint =
            board &&
            board.id === boardId &&
            board.footprints.find((item) => item.id === footprintId);
          if (!footprint) throw new Error('Choose a footprint on the current board.');
          if (footprint.locked) throw new Error('Unlock the footprint before changing its models.');
          const target = index ?? footprint.models?.length ?? 0;
          if (target >= modelLimit)
            throw new Error(`A footprint supports at most ${modelLimit} models.`);
          if (target > (footprint.models?.length ?? 0))
            throw new Error('Choose an existing model index or append at the end.');
          const fileId = method === 'import' ? currentFile() : ports.getFileId?.();
          const selected =
            method === 'import'
              ? await ports.chooseComponentModel!(fileId!)
              : await (
                  await api('component-model/library', {
                    method: 'POST',
                    body: JSON.stringify({ id: libraryId, index: modelIndex }),
                    signal: context.signal,
                  })
                ).json();
          recheck(basis, context.signal);
          if (ports.getFileId?.() !== fileId)
            throw new Error('The project destination changed. Select the model again.');
          if (!selected) return { status: 'cancelled' };
          const models = prepareFootprintModelSelection(footprint, target, selected.path);
          core.execute(
            'layout.footprint.properties',
            { boardId, footprintId, changes: { models } },
            { expectedRevision: basis.revision },
          );
          return {
            status: 'applied',
            revision: String(core.getSnapshot().revision),
            boardId,
            footprintId,
            index: target,
            models,
          };
        },
      }),
    ),
    ...(['choose', 'inspect'] as const).map((method) =>
      host.register<any>({
        id: `part.spiceModel.${method}`,
        owner: 'host',
        ...(method === 'choose' ? { level: 'object' as const } : {}),
        kind: method === 'choose' ? 'command' : 'query',
        ...(method === 'choose'
          ? { mutation: 'document' as const, review: 'optional' as const }
          : {}),
        description:
          method === 'choose'
            ? 'Choose a SPICE library through the native picker, retain its declaration observation and update this component using the shared Properties rules.'
            : 'Inspect the component current project-relative SPICE library through its live grant. Return an observation and compatible pin mappings without model bytes or arbitrary path input.',
        inputSchema: object(partSelection, ['schematicId', 'partId']),
        available: () =>
          nativeAvailability(
            method === 'choose' ? ports.chooseSpiceModel : ports.inspectSpiceModel,
            true,
          ),
        handler: async ({ schematicId, partId }, context) => {
          const basis = begin(context.expectedRevision, true),
            fileId = currentFile();
          const { part } = component(basis, schematicId, partId);
          const fields = partFields(part),
            library = fields['Sim.Library'] || '',
            path = simulationLibraryPath(library);
          if (method === 'inspect' && (!path || /^(?:[A-Za-z]:|[\\/])/.test(path)))
            throw new Error('Choose the SPICE model file through the native picker first.');
          const catalog =
            method === 'choose'
              ? await ports.chooseSpiceModel!(fileId, path || undefined)
              : await ports.inspectSpiceModel!(fileId, path);
          recheck(basis, context.signal, true);
          if (currentFile() !== fileId)
            throw new Error('The project destination changed. Select the model again.');
          if (!catalog) return { status: method === 'choose' ? 'cancelled' : 'unavailable' };
          if (method === 'inspect' && catalog.path !== path)
            throw new Error('The model library changed during inspection.');
          if (method === 'choose')
            saveFields(
              schematicId,
              partId,
              prepareSimulationLibrarySelection(part, fields, catalog.path, catalog.models),
              basis.revision,
              context.actor,
            );
          return observe(catalog, schematicId, partId, fileId);
        },
      }),
    ),
    host.register<any>({
      id: 'part.spiceModel.bind',
      owner: 'host',
      level: 'object',
      kind: 'command',
      mutation: 'document',
      review: 'optional',
      description:
        'Select the intrinsic model or bind an exact observed external declaration with validated terminal mapping, retaining inactive fields and one whole-project undo edit.',
      inputSchema: {
        anyOf: [
          object(
            {
              ...partSelection,
              source: { const: 'basic' },
              passiveModel: { enum: ['R', 'C', 'L', null] },
            },
            ['schematicId', 'partId', 'source'],
          ),
          object({ ...partSelection, source: { const: 'external' } }, [
            'schematicId',
            'partId',
            'source',
          ]),
          object(
            {
              ...partSelection,
              source: { const: 'external' },
              observationId: identity,
              name: identity,
              mapping: {
                type: 'object',
                maxProperties: 64,
                additionalProperties: { type: 'string', minLength: 1, maxLength: 128 },
              },
            },
            ['schematicId', 'partId', 'source', 'observationId', 'name'],
          ),
        ],
      },
      available: () => resourceAvailability(true),
      handler: (
        { schematicId, partId, source, observationId, name, mapping, passiveModel },
        context,
      ) => {
        const basis = begin(context.expectedRevision, true),
          { schematic, part } = component(basis, schematicId, partId);
        const observation = observationId ? observations.get(observationId) : undefined;
        if (
          observationId &&
          (!observation ||
            observation.revision !== basis.revision ||
            observation.schematicId !== schematicId ||
            observation.partId !== partId ||
            observation.fileId !== ports.getFileId?.() ||
            observation.path !== simulationLibraryPath(partFields(part)['Sim.Library'] || ''))
        )
          throw new Error(
            'The SPICE declaration observation is stale. Inspect or choose the library again.',
          );
        const fields = prepareSimulationModelSelection(
          schematic,
          part,
          partFields(part),
          source === 'basic'
            ? { source, passiveModel }
            : {
                source,
                name: name ?? partFields(part)['Sim.Name'] ?? '',
                mapping,
                declarations: observation?.models,
              },
        );
        return saveFields(schematicId, partId, fields, basis.revision, context.actor);
      },
    }),
    host.register<any>({
      id: 'part.sourceType',
      owner: 'host',
      level: 'object',
      kind: 'command',
      mutation: 'document',
      review: 'optional',
      description:
        'Convert an intrinsic voltage/current source between DC, PULSE and SIN using the same level/timing preservation and native-field rules as Properties.',
      inputSchema: object({ ...partSelection, type: { enum: ['DC', 'PULSE', 'SIN'] } }, [
        'schematicId',
        'partId',
        'type',
      ]),
      available: () => resourceAvailability(true),
      handler: ({ schematicId, partId, type }, context) => {
        const basis = begin(context.expectedRevision, true),
          { part } = component(basis, schematicId, partId);
        const change = prepareSourceConversion(
          part,
          part.ref,
          displayPartValue(part),
          Object.entries(partFields(part)).map(([name, value]) => ({ name, value })),
          type,
        );
        if (!change) return { revision: String(basis.revision) };
        const result = core.execute(
          'part.properties',
          {
            schematicId,
            partId,
            reference: change.ref,
            value: change.value,
            fields: Object.entries(change.fields).map(([name, value]) => ({ name, value })),
          },
          { expectedRevision: basis.revision },
        );
        return context.actor === 'agent' ? agentCoreResult(result) : result;
      },
    }),
    host.register<any>({
      owner: 'host',
      id: 'library.categories',
      kind: 'query',
      description: 'Read KiCad library namespaces or the NextPCB and JLCPCB category trees.',
      inputSchema: object({ kind, source: { enum: [...librarySources] } }, ['kind', 'source']),
      handler: async ({ kind, source }, { signal }) =>
        (
          await api(`libraries/${kind}?categories=${encodeURIComponent(source)}`, { signal })
        ).json(),
    }),
    host.register<any>({
      owner: 'host',
      id: 'library.search',
      kind: 'query',
      description:
        'Search KiCad symbols and footprints or online parts with linked footprints. For online search, use a keyword or a category ID from library.categories. Empty filters browse JLCPCB. Set includeAssetStatus for symbol pages with checked footprint and model links. Use the returned nextOffset to continue a paged scan, including after an empty batch. Null ends the scan.',
      inputSchema: object(
        {
          kind,
          query: { type: 'string', maxLength: 200 },
          library: { type: 'string', maxLength: 200 },
          category: { type: 'string', maxLength: 10 },
          offset: { type: 'integer', minimum: 0, maximum: 999999 },
          includeAssetStatus: { type: 'boolean' },
        },
        ['kind'],
      ),
      handler: (input, { signal, reportProgress }) =>
        readLibrarySearch(input, signal, reportProgress),
    }),
    host.register<any>({
      owner: 'host',
      id: 'library.detail',
      kind: 'query',
      description:
        'Read a validated KiCad, NextPCB or JLCPCB symbol or footprint by its catalog identity.',
      inputSchema: object({ kind, id: identity }, ['kind', 'id']),
      handler: ({ kind, id }, { signal }) => detail(kind, id, signal),
    }),
    host.register<any>({
      id: 'schematic.place',
      kind: 'command',
      owner: 'host',
      level: 'object',
      mutation: 'document',
      review: 'optional',
      description:
        'Place a unit of a validated KiCad, NextPCB or JLCPCB symbol in an explicitly selected schematic, using the same reference, grid and participation rules as the chooser.',
      inputSchema: object(
        {
          schematicId: identity,
          libraryId: identity,
          x: { type: 'number', minimum: -100000, maximum: 100000 },
          y: { type: 'number', minimum: -100000, maximum: 100000 },
          unit: { type: 'integer', minimum: 1, maximum: 100 },
          rotation: { type: 'number', minimum: -360, maximum: 360 },
          section: { enum: ['hardware', 'simulation'] },
        },
        ['schematicId', 'libraryId', 'x', 'y'],
      ),
      handler: async (
        { schematicId, libraryId, x, y, unit = 1, rotation = 0, section = 'hardware' },
        context,
      ) => {
        const snapshot = core.getSnapshot();
        if (snapshot.sourceDraft !== null)
          throw new Error('Apply Source edits before placing symbols.');
        if (
          context.expectedRevision !== undefined &&
          String(snapshot.revision) !== context.expectedRevision
        )
          throw new Error('The project changed. Query it before placing a symbol.');
        const resolved = (await detail('symbols', libraryId, context.signal)) as SymbolDetail;
        context.signal.throwIfAborted();
        if (core.getSnapshot().revision !== snapshot.revision)
          throw new Error('The project changed while loading the symbol. Try again.');
        const schematic = snapshot.project && findSchematic(snapshot.project, schematicId);
        if (!schematic) throw new Error('Choose a schematic in this project.');
        if (
          !Array.isArray(resolved.symbol) ||
          val(resolved.symbol) !== libraryId ||
          unit > symbolUnits(resolved.symbol)
        )
          throw new Error('Choose a valid loaded symbol unit.');
        const next = structuredClone(schematic);
        const part = createLibraryPart(next, resolved.symbol, x, y, unit);
        part.rotation = rotation;
        next.libraries[part.libId] = structuredClone(resolved.symbol);
        next.parts.push(part);
        const footprint = partFootprint(part);
        const packageUnavailable =
          resolved.footprintPreview === 'unavailable' && resolved.footprint === footprint;
        const nativeFiles = packageUnavailable
          ? undefined
          : await prepareSchematicPackage(snapshot.project!, footprint, context.signal);
        context.signal.throwIfAborted();
        if (core.getSnapshot() !== snapshot)
          throw new Error('The project changed while preparing the symbol. Try again.');
        core.replaceSchematic(prepareSchematicSection(next, [part.id], section), nativeFiles);
        return { id: part.id, reference: part.ref, revision: String(core.getSnapshot().revision) };
      },
    }),
    host.register<any>({
      id: 'part.footprint',
      kind: 'command',
      owner: 'host',
      level: 'object',
      mutation: 'document',
      review: 'optional',
      description:
        'Assign a validated KiCad, NextPCB or JLCPCB footprint or clear the assignment, sharing Properties and Layout package synchronization.',
      inputSchema: object(
        { schematicId: identity, partId: identity, libraryId: { type: 'string', maxLength: 500 } },
        ['schematicId', 'partId', 'libraryId'],
      ),
      handler: async ({ schematicId, partId, libraryId }, context) => {
        const snapshot = core.getSnapshot();
        if (snapshot.sourceDraft !== null)
          throw new Error('Apply Source edits before changing a footprint.');
        if (
          context.expectedRevision !== undefined &&
          String(snapshot.revision) !== context.expectedRevision
        )
          throw new Error('The project changed. Query it before assigning a footprint.');
        const prepared = libraryId
          ? await loadLibraryFootprint(libraryId, context.signal)
          : undefined;
        context.signal.throwIfAborted();
        const part =
          snapshot.project &&
          findSchematic(snapshot.project, schematicId)?.parts.find((part) => part.id === partId);
        if (!part) throw new Error('Choose a component in this project.');
        const fields = { ...partFields(part), Footprint: libraryId };
        const restore = prepared ? ports.stageFootprint?.(prepared) : undefined;
        let result;
        try {
          result = core.execute(
            'part.properties',
            {
              schematicId,
              partId,
              fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
            },
            { expectedRevision: snapshot.revision },
          );
        } catch (error) {
          restore?.();
          throw error;
        }
        return context.actor === 'agent' ? agentCoreResult(result) : result;
      },
    }),
    host.register<any>({
      id: 'layout.place',
      kind: 'command',
      owner: 'host',
      level: 'object',
      mutation: 'document',
      review: 'optional',
      description:
        'Place a validated KiCad, NextPCB or JLCPCB footprint for an unplaced primary-schematic component, sharing the Layout chooser preparation and assignment transaction.',
      inputSchema: object(
        {
          boardId: identity,
          partId: identity,
          libraryId: identity,
          position: object(
            {
              x: { type: 'number', minimum: -100000, maximum: 100000 },
              y: { type: 'number', minimum: -100000, maximum: 100000 },
            },
            ['x', 'y'],
          ),
          rotation: { type: 'number', minimum: -360, maximum: 360 },
          side: { enum: ['front', 'back'] },
        },
        ['boardId', 'partId', 'libraryId', 'position'],
      ),
      available: () => {
        const snapshot = core.getSnapshot();
        return (
          snapshot.editingBlocked ??
          (snapshot.sourceDraft !== null
            ? 'Apply Source edits before placing a footprint.'
            : !!snapshot.project?.pcb || 'This project has no PCB layout.')
        );
      },
      handler: async (
        { boardId, partId, libraryId, position, rotation = 0, side = 'front' },
        context,
      ) => {
        const snapshot = core.getSnapshot();
        const board = snapshot.project?.pcb;
        if (!board || board.id !== boardId) throw new Error('Choose a board in this project.');
        if (
          context.expectedRevision !== undefined &&
          context.expectedRevision !== String(snapshot.revision)
        )
          throw new Error('The project changed. Query it before placing a footprint.');
        if (board.footprints.some((footprint) => footprint.symbolId === partId))
          throw new Error('This component already has a placed footprint.');
        const resolved = await loadLibraryFootprint(libraryId, context.signal);
        context.signal.throwIfAborted();
        if (core.getSnapshot().revision !== snapshot.revision)
          throw new Error('The project changed while loading the footprint. Try again.');
        let footprint = createPCBFootprint(resolved, snapshot.project!.schematic, partId, position);
        footprint.rotation = rotation;
        if (side === 'back') footprint = flipPCBFootprint(footprint);
        const boardNext = { ...board, footprints: [...board.footprints, footprint] };
        const packaged = attachOnlineFootprint({ ...snapshot.project!, pcb: boardNext }, resolved);
        core.replaceBoard(boardNext, packaged.nativeFiles);
        return { id: footprint.id, revision: String(core.getSnapshot().revision) };
      },
    }),
  ];
  return () => {
    observations.clear();
    for (const unregister of dispose.reverse()) unregister();
  };
}
