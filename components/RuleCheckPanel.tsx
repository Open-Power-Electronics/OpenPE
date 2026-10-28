'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, LocateFixed, Play, RefreshCw } from 'lucide-react';
import type { RuleCheckIssue, RuleCheckResult } from '@/lib/design-rule-checks';
import type { PCBDesignRuleConfig } from '@/lib/pcb-drc';
import Dialog, { type DialogSizeProps } from './Dialog';
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
  const runButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Disabling the focused action during a check can return browser focus to
    // the body. Restore the panel's keyboard path when that check settles.
    if (busy || document.activeElement !== document.body) return;
    const target = runButton.current;
    (target && !target.disabled
      ? target
      : target?.closest('dialog')?.querySelector<HTMLButtonElement>('button:not(:disabled)')
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
    !busy && !sourcePending && !blockedReason && (kind === 'erc' || (!!drcSettings && !!limits));
  const canLocate = !busy && !sourcePending && !blockedReason && !outdated;
  const runLabel = `${currentReport ? 'Recheck' : 'Run'} ${code}`;
  function run() {
    if (!canRun) return;
    if (kind === 'drc' && limits) {
      if (limitsChanged) onDRCSettingsChange?.(limits);
      onRun(limits);
    } else onRun();
  }
  return (
    <Dialog
      title={kind === 'erc' ? 'Electrical rules' : 'Design rules'}
      label={`${code} checks`}
      className={`independent-window schematic-panel ${styles.panel}`}
      onClose={onClose}
      busy={busy}
      resizable
      resizeCorner="bottom-right"
      minWidth={320}
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
      {kind === 'drc' && (
        <fieldset className={styles.limits} disabled={busy || !drcSettings}>
          <legend>Limits (mm)</legend>
          <div className={styles.limitGrid}>
            {limitFields.map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  step="any"
                  aria-label={`${label} (mm)`}
                  aria-invalid={!validLimit(drafts[key])}
                  value={drafts[key]}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [key]: event.target.value }))
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
                  <div className={styles.issueText}>
                    <span className={styles.severity} aria-description={issue.ruleId}>
                      {issue.severity === 'error' ? 'Error' : 'Warning'} · {ruleLabel(issue.ruleId)}
                    </span>
                    <p>{issue.message}</p>
                  </div>
                  <button
                    type="button"
                    className="tool-button"
                    aria-label={`Locate issue: ${issue.message}`}
                    title="Locate issue"
                    disabled={!canLocate || (!issue.objectIds.length && !issue.location)}
                    onClick={() => onSelectIssue(issue)}
                  >
                    <LocateFixed size={17} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Dialog>
  );
}
