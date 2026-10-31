import type { CapabilityHost, CapabilitySchema } from '../api/capabilities';
import { emptyCapabilityInput } from '../api/capabilities';
import { projectExportFormats, type ProjectExportFormat } from './export-formats';

/** Native and presentation ports stay outside the document engine. Both clients
 * use these same ports; the host never accepts native paths or commands. */
export type WorkbenchCapabilityPorts = {
  revision: () => string;
  state: (signal?: AbortSignal) => unknown;
  datasheet?: (signal: AbortSignal) => unknown | Promise<unknown>;
  view: (
    view: 'canvas' | 'source' | 'layout' | '3d',
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  sheet: (id: string, signal?: AbortSignal) => void | Promise<void>;
  selection: (ids: string[]) => void;
  panel: (
    panel: 'parts' | 'layers' | 'history' | 'settings' | null,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  save: (saveAs: boolean, signal?: AbortSignal) => Promise<'saved' | 'cancelled' | Error>;
  export: (format: ProjectExportFormat, signal?: AbortSignal) => Promise<'exported' | 'cancelled'>;
  historyList: (offset: number) => Promise<unknown>;
  historyRead: (id: string) => Promise<string>;
  historyCreate: (message: string) => Promise<unknown>;
  simulation: (visible: boolean, signal: AbortSignal) => Promise<unknown>;
  thermal?: (visible: boolean, signal: AbortSignal) => Promise<unknown>;
  enclosureExport?: (signal: AbortSignal) => Promise<{ name: string } | null>;
  enclosureExportAvailable?: () => boolean | string;
};

const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): CapabilitySchema => ({ type: 'object', properties, required, additionalProperties: false });

export function registerWorkbenchCapabilities(
  host: CapabilityHost,
  ports: () => WorkbenchCapabilityPorts,
) {
  const disposers: (() => void)[] = [];
  const command = (
    id: string,
    description: string,
    inputSchema: CapabilitySchema,
    handler: (input: any, signal: AbortSignal) => unknown | Promise<unknown>,
    external = false,
    document = false,
    available?: () => boolean | string,
  ) => {
    disposers.push(
      host.register({
        owner: 'host',
        id,
        kind: 'command',
        description,
        inputSchema,
        mutation: external ? 'external' : document ? 'document' : 'session',
        review: 'optional',
        ...(available ? { available } : {}),
        handler: (input, context) => {
          context.signal.throwIfAborted();
          if (
            context.expectedRevision !== undefined &&
            context.expectedRevision !== ports().revision()
          )
            throw new Error(
              'The project changed since this command was prepared. Query it again before continuing.',
            );
          return handler(input, context.signal);
        },
      }),
    );
  };
  disposers.push(
    host.register({
      owner: 'host',
      id: 'workbench.state',
      kind: 'query',
      description:
        'Read the current project, pending Source, interface, selection and resident plugin results for this workspace.',
      inputSchema: emptyCapabilityInput,
      handler: (_, { signal }) => ports().state(signal),
    }),
  );
  if (ports().datasheet) {
    disposers.push(
      host.register({
        id: 'project.datasheet',
        kind: 'query',
        owner: 'host',
        description:
          'Read the current example controller IC datasheet JSON, including key parameters, units, test conditions, source pages, official URL and pinned document identity. Applies to the validated design, not pending Source drafts.',
        inputSchema: emptyCapabilityInput,
        handler: (_, { signal }) => ports().datasheet!(signal),
      }),
    );
  }
  command(
    'workbench.view',
    'Switch editor view, validating and applying pending Source first.',
    object({ view: { enum: ['canvas', 'source', 'layout', '3d'] } }),
    async ({ view }, signal) => {
      if (!(await ports().view(view, signal)))
        throw new Error('Fix pending Source before switching views.');
      signal.throwIfAborted();
      return { view };
    },
    false,
    true,
  );
  command(
    'workbench.sheet',
    'Open and select a schematic file in this project.',
    object({ id: { type: 'string', maxLength: 100 } }),
    async ({ id }, signal) => {
      await ports().sheet(id, signal);
      signal.throwIfAborted();
      return { id };
    },
  );
  command(
    'workbench.selection',
    'Select visible schematic objects by stable IDs.',
    object({
      ids: {
        type: 'array',
        items: { type: 'string', maxLength: 150 },
        maxItems: 30000,
        uniqueItems: true,
      },
    }),
    ({ ids }) => {
      ports().selection(ids);
      return { ids };
    },
  );
  command(
    'workbench.panel',
    'Open or close a workspace inspector.',
    object({ panel: { enum: ['parts', 'layers', 'history', 'settings', null] } }),
    async ({ panel }, signal) => {
      await ports().panel(panel, signal);
      signal.throwIfAborted();
      return { panel };
    },
  );
  command(
    'project.save',
    'Validate and save this project through its native file grant or Save dialog.',
    object({ saveAs: { type: 'boolean' } }, []),
    async ({ saveAs = false }, signal) => {
      const status = await ports().save(saveAs, signal);
      if (status instanceof Error) throw status;
      signal.throwIfAborted();
      return { status };
    },
    true,
  );
  command(
    'project.export',
    'Export Gerber/drill, JLCPCB manufacturing files, BOM, pick and place or OpenSCAD through the native picker.',
    object({ format: { enum: projectExportFormats.map((entry) => entry.id) } }),
    async ({ format }, signal) => {
      const status = await ports().export(format, signal);
      signal.throwIfAborted();
      return { status };
    },
    true,
  );
  if (ports().enclosureExport)
    command(
      'enclosure.exportStep',
      'Export the current validated Model CAD assembly as STEP through the native destination picker.',
      emptyCapabilityInput,
      async (_, signal) => {
        signal.throwIfAborted();
        const result = await ports().enclosureExport!(signal);
        signal.throwIfAborted();
        return {
          status: result ? 'exported' : 'cancelled',
          ...(result ? { name: result.name } : {}),
        };
      },
      true,
      false,
      () => ports().enclosureExportAvailable?.() ?? true,
    );
  disposers.push(
    host.register({
      owner: 'host',
      id: 'versions.list',
      kind: 'query',
      description: 'List local Git versions for this project destination.',
      inputSchema: object({ offset: { type: 'integer', minimum: 0, maximum: 100000 } }, []),
      handler: (input: any) => ports().historyList(input.offset ?? 0),
    }),
  );
  disposers.push(
    host.register({
      owner: 'host',
      id: 'versions.read',
      kind: 'query',
      description: 'Read a validated, reachable local version as canonical project Source.',
      inputSchema: object({ id: { type: 'string', pattern: '^[a-f0-9]{40,64}$' } }),
      handler: async (input: any) => ({ source: await ports().historyRead(input.id) }),
    }),
  );
  command(
    'versions.create',
    'Create a local Git version of the current validated project.',
    object({ message: { type: 'string', minLength: 1, maxLength: 2000 } }),
    ({ message }) => ports().historyCreate(message),
    true,
  );
  command(
    'simulation.show',
    'Open the supported SPICE plugin and wait until its capabilities are ready.',
    emptyCapabilityInput,
    (_, signal) => ports().simulation(true, signal),
    false,
    true,
  );
  command(
    'simulation.hide',
    'Hide SPICE settings and cancel active work while retaining completed results.',
    emptyCapabilityInput,
    (_, signal) => ports().simulation(false, signal),
  );
  if (ports().thermal) {
    command(
      'thermal.show',
      'Open Thermal FEM in Layout and wait until its capabilities are ready.',
      emptyCapabilityInput,
      (_, signal) => ports().thermal!(true, signal),
    );
    command(
      'thermal.hide',
      'Hide Thermal FEM and cancel active work while retaining completed results.',
      emptyCapabilityInput,
      (_, signal) => ports().thermal!(false, signal),
    );
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
