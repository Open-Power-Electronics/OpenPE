import type { Project } from './project';
import { validPCBDesignRuleLimit } from './design-rule-checks';
import { parseSExpr, val, type SExpr } from './sexpr';

type ClearanceSource = {
  key: string;
  label: string;
  clearance: number;
};

export type PCBRuleOperand = {
  netClass: string;
  type: string;
  localClearance?: number;
  intersectsCourtyard: (reference: string) => boolean;
};
type Condition = (a: PCBRuleOperand, b: PCBRuleOperand) => boolean;
type ClearanceRule = ClearanceSource & { condition: string; matches: Condition };

// KiCad 10 expressions used by the supported clearance subset. Compile to
// predicates over known properties instead of evaluating the native text.
function compileCondition(source: string): Condition {
  const token = /\s*(\|\||&&|==|!=|[().]|[A-Za-z]+|'[^'\r\n]*')/gy;
  const tokens: string[] = [];
  const invalid = () => new Error('Unsupported clearance condition.');
  source = source.trim();
  while (token.lastIndex < source.length) {
    const match = token.exec(source);
    if (!match || tokens.length >= 192) throw invalid();
    tokens.push(match[1]);
  }
  let i = 0;
  function take(value: string) {
    if (tokens[i] !== value) return false;
    i++;
    return true;
  }
  function expect(value: string) {
    if (!take(value)) throw invalid();
  }
  function literal() {
    const value = tokens[i++];
    if (!value?.startsWith("'") || /[*?\\]/.test(value)) throw invalid();
    return value.slice(1, -1);
  }
  function predicate(): Condition {
    if (take('(')) {
      const nested = expression();
      expect(')');
      return nested;
    }
    const side = tokens[i++];
    if (side !== 'A' && side !== 'B') throw invalid();
    const operand = (a: PCBRuleOperand, b: PCBRuleOperand) => (side === 'A' ? a : b);
    expect('.');
    const member = tokens[i++];
    if (member === 'intersectsCourtyard') {
      expect('(');
      const reference = literal();
      expect(')');
      return (a, b) => operand(a, b).intersectsCourtyard(reference);
    }
    if (member !== 'NetClass' && member !== 'Type') throw invalid();
    const equal = take('==');
    if (!equal) expect('!=');
    const value = literal();
    const key = member === 'NetClass' ? 'netClass' : 'type';
    return (a, b) => (operand(a, b)[key] === value) === equal;
  }
  function conjunction(): Condition {
    const terms = [predicate()];
    while (take('&&')) terms.push(predicate());
    return (a, b) => terms.every((term) => term(a, b));
  }
  function expression(): Condition {
    const terms = [conjunction()];
    while (take('||')) terms.push(conjunction());
    return (a, b) => terms.some((term) => term(a, b));
  }
  const matches = expression();
  if (i !== tokens.length) throw invalid();
  return matches;
}

function nativeRuleTexts(files: Project['nativeFiles']): PCBFillRuleContext {
  const settings = files?.files.find(({ name }) => /\.kicad_pro$/i.test(name));
  const ruleName = (settings?.name ?? files?.entry)
    ?.replace(/\.kicad_(?:pro|pcb|sch)$/i, '.kicad_dru')
    .toLowerCase();
  return {
    projectSource: settings?.source,
    rulesSource: files?.files.find(({ name }) => name.toLowerCase() === ruleName)?.source,
  };
}

export function readPCBDesignRuleSources(project: Pick<Project, 'pcb' | 'nativeFiles'>) {
  const { projectSource, rulesSource } = nativeRuleTexts(project.nativeFiles);
  return readPCBDesignRuleSourceTexts(project.pcb, projectSource, rulesSource);
}

