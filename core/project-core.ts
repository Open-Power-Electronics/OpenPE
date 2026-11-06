import { compileCapabilitySchema, type CapabilityValidation } from '../api/capability-schema';
import type { CapabilityLevel } from '../api/capabilities';
import { assertPCBLockedEdits } from '../lib/pcb-lock';
import { type Circuit, type Point, uid } from '../lib/circuit';
import {
  appendSchematic,
  createProject,
  findSchematic,
  MAX_PROJECT_BYTES,
  parseProject,
  type Project,
  projectSchematics,
  removeSchematic,
  replaceSchematic,
  schematicSnapshot,
  serializeProject,
} from '../lib/project';
import { type PCB, invalidatePCBFill } from '../lib/pcb';
import { refreshPCBFill } from '../lib/pcb-polygons';
import { partFields, displayPartValue } from '../lib/library';
import { preparePartGeometry, preparePartProperties, type FieldRow } from '../lib/part-properties';
import { applyProposal, extractProposal } from '../lib/proposals';
import {
  duplicateSelection,
  moveSelection,
  moveText,
  placeNoConnect,
  pasteSchematicSelection,
  removeSelection,
  saveAnnotation,
  saveLabel,
  simplifyWires,
  transformSelection,
} from '../lib/schematic-edit';
import { commitWireRoute } from '../lib/wiring';
import { previewSchematicMove } from '../lib/schematic-move';
import { val } from '../lib/sexpr';
import { schematicTexts } from '../lib/schematic-text';
import { displayName, MAX_DISPLAY_NAME_LENGTH } from '../lib/display-name';
import { ownProject } from '../lib/immutable-project';
import { defaultPCBDesignRules } from '../lib/design-rule-checks';
import {
  modelCadFromProject,
  modelCadGeometryKey,
  modelCadObjectSchema,
  modelCadRequiresPreparation,
  modelCadShape,
  newModelCadBooleanObject,
  validateModelCadObject,
  withModelCad,
  type ModelCadObject,
  type ModelCadShape,
} from '../lib/model-cad';
import { extrudeModelCadSketch, modelCadSketchExtrusionSchema } from '../lib/model-cad-sketch';
import {
  projectNativeFiles,
  projectWithNativeFiles,
  withNativeProjectName,
  validateKiCadProjectFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';
import {
  executeLayout,
  layoutCommandDefinitions,
  layoutQueryDefinitions,
  queryLayout,
} from './layout-commands';

/** Private editor models are confined to the in-process adapter. Public queries
 * and project.replace use the existing canonical document format. */
export type ProjectCoreSnapshot = {
  project: Project | null;
  source: string;
  sourceDraft: string | null;
  sourceError: string;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
  editingBlocked: string | null;
};
export type ProjectCoreEvent = {
  type:
    | 'project.changed'
    | 'project.loaded'
    | 'project.materialized'
    | 'source.changed'
    | 'source.applied'
    | 'source.error'
    | 'history.changed'
    | 'core.availability';
  revision: number;
  snapshot: ProjectCoreSnapshot;
};
export type CoreDefinition = {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  level?: CapabilityLevel;
};
export type ProjectCoreOptions = {
  draft?: string | null;
  nativeEntryName?: string;
  /** Pure preparation of a validated immutable snapshot. Library I/O belongs to the host adapter. */
  prepare?: (project: Project) => Project;
};

const text = { type: 'string', minLength: 1, maxLength: 4096 };
const identity = { type: 'string', minLength: 1, maxLength: 200 };
const point = {
  type: 'object',
  properties: {
    x: { type: 'number', minimum: -100000, maximum: 100000 },
    y: { type: 'number', minimum: -100000, maximum: 100000 },
  },
  required: ['x', 'y'],
  additionalProperties: false,
};
const ids = { type: 'array', items: identity, uniqueItems: true, maxItems: 30000 };
const sheet = { schematicId: identity };
const designRuleSettings = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(defaultPCBDesignRules).map((key) => [
      key,
      { type: 'number', minimum: 0, maximum: 1000 },
    ]),
  ),
  additionalProperties: false,
};
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const definition = (id: string, description: string, inputSchema = object()): CoreDefinition => ({
  id,
  description,
  inputSchema,
});
const objectCommand = (...args: Parameters<typeof definition>): CoreDefinition => ({
  ...definition(...args),
  level: 'object',
});
const operationCommand = (...args: Parameters<typeof definition>): CoreDefinition => ({
  ...definition(...args),
  level: 'operation',
});

