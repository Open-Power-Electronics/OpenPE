import type { Point } from './circuit';
import type { PCB } from './pcb';
import { padDrillPosition } from './pcb-layout';
import { squaredDistance } from './pcb-collision';
import { createPCBRouter } from './pcb-routing';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';

export type PCBViaOptions = {
  netId: string;
  diameter: number;
  drill: number;
  clearance: number;
};
type Hole = Point &
  ({ radius: number; owner: 'pad' } | { radius: number; copperRadius: number; owner: 'via' });
const safety = 0.002;
const limitMessage =
  'Via placement exceeds the geometry limit. Simplify the board before placing a via.';
const invalidMessage =
  'Choose a board net, a positive via diameter up to 20 mm, a smaller positive drill and clearance from 0.05 to 20 mm.';

/** Prepare bounded all-layer disc checks once for a pointer placement session.
 * Same-net copper can connect, but creating a hole on an existing hole is blocked.
 * Saved pours never obstruct placement; explicit via keepouts remain authoritative.
 * Invalid settings or unavailable geometry return errors through validate.
 */
export function createPCBViaValidator(
  board: PCB,
  options: PCBViaOptions,
): {
  validate: (at: Point, budget?: () => void) => string;
} {
  try {
    const { netId, diameter, drill, clearance } = options;
    if (
      !board.nets.some((net) => net.id === netId) ||
      !Number.isFinite(diameter) ||
      diameter <= 0 ||
      diameter > 20 ||
      !Number.isFinite(drill) ||
      drill <= 0 ||
      drill >= diameter ||
      !Number.isFinite(clearance) ||
      clearance < 0.05 ||
      clearance > 20
    )
      return { validate: () => invalidMessage };
    const holes: Hole[] = [];
    const addHole = (hole: Hole) => {
      if (holes.length >= 15000) throw new Error(limitMessage);
      holes.push(hole);
    };
    for (const footprint of board.footprints)
      for (const pad of footprint.pads)
        if (pad.drill)
          addHole({ ...padDrillPosition(footprint, pad), radius: pad.drill / 2, owner: 'pad' });
    for (const via of board.vias)
      addHole({
        x: via.x,
        y: via.y,
        radius: via.drill / 2,
        copperRadius: via.diameter / 2,
        owner: 'via',
      });
    const obstacleBoard = preparePCBArtworkObstacles(board);
    const engines = board.layers.map((layer) =>
      createPCBRouter(obstacleBoard, {
        layer,
        netId,
        width: diameter,
        clearance,
        obstacleType: 'via',
      }),
    );
    const radius = diameter / 2 + clearance + safety;
    return {
      validate(at, budget) {
        if (
          !Number.isFinite(at.x) ||
          !Number.isFinite(at.y) ||
          Math.abs(at.x) > 100000 ||
          Math.abs(at.y) > 100000
        )
          return 'Via coordinates must be within ±100000 mm.';
        let work = 0;
        const spend = () => {
          if (++work > 2_000_000) throw new Error(limitMessage);
          budget?.();
        };
        try {
          for (const hole of holes) {
            spend();
            const separation =
              hole.owner === 'via'
                ? Math.max(radius + hole.radius, hole.copperRadius + drill / 2 + clearance + safety)
                : radius + hole.radius;
            if (squaredDistance(at, hole) < separation ** 2)
              return `Via blocked by an existing ${hole.owner} hole. Move away from the hole or connect to its existing copper.`;
          }
          for (const engine of engines) {
            const issue = engine.validate([at], spend);
            if (issue)
              return issue.startsWith('Route blocked')
                ? 'Via blocked. Move away from copper, keepouts or board edges, or reduce its diameter or clearance.'
                : issue;
          }
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      },
    };
  } catch (error) {
    return { validate: () => (error as Error).message };
  }
}

export function validatePCBVia(
  board: PCB,
  via: Pick<PCB['vias'][number], 'x' | 'y' | 'netId' | 'diameter' | 'drill'>,
  clearance: number,
): string {
  return createPCBViaValidator(board, { ...via, clearance }).validate(via);
}
