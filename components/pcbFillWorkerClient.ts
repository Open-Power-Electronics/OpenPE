import type { PCB } from '../lib/pcb';
import { samePCBFillRules, type PCBFillRuleContext } from '../lib/pcb-clearance-sources';
import type { PCBFillWorkerRequest, PCBFillWorkerResponse } from './pcbFillWorkerProtocol';

export type PCBFillWorkerResult = PCBFillWorkerResponse & {
  basis: PCB;
  candidate: PCB;
  rules?: PCBFillRuleContext;
  fatal?: true;
};

export type PCBFillWorkerPort = {
  postMessage(message: PCBFillWorkerRequest): void;
  onmessage: ((event: MessageEvent<PCBFillWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
};

type Job = {
  basis: PCB;
  candidate: PCB;
  generation: number;
  requestId: number;
  rules?: PCBFillRuleContext;
};

/** Saved contours belong to the worker's one basis message, not every pose.
 * Reading their references to omit them never visits their vertices. */
function withoutFills(board: PCB): PCB {
  const strip = ({ filledPolygons: _filled, ...zone }: PCB['zones'][number]) => zone;
  return {
    ...board,
    zones: board.zones.map(strip),
    footprints: board.footprints.map((footprint) =>
      footprint.zones ? { ...footprint, zones: footprint.zones.map(strip) } : footprint,
    ),
  };
}

/** One active calculation and one replaceable latest pose. A finished current-
 * generation result advances presentation even while the pointer keeps moving.
 * Its candidate reference is always explicit; it grants no commit authority. */
export function createPCBFillWorkerClient(
  worker: PCBFillWorkerPort,
  onResult: (result: PCBFillWorkerResult) => void,
) {
  let disposed = false;
  let generation = 0;
  let requestId = 0;
  let basis: PCB | null = null;
  let rules: PCBFillRuleContext | undefined;
  let sentGeneration: number | null = null;
  let active: Job | null = null;
  let pending: Job | null = null;
  let latest: Job | null = null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    active = null;
    pending = null;
    latest = null;
    basis = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  function fail(message: string) {
    const failed = latest;
    dispose();
    if (failed && failed.generation === generation)
      onResult({ ...failed, error: message, fatal: true });
  }

  function dispatch() {
    if (disposed || active || !pending) return;
    const job = pending;
    pending = null;
    active = job;
    try {
      if (sentGeneration !== job.generation) {
        worker.postMessage({
          type: 'basis',
          generation: job.generation,
          board: job.basis,
          ...(job.rules ? { rules: job.rules } : {}),
        });
        sentGeneration = job.generation;
      }
      worker.postMessage({
        type: 'fill',
        generation: job.generation,
        requestId: job.requestId,
        board: withoutFills(job.candidate),
      });
    } catch (error) {
      fail(
        error instanceof Error ? error.message : 'Copper fill worker could not receive this pose.',
      );
    }
  }

  worker.onmessage = ({ data }) => {
    if (
      disposed ||
      !active ||
      !data ||
      data.generation !== active.generation ||
      data.requestId !== active.requestId
    )
      return;
    const finished = active;
    active = null;
    if (finished.generation === generation)
      onResult({
        ...data,
        basis: finished.basis,
        candidate: finished.candidate,
        ...(finished.rules ? { rules: finished.rules } : {}),
      });
    dispatch();
  };
  worker.onerror = (event) => fail(event.message || 'Copper fill worker stopped unexpectedly.');

  return {
    /** False means a fatal failure/disposal requires a fresh worker client. */
    submit(nextBasis: PCB, candidate: PCB, nextRules?: PCBFillRuleContext) {
      if (disposed) return false;
      if (basis !== nextBasis || !samePCBFillRules(rules, nextRules)) {
        basis = nextBasis;
        rules = nextRules ? { ...nextRules } : undefined;
        generation++;
        pending = null;
      }
      if (active?.generation === generation && active.candidate === candidate) {
        pending = null;
        latest = active;
        return true;
      }
      if (pending?.generation === generation && pending.candidate === candidate) return true;
      latest = {
        basis: nextBasis,
        candidate,
        generation,
        requestId: ++requestId,
        ...(rules ? { rules } : {}),
      };
      pending = latest;
      dispatch();
      return !disposed;
    },
    /** Revoke every old result without queuing a replacement calculation. */
    clear() {
      if (disposed) return;
      generation++;
      basis = null;
      pending = null;
      latest = null;
    },
    dispose,
  };
}