export const coreQueryDefinitions: CoreDefinition[] = [
  ...layoutQueryDefinitions,
  definition(
    'modelCad.get',
    'Read the bounded box, cylinder, extrusion and Boolean CAD objects for the PCB.',
    object({ boardId: identity }, ['boardId']),
  ),
  definition(
    'schematic.erc',
    'Check the selected schematic for supported electrical rule violations without editing it.',
    object(sheet, ['schematicId']),
  ),
  definition(
    'layout.drc',
    'Check the PCB for supported design rule violations using optional millimetre thresholds.',
    object({ boardId: identity, settings: designRuleSettings }, ['boardId']),
  ),
  definition(
    'project.snapshot',
    'Read canonical design, Source state and revision. Agent observations omit native backing and private draft text.',
  ),
  definition(
    'project.get',
    'Read canonical design. Agent observations omit private native backing.',
  ),
  definition(
    'project.source',
    'Read validated canonical JSON. Agent observations omit private native backing.',
  ),
  definition(
    'source.get',
    'Read validated Source and pending-edit status. Agent observations omit private backing, draft text and parser excerpts.',
  ),
  definition(
    'source.files',
    'Read native design text, including pending edits. Agent access excludes model and log resources.',
  ),
  definition('history.get', 'Read the available document undo and redo counts.'),
  definition('schematic.list', 'List all independent schematics and their stable IDs.'),
  definition(
    'schematic.get',
    'Read one schematic as a complete canonical single-file project.',
    object(sheet, ['schematicId']),
  ),
  definition('core.state', 'Read revision and document/Source/undo availability.'),
];
export const coreCommandDefinitions: CoreDefinition[] = [
  ...layoutCommandDefinitions,
  operationCommand(
    'modelCad.sketch.extrude',
    'Extrude up to six ordered analytic sketch contours with selected-corner fillet/chamfer and planar Union, Difference or Intersection as one prepared undo edit.',
    object({ boardId: identity, sketch: modelCadSketchExtrusionSchema }, ['boardId', 'sketch']),
  ),
  objectCommand(
    'modelCad.add',
    'Add a validated CAD solid, preparing advanced geometry before one undo edit.',
    object({ boardId: identity, object: modelCadObjectSchema }, ['boardId', 'object']),
  ),
  objectCommand(
    'modelCad.update',
    'Update a CAD object, its transform, material and color as one undo edit.',
    object({ boardId: identity, object: modelCadObjectSchema }, ['boardId', 'object']),
  ),
  objectCommand(
    'modelCad.remove',
    'Remove selected CAD objects without changing the PCB.',
    object({ boardId: identity, ids: { ...ids, minItems: 1, maxItems: 64 } }, ['boardId', 'ids']),
  ),
  operationCommand(
    'modelCad.duplicate',
    'Duplicate selected CAD objects with fresh identities and a millimetre translation.',
    object(
      {
        boardId: identity,
        ids: { ...ids, minItems: 1, maxItems: 64 },
        offset: object(
          {
            x: { type: 'number', minimum: -100000, maximum: 100000 },
            y: { type: 'number', minimum: -100000, maximum: 100000 },
            z: { type: 'number', minimum: -100000, maximum: 100000 },
          },
          ['x', 'y', 'z'],
        ),
      },
      ['boardId', 'ids', 'offset'],
    ),
  ),
  operationCommand(
    'modelCad.boolean',
    'Combine two CAD bodies by union, difference or intersection as one prepared undo edit.',
    object(
      {
        boardId: identity,
        operation: { enum: ['union', 'difference', 'intersection'] },
        targetId: identity,
        toolId: identity,
        resultId: identity,
      },
      ['boardId', 'operation', 'targetId', 'toolId'],
    ),
  ),
  objectCommand(
    'project.rename',
    'Rename the project and native project settings as one undo edit.',
    object({ name: { type: 'string', minLength: 1, maxLength: MAX_DISPLAY_NAME_LENGTH } }, [
      'name',
    ]),
  ),
  definition(
    'project.replace',
    'Replace the complete project with validated current-format canonical JSON in one undo transaction.',
    object({ source: { type: 'string', maxLength: MAX_PROJECT_BYTES } }, ['source']),
  ),
  definition(
    'source.update',
    'Update the pending Source draft without changing the validated project.',
    object({ draft: { type: ['string', 'null'], maxLength: MAX_PROJECT_BYTES } }, ['draft']),
  ),
  definition(
    'source.apply',
    'Validate and apply the complete pending Source draft as one undo transaction.',
  ),
  definition(
    'source.updateFile',
    'Edit one native project file without applying any pending file edits.',
    object({ name: identity, source: { type: 'string', maxLength: MAX_PROJECT_BYTES } }, [
      'name',
      'source',
    ]),
  ),
  definition('source.discard', 'Discard pending Source text and its validation error.'),
  definition('history.undo', 'Undo one complete project transaction.'),
  definition('history.redo', 'Redo one complete project transaction.'),
  objectCommand('schematic.add', 'Append an independent schematic file to the project.'),
  objectCommand(
    'schematic.remove',
    'Remove a schematic file, subject to primary PCB ownership.',
    object(sheet, ['schematicId']),
  ),
  operationCommand(
    'schematic.operations',
    'Apply up to 100 validated setValue/addPart/removePart operations atomically.',
    object(
      {
        ...sheet,
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              object(
                {
                  type: { const: 'setValue' },
                  ref: identity,
                  value: { type: 'string', minLength: 1, maxLength: 200 },
                },
                ['type', 'ref', 'value'],
              ),
              object(
                {
                  type: { const: 'addPart' },
                  kind: { enum: ['R', 'C', 'L', 'D', 'NMOS', 'GND', 'Port'] },
                  x: { type: 'number', minimum: -1000, maximum: 1000 },
                  y: { type: 'number', minimum: -1000, maximum: 1000 },
                  value: { type: 'string', maxLength: 200 },
                },
                ['type', 'kind', 'x', 'y'],
              ),
              object({ type: { const: 'removePart' }, ref: identity }, ['type', 'ref']),
            ],
          },
        },
      },
      ['schematicId', 'operations'],
    ),
  ),
  objectCommand(
    'schematic.move',
    'Move selected objects, leaving unselected wires in place.',
    object({ ...sheet, ids, delta: point }, ['schematicId', 'ids', 'delta']),
  ),
  operationCommand(
    'schematic.drag',
    'Reposition selected components and objects while rerouting attached wires to retain original electrical connections. Use for connected component movement; delta is in millimetres. Commits one undo transaction.',
    object({ ...sheet, ids, delta: point }, ['schematicId', 'ids', 'delta']),
  ),
  objectCommand(
    'schematic.transform',
    'Rotate or mirror selected objects in one transaction.',
    object(
      {
        ...sheet,
        ids,
        operation: { enum: ['rotate', 'rotateReverse', 'mirrorX', 'mirrorY'] },
        pivot: point,
      },
      ['schematicId', 'ids', 'operation'],
    ),
  ),
  operationCommand(
    'schematic.pose',
    'Commit a complete canvas pickup pose in one undo transaction: apply ordered rotations/mirrors around anchor, then translate anchor to target. connected retains attached wire networks; false leaves unselected wires in place.',
    object(
      {
        ...sheet,
        ids,
        anchor: point,
        target: point,
        operations: {
          type: 'array',
          maxItems: 128,
          items: { enum: ['rotate', 'rotateReverse', 'mirrorX', 'mirrorY'] },
        },
        connected: { type: 'boolean' },
      },
      ['schematicId', 'ids', 'anchor', 'target', 'operations', 'connected'],
    ),
  ),
  operationCommand(
    'schematic.delete',
    'Delete selected objects and complete attached component leads using the shared deletion rules.',
    object({ ...sheet, ids }, ['schematicId', 'ids']),
  ),
  objectCommand(
    'schematic.duplicate',
    'Copy selected objects with fresh UUIDs/references and return their IDs.',
    object({ ...sheet, ids, delta: point }, ['schematicId', 'ids']),
  ),
  operationCommand(
    'schematic.paste',
    'Paste selected objects and native annotations from a retained canonical JSON source snapshot (source.get().source or JSON.stringify(project.get())) into the same schematic, preserving current objects and allocating fresh IDs/references in one undo transaction. Rejects changed embedded symbols.',
    object(
      {
        ...sheet,
        source: { type: 'string', maxLength: MAX_PROJECT_BYTES },
        ids,
        delta: point,
      },
      ['schematicId', 'source', 'ids', 'delta'],
    ),
  ),
  operationCommand(
    'schematic.wire',
    'Commit all wire-route legs together, splitting deliberate connections.',
    object({ ...sheet, points: { type: 'array', items: point, minItems: 2, maxItems: 30000 } }, [
      'schematicId',
      'points',
    ]),
  ),
  objectCommand(
    'schematic.annotation',
    'Create or edit an annotation at a grid-snapped position.',
    object({ ...sheet, text, position: point, id: identity }, ['schematicId', 'text', 'position']),
  ),
  objectCommand(
    'schematic.label',
    'Create a local/global net label or edit its name, position and global shape using Properties rules.',
    object(
      {
        ...sheet,
        id: identity,
        text,
        position: point,
        scope: { const: 'global' },
        shape: { enum: ['input', 'output', 'bidirectional', 'tri_state', 'passive'] },
      },
      ['schematicId'],
    ),
  ),
  objectCommand(
    'schematic.noConnect',
    'Place a no-connect marker on an existing component pin; an existing marker is retained.',
    object({ ...sheet, position: point }, ['schematicId', 'position']),
  ),
  objectCommand(
    'schematic.text.position',
    'Set a component Reference/Value/Sim.Params or annotation text position on the schematic grid.',
    object({ ...sheet, id: identity, position: point }, ['schematicId', 'id', 'position']),
  ),
  operationCommand(
    'schematic.simplify',
    'Simplify wires using the same topology-preserving preparation as the canvas menu.',
    object(sheet, ['schematicId']),
  ),
  objectCommand(
    'part.properties',
    'Edit a component and its shared units by stable ID using the same value/field rules as Properties.',
    object(
      {
        ...sheet,
        partId: identity,
        reference: identity,
        value: text,
        fields: {
          type: 'array',
          maxItems: 200,
          items: object(
            {
              name: { type: 'string', maxLength: 4096 },
              value: { type: 'string', maxLength: 4096 },
              fresh: { type: 'boolean' },
            },
            ['name', 'value'],
          ),
        },
        position: point,
        rotation: { type: 'number', minimum: -360, maximum: 360 },
      },
      ['schematicId', 'partId'],
    ),
  ),
  objectCommand(
    'part.participation',
    'Set Include in simulation for a component and its shared units independently of plugin availability.',
    object({ ...sheet, partId: identity, included: { type: 'boolean' } }, [
      'schematicId',
      'partId',
      'included',
    ]),
  ),
];

