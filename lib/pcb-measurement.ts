import type { Point } from './circuit';
import type { BoardLine, PCB } from './pcb';
import { pcbFootprintBodyBounds, type PCBDisplay } from './pcb-display';
import { footprintPoint } from './pcb-layout';

/** Exact native drawing anchors, prepared only while the ruler is active. */
export function pcbMeasurementAnchors(board: PCB, display: PCBDisplay): Point[] {
  const points: Point[] = [];
  const add = (graphic: BoardLine, transform: (point: Point) => Point) => {
    if (!display[graphic.layer] || graphic.text || graphic.dimension) return;
    const anchors = [
      graphic.start,
      graphic.end,
      ...(graphic.mid ? [graphic.mid] : []),
      ...(graphic.points ?? []),
    ];
    if (graphic.kind === 'circle') {
      const radius = Math.hypot(graphic.end.x - graphic.start.x, graphic.end.y - graphic.start.y);
      anchors.push(
        ...[
          { x: radius, y: 0 },
          { x: -radius, y: 0 },
          { x: 0, y: radius },
          { x: 0, y: -radius },
        ].map((point) => ({ x: graphic.start.x + point.x, y: graphic.start.y + point.y })),
      );
    }
    for (const point of anchors) points.push(transform(point));
  };
  for (const graphic of board.graphics) add(graphic, (point) => ({ ...point }));
  if (display.footprints)
    for (const footprint of board.footprints) {
      // Native footprint origin is its placement center, independent of captions or rotation.
      if (pcbFootprintBodyBounds(board, footprint, display))
        points.push({ x: footprint.x, y: footprint.y });
      for (const graphic of footprint.graphics)
        add(graphic, (point) => footprintPoint(footprint, point));
    }
  return points;
}

export function nearestMeasurementAnchor(
  anchors: readonly Point[],
  point: Point,
  tolerance: number,
): Point | undefined {
  let nearest: Point | undefined;
  let distance = tolerance;
  for (const anchor of anchors) {
    const next = Math.hypot(anchor.x - point.x, anchor.y - point.y);
    if (next <= distance) {
      nearest = anchor;
      distance = next;
    }
  }
  return nearest && { ...nearest };
}
