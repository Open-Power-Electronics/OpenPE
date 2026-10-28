export const leftButtonDragOptions = [
  { value: 'drag-any', label: 'Drag any object' },
  { value: 'drag-selected', label: 'Drag selected objects' },
  { value: 'select', label: 'Draw selection rectangle' },
] as const;

export type LeftButtonDrag = (typeof leftButtonDragOptions)[number]['value'];
export const defaultLeftButtonDrag: LeftButtonDrag = 'drag-selected';

export function pointerDragsObject(behavior: LeftButtonDrag, selected: boolean) {
  return behavior === 'drag-any' || (behavior === 'drag-selected' && selected);
}
