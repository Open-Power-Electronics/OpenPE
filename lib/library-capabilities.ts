import type { CapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { api } from './bridge';
import {
  createLibraryPart,
  symbolUnits,
  partFields,
  searchLibrary,
  type SymbolDetail,
} from './library';
import { tiDcdcParts } from './ti-dcdc';
import { findSchematic } from './project';
import { val } from './sexpr';

const kind = { enum: ['symbols', 'footprints'] };
const identity = { type: 'string', minLength: 1, maxLength: 500 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function registerLibraryCapabilities(host: CapabilityHost, core: ProjectCore) {
  const detail = async (kind: string, id: string, signal: AbortSignal) => {
    const value = await (
      await api(`libraries/${kind}?id=${encodeURIComponent(id)}`, { signal })
    ).json();
    if (value.id !== id || value.error)
      throw new Error(value.error || 'The library entry is unavailable.');
    return value;
  };
  const dispose = [
    host.register<any>({
      owner: 'host',
      id: 'library.search',
      kind: 'query',
      description:
        'Search the bundled official symbol or footprint library with bounded pagination.',
      inputSchema: object(
        {
          kind,
          query: { type: 'string', maxLength: 200 },
          library: { type: 'string', maxLength: 200 },
          offset: { type: 'integer', minimum: 0, maximum: 999999 },
        },
        ['kind'],
      ),
      handler: async ({ kind, query = '', library = '', offset = 0 }, { signal }) => {
        if (kind === 'symbols' && library === 'ti-dcdc') {
          const entries = searchLibrary(tiDcdcParts, query);
          return {
            entries: entries.slice(offset, offset + 100),
            total: entries.length,
            libraries: ['ti-dcdc'],
          };
        }
        return (
          await api(
            `libraries/${kind}?q=${encodeURIComponent(query)}&library=${encodeURIComponent(library)}&offset=${offset}`,
            { signal },
          )
        ).json();
      },
    }),
    host.register<any>({
      owner: 'host',
      id: 'library.detail',
      kind: 'query',
      description: 'Read a resolved official symbol or footprint by its catalog identity.',
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
        'Place a unit of an official bundled symbol in an explicitly selected schematic, using the same reference, grid and participation rules as the chooser.',
      inputSchema: object(
        {
          schematicId: identity,
          libraryId: identity,
          x: { type: 'number', minimum: -100000, maximum: 100000 },
          y: { type: 'number', minimum: -100000, maximum: 100000 },
          unit: { type: 'integer', minimum: 1, maximum: 100 },
          rotation: { type: 'number', minimum: -360, maximum: 360 },
        },
        ['schematicId', 'libraryId', 'x', 'y'],
      ),
      handler: async ({ schematicId, libraryId, x, y, unit = 1, rotation = 0 }, context) => {
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
        core.replaceSchematic(next);
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
        'Assign a verified official footprint or clear the assignment, sharing Properties and Layout package synchronization.',
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
        if (libraryId) await detail('footprints', libraryId, context.signal);
        context.signal.throwIfAborted();
        const part =
          snapshot.project &&
          findSchematic(snapshot.project, schematicId)?.parts.find((part) => part.id === partId);
        if (!part) throw new Error('Choose a component in this project.');
        const fields = { ...partFields(part), Footprint: libraryId };
        return core.execute(
          'part.properties',
          {
            schematicId,
            partId,
            fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
          },
          { expectedRevision: snapshot.revision },
        );
      },
    }),
  ];
  return () => {
    for (const unregister of dispose.reverse()) unregister();
  };
}
