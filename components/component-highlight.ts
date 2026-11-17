import { findSchematic, type Project } from '@/lib/project';
import type { PCB } from '@/lib/pcb';
import type { Point } from '@/lib/circuit';

export type ComponentMode = 'canvas' | 'layout' | '3d';
export type ComponentHighlightOrigin =
  { view: 'canvas'; sheetId: string; id: string } | { view: 'layout' | '3d'; id: string };
export type ModelComponentFocus = { request: number; board: PCB; footprintId: string };
export type ComponentHighlightTarget =
  | { view: 'canvas'; sheetId: string; partId: string; location: Point }
  | { view: 'layout' | '3d'; board: PCB; footprintId: string; location: Point };

/** Resolve only the native symbol association; references and captions are not links. */
export function resolveComponentHighlight(
  project: Project,
  origin: ComponentHighlightOrigin,
  view: ComponentMode,
): ComponentHighlightTarget {
  if (origin.view === view) throw new Error('The component is already in this mode.');
  let footprint: PCB['footprints'][number] | undefined;
  if (origin.view === 'canvas') {
    const sheet = findSchematic(project, origin.sheetId);
    const part = sheet?.parts.find((part) => part.id === origin.id);
    if (!sheet || !part) throw new Error('The selected component is no longer available.');
    if (sheet.id !== project.schematic.id) throw new Error('This sheet has no linked PCB.');
    const linked = project.pcb?.footprints.filter((item) => item.symbolId === part.id) ?? [];
    if (linked.length > 1) throw new Error('The component has more than one linked footprint.');
    footprint = linked[0];
    if (!footprint) throw new Error('The component has no linked PCB footprint.');
  } else {
    footprint = project.pcb?.footprints.find((item) => item.id === origin.id);
    if (!footprint) throw new Error('The selected footprint is no longer available.');
  }
  if (view === 'canvas') {
    const part = project.schematic.parts.find((part) => part.id === footprint.symbolId);
    if (!part) throw new Error('The footprint has no linked schematic component.');
    return {
      view,
      sheetId: project.schematic.id,
      partId: part.id,
      location: { x: part.x, y: part.y },
    };
  }
  return {
    view,
    board: project.pcb!,
    footprintId: footprint.id,
    location: { x: footprint.x, y: footprint.y },
  };
}
