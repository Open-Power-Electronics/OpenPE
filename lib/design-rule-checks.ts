import type { Point } from './circuit';

// [OpenPE default, KiCad 10 default, native board constraint, control label, check ID]
export const pcbDesignRuleLimits = {
  clearance: [0.15, 0, 'min_clearance', 'Minimum copper clearance (board-wide)', 'pcb.clearance'],
  minTrackWidth: [0.2, 0.2, 'min_track_width', 'Minimum track width', 'pcb.track-width'],
  minThroughHole: [
    0.1,
    0.3,
    'min_through_hole_diameter',
    'Minimum through-hole diameter',
    'pcb.via-drill',
  ],
  minViaDiameter: [0.2, 0.5, 'min_via_diameter', 'Minimum via diameter', 'pcb.via-diameter'],
  minAnnularRing: [0.05, 0.1, 'min_via_annular_width', 'Minimum annular ring', 'pcb.annular-ring'],
  copperToEdge: [0.25, 0.5, 'min_copper_edge_clearance', 'Copper to board edge', 'pcb.copper-edge'],
  copperToHole: [0.25, 0.25, 'min_hole_clearance', 'Copper to hole', 'pcb.copper-hole'],
  holeToHole: [0, 0.25, 'min_hole_to_hole', 'Hole to hole', 'pcb.hole-spacing'],
  minSilkClearance: [
    0,
    0,
    'min_silk_clearance',
    'Minimum silkscreen clearance',
    'pcb.silk-clearance',
  ],
  minTextHeight: [
    0,
    0.8,
    'min_text_height',
    'Minimum silkscreen text height',
    'pcb.silk-text-height',
  ],
  minTextThickness: [
    0,
    0.08,
    'min_text_thickness',
    'Minimum silkscreen text thickness',
    'pcb.silk-text-thickness',
  ],
} as const satisfies Record<string, readonly [number, number, string, string, PCBDesignRuleId]>;

export const pcbDesignRuleScopes = {
  dimensions: [
    'pcb.track-width',
    'pcb.via-drill',
    'pcb.pad-drill',
    'pcb.via-diameter',
    'pcb.annular-ring',
  ],
  clearance: ['pcb.short', 'pcb.clearance'],
  edge: ['pcb.outline', 'pcb.copper-edge'],
  holes: ['pcb.copper-hole', 'pcb.hole-spacing'],
  silkscreen: ['pcb.silk-clearance', 'pcb.silk-text-height', 'pcb.silk-text-thickness'],
  courtyards: ['pcb.courtyard-malformed', 'pcb.courtyard-overlap'],
  keepouts: ['pcb.keepout'],
  connectivity: ['pcb.unrouted'],
} as const;

export type PCBDesignRuleLimit = keyof typeof pcbDesignRuleLimits;
export type PCBDesignRuleThresholds = Record<PCBDesignRuleLimit, number>;
type PCBDesignRuleScope = keyof typeof pcbDesignRuleScopes;
export type PCBDesignRuleId = (typeof pcbDesignRuleScopes)[PCBDesignRuleScope][number];
export const pcbDesignRuleIds = Object.values(pcbDesignRuleScopes).flat();
export const designRuleSeverities = ['error', 'warning', 'ignore'] as const;
export type DesignRuleSeverity = (typeof designRuleSeverities)[number];
export type PCBDesignRuleSeverities = Partial<Record<PCBDesignRuleId, DesignRuleSeverity>>;
export const defaultPCBRuleSeverity = 'error';
export const schematicRuleDefinitions = {
  'erc.reference-conflict': ['Reference conflict', 'error'],
  'erc.pin-type-unsupported': ['Unsupported pin type', 'warning'],
  'erc.pin-type-inconsistent': ['Inconsistent pin type', 'warning'],
  'erc.pin-unconnected': ['Unconnected pin', 'error'],
  'erc.input-undriven': ['Undriven input', 'error'],
  'erc.power-undriven': ['Undriven power input', 'error'],
  'erc.output-conflict': ['Output conflict', 'error'],
  'erc.pin-conflict': ['Pin conflict', 'warning'],
  'erc.net-name-conflict': ['Net name conflict', 'error'],
  'erc.wire-dangling': ['Dangling wire', 'warning'],
  'erc.wire-zero-length': ['Zero-length wire', 'warning'],
  'erc.label-dangling': ['Dangling label', 'error'],
  'erc.no-connect-misplaced': ['Misplaced no-connect marker', 'warning'],
  'erc.no-connect-connected': ['Connected no-connect marker', 'error'],
} as const satisfies Record<string, readonly [string, RuleCheckIssue['severity']]>;
export type SchematicRuleId = keyof typeof schematicRuleDefinitions;
export const schematicRuleIds = Object.keys(schematicRuleDefinitions) as SchematicRuleId[];
export type SchematicRuleSeverities = Partial<Record<SchematicRuleId, DesignRuleSeverity>>;
type PCBClearanceOverride = { key: string; clearance: number; enabled?: boolean };
export const maxPCBClearanceOverrides = 512;
export type PCBDesignRuleConfig = PCBDesignRuleThresholds & {
  scopes: readonly PCBDesignRuleScope[];
  useZoneClearance: boolean;
  useKiCadClearance: boolean;
  clearanceOverrides: readonly PCBClearanceOverride[];
  severities: PCBDesignRuleSeverities;
};
export const pcbDesignRuleLimitKeys = Object.keys(pcbDesignRuleLimits) as PCBDesignRuleLimit[];
export const pcbDesignRuleScopeKeys = Object.keys(pcbDesignRuleScopes) as PCBDesignRuleScope[];

