import type { Point } from './circuit';
import type { PCB } from './pcb';
import type { PCBSelection } from './pcb-layout';
import { createPCBFootprintDrag } from './pcb-footprint-drag';
import { createPCBTrackDrag } from './pcb-track-drag';
import { createPCBTrackJointDrag } from './pcb-track-joint-drag';

export function connectedPCBDragKind(selection: readonly PCBSelection[]) {
  const kind = selection[0]?.kind;
  return (kind === 'track' || kind === 'footprint') && selection.every((item) => item.kind === kind)
    ? kind
    : null;
}

/** Shared geometry preparation for canvas gestures and Core/Agent commands. */
export function createPCBInteractiveDrag(
  board: PCB,
  selection: readonly PCBSelection[],
  options: {
    clearance: number;
    mode?: 'connected' | 'corner';
    obstacleMode?: 'shove' | 'walk-around';
    pickup?: Point;
    endpointTolerance?: number;
  },
) {
  if (options.mode === 'corner') {
    if (selection.length !== 1 || selection[0].kind !== 'track' || !options.pickup)
      throw new Error('Corner drag requires one track and an exact pickup point.');
    return createPCBTrackJointDrag(board, selection[0].id, options.pickup, {
      clearance: options.clearance,
      endpointTolerance: options.endpointTolerance ?? 0.5,
    });
  }
  const kind = connectedPCBDragKind(selection);
  if (kind === 'footprint') {
    if (options.obstacleMode === 'shove')
      throw new Error('Footprint drag uses Walk Around. Omit obstacleMode or select walk-around.');
    return createPCBFootprintDrag(board, selection, options.clearance);
  }
  if (!kind)
    throw new Error('Connected drag requires a selection of only footprints or only tracks.');
  return createPCBTrackDrag(board, selection, {
    clearance: options.clearance,
    obstacleMode: options.obstacleMode ?? 'shove',
    rerouteSelected: true,
    pickup: options.pickup,
  });
}