const commandValidators = new Map(
  coreCommandDefinitions.map((item) => [item.id, compileCapabilitySchema(item.inputSchema)]),
);
const queryValidators = new Map(
  coreQueryDefinitions.map((item) => [item.id, compileCapabilitySchema(item.inputSchema)]),
);
function validateInput(
  validators: Map<string, (value: unknown) => CapabilityValidation>,
  id: string,
  input: unknown,
) {
  const validate = validators.get(id);
  if (!validate) throw new Error(`Unknown Core capability: ${id}.`);
  const value = input === undefined ? {} : input;
  const validation = validate(value);
  if (!validation.valid) throw new Error(`Invalid ${id} input: ${validation.error}.`);
  return value as Record<string, any>;
}
/** Framework-independent authoritative project state, transactions and Source.
 * The host owns file capabilities and asynchronous services; they can materialize
 * a still-current document without creating a second user undo transaction. */
export class ProjectCore {
  private project: Project | null = null;
  private source = '';
  private sourceDraft: string | null = null;
  private sourceError = '';
  private nativeEntryName: string | undefined;
  private revision = 0;
  private editingBlocked: string | null = null;
  private previous: Project[] = [];
  private following: Project[] = [];
  private listeners = new Set<(event: ProjectCoreEvent) => void>();
  private preparedModelCadGeometry = new Map<string, ModelCadShape>();
  private preparedModelCadCharacters = 0;
  private snapshot!: ProjectCoreSnapshot;

