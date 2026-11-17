import {
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from 'react';
import { RotateCcw } from 'lucide-react';
import {
  schematicRuleDefinitions,
  workbenchPCBDesignRules,
  type PCBDesignRuleConfig,
  type SchematicRuleId,
  type SchematicRuleSeverities,
} from '@/lib/design-rule-checks';
import Dialog from './Dialog';
import DRCSettings, { drcSettingsTabs, RuleSeveritySelect } from './DRCSettings';
import { parseRuleLimitDrafts, ruleLimitDrafts, type RuleLimitDrafts } from './RuleLimits';
import RuleTabs from './RuleTabs';
import styles from './RuleCheckPanel.module.css';

const tabs = ['Schematic', ...drcSettingsTabs] as const;
const schematicGroups = {
  Connectivity: [
    'erc.pin-unconnected',
    'erc.input-undriven',
    'erc.power-undriven',
    'erc.output-conflict',
    'erc.pin-conflict',
    'erc.net-name-conflict',
  ],
  'Wires & markers': [
    'erc.wire-dangling',
    'erc.wire-zero-length',
    'erc.label-dangling',
    'erc.no-connect-misplaced',
    'erc.no-connect-connected',
  ],
  Symbols: ['erc.reference-conflict', 'erc.pin-type-unsupported', 'erc.pin-type-inconsistent'],
} as const satisfies Record<string, readonly SchematicRuleId[]>;

export type RuleSettingsDraft = {
  erc: SchematicRuleSeverities;
  limits: RuleLimitDrafts;
  severities: PCBDesignRuleConfig['severities'];
  resetToDefault?: boolean;
};

export type RuleSettingsProps = {
  erc: SchematicRuleSeverities;
  drc: PCBDesignRuleConfig;
  retainedDraft: RefObject<RuleSettingsDraft | null>;
  initialTab?: 'Schematic' | 'Copper & Routing';
  blockedReason: string;
  onApply: (erc: SchematicRuleSeverities, drc: PCBDesignRuleConfig) => boolean;
};

export type RuleSettingsActions = {
  isComposing: () => boolean;
  apply: () => boolean;
};

export default function RuleSettings({
  ref,
  erc,
  drc,
  retainedDraft,
  initialTab = 'Schematic',
  blockedReason,
  onApply,
}: RuleSettingsProps & { ref?: Ref<RuleSettingsActions> }) {
  const id = useId();
  const composing = useRef(false);
  const [active, setActive] = useState<(typeof tabs)[number]>(initialTab);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draft, setDraft] = useState<RuleSettingsDraft>(
    () =>
      retainedDraft.current ?? {
        erc,
        limits: ruleLimitDrafts(drc),
        severities: drc.severities,
      },
  );
  const baseDRC = draft.resetToDefault ? workbenchPCBDesignRules : drc;
  const limits = parseRuleLimitDrafts(draft.limits);
  const error = limits ? '' : 'Enter each limit from 0 to 1000 mm.';
  const nextDRC: PCBDesignRuleConfig | null = limits
    ? {
        ...baseDRC,
        ...limits,
        severities: draft.severities,
      }
    : null;
  const changed =
    JSON.stringify(erc) !== JSON.stringify(draft.erc) ||
    (nextDRC !== null && JSON.stringify(drc) !== JSON.stringify(nextDRC));

  useImperativeHandle(ref, () => ({
    isComposing: () => composing.current,
    apply: () => {
      if (composing.current || confirmReset || !nextDRC) return false;
      if (changed && (blockedReason || !onApply(draft.erc, nextDRC))) return false;
      retainedDraft.current = null;
      return true;
    },
  }));

  function update(next: RuleSettingsDraft) {
    if (composing.current || blockedReason) return false;
    retainedDraft.current = next;
    setDraft(next);
    return true;
  }

  function guardKey(event: KeyboardEvent<HTMLElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  return (
    <div
      className={styles.ruleSettings}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      onClickCapture={(event) => {
        if (
          composing.current &&
          event.target instanceof Element &&
          event.target.closest('button')
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="settings-section-header">
        <h3 className="settings-section-heading">Rule</h3>
        <button
          type="button"
          className={`icon-button ${styles.resetRules}`}
          aria-label="Reset to default"
          title="Reset to default"
          disabled={!!blockedReason}
          onPointerDown={(event) => {
            if (composing.current) event.preventDefault();
          }}
          onKeyDown={guardKey}
          onKeyUp={guardKey}
          onClick={() => {
            if (!composing.current && !blockedReason) setConfirmReset(true);
          }}
        >
          <RotateCcw size={17} aria-hidden="true" />
        </button>
      </div>
      <RuleTabs
        id={id}
        label="Rule settings"
        tabs={tabs}
        active={active}
        onSelect={setActive}
        guardKey={guardKey}
      />
      {tabs.map((tab, index) => (
        <div
          key={tab}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={active !== tab}
        >
          {tab === 'Schematic' ? (
            <div className={styles.limits}>
              {Object.entries(schematicGroups).map(([label, rules]) => (
                <section key={label}>
                  <h3 className={styles.sourceHeading}>{label}</h3>
                  <div className={styles.limitGrid} role="group" aria-label={label}>
                    {rules.map((rule) => {
                      const [name, baseline] = schematicRuleDefinitions[rule];
                      return (
                        <div className={styles.limitField} key={rule}>
                          <span>{name}</span>
                          <RuleSeveritySelect
                            label={name}
                            value={draft.erc[rule]}
                            baseline={baseline}
                            disabled={!!blockedReason}
                            onChange={(severity) => {
                              const erc = { ...draft.erc };
                              if (severity) erc[rule] = severity;
                              else delete erc[rule];
                              update({ ...draft, erc });
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <DRCSettings
              tab={tab}
              drafts={draft.limits}
              severities={draft.severities}
              busy={!!blockedReason}
              onThreshold={(key, value) =>
                update({ ...draft, limits: { ...draft.limits, [key]: value } })
              }
              onSeverity={(rules, severity) => {
                const severities = { ...draft.severities };
                for (const rule of rules) {
                  if (severity) severities[rule] = severity;
                  else delete severities[rule];
                }
                update({ ...draft, severities });
              }}
            />
          )}
        </div>
      ))}
      {(blockedReason || error) && (
        <p className={styles.ruleSettingsError} role="alert">
          {blockedReason || error}
        </p>
      )}
      {confirmReset && (
        <Dialog
          compact
          maximizable={false}
          title="Reset rule settings?"
          onClose={() => setConfirmReset(false)}
          footer={
            <>
              <button
                type="button"
                className="dialog-button secondary"
                data-autofocus
                onClick={() => setConfirmReset(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dialog-button primary"
                disabled={!!blockedReason}
                onClick={() => {
                  if (
                    update({
                      erc: {},
                      limits: ruleLimitDrafts(workbenchPCBDesignRules),
                      severities: workbenchPCBDesignRules.severities,
                      resetToDefault: true,
                    })
                  )
                    setConfirmReset(false);
                }}
              >
                Reset
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
