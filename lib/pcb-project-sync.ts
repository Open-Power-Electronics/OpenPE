import type { Project } from './project';
import { serializeProject } from './project';
import { isOwnedProject, ownProject } from './immutable-project';
import { onlineFootprintLibrary, partFields, unitGraphics } from './library';
import { toProjectDocument } from './project-document';
import { child, children, val } from './sexpr';
import { partSchematicSection } from './schematic-section';
import { attachOnlineFootprint, projectFootprintSource } from './library-project-assets';
import {
  pcbUpdateFootprintIds,
  pcbPinKey,
  pcbIncludedParts,
  schematicPCBPhysicalNets,
  updatePCBFromSchematic,
  type FootprintSource,
  type EmbeddedFootprintAssignment,
} from './pcb-sync';

export type LayoutSyncStatus = { pending: boolean; error: string; warnings: string[] };
export type SyncedProject = { project: Project; warnings: string[] };

function pcbSourceDocument(project: Project) {
  const document = toProjectDocument(
    { ...project, pcb: null, additionalSchematics: undefined },
    true,
  );
  // Captions and simulation fields do not change physical packages or pin nets.
  // Keep a loaded board's native net aliases authoritative for these edits.
  const schematic = { ...document.schematic };
  const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
  if (schematic.components)
    schematic.components = schematic.components.map((source) => {
      const component = { ...source };
      const part = parts.get(source.id)!;
      const footprint = (partFields(part).Footprint || '').trim();
      // Physical power symbols name rails with the working Value, independently
      // of the private snapshot's normalized simulation value representation.
      component.value = child(project.schematic.libraries[part.libId], 'power') ? part.value : '';
      delete component.simulation;
      delete component.fields;
      if (footprint) component.fields = { Footprint: footprint };
      delete component.fieldLayout;
      delete component.fieldOrder;
      if (source.kicad) {
        component.kicad = source.kicad.filter((node) => node[0] !== 'exclude_from_sim');
        if (!component.kicad.length) delete component.kicad;
      }
      return component;
    });
  return { schematic, libraries: document.libraries };
}

export function schematicPCBSourceFingerprint(project: Project): string {
  const { schematic, libraries } = pcbSourceDocument(project);
  return JSON.stringify([schematic, libraries]);
}

/** An optional, conservative equivalence check after the structural guard misses.
 * Connectivity failures disable reuse; they do not make admission/viewing an
 * already-loaded board depend on a successful schematic-to-PCB compilation. */
function physicalSourceFingerprint(project: Project): string | null {
  try {
    const { schematic } = pcbSourceDocument(project);
    const primaryParts = new Map(project.schematic.parts.map((part) => [part.id, part]));
    const assignedReferences = new Set(
      project.schematic.parts
        .filter((part) => (partFields(part).Footprint || '').trim())
        .map((part) => part.ref),
    );
    const linkedReferences = new Set<string>();
    for (const footprint of project.pcb?.footprints ?? []) {
      const part = primaryParts.get(footprint.symbolId ?? '');
      if (part) linkedReferences.add(part.ref);
    }
    const included = new Set(
      pcbIncludedParts(project.schematic)
        .filter((part) => assignedReferences.has(part.ref) || linkedReferences.has(part.ref))
        .map((part) => part.id),
    );
    // An imported board may retain a linked package whose symbol is excluded
    // from board output. Its source metadata must still guard loaded authority.
    for (const part of project.schematic.parts)
      if (linkedReferences.has(part.ref)) included.add(part.id);
    const components = schematic.components?.filter((part) => included.has(part.id));
    const libraries = [
      ...new Set(
        project.schematic.parts.filter((part) => included.has(part.id)).map((part) => part.libId),
      ),
    ]
      .sort()
      .map((id) => [id, project.schematic.libraries[id]]);
    const physicalPins = new Set(
      project.schematic.parts
        .filter((part) => included.has(part.id))
        .flatMap((part) =>
          unitGraphics(project.schematic.libraries[part.libId], part.unit || 1).flatMap((unit) =>
            children(unit, 'pin').map((pin) => pcbPinKey(part.ref, val(child(pin, 'number')))),
          ),
        ),
    );
    const nets = schematicPCBPhysicalNets(project.schematic, project.pcb ?? undefined)
      .map((net) => ({ ...net, pins: net.pins.filter((pin) => physicalPins.has(pin)) }))
      .filter((net) => net.pins.length > 0);
    return JSON.stringify([schematic.id, components, libraries, nets]);
  } catch {
    return null;
  }
}