  constructor(
    initialProject: Project | null,
    private options: ProjectCoreOptions = {},
  ) {
    if (initialProject) {
      this.project = ownProject(initialProject);
      this.source = serializeProject(this.project);
      if (options.nativeEntryName) this.setNativeEntryName(options.nativeEntryName);
    }
    this.assertDraft(options.draft ?? null);
    this.sourceDraft = options.draft === this.source ? null : (options.draft ?? null);
    this.refresh();
  }

  getSnapshot = (): ProjectCoreSnapshot => this.snapshot;

  /** Host-only proof admission; geometry is copied before it enters this Core's bounded registry. */
  acceptPreparedModelCadGeometry(object: ModelCadObject, shapeKey: string): void {
    this.requireEditing();
    validateModelCadObject(object);
    const shape = modelCadShape(object);
    const actualKey = modelCadGeometryKey(shape);
    if (typeof shapeKey !== 'string' || actualKey !== shapeKey)
      throw new Error('The prepared CAD geometry does not match this object.');
    if (!modelCadRequiresPreparation(object)) return;
    if (shapeKey.length > 256000)
      throw new Error('Prepared CAD geometry exceeds the native parameter limit.');
    if (this.preparedModelCadGeometry.has(shapeKey)) {
      this.preparedModelCadGeometry.delete(shapeKey);
      this.preparedModelCadCharacters -= shapeKey.length;
    }
    this.preparedModelCadGeometry.set(shapeKey, structuredClone(shape));
    this.preparedModelCadCharacters += shapeKey.length;
    while (this.preparedModelCadGeometry.size > 64 || this.preparedModelCadCharacters > 2000000) {
      const oldest = this.preparedModelCadGeometry.keys().next().value!;
      this.preparedModelCadGeometry.delete(oldest);
      this.preparedModelCadCharacters -= oldest.length;
    }
  }

  /** Independent advanced bodies whose exact shape is neither current nor host-prepared. */
  pendingModelCadGeometry(project: Project): ModelCadObject[] {
    const known = new Set(
      (this.project ? (modelCadFromProject(this.project)?.objects ?? []) : []).map(
        modelCadGeometryKey,
      ),
    );
    const pending: ModelCadObject[] = [];
    for (const body of modelCadFromProject(project)?.objects ?? []) {
      if (!modelCadRequiresPreparation(body)) continue;
      const key = modelCadGeometryKey(body);
      if (known.has(key) || this.preparedModelCadGeometry.has(key)) continue;
      known.add(key);
      pending.push(structuredClone(body));
    }
    return pending;
  }

  private requirePreparedModelCadGeometry(project: Project): void {
    if (this.pendingModelCadGeometry(project).length)
      throw new Error('Prepare CAD geometry before applying this change.');
  }

  subscribe = (listener: (event: ProjectCoreEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private refresh() {
    this.snapshot = Object.freeze({
      project: this.project,
      source: this.source,
      sourceDraft: this.sourceDraft,
      sourceError: this.sourceError,
      revision: this.revision,
      canUndo: !!this.previous.length && this.sourceDraft === null && this.editingBlocked === null,
      canRedo: !!this.following.length && this.sourceDraft === null && this.editingBlocked === null,
      undoDepth: this.previous.length,
      redoDepth: this.following.length,
      editingBlocked: this.editingBlocked,
    });
  }

  private publish(type: ProjectCoreEvent['type']) {
    this.revision++;
    this.refresh();
    const event = Object.freeze({ type, revision: this.revision, snapshot: this.snapshot });
    // Observers cannot turn an already committed transaction into a failed edit.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* The adapter owns its observer errors. */
      }
    }
  }

  private requireProject(): Project {
    if (!this.project) throw new Error('Open a project before using this command.');
    return this.project;
  }

  private requireAppliedSource() {
    this.requireEditing();
    if (this.sourceDraft !== null)
      throw new Error('Apply the Source edits before changing the project.');
  }

  /** Lifecycle barriers protect the persisted close snapshot while asynchronous
   * cleanup runs. They are runtime state, never document content or undo edits. */
  setEditingBlocked(reason: string | null): void {
    if (reason !== null && (typeof reason !== 'string' || !reason.trim() || reason.length > 4096))
      throw new Error('Use a non-empty lifecycle reason of at most 4096 characters.');
    if (this.editingBlocked === reason) return;
    this.editingBlocked = reason;
    this.publish('core.availability');
  }

  private requireEditing(): void {
    if (this.editingBlocked !== null) throw new Error(this.editingBlocked);
  }

  private assertDraft(draft: string | null) {
    if (
      draft !== null &&
      (typeof draft !== 'string' || new TextEncoder().encode(draft).length > MAX_PROJECT_BYTES)
    )
      throw new Error('Source draft exceeds the supported 8 MB limit.');
  }

  load(project: Project | null, draft: string | null = null): void {
    this.requireEditing();
    const next = project ? ownProject(project, this.project) : null;
    const source = next ? serializeProject(next) : '';
    this.assertDraft(draft);
    this.project = next;
    this.source = source;
    this.sourceDraft = draft === source ? null : draft;
    this.sourceError = '';
    this.previous = [];
    this.following = [];
    this.preparedModelCadGeometry.clear();
    this.preparedModelCadCharacters = 0;
    this.publish('project.loaded');
  }

