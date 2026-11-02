import type { Point } from './circuit';
import type { PCB } from './pcb';
import type { PCBSelection } from './pcb-layout';
import { createPCBTrackDrag } from './pcb-track-drag';
import { createPCBTrackJointDrag } from './pcb-track-joint-drag';

/** Shared geometry preparation for canvas gestures and Core/Agent commands. */
export function createPCBInteractiveTrackDrag(
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
  return createPCBTrackDrag(board, selection, {
    clearance: options.clearance,
    obstacleMode: options.obstacleMode ?? 'shove',
    rerouteSelected: true,
    pickup: options.pickup,
  });
}
