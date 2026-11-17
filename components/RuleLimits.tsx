import type { ReactNode } from 'react';
import {
  pcbDesignRuleLimitKeys,
  validPCBDesignRuleLimit,
  type PCBDesignRuleLimit,
} from '@/lib/design-rule-checks';
import QuantityInput from './QuantityInput';
import styles from './RuleCheckPanel.module.css';

export type RuleLimitDrafts = Record<PCBDesignRuleLimit, string>;
export function ruleLimitDrafts(settings: Record<PCBDesignRuleLimit, number>): RuleLimitDrafts {
  return Object.fromEntries(
    pcbDesignRuleLimitKeys.map((key) => [key, String(settings[key])]),
  ) as RuleLimitDrafts;
}
export function validRuleLimitDraft(value: string) {
  return value.trim() !== '' && validPCBDesignRuleLimit(Number(value));
}
export function parseRuleLimitDrafts(
  drafts: RuleLimitDrafts,
): Record<PCBDesignRuleLimit, number> | null {
  return pcbDesignRuleLimitKeys.every((key) => validRuleLimitDraft(drafts[key]))
    ? (Object.fromEntries(
        pcbDesignRuleLimitKeys.map((key) => [key, Number(drafts[key])]),
      ) as Record<PCBDesignRuleLimit, number>)
    : null;
}

export const ruleLimitCaptions: Record<PCBDesignRuleLimit, string> = {
  clearance: 'Board-wide minimum clearance',
  minTrackWidth: 'Track width',
  minThroughHole: 'Through-hole diameter',
  minViaDiameter: 'Via diameter',
  minAnnularRing: 'Annular ring',
  copperToEdge: 'Copper to board edge',
  copperToHole: 'Copper to hole',
  holeToHole: 'Hole to hole',
  minSilkClearance: 'Silkscreen clearance',
  minTextHeight: 'Silkscreen text height',
  minTextThickness: 'Silkscreen text thickness',
};
export function RuleValue({
  id,
  label,
  caption,
  value,
  enabled,
  action,
  onChange,
  onCommit,
  valid,
}: {
  id: string;
  label: string;
  caption: string;
  value: string;
  enabled: boolean;
  action?: ReactNode;
  onChange: (value: string) => void;
  onCommit?: () => void;
  valid: boolean;
}) {
  return (
    <div className={styles.limitField}>
      <label htmlFor={id} title={label}>
        {caption}
      </label>
      <div className={styles.fieldControls}>
        <QuantityInput
          id={id}
          aria-label={`${label} (mm)`}
          aria-invalid={!valid}
          unit="mm"
          decimalPlaces={2}
          type="number"
          min="0"
          max="1000"
          step="any"
          value={value}
          disabled={!enabled && valid}
          onValueChange={onChange}
          onBlur={onCommit}
        />
        {action}
      </div>
    </div>
  );
}