  private commit(
    next: Project,
    type: ProjectCoreEvent['type'] = 'project.changed',
    applyDraft = false,
  ): boolean {
    this.requireEditing();
    next = ownProject(next, this.project);
    serializeProject(next);
    const prepared = this.options.prepare?.(next) ?? next;
    next = ownProject(prepared, next);
    serializeProject(next);
    // Geometry and its current copper are one edit for every editor/Agent path.
    // Explicit native Source retains its own accepted contours without refilling.
    if (!applyDraft && this.project?.pcb && next.pcb) {
      const pcb = refreshPCBFill(this.project.pcb, next.pcb);
      if (pcb !== next.pcb) next = ownProject({ ...next, pcb }, next);
    }
    this.requirePreparedModelCadGeometry(next);
    const source = serializeProject(next);
    const changed = source !== this.source;
    if (!changed && !applyDraft) return true;
    if (changed) {
      if (this.project) this.previous = [...this.previous.slice(-59), this.project];
      this.following = [];
      this.project = next;
      this.source = source;
    }
    if (applyDraft) {
      this.sourceDraft = null;
      this.sourceError = '';
    }
    this.publish(type);
    return true;
  }

  /** Internal editor adapter. Externally use project.replace with canonical JSON. */
  commitProject(next: Project): boolean {
    this.requireAppliedSource();
    next = ownProject(next, this.project);
    if (
      this.project &&
      (next.name ?? next.schematic.title) !== (this.project.name ?? this.project.schematic.title)
    )
      next = withNativeProjectName(next);
    return this.commit(next);
  }

  replaceSchematic(next: Circuit): boolean {
    this.requireAppliedSource();
    const latest = this.project;
    if (!latest) return this.commit(createProject(next));
    let replacement = replaceSchematic(latest, next);
    if (next.id === latest.schematic.id && latest.pcb) {
      const footprints = latest.pcb.footprints.flatMap((footprint) => {
        if (!footprint.symbolId) return [footprint];
        const old = latest.schematic.parts.find((part) => part.id === footprint.symbolId);
        const part =
          next.parts.find((part) => part.id === footprint.symbolId) ??
          (old && next.parts.find((part) => part.ref === old.ref && part.libId === old.libId));
        if (!part) return [];
        if (Object.hasOwn(partFields(part), 'Footprint') && !partFields(part).Footprint.trim())
          return [];
        return part.id === footprint.symbolId ? [footprint] : [{ ...footprint, symbolId: part.id }];
      });
      const board =
        footprints.length === latest.pcb.footprints.length &&
        footprints.every((footprint, index) => footprint === latest.pcb!.footprints[index])
          ? latest.pcb
          : { ...latest.pcb, footprints };
      replacement = {
        ...replacement,
        pcb: invalidatePCBFill(latest.pcb, board),
      };
    }
    return this.commit(replacement);
  }

  replaceBoard(board: PCB): boolean {
    this.requireAppliedSource();
    const latest = this.requireProject();
    if (latest.pcb) assertPCBLockedEdits(latest.pcb, board);
    // The current document recursively owns this immutable footprint array.
    // Copper-only previews cannot change assignments through the same array;
    // the complete candidate still passes the normal commit validation.
    if (latest.pcb && board.footprints === latest.pcb.footprints)
      return this.commit({ ...latest, pcb: board });
    const assignments = new Map<string, string>();
    for (const footprint of board.footprints) {
      const old = latest.pcb?.footprints.find((item) => item.id === footprint.id);
      if (!old || old.libraryId !== footprint.libraryId) {
        const part = latest.schematic.parts.find((part) => part.id === footprint.symbolId);
        if (part) assignments.set(part.ref, footprint.libraryId);
      }
    }
    for (const footprint of latest.pcb?.footprints ?? []) {
      if (board.footprints.some((item) => item.id === footprint.id)) continue;
      const part = latest.schematic.parts.find((part) => part.id === footprint.symbolId);
      if (part) assignments.set(part.ref, '');
    }
    const schematic = assignments.size
      ? {
          ...latest.schematic,
          parts: latest.schematic.parts.map((part) =>
            assignments.has(part.ref)
              ? { ...part, fields: { ...partFields(part), Footprint: assignments.get(part.ref)! } }
              : part,
          ),
        }
      : latest.schematic;
    return this.commit({
      ...latest,
      schematic,
      pcb: board,
    });
  }

  updateSource(draft: string | null): void {
    this.requireEditing();
    this.assertDraft(draft);
    if (draft === this.source) draft = null;
    if (this.sourceDraft === draft && !this.sourceError) return;
    this.sourceDraft = draft;
    this.sourceError = '';
    this.publish('source.changed');
  }

  /** Source presents native files; the recovery draft is a private file-set envelope. */
  getNativeFiles(): KiCadProjectFiles {
    if (this.sourceDraft !== null) {
      try {
        const draft = JSON.parse(this.sourceDraft);
        if (draft && typeof draft.entry === 'string' && Array.isArray(draft.files)) {
          // Source text may be invalid (including encoding/NUL errors) until
          // Apply. Check only the envelope here so typing stays visible.
          if (
            !draft.files.every(
              (file: unknown) =>
                file &&
                typeof file === 'object' &&
                typeof (file as { source?: unknown }).source === 'string',
            )
          )
            throw new Error('Invalid Source file envelope.');
          validateKiCadProjectFiles({
            ...draft,
            files: draft.files.map(
              (file: { name: string; source: string; encoding?: 'latin1' }) => ({
                ...file,
                source: '',
              }),
            ),
          });
          return draft;
        }
      } catch {
        // An invalid old recovery draft remains protected by the Source barrier.
      }
    }
    return projectNativeFiles(this.requireProject(), this.nativeEntryName);
  }