/** Per-workbench library cache. The canonical PCB remains in the same Project.
 * Resolved snapshots are reused across undo, including their generated UUIDs. */
export class PCBProjectSync {
  readonly sources = new Map<string, FootprintSource>();
  private snapshots = new Map<string, SyncedProject>();
  private prepared = new WeakMap<Project, SyncedProject>();
  private boardSources = new WeakMap<Project['schematic'], string>();
  private requiredPackages = new WeakMap<Project, Set<string>>();
  private loadedSchematic?: {
    projectId: string;
    fingerprint: string;
    physicalFingerprint: string | null;
  };
  private embedded = new Map<string, EmbeddedFootprintAssignment>();

  constructor(initial?: Project | null) {
    if (!initial?.pcb) return;
    this.loadedSchematic = {
      projectId: initial.id,
      fingerprint: this.boardSourceFingerprint(initial),
      physicalFingerprint: physicalSourceFingerprint(initial),
    };
    const parts = new Map(initial.schematic.parts.map((part) => [part.id, part]));
    for (const footprint of initial.pcb.footprints) {
      const part = footprint.symbolId ? parts.get(footprint.symbolId) : undefined;
      const assignment = part && (partFields(part).Footprint || '').trim();
      if (assignment)
        this.embedded.set(footprint.id, { libraryId: footprint.libraryId, assignment });
    }
  }

  private boardSourceFingerprint(project: Project): string {
    // Only Core-owned snapshots guarantee that every nested object is immutable.
    // Their primary schematic can also be shared by board/other-sheet edits.
    if (!isOwnedProject(project)) return schematicPCBSourceFingerprint(project);
    const cached = this.boardSources.get(project.schematic);
    if (cached !== undefined) return cached;
    const fingerprint = schematicPCBSourceFingerprint(project);
    this.boardSources.set(project.schematic, fingerprint);
    return fingerprint;
  }

  private remember(project: Project, value: SyncedProject): SyncedProject {
    // Cache wrappers and notices together so consumers cannot poison later undo
    // or follow-up materialization results through a returned mutable array.
    Object.freeze(value.warnings);
    Object.freeze(value);
    if (isOwnedProject(project)) this.prepared.set(project, value);
    return value;
  }

  retainNativeSnapshot(project: Project): void {
    this.remember(project, { project, warnings: [] });
  }

  private footprintSources(project: Project, ids: readonly string[]) {
    const sources = new Map(this.sources);
    for (const id of ids) {
      if (!onlineFootprintLibrary(id)) continue;
      const local = projectFootprintSource(project, id);
      if (local) sources.set(id, local);
      else if (sources.get(id)?.projectAssets !== true) sources.delete(id);
    }
    return sources;
  }

  private requiredPackageIds(project: Project, previous?: Project | null): Set<string> {
    if (!previous && !this.requiredPackages.has(project)) return new Set();
    const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
    const linkedReferences = new Set(
      (project.pcb?.footprints ?? []).flatMap((footprint) => {
        const part = parts.get(footprint.symbolId ?? '');
        return part ? [part.ref] : [];
      }),
    );
    const assignedReferences = new Set(
      project.schematic.parts
        .filter((part) => (partFields(part).Footprint || '').trim())
        .map((part) => part.ref),
    );
    const required = new Set([
      ...(this.requiredPackages.get(project) ?? []),
      ...(previous ? (this.requiredPackages.get(previous) ?? []) : []),
    ]);
    if (previous) {
      const before = new Map(previous.schematic.parts.map((part) => [part.id, part]));
      for (const part of project.schematic.parts) {
        const old = before.get(part.id);
        if (
          old &&
          partSchematicSection(old) === 'simulation' &&
          partSchematicSection(part) === 'hardware'
        )
          required.add(part.id);
      }
    }
    for (const id of required) {
      const part = parts.get(id);
      if (
        !part ||
        partSchematicSection(part) !== 'hardware' ||
        child(project.schematic.libraries[part.libId], 'power') ||
        !assignedReferences.has(part.ref) ||
        linkedReferences.has(part.ref)
      )
        required.delete(id);
    }
    if (isOwnedProject(project)) {
      if (required.size) this.requiredPackages.set(project, required);
      else this.requiredPackages.delete(project);
    }
    return required;
  }

