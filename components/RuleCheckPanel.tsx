'use client';
import QuantityInput from './QuantityInput';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ClipboardCheck, Play, RefreshCw } from 'lucide-react';
import type { RuleCheckIssue, RuleCheckResult } from '@/lib/design-rule-checks';
import type { PCBDesignRuleConfig } from '@/lib/pcb-drc';
import Dialog, { type DialogSizeProps } from './Dialog';
import { DRCIcon, ERCIcon } from './EditorIcons';
import styles from './RuleCheckPanel.module.css';

const limitFields = [
  ['clearance', 'Copper clearance'],
  ['minTrackWidth', 'Minimum track width'],
  ['minViaDrill', 'Minimum via drill'],
  ['minAnnularRing', 'Minimum annular ring'],
  ['copperToEdge', 'Copper to board edge'],
  ['copperToHole', 'Copper to hole'],
] as const satisfies readonly (readonly [keyof PCBDesignRuleConfig, string])[];
type LimitDrafts = Record<(typeof limitFields)[number][0], string>;

function limitDrafts(settings?: PCBDesignRuleConfig): LimitDrafts {
  return Object.fromEntries(
    limitFields.map(([key]) => [key, settings ? String(settings[key]) : '']),
  ) as LimitDrafts;
}
function validLimit(value: string) {
  return (
    value.trim() !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 1000
  );
}
function parseLimits(drafts: LimitDrafts): PCBDesignRuleConfig | null {
  return limitFields.every(([key]) => validLimit(drafts[key]))
    ? (Object.fromEntries(
        limitFields.map(([key]) => [key, Number(drafts[key])]),
      ) as PCBDesignRuleConfig)
    : null;
}
function ruleLabel(id: string) {
  const label = id.replace(/^(erc|drc|pcb)[.:/_-]/i, '').replace(/[._-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type RuleCheckPanelProps = {
  kind: 'erc' | 'drc';
  onKindChange: (kind: 'erc' | 'drc') => void;
  drcAvailable?: boolean;
  report: RuleCheckResult | null;
  busy?: boolean;
  error?: string;
  stale?: boolean;
  sourcePending?: boolean;
  blockedReason?: string;
  drcSettings?: PCBDesignRuleConfig;
  onDRCSettingsChange?: (settings: PCBDesignRuleConfig) => void;
  onRun: (settings?: PCBDesignRuleConfig) => void;
  onSelectIssue: (issue: RuleCheckIssue) => void;
  onClose: () => void;
} & DialogSizeProps;

export default function RuleCheckPanel({
  kind,
  onKindChange,
  drcAvailable = true,
  report,
  busy = false,
  error = '',
  stale = false,
  sourcePending = false,
  blockedReason = '',
  drcSettings,
  onDRCSettingsChange,
  onRun,
  onSelectIssue,
  onClose,
  size,
  onResize,
}: RuleCheckPanelProps) {
  const id = useId();
  const runButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    // Disabling the focused action during a check can return browser focus to
    // the body. Restore the panel's keyboard path when that check settles.
    if (busy || document.activeElement !== document.body) return;
    const target = runButton.current;
    (target && !target.disabled
      ? target
      : target
          ?.closest('dialog')
          ?.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]:not(:disabled)')
    )?.focus({ preventScroll: true });
  }, [busy]);
  const [drafts, setDrafts] = useState(() => limitDrafts(drcSettings));
  useEffect(() => {
    setDrafts(limitDrafts(drcSettings));
  }, [
    drcSettings?.clearance,
    drcSettings?.minTrackWidth,
    drcSettings?.minViaDrill,
    drcSettings?.minAnnularRing,
    drcSettings?.copperToEdge,
    drcSettings?.copperToHole,
  ]);
  const limits = kind === 'drc' ? parseLimits(drafts) : null;
  const limitsChanged =
    kind === 'drc' &&
    drcSettings &&
    limitFields.some(
      ([key]) => !validLimit(drafts[key]) || Number(drafts[key]) !== drcSettings[key],
    );
  const currentReport = report?.kind === kind ? report : null;
  const code = kind.toUpperCase();
  const errors = currentReport?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  const warnings =
    currentReport?.issues.filter((issue) => issue.severity === 'warning').length ?? 0;
  const incomplete = currentReport && (!currentReport.complete || currentReport.truncated);
  const outdated = stale || !!limitsChanged;
  const canRun =
    !busy &&
    !sourcePending &&
    !blockedReason &&
    (kind === 'erc' || (drcAvailable && !!drcSettings && !!limits));
  const canLocate = !busy && !sourcePending && !blockedReason && !outdated;
  const runLabel = `${currentReport ? 'Recheck' : 'Run'} ${code}`;
  function run() {
    if (!canRun) return;
    if (kind === 'drc' && limits) {
      if (limitsChanged) onDRCSettingsChange?.(limits);
      onRun(limits);
    } else onRun();
  }
  useEffect(() => {
    // Opening a window or choosing a tab uses the same validated local drafts
    // as Run. Editing a threshold alone never starts a background check.
    run();
  }, [kind]);
  return (
    <Dialog
      title="Rule"
      icon={<ClipboardCheck size={16} />}
      className={`independent-window ${styles.panel}`}
      onClose={onClose}
      busy={busy}
      minWidth={400}
      size={size}
      onResize={onResize}
      footer={
        <>
          <span className={styles.runStatus} role="status">
            {busy ? `Checking ${code}…` : currentReport ? '' : 'Not checked'}
          </span>
          <button
            ref={runButton}
            type="button"
            className="tool-button"
            aria-label={runLabel}
            title={runLabel}
            onClick={run}
            disabled={!canRun}
            onKeyDown={(event) => {
              if (
                (event.key === 'Enter' || event.key === ' ') &&
                (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {currentReport ? (
              <RefreshCw size={15} aria-hidden="true" />
            ) : (
              <Play size={15} aria-hidden="true" />
            )}
          </button>
        </>
      }
    >
      <div
        className={`editor-view-switch ${styles.tabs}`}
        role="tablist"
        aria-label="Rule"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            if (['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (sourcePending || blockedReason) return;
          const next =
            !drcAvailable || event.key === 'Home'
              ? 'erc'
              : event.key === 'End'
                ? 'drc'
                : kind === 'erc'
                  ? 'drc'
                  : 'erc';
          if (next !== kind) onKindChange(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`#${CSS.escape(id + '-' + next + '-tab')}`)
            ?.focus();
        }}
      >
        {(['erc', 'drc'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`reveal-button${kind === tab ? ' active' : ''}`}
            role="tab"
            aria-label={tab.toUpperCase()}
            id={`${id}-${tab}-tab`}
            aria-controls={`${id}-panel`}
            aria-selected={kind === tab}
            aria-description={tab === 'erc' ? 'Electrical rules' : 'Design rules'}
            tabIndex={kind === tab ? 0 : -1}
            disabled={sourcePending || Boolean(blockedReason) || (tab === 'drc' && !drcAvailable)}
            onClick={() => {
              if (kind !== tab) onKindChange(tab);
            }}
          >
            {tab === 'erc' ? (
              <ERCIcon size={16} aria-hidden="true" />
            ) : (
              <DRCIcon size={16} aria-hidden="true" />
            )}
            <span className="reveal-button-label" aria-hidden="true">
              <span>{tab.toUpperCase()}</span>
            </span>
          </button>
        ))}
      </div>
      <div
        className={styles.body}
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${kind}-tab`}
        onCompositionStartCapture={() => {
          composing.current = true;
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
        }}
      >
        {kind === 'drc' && (
          <fieldset
            className={styles.limits}
            aria-label="Design rule limits"
            disabled={busy || !drcSettings}
          >
            <div className={styles.limitGrid}>
              {limitFields.map(([key, label]) => (
                <label key={key}>
                  <span>{label}</span>
                  <QuantityInput
                    decimalPlaces={2}
                    unit={'mm'}
                    type="number"
                    min="0"
                    max="1000"
                    step="any"
                    aria-label={`${label} (mm)`}
                    aria-invalid={!validLimit(drafts[key])}
                    value={drafts[key]}
                    onValueChange={(inputValue) =>
                      setDrafts((current) => ({ ...current, [key]: inputValue }))
                    }
                    onBlur={() => {
                      if (limits && limitsChanged) onDRCSettingsChange?.(limits);
                    }}
                  />
                </label>
              ))}
            </div>
            {!drcSettings ? (
              <p className={styles.error} role="alert">
                Design rule limits are unavailable.
              </p>
            ) : (
              !limits && (
                <p className={styles.error} role="alert">
                  Enter each limit from 0 to 1000 mm.
                </p>
              )
            )}
          </fieldset>
        )}
        {sourcePending && (
          <p className={styles.notice} role="status">
            Apply Source edits before checking rules.
          </p>
        )}
        {!sourcePending && outdated && currentReport && (
          <p className={styles.notice} role="status">
            Design or limits changed. Recheck {code}.
          </p>
        )}
        {blockedReason && (
          <p className={styles.notice} role="status">
            {blockedReason}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {currentReport && (
          <>
            <div className={styles.summary} aria-label={`${code} summary`}>
              <span>
                <AlertCircle size={15} aria-hidden="true" />
                {errors} {errors === 1 ? 'error' : 'errors'}
              </span>
              <span>
                <AlertTriangle size={15} aria-hidden="true" />
                {warnings} {warnings === 1 ? 'warning' : 'warnings'}
              </span>
            </div>
            {incomplete && (
              <p className={styles.notice} role="status">
                Incomplete checks{currentReport.truncated ? ': issue list truncated.' : '.'}
              </p>
            )}
            {!currentReport.issues.length &&
              !incomplete &&
              !outdated &&
              !sourcePending &&
              !blockedReason &&
              !error &&
              !busy && <p className={styles.empty}>No violations found in checked rules.</p>}
            {!!currentReport.issues.length && (
              <ul className={styles.issues} aria-label={`${code} issues`}>
                {currentReport.issues.map((issue) => (
                  <li key={issue.id}>
                    <button
                      type="button"
                      className={styles.issue}
                      data-severity={issue.severity}
                      aria-label={`Locate issue: ${issue.message}`}
                      aria-description={`${issue.severity === 'error' ? 'Error' : 'Warning'} · ${ruleLabel(issue.ruleId)}`}
                      disabled={!canLocate || (!issue.objectIds.length && !issue.location)}
                      onClick={() => {
                        if (!composing.current) onSelectIssue(issue);
                      }}
                      onKeyDown={(event) => {
                        if (
                          (event.key === 'Enter' || event.key === ' ') &&
                          (composing.current ||
                            event.nativeEvent.isComposing ||
                            event.nativeEvent.keyCode === 229)
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                        }
                      }}
                    >
                      <span className={styles.ruleName} aria-description={issue.ruleId}>
                        {ruleLabel(issue.ruleId)}
                      </span>
                      <span className={styles.message}>{issue.message}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