  /** The native destination is presentation/host state and survives document undo. */
  setNativeEntryName(name: string): void {
    projectNativeFiles(this.requireProject(), name);
    this.nativeEntryName = name;
  }

  updateNativeSource(name: string, source: string): void {
    this.requireEditing();
    const current = this.getNativeFiles();
    if (!current.files.some((file) => file.name === name))
      throw new Error('This file is no longer in the project.');
    const next = {
      ...current,
      files: current.files.map((file) => (file.name === name ? { ...file, source } : file)),
    };
    const baseline = projectNativeFiles(this.requireProject(), this.nativeEntryName);
    const unchanged =
      next.entry === baseline.entry &&
      next.files.length === baseline.files.length &&
      next.files.every((file) =>
        baseline.files.some(
          (base) =>
            base.name === file.name &&
            base.source === file.source &&
            base.encoding === file.encoding,
        ),
      );
    this.updateSource(unchanged ? null : JSON.stringify(next));
  }

  discardSource(): void {
    this.updateSource(null);
  }

  /** Validate pending Source without changing the document, draft, error or history. */
  previewSource(): Project | null {
    if (this.sourceDraft === null) return this.project;
    const draft = JSON.parse(this.sourceDraft);
    const previous = this.requireProject();
    const native = draft && typeof draft.entry === 'string' && Array.isArray(draft.files);
    return native ? projectWithNativeFiles(previous, draft) : parseProject(this.sourceDraft);
  }

  applySource(): Project | null {
    this.requireEditing();
    if (this.sourceDraft === null) return this.project;
    try {
      this.commit(this.previewSource()!, 'source.applied', true);
      return this.project;
    } catch (error) {
      const message = (error as Error).message;
      if (this.sourceError !== message) {
        this.sourceError = message;
        this.publish('source.error');
      }
      return null;
    }
  }

  undo(): boolean {
    this.requireAppliedSource();
    if (!this.project || !this.previous.length) return false;
    this.following.push(this.project);
    this.project = this.previous.pop()!;
    this.source = serializeProject(this.project);
    this.publish('history.changed');
    return true;
  }

  redo(): boolean {
    this.requireAppliedSource();
    if (!this.project || !this.following.length) return false;
    this.previous.push(this.project);
    this.project = this.following.pop()!;
    this.source = serializeProject(this.project);
    this.publish('history.changed');
    return true;
  }

  materialize(basis: Project, next: Project): boolean {
    if (this.editingBlocked !== null) return false;
    if (this.project !== basis || this.sourceDraft !== null) return false;
    next = ownProject(next, basis);
    serializeProject(next);
    if (basis.pcb && next.pcb) {
      const pcb = refreshPCBFill(basis.pcb, next.pcb);
      if (pcb !== next.pcb) next = ownProject({ ...next, pcb }, next);
    }
    this.requirePreparedModelCadGeometry(next);
    const source = serializeProject(next);
    if (source === this.source) return true;
    this.project = next;
    this.source = source;
    this.publish('project.materialized');
    return true;
  }

  private async checkRules(id: string, args: Record<string, any>, signal?: AbortSignal) {
    this.requireEditing();
    if (this.sourceDraft !== null)
      throw new Error('Apply the Source edits before running rule checks.');
    signal?.throwIfAborted();
    const project = this.requireProject();
    const revision = this.revision;
    const ready = () => {
      signal?.throwIfAborted();
      this.requireEditing();
      if (this.project !== project || this.revision !== revision || this.sourceDraft !== null)
        throw new Error('The project changed during rule checks. Run the checks again.');
    };
    if (id === 'schematic.erc') {
      const schematic = findSchematic(project, args.schematicId);
      if (!schematic) throw new Error('This schematic file is no longer in the project.');
      const { runSchematicERC } = await import('../lib/schematic-erc');
      ready();
      return {
        ...runSchematicERC(schematic),
        revision: String(revision),
        schematicId: schematic.id,
      };
    }
    if (!project.pcb || project.pcb.id !== args.boardId)
      throw new Error('This PCB layout is no longer in the project.');
    const { runPCBDesignRules } = await import('../lib/pcb-drc');
    ready();
    return {
      ...runPCBDesignRules(project.pcb, args.settings),
      revision: String(revision),
      boardId: project.pcb.id,
      settings: { ...defaultPCBDesignRules, ...args.settings },
    };
  }