export function pcbDesignRuleLimitChecks(key: PCBDesignRuleLimit): readonly PCBDesignRuleId[] {
  return key === 'minThroughHole'
    ? ['pcb.via-drill', 'pcb.pad-drill']
    : [pcbDesignRuleLimits[key][4]];
}

/** Session defaults in millimetres, covering the curated boards' geometry. */
export const defaultPCBDesignRules: PCBDesignRuleConfig = {
  ...(Object.fromEntries(
    pcbDesignRuleLimitKeys.map((key) => [key, pcbDesignRuleLimits[key][0]]),
  ) as Record<PCBDesignRuleLimit, number>),
  scopes: pcbDesignRuleScopeKeys,
  useZoneClearance: false,
  useKiCadClearance: false,
  clearanceOverrides: [],
  severities: {},
};

export const workbenchPCBDesignRules: PCBDesignRuleConfig = {
  ...defaultPCBDesignRules,
  useKiCadClearance: true,
  holeToHole: pcbDesignRuleLimits.holeToHole[1],
  minTextHeight: pcbDesignRuleLimits.minTextHeight[1],
  minTextThickness: pcbDesignRuleLimits.minTextThickness[1],
};

export function validPCBDesignRuleLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000;
}

export function resolvePCBDesignRules(
  input: Partial<PCBDesignRuleConfig> = {},
  baseline = defaultPCBDesignRules,
): PCBDesignRuleConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Choose a valid PCB design-rule configuration.');
  for (const [key, value] of Object.entries(input)) {
    if (key === 'scopes') {
      if (
        !Array.isArray(value) ||
        !value.length ||
        new Set(value).size !== value.length ||
        value.some(
          (scope) => typeof scope !== 'string' || !Object.hasOwn(pcbDesignRuleScopes, scope),
        )
      )
        throw new Error('Choose one or more distinct supported PCB rule scopes.');
    } else if (key === 'useZoneClearance' || key === 'useKiCadClearance') {
      if (typeof value !== 'boolean') throw new Error('Choose which clearance sources to apply.');
    } else if (key === 'severities') {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([id, severity]) =>
            !pcbDesignRuleIds.some((rule) => rule === id) ||
            !designRuleSeverities.some((option) => option === severity),
        )
      )
        throw new Error('Choose a valid severity for each supported PCB rule.');
    } else if (key === 'clearanceOverrides') {
      if (
        !Array.isArray(value) ||
        value.length > maxPCBClearanceOverrides ||
        value.some(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            Object.keys(entry).some((field) => !['key', 'clearance', 'enabled'].includes(field)) ||
            typeof entry.key !== 'string' ||
            entry.key.length === 0 ||
            entry.key.length > 200 ||
            !validPCBDesignRuleLimit(entry.clearance) ||
            (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean'),
        ) ||
        new Set(value.map((entry) => entry.key)).size !== value.length
      )
        throw new Error('Choose distinct, valid PCB clearance overrides.');
    } else if (!Object.hasOwn(pcbDesignRuleLimits, key) || !validPCBDesignRuleLimit(value)) {
      throw new Error('PCB design-rule thresholds must be finite values from 0 to 1000 mm.');
    }
  }
  const selected = input.scopes ?? baseline.scopes;
  return {
    ...baseline,
    ...input,
    scopes: pcbDesignRuleScopeKeys.filter((scope) => selected.includes(scope)),
    clearanceOverrides: (input.clearanceOverrides ?? baseline.clearanceOverrides).map(
      ({ key, clearance, enabled }) => ({
        key,
        clearance,
        ...(enabled === false ? { enabled } : {}),
      }),
    ),
    severities: { ...(input.severities ?? baseline.severities) },
  };
}

function nativeRuleObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('KiCad board settings and constraints must be JSON objects.');
  return value as Record<string, unknown>;
}

/** KiCad board minima, independent of net classes and custom clearance rules. */
export function loadKiCadPCBDesignRuleLimits(
  source?: string,
  defaults?: PCBDesignRuleThresholds,
): PCBDesignRuleThresholds {
  const project = nativeRuleObject(source === undefined ? undefined : JSON.parse(source));
  return readKiCadPCBDesignRuleLimits(project, defaults);
}

export function readKiCadPCBDesignRuleLimits(
  project: Record<string, unknown>,
  defaults?: PCBDesignRuleThresholds,
): PCBDesignRuleThresholds {
  const board = nativeRuleObject(project.board);
  const design = nativeRuleObject(board.design_settings);
  const rules = nativeRuleObject(design.rules);
  return Object.fromEntries(
    pcbDesignRuleLimitKeys.map((key) => {
      const [, defaultValue, nativeKey] = pcbDesignRuleLimits[key];
      const value = Object.hasOwn(rules, nativeKey)
        ? rules[nativeKey]
        : (defaults?.[key] ?? defaultValue);
      if (!validPCBDesignRuleLimit(value))
        throw new Error(
          `KiCad constraint ${nativeKey} is outside the supported 0 to 1000 mm range.`,
        );
      return [key, value];
    }),
  ) as PCBDesignRuleThresholds;
}

export function setKiCadPCBDesignRuleLimits(
  project: Record<string, unknown>,
  thresholds: Partial<PCBDesignRuleThresholds>,
) {
  const board = nativeRuleObject(project.board);
  const design = nativeRuleObject(board.design_settings);
  const rules = { ...nativeRuleObject(design.rules) };
  for (const key of pcbDesignRuleLimitKeys) {
    const value = thresholds[key];
    if (value === undefined) continue;
    if (!validPCBDesignRuleLimit(value))
      throw new Error('PCB design-rule thresholds must be finite values from 0 to 1000 mm.');
    rules[pcbDesignRuleLimits[key][2]] = value;
  }
  return { ...project, board: { ...board, design_settings: { ...design, rules } } };
}

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
