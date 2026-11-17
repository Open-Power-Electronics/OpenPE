import type { BoardZone, PCB } from '../lib/pcb';
import { pcbFillInputsChanged } from '../lib/pcb';
import { ownProjectData } from '../lib/immutable-project';
import { filledCopperPolygons, polygonPath, refreshPCBFill } from '../lib/pcb-polygons';
import type { PCBFillRuleContext } from '../lib/pcb-clearance-sources';

export type PCBFillWorkerRequest =
  | { type: 'basis'; generation: number; board: PCB; rules?: PCBFillRuleContext }
  | { type: 'fill'; generation: number; requestId: number; board: PCB };

export type PCBFillWorkerResponse =
  | {
      generation: number;
      requestId: number;
      board: PCB;
      paths: [string, string][];
      error?: never;
    }
  | {
      generation: number;
      requestId: number;
      error: string;
      board?: never;
      paths?: never;
    };

const validIdentity = (value: number) => Number.isSafeInteger(value) && value >= 0;
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4096);

function restoreUnchangedFills(basis: PCB, candidate: PCB): PCB {
  if (pcbFillInputsChanged(basis, candidate)) return candidate;
  const saved = new Map(
    [...basis.zones, ...basis.footprints.flatMap((footprint) => footprint.zones ?? [])].map(
      (zone) => [zone.id, zone.filledPolygons] as const,
    ),
  );
  const restore = (zone: BoardZone) => {
    const filledPolygons = saved.get(zone.id);
    return zone.filledPolygons === undefined && filledPolygons !== undefined
      ? { ...zone, filledPolygons }
      : zone;
  };
  return ownProjectData(
    {
      ...candidate,
      zones: candidate.zones.map(restore),
      footprints: candidate.footprints.map((footprint) => {
        if (!footprint.zones) return footprint;
        const zones = footprint.zones.map(restore);
        return zones.every((zone, index) => zone === footprint.zones![index])
          ? footprint
          : { ...footprint, zones };
      }),
    },
    basis,
  );
}

/** One private immutable basis per worker. Results are presentation proposals;
 * the owning Core validates every complete board before accepting an edit. */
export function createPCBFillWorkerProcessor(
  calculations = {
    refresh: refreshPCBFill,
    copper: filledCopperPolygons,
    path: polygonPath,
  },
) {
  let generation = -1;
  let basis: PCB | undefined;
  let rules: PCBFillRuleContext | undefined;
  let basisError = '';
  return (request: PCBFillWorkerRequest): PCBFillWorkerResponse | undefined => {
    if (request.type === 'basis') {
      if (!validIdentity(request.generation) || request.generation <= generation) return undefined;
      generation = request.generation;
      basis = undefined;
      rules = undefined;
      basisError = '';
      try {
        basis = ownProjectData(request.board);
        rules = request.rules === undefined ? undefined : ownProjectData(request.rules);
      } catch (error) {
        basisError = errorMessage(error);
      }
      return undefined;
    }
    const identity = { generation: request.generation, requestId: request.requestId };
    try {
      if (
        request.type !== 'fill' ||
        !validIdentity(request.generation) ||
        !validIdentity(request.requestId)
      )
        throw new Error('Invalid copper fill preview request identity.');
      if (request.generation !== generation)
        throw new Error('Copper fill preview belongs to an inactive board generation.');
      if (!basis) throw new Error(basisError || 'Set the copper fill preview basis first.');
      const candidate = ownProjectData(request.board, basis);
      if (candidate.id !== basis.id)
        throw new Error('Copper fill preview board no longer matches its basis.');
      const restored = restoreUnchangedFills(basis, candidate);
      const board = calculations.refresh(basis, restored, true, rules);
      const paths: [string, string][] = [...calculations.copper(board)].map(([id, polygons]) => [
        id,
        calculations.path(polygons),
      ]);
      return { ...identity, board, paths };
    } catch (error) {
      return { ...identity, error: errorMessage(error) };
    }
  };
}