  private buildModelCadCommand(id: string, input: Record<string, any>) {
    const args = structuredClone(input);
    const project = this.requireProject();
    if (!project.pcb || project.pcb.id !== args.boardId)
      throw new Error('This PCB layout is no longer in the project.');
    let objects = modelCadFromProject(project)?.objects ?? [];
    let changed: ModelCadObject | undefined;
    let duplicates: ModelCadObject[] | undefined;
    if (id === 'modelCad.add' || id === 'modelCad.sketch.extrude') {
      changed =
        id === 'modelCad.add'
          ? validateModelCadObject(args.object)
          : extrudeModelCadSketch(args.sketch);
      if (objects.some((body) => body.id.toLowerCase() === changed!.id.toLowerCase()))
        throw new Error('This CAD object identity already exists.');
      objects = [...objects, changed];
    } else if (id === 'modelCad.update') {
      changed = validateModelCadObject(args.object);
      if (!objects.some((body) => body.id === changed!.id))
        throw new Error('This CAD object is no longer in the project.');
      objects = objects.map((body) => (body.id === changed!.id ? changed! : body));
    } else if (id === 'modelCad.boolean') {
      const target = objects.find((body) => body.id === args.targetId),
        tool = objects.find((body) => body.id === args.toolId);
      if (!target || !tool) throw new Error('A Boolean operand is no longer in the project.');
      args.resultId ??= uid();
      if (objects.some((body) => body.id.toLowerCase() === args.resultId.toLowerCase()))
        throw new Error('The Boolean result needs a fresh object identity.');
      changed = newModelCadBooleanObject(target, tool, args.operation, args.resultId);
      objects = objects.flatMap((body) =>
        body.id === target.id ? [changed!] : body.id === tool.id ? [] : [body],
      );
    } else {
      if (args.ids.some((selected: string) => !objects.some((body) => body.id === selected)))
        throw new Error('A selected CAD object is no longer in the project.');
      const selected = new Set<string>(args.ids);
      if (id === 'modelCad.remove') objects = objects.filter((body) => !selected.has(body.id));
      else {
        duplicates = objects
          .filter((body) => selected.has(body.id))
          .map((body) => ({
            ...structuredClone(body),
            id: uid(),
            name: `${body.name.slice(0, 75)} copy`,
            position: {
              x: body.position.x + args.offset.x,
              y: body.position.y + args.offset.y,
              z: body.position.z + args.offset.z,
            },
          }));
        objects = [...objects, ...duplicates];
      }
    }
    const next = withModelCad(project, objects.length ? { version: 1, objects } : null);
    serializeProject(next);
    return { project: next, input: args, object: changed, objects: duplicates };
  }

  /** Host preflight only: no publication, proof admission, undo entry or caller-owned containers. */
  previewModelCadCommand(
    id: string,
    input?: unknown,
  ): { project: Project; input: Record<string, any> } {
    this.requireAppliedSource();
    if (!id.startsWith('modelCad.')) throw new Error('Preview a Model CAD command.');
    const args = validateInput(commandValidators, id, input);
    const preview = this.buildModelCadCommand(id, args);
    return { project: structuredClone(preview.project), input: structuredClone(preview.input) };
  }

  query(id: string, input?: unknown, options: { signal?: AbortSignal } = {}): unknown {
    const args = validateInput(queryValidators, id, input);
    if (id === 'schematic.erc' || id === 'layout.drc')
      return this.checkRules(id, args, options.signal);
    const metadata = {
      revision: String(this.revision),
      editingBlocked: this.editingBlocked,
      sourceDraft: this.sourceDraft,
      sourceError: this.sourceError,
      canUndo: this.snapshot.canUndo,
      canRedo: this.snapshot.canRedo,
      undoDepth: this.previous.length,
      redoDepth: this.following.length,
    };
    if (id === 'project.snapshot')
      return { ...metadata, project: this.project ? JSON.parse(this.source) : null };
    if (id === 'project.get') return this.project ? JSON.parse(this.source) : null;
    if (id === 'project.source') return this.source;
    if (id === 'source.get')
      return { source: this.source, sourceDraft: this.sourceDraft, sourceError: this.sourceError };
    if (id === 'source.files') return this.getNativeFiles();
    if (id === 'history.get')
      return {
        canUndo: this.snapshot.canUndo,
        canRedo: this.snapshot.canRedo,
        undoDepth: this.previous.length,
        redoDepth: this.following.length,
      };
    if (id === 'core.state')
      return { ...metadata, hasProject: !!this.project, sourcePending: this.sourceDraft !== null };
    const project = this.requireProject();
    if (id === 'modelCad.get') {
      if (!project.pcb || project.pcb.id !== args.boardId)
        throw new Error('This PCB layout is no longer in the project.');
      return { boardId: project.pcb.id, modelCad: structuredClone(modelCadFromProject(project)) };
    }
    if (id.startsWith('layout.')) {
      const result = queryLayout(project.pcb, id, args);
      return id === 'layout.get' ? { ...result, project: JSON.parse(this.source) } : result;
    }
    if (id === 'schematic.list')
      return projectSchematics(project).map((file) => ({
        id: file.id,
        name: file.title,
        primary: file.id === project.schematic.id,
      }));
    const schematic = findSchematic(project, args.schematicId);
    if (!schematic) throw new Error('This schematic file is no longer in the project.');
    return JSON.parse(serializeProject(schematicSnapshot(project, schematic.id)));
  }