  private fulfillsPackages(project: Project, ids: ReadonlySet<string>): boolean {
    const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
    const linkedReferences = new Set(
      (project.pcb?.footprints ?? []).flatMap((footprint) => {
        const part = parts.get(footprint.symbolId ?? '');
        return part ? [part.ref] : [];
      }),
    );
    return [...ids].every((id) => {
      const part = parts.get(id);
      return part && linkedReferences.has(part.ref);
    });
  }

  prepare(project: Project, previousProject?: Project | null): SyncedProject | null {
    // Returning a native board-excluded component to Hardware is a deliberate
    // package request. Carry it across accepted snapshots while its library is
    // loading; an initial-board equivalence guard must not hide the missing part.
    const required = this.requiredPackageIds(project, previousProject);
    const prepared = isOwnedProject(project) ? this.prepared.get(project) : undefined;
    if (prepared && (!required.size || this.fulfillsPackages(prepared.project, required))) {
      this.requiredPackages.delete(project);
      return prepared;
    }
    const source = serializeProject(project);
    const cached = this.snapshots.get(source);
    if (cached && (!required.size || this.fulfillsPackages(cached.project, required))) {
      this.requiredPackages.delete(project);
      return this.remember(project, cached);
    }
    // An opened board is authoritative. Viewing, saving, board-only edits and
    // changes to other sheets must not normalize its nets or replace its packages.
    if (
      project.pcb &&
      !required.size &&
      this.loadedSchematic?.projectId === project.id &&
      (this.loadedSchematic.fingerprint === this.boardSourceFingerprint(project) ||
        (this.loadedSchematic.physicalFingerprint !== null &&
          this.loadedSchematic.physicalFingerprint === physicalSourceFingerprint(project)))
    )
      return this.remember(project, { project, warnings: [] });
    const ids = pcbUpdateFootprintIds(project.schematic, project.pcb ?? undefined, this.embedded);
    const sources = this.footprintSources(project, ids);
    if (ids.some((id) => !sources.has(id))) return null;
    // Schematics without assigned packages do not manufacture an empty board.
    if (!project.pcb && !ids.length) return this.remember(project, { project, warnings: [] });
    const result = updatePCBFromSchematic(
      project.schematic,
      project.pcb ?? undefined,
      sources,
      this.embedded,
    );
    let candidate = result.changed ? { ...project, pcb: result.board } : project;
    for (const id of ids) candidate = attachOnlineFootprint(candidate, sources.get(id)!);
    const next = ownProject(candidate, isOwnedProject(project) ? project : undefined);
    this.requiredPackages.delete(project);
    this.requiredPackages.delete(next);
    const normalized = next === project ? source : serializeProject(next);
    const value = this.remember(project, { project: next, warnings: result.warnings });
    this.prepared.set(next, value);
    // Bound retained snapshots by bytes as well as count; these are transient.
    if (source.length <= 1000000) {
      this.snapshots.set(source, value);
      // Retain replacement notices when the follow-up render sees the already
      // materialized document. A later design edit recomputes its own notices.
      if (normalized.length <= 1000000) this.snapshots.set(normalized, value);
      while (this.snapshots.size > 12) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    return value;
  }

  async resolve(
    project: Project,
    load: (id: string, signal: AbortSignal) => Promise<FootprintSource>,
    signal: AbortSignal,
  ): Promise<SyncedProject> {
    const ready = this.prepare(project);
    if (ready) return ready;
    const needed = pcbUpdateFootprintIds(
      project.schematic,
      project.pcb ?? undefined,
      this.embedded,
    );
    const sources = this.footprintSources(project, needed);
    const ids = needed.filter((id) => !sources.has(id));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, ids.length) }, async () => {
        while (cursor < ids.length) {
          signal.throwIfAborted();
          const id = ids[cursor++];
          const detail = await load(id, signal);
          signal.throwIfAborted();
          if (detail.id !== id || !Array.isArray(detail.footprint))
            throw new Error(`${id}: invalid footprint library response.`);
          const library = onlineFootprintLibrary(id);
          if (library && detail.projectAssets !== true)
            throw new Error(`${id}: prepare the ${library} project package before placement.`);
          this.sources.set(id, detail);
        }
      }),
    );
    signal.throwIfAborted();
    return this.prepare(project)!;
  }
}
