import type { Circuit } from '@/lib/circuit';
import type { PCB } from '@/lib/pcb';

/** Renderer observations of one exact preview basis, outside design data. */
export type ModelCheckIssue = {
  message: string;
  footprintId?: string;
  severity: 'error' | 'warning' | 'notice';
};
export type ModelCheckReport = {
  board: PCB;
  schematic?: Circuit;
  issues: readonly ModelCheckIssue[];
  state: 'loading' | 'ready' | 'error';
  message: string;
  canLocate: boolean;
};
export type ModelCheckFocus = { request: number; board: PCB; footprintId: string };