  execute(
    id: string,
    input?: unknown,
    options: { expectedRevision?: number | string } = {},
  ): unknown {
    this.requireEditing();
    const args = validateInput(commandValidators, id, input);
    if (
      options.expectedRevision !== undefined &&
      String(options.expectedRevision) !== String(this.revision)
    )
      throw new Error(
        'The project changed since this command was prepared. Query the current project and try again.',
      );
    if (id === 'source.update') {
      this.updateSource(args.draft);
      return this.query('source.get');
    }
    if (id === 'source.updateFile') {
      this.updateNativeSource(args.name, args.source);
      return this.query('source.files');
    }
    if (id === 'source.discard') {
      this.discardSource();
      return this.query('source.get');
    }
    if (id === 'source.apply') {
      if (!this.applySource() && this.sourceDraft !== null) throw new Error(this.sourceError);
      return this.query('project.snapshot');
    }
    this.requireAppliedSource();
    if (id === 'history.undo') return this.undo();
    if (id === 'history.redo') return this.redo();
    if (id === 'project.replace') {
      this.commitProject(parseProject(args.source));
      return this.query('project.snapshot');
    }
    const project = this.requireProject();
    if (id === 'project.rename') {
      this.commitProject({ ...project, name: displayName(args.name) });
      return this.query('project.snapshot');
    }
    if (id.startsWith('modelCad.')) {
      const preview = this.buildModelCadCommand(id, args);
      this.commitProject(preview.project);
      return {
        revision: String(this.revision),
        ...(this.query('modelCad.get', { boardId: project.pcb!.id }) as object),
        ...(preview.object ? { object: structuredClone(preview.object) } : {}),
        ...(preview.objects ? { objects: structuredClone(preview.objects) } : {}),
      };
    }
    if (id.startsWith('layout.')) {
      const result = executeLayout(project.pcb, id, args);
      // Explicit Fill also enables its target and supplies the requested minimum.
      if (id === 'layout.fill') this.commitProject({ ...project, pcb: result.board });
      else this.replaceBoard(result.board);
      return { revision: String(this.revision), ...result.result };
    }
    if (id === 'schematic.add') {
      const result = appendSchematic(project);
      this.commitProject(result.project);
      return { schematicId: result.schematic.id, revision: String(this.revision) };
    }
    if (id === 'schematic.remove') {
      this.commitProject(removeSchematic(project, args.schematicId));
      return this.query('project.snapshot');
    }
    const schematic = findSchematic(project, args.schematicId);
    if (!schematic) throw new Error('This schematic file is no longer in the project.');
    let next: Circuit;
    let selection: string[] | undefined;
    switch (id) {
      case 'schematic.operations': {
        const operations = extractProposal(
          '```openpe\n' + JSON.stringify(args.operations) + '\n```',
        );
        next = applyProposal(schematic, operations!);
        break;
      }
      case 'schematic.move':
      case 'schematic.drag':
        next = moveSelection(schematic, args.ids, args.delta, id === 'schematic.drag');
        break;
      case 'schematic.transform':
        next = transformSelection(schematic, args.ids, args.operation, args.pivot);
        break;
      case 'schematic.pose':
        next = previewSchematicMove(
          schematic,
          args.ids,
          args.anchor,
          args.target,
          args.operations,
          args.connected,
        );
        break;
      case 'schematic.delete':
        next = removeSelection(schematic, args.ids);
        break;
      case 'schematic.duplicate': {
        const result = duplicateSelection(schematic, args.ids, args.delta);
        next = result.circuit;
        selection = result.selection;
        break;
      }
      case 'schematic.paste': {
        const snapshot = findSchematic(parseProject(args.source), args.schematicId);
        if (!snapshot) throw new Error('Copy a selection from this document first.');
        const result = pasteSchematicSelection(schematic, snapshot, args.ids, args.delta);
        next = result.circuit;
        selection = result.selection;
        break;
      }
      case 'schematic.wire':
        next = commitWireRoute(schematic, args.points);
        break;
      case 'schematic.annotation':
        next = saveAnnotation(schematic, args.text, args.position as Point, args.id).circuit;
        break;
      case 'schematic.label': {
        const result = saveLabel(schematic, args);
        next = result.circuit;
        selection = [result.id];
        break;
      }
      case 'schematic.noConnect': {
        const result = placeNoConnect(schematic, args.position);
        next = result.circuit;
        selection = [result.id];
        break;
      }
      case 'schematic.text.position':
        if (
          !args.id.startsWith('field/') &&
          !schematicTexts(schematic.original).some((text) => text.id === args.id)
        )
          throw new Error('Select a component field or annotation text.');
        next = moveText(schematic, args.id, args.position);
        break;
      case 'schematic.simplify':
        next = simplifyWires(schematic);
        break;
      case 'part.properties':
      case 'part.participation': {
        const part = schematic.parts.find((part) => part.id === args.partId);
        if (!part)
          throw new Error(
            'This component no longer exists. Query the current project and try again.',
          );
        next = {
          ...schematic,
          parts: schematic.parts.map((unit) => {
            if (unit.ref !== part.ref) return unit;
            const edited = { ...unit };
            if (id === 'part.participation') {
              edited.excludeFromSimulation = !args.included;
              return edited;
            }
            const fields = (args.fields ??
              Object.entries(partFields(unit)).map(([name, value]) => ({
                name,
                value,
              }))) as FieldRow[];
            const change = preparePartProperties(
              unit,
              args.reference ?? unit.ref,
              args.value ?? displayPartValue(unit),
              fields,
            );
            if (change) {
              Object.assign(edited, change);
              if (unit.raw)
                edited.raw = unit.raw.filter(
                  (node) =>
                    !Array.isArray(node) ||
                    node[0] !== 'property' ||
                    ['Reference', 'Value'].includes(val(node)) ||
                    Object.hasOwn(change.fields, val(node)),
                );
            }
            if (args.position && unit.id === part.id) {
              edited.x = preparePartGeometry('x', args.position.x);
              edited.y = preparePartGeometry('y', args.position.y);
            }
            if (args.rotation !== undefined && unit.id === part.id)
              edited.rotation = preparePartGeometry('rotation', args.rotation);
            return edited;
          }),
        };
        break;
      }
      default:
        throw new Error(`Unknown Core command: ${id}.`);
    }
    this.replaceSchematic(next);
    return { revision: String(this.revision), ...(selection ? { selection } : {}) };
  }
}
