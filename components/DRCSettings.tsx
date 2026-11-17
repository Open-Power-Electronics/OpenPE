import { useId } from 'react';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import {
  defaultPCBRuleSeverity,
  pcbDesignRuleLimitChecks,
  pcbDesignRuleLimits,
  type DesignRuleSeverity,
  type PCBDesignRuleId,
  type PCBDesignRuleLimit,
  type PCBDesignRuleSeverities,
} from '@/lib/design-rule-checks';
import { RuleValue, ruleLimitCaptions, validRuleLimitDraft } from './RuleLimits';
import Select from './Select';
import styles from './RuleCheckPanel.module.css';

type RuleSetting = PCBDesignRuleLimit | readonly [PCBDesignRuleId, string];
type RuleGroup = { heading?: string; rows: readonly RuleSetting[] };

const ruleGroups = {
  'Copper & Routing': [
    { heading: 'Clearance & width', rows: ['clearance', 'minTrackWidth'] },
    {
      heading: 'Connectivity',
      rows: [
        ['pcb.short', 'Copper shorts'],
        ['pcb.unrouted', 'Unrouted connections'],
      ],
    },
  ],
  'Holes & Vias': [
    { heading: 'Drill size & spacing', rows: ['minThroughHole', 'copperToHole', 'holeToHole'] },
    { heading: 'Via & pad copper', rows: ['minViaDiameter', 'minAnnularRing'] },
  ],
  'Board & Placement': [
    {
      heading: 'Outline & keepouts',
      rows: [
        ['pcb.outline', 'Board outline'],
        'copperToEdge',
        ['pcb.keepout', 'Keepout violations'],
      ],
    },
    {
      heading: 'Footprint courtyards',
      rows: [
        ['pcb.courtyard-malformed', 'Malformed courtyards'],
        ['pcb.courtyard-overlap', 'Courtyard overlap'],
      ],
    },
  ],
  Silkscreen: [{ rows: ['minSilkClearance', 'minTextHeight', 'minTextThickness'] }],
} as const satisfies Record<string, readonly RuleGroup[]>;

type DRCTab = keyof typeof ruleGroups;
export const drcSettingsTabs = Object.keys(ruleGroups) as DRCTab[];

type Props = {
  tab: DRCTab;
  drafts: Record<PCBDesignRuleLimit, string>;
  severities: PCBDesignRuleSeverities;
  busy: boolean;
  onThreshold: (key: PCBDesignRuleLimit, value: string) => void;
  onSeverity: (ids: readonly PCBDesignRuleId[], severity?: DesignRuleSeverity) => void;
};

const severityOptions = [
  {
    value: 'error',
    label: 'Error',
    icon: <AlertCircle className={styles.severityError} size={15} aria-hidden="true" />,
  },
  {
    value: 'warning',
    label: 'Warning',
    icon: <AlertTriangle className={styles.severityWarning} size={15} aria-hidden="true" />,
  },
  { value: 'ignore', label: 'Off' },
];

export function RuleSeveritySelect({
  label,
  value,
  baseline,
  disabled,
  onChange,
}: {
  label: string;
  value?: DesignRuleSeverity;
  baseline: Exclude<DesignRuleSeverity, 'ignore'>;
  disabled: boolean;
  onChange: (value?: DesignRuleSeverity) => void;
}) {
  const current = value ?? baseline;
  return (
    <div className={styles.severitySelect}>
      <Select
        label={`${label} severity`}
        value={current}
        icon={severityOptions.find((option) => option.value === current)?.icon}
        options={severityOptions}
        popupClassName={styles.severityMenu}
        disabled={disabled}
        onChange={(next) => onChange(next === baseline ? undefined : (next as DesignRuleSeverity))}
      />
    </div>
  );
}

export default function DRCSettings(props: Props) {
  const { tab, drafts, severities, busy } = props;
  const id = useId();
  const groups: readonly RuleGroup[] = ruleGroups[tab];

  function severityControl(rules: readonly PCBDesignRuleId[], label: string) {
    return (
      <RuleSeveritySelect
        label={label}
        value={severities[rules[0]]}
        baseline={defaultPCBRuleSeverity}
        disabled={busy}
        onChange={(severity) => props.onSeverity(rules, severity)}
      />
    );
  }

  return (
    <fieldset className={styles.limits} aria-label={`${tab} rules`} disabled={busy}>
      {groups.map(({ heading, rows }) => (
        <div key={heading ?? tab}>
          {heading && <h3 className={styles.sourceHeading}>{heading}</h3>}
          <div
            className={styles.limitGrid}
            role={heading ? 'group' : undefined}
            aria-label={heading}
          >
            {rows.map((row) => {
              if (typeof row !== 'string') {
                const [rule, label] = row;
                return (
                  <div className={styles.limitField} key={rule}>
                    <span>{label}</span>
                    {severityControl([rule], label)}
                  </div>
                );
              }
              const [, , , name] = pcbDesignRuleLimits[row];
              const rules = pcbDesignRuleLimitChecks(row);
              return (
                <RuleValue
                  key={row}
                  id={`${id}-${row}`}
                  label={name}
                  caption={ruleLimitCaptions[row]}
                  value={drafts[row]}
                  enabled={rules.some((rule) => severities[rule] !== 'ignore')}
                  valid={validRuleLimitDraft(drafts[row])}
                  action={severityControl(rules, name)}
                  onChange={(value) => props.onThreshold(row, value)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
