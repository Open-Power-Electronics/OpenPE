'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Box,
  Circle,
  CircleCheck,
  Plus,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import type { ModelCheckIssue, ModelCheckReport } from './model-checks';
import {
  pcbDesignRuleLimitKeys,
  pcbDesignRuleLimitChecks,
  pcbDesignRuleLimits,
  workbenchPCBDesignRules,
  type PCBDesignRuleConfig,
  type PCBDesignRuleLimit,
  type RuleCheckIssue,
  type RuleCheckResult,
} from '@/lib/design-rule-checks';
import type { BoardLine, BoardZone } from '@/lib/pcb';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import type { Project } from '@/lib/project';
import BottomPanelResize from './BottomPanelResize';
import {
  RuleValue,
  parseRuleLimitDrafts,
  ruleLimitCaptions,
  ruleLimitDrafts,
  validRuleLimitDraft,
} from './RuleLimits';
import Select from './Select';
import styles from './RuleCheckPanel.module.css';

const quickLimits = [
  ['clearance', 'Min. clearance'],
  ['minTrackWidth', 'Track width'],
  ['copperToEdge', 'Board edge'],
  ['minThroughHole', 'Through-hole'],
  ['minViaDiameter', 'Via diameter'],
] as const;
const extraQuickLimits = [
  'minAnnularRing',
  'copperToHole',
  'holeToHole',
  'minSilkClearance',
] as const satisfies readonly PCBDesignRuleLimit[];