export function readPCBDesignRuleSourceTexts(
  pcb: Project['pcb'],
  projectSource?: string,
  rulesSource?: string,
) {
  const netNames = new Map(pcb?.nets.map(({ id, name }) => [id, name]));
  const zones: ClearanceSource[] = [];
  for (const zone of [
    ...(pcb?.zones ?? []),
    ...(pcb?.footprints.flatMap((f) => f.zones ?? []) ?? []),
  ]) {
    if (zone.keepout || zone.fillEnabled === false) continue;
    const net = zone.netId && netNames.get(zone.netId);
    zones.push({
      key: `zone:${zone.id}`,
      label: `${net || 'Zone'} · ${zone.layer}`,
      clearance: zone.clearance,
    });
  }
  const notes: string[] = [];
  const classes = new Map<string, ClearanceSource>();
  const assignments = new Map<string, string>();
  const rules: ClearanceRule[] = [];
  try {
    const projectSettings = projectSource === undefined ? undefined : JSON.parse(projectSource);
    const settings = projectSettings?.net_settings;
    if (settings) {
      const entries = settings.classes ?? [];
      if (!Array.isArray(entries) || entries.length > 128) throw new Error();
      for (const entry of entries) {
        const { name, clearance } = entry ?? {};
        if (
          typeof name !== 'string' ||
          !name ||
          name.length > 190 ||
          classes.has(name) ||
          !validPCBDesignRuleLimit(clearance)
        )
          throw new Error();
        classes.set(name, { key: `class:${name}`, label: name, clearance });
      }
      const patterns = settings.netclass_patterns ?? [];
      if (!Array.isArray(patterns) || patterns.length > 4096) throw new Error();
      for (const entry of patterns) {
        const { pattern, netclass } = entry ?? {};
        if (typeof pattern !== 'string' || !classes.has(netclass) || /[*?\\]/.test(pattern)) {
          notes.push('KiCad net-class assignment requires an unsupported pattern or class.');
          continue;
        }
        if (assignments.has(pattern) && assignments.get(pattern) !== netclass) {
          notes.push('Multiple KiCad net classes assign the same net.');
          continue;
        }
        assignments.set(pattern, netclass);
      }
      if (settings.netclass_assignments && Object.keys(settings.netclass_assignments).length)
        notes.push(
          'KiCad explicit net-class assignments are outside the supported pattern format.',
        );
    }
  } catch {
    classes.clear();
    assignments.clear();
    notes.push('KiCad net-class clearances could not be read.');
  }
  if (projectSource !== undefined && !classes.has('Default'))
    classes.set('Default', { key: 'class:Default', label: 'Default', clearance: 0.2 });

  if (rulesSource !== undefined) {
    try {
      const nodes = parseSExpr(`(${rulesSource.replace(/^\s*#[^\r\n]*/gm, '')})`, 131072);
      const [version, ...entries] = nodes;
      if (
        !Array.isArray(version) ||
        version[0] !== 'version' ||
        version[1] !== '1' ||
        version.length !== 2 ||
        entries.length > 64
      )
        throw new Error();
      for (const node of entries) {
        const label = Array.isArray(node) ? val(node) : '';
        try {
          if (
            !Array.isArray(node) ||
            node[0] !== 'rule' ||
            !label ||
            label.length > 190 ||
            rules.some((rule) => rule.label === label)
          )
            throw new Error();
          const clauses = node.slice(2);
          if (
            clauses.some(
              (clause) =>
                !Array.isArray(clause) || (clause[0] !== 'condition' && clause[0] !== 'constraint'),
            )
          )
            throw new Error();
          const conditions = clauses.filter(
            (clause): clause is SExpr => Array.isArray(clause) && clause[0] === 'condition',
          );
          const constraints = clauses.filter(
            (clause): clause is SExpr => Array.isArray(clause) && clause[0] === 'constraint',
          );
          if (conditions.length > 1 || constraints.length !== 1) throw new Error();
          const [, type, minimum, ...rest] = constraints[0];
          if (
            type !== 'clearance' ||
            rest.length ||
            !Array.isArray(minimum) ||
            minimum[0] !== 'min' ||
            minimum.length !== 2
          )
            throw new Error();
          const value = /^(\d+(?:\.\d*)?|\.\d+)(mm|mil)?$/.exec(val(minimum));
          const clearance = value ? Number(value[1]) * (value[2] === 'mil' ? 0.0254 : 1) : NaN;
          if (!validPCBDesignRuleLimit(clearance) || (conditions[0] && conditions[0].length !== 2))
            throw new Error();
          const condition = conditions[0] ? val(conditions[0]) : '';
          const matches = conditions[0] ? compileCondition(condition) : () => true;
          rules.push({ key: `rule:${label}`, label, clearance, condition, matches });
        } catch {
          notes.push(
            label ? `Unsupported KiCad rule “${label}”.` : 'Unsupported KiCad rule entry.',
          );
        }
      }
    } catch {
      notes.push('KiCad custom rules could not be read as a bounded version 1 rule file.');
    }
  }
  return {
    zones,
    classes,
    assignments,
    netNames,
    rules,
    notes: [...new Set(notes)],
  };
}

export type PCBDesignRuleSources = ReturnType<typeof readPCBDesignRuleSources>;

/** Pure, serializable rule texts for a pour/worker, without unrelated native files. */
export type PCBFillRuleContext = { projectSource?: string; rulesSource?: string };

export function pcbFillRuleContext(project: Pick<Project, 'nativeFiles'>): PCBFillRuleContext {
  const { projectSource: source, rulesSource } = nativeRuleTexts(project.nativeFiles);
  if (source === undefined) return { rulesSource };
  const settings = JSON.parse(source);
  const rules = settings.board?.design_settings?.rules;
  const net = settings.net_settings;
  const limits = Object.fromEntries(
    ['min_clearance', 'min_copper_edge_clearance', 'min_hole_clearance']
      .filter((key) => rules && Object.hasOwn(rules, key))
      .map((key) => [key, rules[key]]),
  );
  // Saving a standalone PCB introduces a project settings file. Empty native
  // settings and no settings both use the same effective fill rules.
  if (net === undefined && !Object.keys(limits).length) return { rulesSource };
  // CAD, solver bindings and other project metadata cannot invalidate copper.
  const projectSource = JSON.stringify({
    board: {
      design_settings: {
        rules: limits,
      },
    },
    net_settings:
      net && typeof net === 'object' && !Array.isArray(net)
        ? {
            classes: Array.isArray(net.classes)
              ? net.classes.map((entry: unknown) =>
                  entry && typeof entry === 'object' && !Array.isArray(entry)
                    ? {
                        name: (entry as Record<string, unknown>).name,
                        clearance: (entry as Record<string, unknown>).clearance,
                      }
                    : entry,
                )
              : net.classes,
            netclass_patterns: net.netclass_patterns,
            netclass_assignments: net.netclass_assignments,
          }
        : net,
  });
  return { projectSource, rulesSource };
}

export function samePCBFillRules(a?: PCBFillRuleContext, b?: PCBFillRuleContext): boolean {
  return a?.projectSource === b?.projectSource && a?.rulesSource === b?.rulesSource;
}

export function pcbRuleNetClass(sources: PCBDesignRuleSources | undefined, netId: string | null) {
  const name = netId ? sources?.netNames.get(netId) : undefined;
  return (name && sources?.assignments.get(name)) || 'Default';
}

/** Callers supply reverse-precedence, enabled rules; conditions try both orders. */
export function matchingPCBClearanceRule(
  rules: readonly ClearanceRule[],
  a: PCBRuleOperand,
  b: PCBRuleOperand,
  visit: () => void = () => {},
) {
  for (const rule of rules) {
    visit();
    if (rule.matches(a, b) || rule.matches(b, a)) return rule;
  }
}
