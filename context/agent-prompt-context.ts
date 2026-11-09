import type { AgentWorkspaceContext } from './agent-workspace-context';
import type { LayoutAnnotationContext } from '../lib/agent-annotations';
import { parseProject, projectSchematics } from '../lib/project';
import { pinPositions, type Circuit } from '../lib/circuit';
import { projectNetGroups } from '../lib/project-net-groups';
import { unitGraphics } from '../lib/library';
import { child, children, val } from '../lib/sexpr';
import { modelCadFromProject } from '../lib/model-cad';
import { projectDatasheetContext } from '../lib/example-datasheets';

const collectionLimit = 256;
const bounded = <T>(items: T[]) => ({
  total: items.length,
  items: items.slice(0, collectionLimit),
  ...(items.length > collectionLimit ? { truncated: true } : {}),
});

/** Semantic provider observations, never writable project documents. Complete
 * canonical/native data stays behind explicit queries on the originating host. */
export function agentPromptContext(value: unknown, progressive = false): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const context = value as Record<string, unknown>;
  const workspace = context.workspace as AgentWorkspaceContext | undefined;
  if (!workspace) return value;
  const project = parseProject(JSON.stringify(workspace.project));
  const datasheet = projectDatasheetContext(project);
  const selected = new Set(
    Array.isArray(workspace.ui.selection) ? (workspace.ui.selection as string[]) : [],
  );
  const summarizeSheet = (circuit: Circuit) => {
    const active = circuit.id === workspace.ui.activeSchematicId;
    const summary = {
      id: circuit.id,
      title: circuit.title,
      counts: {
        components: circuit.parts.length,
        wires: circuit.wires.length,
        labels: circuit.labels.length,
        junctions: circuit.junctions.length,
        noConnects: circuit.noConnects?.length ?? 0,
      },
    };
    if (!active) return summary;
    if (progressive)
      return {
        ...summary,
        selectedComponents: bounded(
          circuit.parts
            .filter((part) => selected.has(part.id))
            .map(({ id, ref, value }) => ({ id, ref, value })),
        ),
      };
    // Keep selected components visible when a large sheet exceeds the bound.
    const parts = [...circuit.parts].sort(
      (a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)),
    );
    const visibleParts = parts.slice(0, collectionLimit);
    const groups = projectNetGroups(circuit)
      .map((group) => ({
        ...group,
        selected:
          group.pins.some(
            (key) => !key.startsWith('physical:') && selected.has(JSON.parse(key)[0]),
          ) ||
          group.wires.some((index) => selected.has(circuit.wires[index].id)) ||
          group.labels.some((index) => selected.has(circuit.labels[index].id)),
      }))
      .sort((a, b) => Number(b.selected) - Number(a.selected));
    const byId = new Map(circuit.parts.map((part) => [part.id, part]));
    const symbols = [...new Set(visibleParts.map((part) => part.libId))];
    return {
      ...summary,
      components: bounded(
        parts.map(({ raw: _raw, fields, ...part }) => ({
          ...part,
          ...(fields?.Footprint ? { footprint: fields.Footprint } : {}),
          ...(fields?.Description ? { description: fields.Description } : {}),
          simulation: Object.fromEntries(
            Object.entries(fields ?? {}).filter(([key]) => key.startsWith('Sim.')),
          ),
        })),
      ),
      connections: bounded(
        groups.map((group) => ({
          labels: [...new Set(group.labels.map((index) => circuit.labels[index].text))],
          // Tuples are [component reference, native pin number]. Geometry owns
          // grouping; drawing crossings never create a connection here.
          pins: group.pins
            .filter((key) => !key.startsWith('physical:'))
            .map((key) => {
              const [id, pin] = JSON.parse(key) as [string, string];
              return [byId.get(id)!.ref, pin];
            }),
        })),
      ),
      symbolPins: Object.fromEntries(
        symbols.map((id) => [
          id,
          bounded(
            children(circuit.libraries[id], 'symbol').flatMap((unit) =>
              children(unit, 'pin').map((pin) => ({
                unit: val(unit),
                number: val(child(pin, 'number')),
                name: val(child(pin, 'name')),
                type: val(pin),
              })),
            ),
          ),
        ]),
      ),
      selectedGeometry: {
        wires: bounded(
          circuit.wires
            .filter((wire) => selected.has(wire.id))
            .map(({ raw: _raw, ...wire }) => wire),
        ),
        labels: bounded(
          circuit.labels
            .filter((label) => selected.has(label.id))
            .map(({ raw: _raw, ...label }) => label),
        ),
        junctions: bounded(
          circuit.junctions
            .filter((point) => selected.has(point.id))
            .map(({ raw: _raw, ...point }) => point),
        ),
        noConnects: bounded(
          (circuit.noConnects ?? [])
            .filter((point) => selected.has(point.id))
            .map(({ raw: _raw, ...point }) => point),
        ),
        pins: visibleParts
          .filter((part) => selected.has(part.id))
          .map((part) => {
            const positions = pinPositions(part, circuit.libraries[part.libId]);
            return {
              componentId: part.id,
              pins: bounded(
                unitGraphics(circuit.libraries[part.libId], part.unit || 1)
                  .flatMap((unit) => children(unit, 'pin'))
                  .map((pin, index) => ({
                    number: val(child(pin, 'number')),
                    ...positions[index],
                  })),
              ),
            };
          }),
      },
    };
  };
  const board = project.pcb;
  const model = modelCadFromProject(project);
  const layout = context.layout as LayoutAnnotationContext | undefined;
  const { projects: _projects, ...observedUI } = workspace.ui;
  return {
    id: context.id,
    basis: context.basis,
    // Attachment freshness uses these identities. The PCB overview below
    // already carries the current board's design summary.
    ...(layout
      ? { layout: { id: layout.id, circuitId: layout.circuitId, basis: layout.basis } }
      : {}),
    workspace: {
      version: workspace.version,
      capturedAt: workspace.capturedAt,
      project: {
        id: project.id,
        name: project.name,
        units: project.units,
        schematics: projectSchematics(project).map(summarizeSheet),
        nativeFileNames: project.nativeFiles?.files.map(({ name }) => name),
        pcb: board
          ? {
              id: board.id,
              layers: board.layers,
              thickness: board.thickness,
              counts: Object.fromEntries(
                (['nets', 'footprints', 'tracks', 'vias', 'zones', 'graphics'] as const).map(
                  (key) => [key, board[key].length],
                ),
              ),
              ...(!progressive && workspace.ui.view === 'layout'
                ? {
                    footprints: bounded(
                      board.footprints.map(
                        ({ id, reference, libraryId, x, y, rotation, side, pads }) => ({
                          id,
                          reference,
                          libraryId,
                          x,
                          y,
                          rotation,
                          side,
                          padCount: pads.length,
                        }),
                      ),
                    ),
                  }
                : {}),
            }
          : null,
        modelCad: model
          ? {
              objectCount: model.objects.length,
              ...(!progressive && workspace.ui.view === '3d'
                ? {
                    objects: model.objects.map(({ id, name, kind, position, rotation, size }) => ({
                      id,
                      name,
                      kind,
                      position,
                      rotation,
                      size,
                    })),
                  }
                : {}),
            }
          : null,
      },
      source: {
        pending: workspace.source.pending,
        error: workspace.source.error,
        draftCharacters: workspace.source.draftCharacters,
      },
      ui: progressive
        ? {
            active: workspace.ui.active,
            view: workspace.ui.view,
            activeSchematicId: workspace.ui.activeSchematicId,
            selection: bounded([...selected]),
          }
        : observedUI,
      icDatasheet: progressive
        ? {
            status: datasheet.status,
            bindings: bounded(datasheet.bindings),
            document: datasheet.record?.datasheet,
          }
        : datasheet,
      simulation: progressive ? { status: workspace.simulation?.status } : workspace.simulation,
      thermal:
        progressive && workspace.thermal ? { status: workspace.thermal.status } : workspace.thermal,
    },
  };
}