function ruleLabel(id: string) {
  const label = id.replace(/^(erc|drc|pcb)[.:/_-]/i, '').replace(/[._-]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type DRCSource = Pick<Project, 'pcb' | 'schematic'>;
type DRCObjectLabel = { object: string; net?: string; layer?: string; ownerId?: string };

function drcObjectLabels({ pcb, schematic }: DRCSource, issues: readonly RuleCheckIssue[]) {
  const labels = new Map<string, DRCObjectLabel>();
  if (!pcb || !issues.length) return labels;
  const ids = new Set(issues.flatMap(({ objectIds }) => objectIds));
  const nets = new Map(pcb.nets.map(({ id, name }) => [id, name]));
  const references = new Map(schematic.parts.map(({ id, ref }) => [id, ref]));
  const addZone = ({ id, keepout, netId, layer }: BoardZone) => {
    if (ids.has(id))
      labels.set(id, {
        object: keepout ? 'Rule area' : 'Zone',
        net: keepout ? undefined : nets.get(netId ?? ''),
        layer,
      });
  };
  const addGraphic = ({ id, kind, layer }: BoardLine) => {
    if (ids.has(id)) labels.set(id, { object: kind === 'text' ? 'Text' : 'Graphic', layer });
  };
  if (ids.has(pcb.id)) labels.set(pcb.id, { object: 'Board' });
  for (const track of pcb.tracks) {
    if (ids.has(track.id))
      labels.set(track.id, { object: 'Track', net: nets.get(track.netId), layer: track.layer });
  }
  for (const via of pcb.vias) {
    if (ids.has(via.id)) labels.set(via.id, { object: 'Via', net: nets.get(via.netId) });
  }
  pcb.zones.forEach(addZone);
  pcb.graphics.forEach(addGraphic);
  for (const footprint of pcb.footprints) {
    const reference =
      references.get(footprint.symbolId ?? '') || footprint.reference || footprint.libraryId;
    if (ids.has(footprint.id)) labels.set(footprint.id, { object: reference });
    for (const pad of footprint.pads) {
      if (ids.has(pad.id)) {
        const layers = padCopperLayers(pcb, footprint, pad);
        labels.set(pad.id, {
          object: [reference, 'pad', pad.number].filter(Boolean).join(' '),
          ownerId: footprint.id,
          net: nets.get(pad.netId ?? ''),
          layer: layers.length === 1 ? layers[0] : undefined,
        });
      }
    }
    footprint.zones?.forEach(addZone);
    footprint.graphics.forEach(addGraphic);
  }
  return labels;
}

// The full diagnostic remains available to assistive technology. Only compact
// known DRC message forms when their objects are already shown in the heading.
const drcDetailReplacements: Partial<Record<string, readonly [RegExp, string]>> = {
  'pcb.clearance': [/^.*? clearance is (?=[\d.]+ mm; requires )/s, ''],
  'pcb.copper-edge': [
    /^.*?(?: to board edge\/cutout clearance is (?=[\d.]+ mm; requires )| (?=extends outside the board or into a cutout\.$))/s,
    '',
  ],
  'pcb.copper-hole': [
    /^.*? to ((?:foreign-net plated|non-plated) hole) clearance is (?=-?[\d.]+ mm; requires )/s,
    'Clearance to a $1 is ',
  ],
  'pcb.pad-drill': [/^.*? (?=drill [\d.]+ mm is below )/s, ''],
  'pcb.annular-ring': [/^.*? has (?=-?[\d.]+ mm minimum annular ring; requires )/s, ''],
  'pcb.short': [
    /^.+ on a shared copper layer with different or unassigned nets\.$/s,
    'Contact on a shared copper layer with different or unassigned nets.',
  ],
  'pcb.unassigned-copper': [
    /^.*? is within ([\d.]+ mm) of .+?, but at least one copper object has no assigned net\./s,
    'Separation is $1. At least one copper object has no assigned net.',
  ],
  'pcb.courtyard-malformed': [/^.+? has a malformed (.+? courtyard\.)/s, 'Malformed $1'],
  'pcb.courtyard-overlap': [/^.+? courtyards overlap on /s, 'Courtyards overlap on '],
  'pcb.keepout': [/^.+? enters a .+? keepout\.$/s, 'Copper enters a restricted area.'],
};

function drcIssueDetail(issue: RuleCheckIssue, labels: readonly DRCObjectLabel[]) {
  if (issue.ruleId === 'pcb.unrouted') {
    return issue.message.replace(/^Net (.+) has disconnected pad groups\.$/s, (message, net) =>
      labels.some((label) => label.net === net) ? 'Pad groups are disconnected.' : message,
    );
  }
  const replacement = drcDetailReplacements[issue.ruleId];
  if (!replacement) return issue.message;
  const compact = issue.message.replace(...replacement);
  if (compact === issue.message) return compact;
  const detail = compact.replace(/ \(zone (.+)\)\.$/s, (suffix, label: string) =>
    labels.some(
      ({ object, net, layer }) => object === 'Zone' && `${net || 'Zone'} · ${layer}` === label,
    )
      ? '.'
      : suffix,
  );
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

const drcTagKinds = ['net', 'layer', 'object'] as const;

function drcIssuePresentation(issue: RuleCheckIssue, labels: ReadonlyMap<string, DRCObjectLabel>) {
  const objects = issue.objectIds.flatMap((id) => {
    const label = labels.get(id);
    return label ? [{ id, ...label }] : [];
  });
  const padOwners = new Set(objects.map(({ ownerId }) => ownerId));
  const visible = objects.filter(({ id }) => !padOwners.has(id));
  const tags = drcTagKinds.flatMap((kind) =>
    [...new Set(visible.map((label) => label[kind]))]
      .filter((text): text is string => !!text)
      .map((text) => ({ kind, text })),
  );
  const detail =
    objects.length && objects.length === issue.objectIds.length
      ? drcIssueDetail(issue, visible)
      : issue.message;
  return { tags, detail };
}

function RuleSummary({
  label,
  issues,
  complete,
  partial = false,
  cleanMessage,
}: {
  label: string;
  issues?: readonly Pick<RuleCheckIssue, 'severity'>[];
  complete: boolean;
  partial?: boolean;
  cleanMessage: string;
}) {
  if (complete && issues?.length === 0)
    return (
      <p className={`${styles.empty} ${styles.clearResult}`} role="status">
        <CircleCheck size={16} aria-hidden="true" />
        {cleanMessage}
      </p>
    );

  const errors = issues?.filter((issue) => issue.severity === 'error').length;
  const warnings = issues?.filter((issue) => issue.severity === 'warning').length;
  const clearErrors = complete && errors === 0;
  const ErrorIcon = errors ? AlertCircle : clearErrors ? CircleCheck : Circle;
  return (
    <div className={styles.summary} aria-label={label}>
      <span data-count-state={errors ? 'error' : clearErrors ? 'clear' : 'neutral'}>
        <ErrorIcon size={15} aria-hidden="true" />
        {errors ?? '—'} {errors === 1 ? 'error' : 'errors'}
      </span>
      <span data-count-state={warnings ? 'warning' : 'neutral'}>
        <AlertTriangle size={15} aria-hidden="true" />
        {warnings ?? '—'} {warnings === 1 ? 'warning' : 'warnings'}
      </span>
      {partial && <span>Partial report</span>}
    </div>
  );
}

export type RuleCheckKind = 'erc' | 'drc' | 'model';
type RuleCheckPanelProps = {
  panelId?: string;
  kind: RuleCheckKind;
  report: RuleCheckResult | null;
  busy?: boolean;
  quietRefresh?: boolean;
  error?: string;
  stale?: boolean;
  sourcePending?: boolean;
  blockedReason?: string;
  drcSource?: DRCSource | null;
  drcSettings?: PCBDesignRuleConfig;
  retainedDRCQuickLimits?: RefObject<readonly PCBDesignRuleLimit[]>;
  onDRCDraftChange?: (pending: boolean) => void;
  onDRCSettingsChange?: (settings: PCBDesignRuleConfig) => void;
  onOpenSettings?: () => void;
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
  quietRefresh = false,
  error = '',
  stale = false,
  sourcePending = false,
  blockedReason = '',
  drcSource,
  drcSettings = workbenchPCBDesignRules,
  retainedDRCQuickLimits,
  onDRCDraftChange,
  onDRCSettingsChange,
  onOpenSettings,
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
  const focusQuickLimit = useRef<PCBDesignRuleLimit | null>(null);
  const limitId = useId();
  const [refreshCount, setRefreshCount] = useState(0);
  const [addedQuickLimits, setAddedQuickLimits] = useState<readonly PCBDesignRuleLimit[]>(
    () => retainedDRCQuickLimits?.current ?? [],
  );
  const availableQuickLimits = extraQuickLimits.filter((key) => !addedQuickLimits.includes(key));
  useLayoutEffect(() => {
    const key = focusQuickLimit.current;
    if (!key) return;
    focusQuickLimit.current = null;
    const input = document.getElementById(`${limitId}-${key}`);
    if (input instanceof HTMLInputElement && !input.matches(':disabled'))
      input.focus({ preventScroll: true });
    else closeButton.current?.focus({ preventScroll: true });
  }, [addedQuickLimits, limitId]);
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
  const [drafts, setDrafts] = useState(() => ruleLimitDrafts(drcSettings));
  useEffect(() => setDrafts(ruleLimitDrafts(drcSettings)), [drcSettings]);
  const thresholds = kind === 'drc' ? parseRuleLimitDrafts(drafts) : null;
  const limits = thresholds && { ...drcSettings, ...thresholds };
  const limitsLocked = busy || sourcePending || !!blockedReason;
  const limitsChanged =
    kind === 'drc' &&
    (!limits || pcbDesignRuleLimitKeys.some((key) => limits[key] !== drcSettings[key]));
  useEffect(() => {
    onDRCDraftChange?.(!!limitsChanged);
  }, [limitsChanged, onDRCDraftChange]);
  const currentReport = report?.kind === kind ? report : null;
  const objectLabels = useMemo(
    () =>
      kind === 'drc' && !stale && drcSource && currentReport
        ? drcObjectLabels(drcSource, currentReport.issues)
        : null,
    [kind, stale, drcSource, currentReport],
  );
  const code = kind.toUpperCase();
  const hasIssues =
    kind === 'model' ? !!modelReport?.issues.length : !!currentReport?.issues.length;
  const incomplete = currentReport && (!currentReport.complete || currentReport.truncated);
  const outdated = stale || !!limitsChanged;
  const canRun = !busy && !sourcePending && !blockedReason && (kind === 'erc' || !!limits);
  const canLocate = !busy && !sourcePending && !blockedReason && !outdated;
  const showProgress = busy && !quietRefresh;
  const countsCurrent = !outdated && !sourcePending && !blockedReason && !error && !showProgress;
  const displayedIssues = countsCurrent ? currentReport?.issues : undefined;
  const fitContent = kind !== 'model' && !incomplete && displayedIssues?.length === 0;
  useLayoutEffect(() => {
    if (fitContent && anchor.current?.querySelector('.bottom-panel-resize:focus')) {
      closeButton.current?.focus({ preventScroll: true });
    }
  }, [fitContent]);
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
      onRun(limits);
    } else onRun();
  }
  return (
    <div className={styles.anchor} ref={anchor}>
      <section
        id={panelId}
        role="dialog"
        aria-label="Rule"
        className={kind === 'model' ? styles.panel : `${styles.panel} ${styles[kind]}`}
        data-fit-content={fitContent || undefined}
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
          visible={!fitContent}
          label="Resize Rule panel"
          initialMaxHeight={kind === 'model' ? 300 : 240}
        />
        <div className={styles.header}>
          <h2 className={styles.title}>
            {kind === 'model' && <Box size={16} aria-hidden="true" />}
            {kind === 'model' ? 'Model checks' : code}
          </h2>
          <div className={styles.actions}>
            {kind !== 'model' && onOpenSettings && (
              <button
                type="button"
                className="tool-button"
                aria-label={`${code} settings`}
                title={`${code} settings`}
                onClick={() => {
                  if (!composing.current) onOpenSettings();
                }}
                onKeyDown={blockComposingActivation}
                onKeyUp={blockComposingActivation}
              >
                <Settings size={16} aria-hidden="true" />
              </button>
            )}
            {kind !== 'model' && (
              <button
                ref={runButton}
                type="button"
                className="tool-button"
                aria-label={runLabel}
                title={runLabel}
                onClick={() => {
                  if (composing.current || !canRun) return;
                  setRefreshCount((count) => count + 1);
                  restoreRunFocus.current = document.activeElement === runButton.current;
                  run();
                }}
                disabled={!canRun}
                onKeyDown={blockComposingActivation}
                onKeyUp={blockComposingActivation}
              >
                <RefreshCw
                  key={refreshCount}
                  size={15}
                  className={showProgress || refreshCount ? `spin ${styles.refresh}` : undefined}
                  data-busy={showProgress}
                  aria-hidden="true"
                />
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
        <div
          className={styles.body}
          data-rule-body
          role="region"
          aria-label={kind === 'model' ? 'Model report' : `${code} report`}
          tabIndex={hasIssues ? 0 : undefined}
        >
          {kind !== 'model' && (
            <div className={styles.runStatus} role="status">
              {showProgress ? `Checking ${code}…` : currentReport ? '' : 'Not checked'}
            </div>
          )}
          {kind === 'drc' && (
            <fieldset
              className={styles.quickLimits}
              aria-label="DRC thresholds"
              disabled={limitsLocked}
            >
              <div className={styles.limitGrid}>
                {[
                  ...quickLimits,
                  ...addedQuickLimits.map((key) => [key, ruleLimitCaptions[key]] as const),
                ].map(([key, caption]) => {
                  const [, , , label] = pcbDesignRuleLimits[key];
                  return (
                    <RuleValue
                      key={key}
                      id={`${limitId}-${key}`}
                      label={label}
                      caption={caption}
                      value={drafts[key]}
                      enabled={pcbDesignRuleLimitChecks(key).some(
                        (rule) => drcSettings.severities[rule] !== 'ignore',
                      )}
                      valid={validRuleLimitDraft(drafts[key])}
                      onChange={(value) => setDrafts((current) => ({ ...current, [key]: value }))}
                      onCommit={() => {
                        if (!composing.current && limits && limitsChanged && !limitsLocked)
                          onDRCSettingsChange?.(limits);
                      }}
                    />
                  );
                })}
                <div
                  className={styles.addQuickLimit}
                  onKeyDownCapture={blockComposingActivation}
                  onKeyUpCapture={blockComposingActivation}
                >
                  <Select
                    label="Add DRC setting"
                    placeholder="Add"
                    value=""
                    icon={<Plus size={15} aria-hidden="true" />}
                    showChevron={false}
                    popupClassName={styles.addQuickLimitMenu}
                    popupMatchWidth="content"
                    onClosedEscape={onClose}
                    disabled={limitsLocked || !availableQuickLimits.length}
                    options={availableQuickLimits.map((key) => ({
                      value: key,
                      label: ruleLimitCaptions[key],
                    }))}
                    onChange={(value) => {
                      if (composing.current) return;
                      const key = availableQuickLimits.find((option) => option === value);
                      if (!key) return;
                      const next = [...addedQuickLimits, key];
                      focusQuickLimit.current = key;
                      if (retainedDRCQuickLimits) retainedDRCQuickLimits.current = next;
                      setAddedQuickLimits(next);
                    }}
                  />
                </div>
              </div>
            </fieldset>
          )}
          {kind === 'drc' && !limits && (
            <p className={styles.settingsError} role="alert">
              Enter each limit from 0 to 1000 mm.
            </p>
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
                  <RuleSummary
                    label="Model summary"
                    issues={countsCurrent ? modelReport.issues : undefined}
                    complete={modelReport.state === 'ready'}
                    cleanMessage="No model issues."
                  />
                  {modelReport.issues.length > 0 && (
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
          {sourcePending && (
            <p className={styles.statusMessage} role="status">
              Apply Source edits before checking rules.
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
              <RuleSummary
                label={`${code} summary`}
                issues={displayedIssues}
                complete={!incomplete}
                partial={countsCurrent && !!incomplete}
                cleanMessage="No violations"
              />
              {currentReport.truncated && (
                <p className={styles.statusMessage} role="status">
                  Issue list truncated.
                </p>
              )}
              {!!currentReport.issues.length && (
                <ul className={styles.issues} aria-label={`${code} issues`}>
                  {currentReport.issues.map((issue) => {
                    const name = ruleLabel(issue.ruleId);
                    const presentation = objectLabels && drcIssuePresentation(issue, objectLabels);
                    return (
                      <li key={issue.id}>
                        <button
                          type="button"
                          className={styles.issue}
                          data-severity={issue.severity}
                          aria-label={`Locate issue: ${issue.message}`}
                          aria-description={[
                            issue.severity === 'error' ? 'Error' : 'Warning',
                            name,
                            ...(presentation?.tags.map(({ kind, text }) =>
                              kind === 'object'
                                ? text
                                : `${kind === 'net' ? 'Net' : 'Layer'} ${text}`,
                            ) ?? []),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
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
                          <span className={styles.issueHeading}>
                            <span className={styles.ruleName} aria-description={issue.ruleId}>
                              {name}
                            </span>
                            {!!presentation?.tags.length && (
                              <span className={styles.issueTags} aria-hidden="true">
                                {presentation.tags.map(({ kind, text }) => (
                                  <span
                                    className={styles.issueTag}
                                    data-kind={kind}
                                    key={`${kind}:${text}`}
                                  >
                                    {text}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>{' '}
                          <span className={styles.message}>
                            {presentation?.detail ?? issue.message}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
