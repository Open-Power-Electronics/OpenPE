import type { Point } from './circuit';

export type PCBDesignRuleConfig = {
  clearance: number;
  minTrackWidth: number;
  minViaDrill: number;
  minAnnularRing: number;
  copperToEdge: number;
  copperToHole: number;
};

/** Session defaults in millimetres, covering the curated boards' geometry. */
export const defaultPCBDesignRules: PCBDesignRuleConfig = {
  clearance: 0.15,
  minTrackWidth: 0.2,
  minViaDrill: 0.1,
  minAnnularRing: 0.05,
  copperToEdge: 0.25,
  copperToHole: 0.25,
};

export type RuleCheckIssue = {
  id: string;
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  objectIds: string[];
  location?: Point;
};

export type RuleCheckFocus = {
  request: number;
  objectIds: string[];
  location?: Point;
  /** Right-side panel overlap in canvas pixels, including a small visual gap. */
  occludedWidth?: number;
};

/** Read-only analysis of the supported editor geometry. A partial report never
 * establishes that the unchecked geometry or rules have no violations. */
export type RuleCheckResult = {
  kind: 'erc' | 'drc';
  complete: boolean;
  truncated: boolean;
  checkedRules: string[];
  issues: RuleCheckIssue[];
  notes: string[];
};
