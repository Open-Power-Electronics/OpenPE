export type CanvasBounds = { left: number; top: number; width: number; height: number };

export function resizeDrawingView(
  view: { x: number; y: number; width: number },
  previous: CanvasBounds,
  next: CanvasBounds,
  anchor: 'screen' | 'center' = 'screen',
) {
  if (previous.width <= 0 || previous.height <= 0 || next.width <= 0 || next.height <= 0)
    return view;

  // Window resizing keeps the drawing centered. In-window dock changes keep
  // geometry under the same screen pixels while exposing or covering it.
  const dx = anchor === 'center' ? (previous.width - next.width) / 2 : next.left - previous.left;
  const dy = anchor === 'center' ? (previous.height - next.height) / 2 : next.top - previous.top;
  const unitsPerPixel = view.width / previous.width;
  return {
    x: view.x + dx * unitsPerPixel,
    y: view.y + dy * unitsPerPixel,
    width: next.width * unitsPerPixel,
  };
}
