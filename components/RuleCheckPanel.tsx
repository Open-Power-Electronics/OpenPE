'use client';
import QuantityInput from './QuantityInput';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertCircle, AlertTriangle, Box, RefreshCw, X } from 'lucide-react';
import type { ModelCheckIssue, ModelCheckReport } from './model-checks';
import type { RuleCheckIssue, RuleCheckResult } from '@/lib/design-rule-checks';
import type { PCBDesignRuleConfig } from '@/lib/pcb-drc';
import { DRCIcon, ERCIcon } from './EditorIcons';
import BottomPanelResize from './BottomPanelResize';
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

function issueSummary(issue: RuleCheckIssue) {
  // The rule name already identifies the missing driver in these rows.
  if (issue.ruleId === 'erc.power-undriven')
    return issue.message.replace(/ has no power output on its network\.$/, '');
  if (issue.ruleId === 'erc.input-undriven')
    return issue.message.replace(/ has no signal driver on its network\.$/, '');
  return issue.message;
}

export type RuleCheckKind = 'erc' | 'drc' | 'model';
type RuleCheckPanelProps = {
  panelId?: string;
  kind: RuleCheckKind;
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
  modelReport?: ModelCheckReport | null;
  onSelectModelCheckIssue?: (issue: ModelCheckIssue) => void;
  onClose: () => void;
};

export default function RuleCheckPanel({
  panelId,
  kind,
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
  modelReport,
  onSelectModelCheckIssue,
  onClose,
}: RuleCheckPanelProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const restoreRunFocus = useRef(false);
  useEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (busy || !restoreRunFocus.current) return;
    restoreRunFocus.current = false;
    if (document.activeElement !== document.body) return;
    const run = runButton.current;
    (run && !run.disabled ? run : closeButton.current)?.focus({ preventScroll: true });
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
  const modelErrors = modelReport?.issues.filter((issue) => issue.severity === 'error').length ?? 0;
  const modelWarnings =
    modelReport?.issues.filter((issue) => issue.severity === 'warning').length ?? 0;
  const incomplete = currentReport && (!currentReport.complete || currentReport.truncated);
  const outdated = stale || !!limitsChanged;
  const canRun =
    !busy && !sourcePending && !blockedReason && (kind === 'erc' || (!!drcSettings && !!limits));
  const canLocate = !busy && !sourcePending && !blockedReason && !outdated;
  const runLabel = `${currentReport ? 'Recheck' : 'Run'} ${code}`;
  function blockComposingActivation(event: KeyboardEvent<HTMLElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  function run() {
    if (composing.current || kind === 'model' || !canRun) return;
    if (kind === 'drc' && limits) {
      if (limitsChanged) onDRCSettingsChange?.(limits);
      onRun(limits);
    } else onRun();
  }
  useEffect(() => {
    // Opening the popup uses the same validated local drafts
    // as Run. Editing a threshold alone never starts a background check.
    run();
  }, [kind]);
  return (
    <div className={styles.anchor} ref={anchor}>
      <section
        id={panelId}
        role="dialog"
        aria-label="Rule"
        className={styles.panel}
        onCompositionStartCapture={() => {
          composing.current = true;
        }}
        onCompositionEndCapture={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          event.preventDefault();
          onClose();
        }}
      >
        <BottomPanelResize
          target={anchor}
          visible
          label="Resize Rule panel"
          initialMaxHeight={300}
        />
        <div className={styles.header}>
          <h2 className={styles.title}>
            {kind === 'erc' ? (
              <ERCIcon size={16} aria-hidden="true" />
            ) : kind === 'drc' ? (
              <DRCIcon size={16} aria-hidden="true" />
            ) : (
              <Box size={16} aria-hidden="true" />
            )}
            {kind === 'model' ? 'Model checks' : code}
          </h2>
          <div className={styles.actions}>
            {kind !== 'model' && (
              <button
                ref={runButton}
                type="button"
                className="tool-button"
                aria-label={runLabel}
                title={runLabel}
                onClick={() => {
                  if (composing.current) return;
                  restoreRunFocus.current = document.activeElement === runButton.current;
                  run();
                }}
                disabled={!canRun}
                onKeyDown={blockComposingActivation}
                onKeyUp={blockComposingActivation}
              >
                <RefreshCw size={15} className={busy ? 'spin' : undefined} aria-hidden="true" />
              </button>
            )}
            <button
              ref={closeButton}
              type="button"
              className="tool-button"
              aria-label="Close Rule"
              title="Close Rule"
              onClick={() => {
                if (!composing.current) onClose();
              }}
              onKeyDown={blockComposingActivation}
              onKeyUp={blockComposingActivation}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className={styles.body} data-rule-body>
          {kind !== 'model' && (
            <div className={styles.runStatus} role="status">
              {busy ? `Checking ${code}…` : currentReport ? '' : 'Not checked'}
            </div>
          )}
          {kind === 'model' && (
            <>
              {!modelReport ? (
                <p className={styles.empty}>Preview not loaded.</p>
              ) : modelReport.state === 'loading' ? (
                <p className={styles.statusMessage} role="status">
                  Loading models…
                </p>
              ) : (
                <>
                  <div className={styles.summary} aria-label="Model summary">
                    <span>
                      <AlertCircle size={15} aria-hidden="true" />
                      {modelErrors} {modelErrors === 1 ? 'error' : 'errors'}
                    </span>
                    <span>
                      <AlertTriangle size={15} aria-hidden="true" />
                      {modelWarnings} {modelWarnings === 1 ? 'warning' : 'warnings'}
                    </span>
                  </div>
                  {!modelReport.issues.length ? (
                    <p className={styles.empty}>No model issues.</p>
                  ) : (
                    <ul className={styles.issues} aria-label="Model issues">
                      {modelReport.issues.map((issue, index) => (
                        <li key={index}>
                          {issue.footprintId ? (
                            <button
                              type="button"
                              className={styles.issue}
                              data-severity={issue.severity}
                              aria-label={`Locate ${issue.message}`}
                              aria-description={issue.severity === 'error' ? 'Error' : 'Warning'}
                              disabled={
                                !canLocate || !modelReport.canLocate || !onSelectModelCheckIssue
                              }
                              onClick={() => {
                                if (!composing.current) onSelectModelCheckIssue?.(issue);
                              }}
                              onKeyDown={blockComposingActivation}
                              onKeyUp={blockComposingActivation}
                            >
                              <span className={styles.message} title={issue.message}>
                                {issue.message}
                              </span>
                            </button>
                          ) : (
                            <div className={styles.issue} data-severity={issue.severity}>
                              <span className={styles.message} title={issue.message}>
                                {issue.message}
                              </span>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
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
            <p className={styles.statusMessage} role="status">
              Apply Source edits before checking rules.
            </p>
          )}
          {!sourcePending && outdated && currentReport && (
            <p className={styles.statusMessage} role="status">
              Design or limits changed. Recheck {code}.
            </p>
          )}
          {blockedReason && (
            <p className={styles.statusMessage} role="status">
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
                <p className={styles.statusMessage} role="status">
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
                        <span className={styles.message} title={issue.message}>
                          {issueSummary(issue)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
