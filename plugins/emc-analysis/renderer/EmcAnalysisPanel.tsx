'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Crosshair, FileCode2, FileJson, Plus, RotateCw, ScanLine, Trash2, X } from 'lucide-react';
import type { CapabilityHost } from '../../../api/capabilities';
import { compileCapabilitySchema } from '../../../api/capability-schema';
import type { CopperLayer, PCB } from '../../../lib/pcb';
import { downloadText } from '../../../lib/download';
import QuantityInput from '../../../components/QuantityInput';
import Select from '../../../components/Select';
import { readQuantity } from '../../../components/quantity-units';
import {
  EMC_REVIEW_DEFAULT_LIMITS,
  EMC_REVIEW_INPUT_SCHEMA,
  EMC_REVIEW_LIMITS,
  validateEmcReviewResult,
  type EmcFinding,
  type EmcNetRole,
  type EmcReviewInput,
  type EmcReviewResult,
} from '../domain/review';
import {
  EMC_MANUAL_CHECKS,
  createEmcReport,
  serializeEmcReportJson,
  renderEmcReportHtml,
  type EmcManualReview,
  type EmcException,
} from '../domain/report';
import './panel.css';

type Tab = 'setup' | 'findings' | 'checklist';
type Severity = 'all' | EmcFinding['severity'];
type LimitKey = keyof EmcReviewInput['limits'];
type ReviewState = { basis: object } & (
  | { status: 'pending' }
  | { status: 'complete'; result: EmcReviewResult }
  | { status: 'error'; message: string }
);
const checkSchema = compileCapabilitySchema(EMC_REVIEW_INPUT_SCHEMA);
const numberFormat = new Intl.NumberFormat('en', { maximumSignificantDigits: 4 });
const format = (value: number) =>
  Math.abs(value) > 0 && Math.abs(value) < 0.0001
    ? value.toExponential(3)
    : numberFormat.format(value);
const roles: { value: EmcNetRole; label: string }[] = [
  { value: 'fast', label: 'Fast signal' },
  { value: 'switching', label: 'Switching node' },
  { value: 'sensitive', label: 'Sensitive signal' },
  { value: 'supply', label: 'Supply' },
];
const limitFields: [LimitKey, string, string][] = [
  ['maxTrackLengthMm', 'Total track length', 'mm'],
  ['maxVias', 'Via count', ''],
  ['minEdgeClearanceMm', 'Minimum edge clearance', 'mm'],
  ['minNetSeparationMm', 'Minimum signal separation', 'mm'],
  ['maxReferenceViaDistanceMm', 'Reference via distance', 'mm'],
  ['maxDecouplingDistanceMm', 'Decoupling distance', 'mm'],
  ['maxConnectorEdgeDistanceMm', 'Connector edge distance', 'mm'],
];
const severityLabel = (severity: EmcFinding['severity']) =>
  severity === 'not-verified' ? 'Not verified' : severity === 'warning' ? 'Warning' : 'Info';
const emptyReviews = (): EmcManualReview[] =>
  EMC_MANUAL_CHECKS.map((item) => ({
    checkId: item.id,
    status: 'unreviewed',
    notes: '',
  }));

export default function EmcAnalysisPanel({
  host,
  revision,
  board,
  selectedNetId,
  onLocate,
  onClose,
}: {
  host: CapabilityHost;
  revision: number;
  board: PCB;
  selectedNetId?: string;
  onLocate?: (objectId: string) => boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('setup');
  const [nets, setNets] = useState<EmcReviewInput['nets']>([]);
  const [netDraft, setNetDraft] = useState(() =>
    board.nets.some((net) => net.id === selectedNetId) ? selectedNetId! : '',
  );
  const [roleDraft, setRoleDraft] = useState<EmcNetRole>('fast');
  const [referenceDraft, setReferenceDraft] = useState('');
  const [layerDraft, setLayerDraft] = useState('');
  const [limitDrafts, setLimitDrafts] = useState(
    () =>
      Object.fromEntries(
        limitFields.map(([key]) => [key, String(EMC_REVIEW_DEFAULT_LIMITS[key])]),
      ) as Record<LimitKey, string>,
  );
  const [decoupling, setDecoupling] = useState<EmcReviewInput['decoupling']>([]);
  const [edgeConnectorIds, setEdgeConnectorIds] = useState<string[]>([]);
  const [connectorDraft, setConnectorDraft] = useState('');
  const [targetPadDraft, setTargetPadDraft] = useState('');
  const [capacitorDraft, setCapacitorDraft] = useState('');
  const [decouplingReferenceDraft, setDecouplingReferenceDraft] = useState('');
  const [state, setState] = useState<ReviewState | null>(null);
  const [filter, setFilter] = useState<Severity>('all');
  const [selectedFindingId, setSelectedFindingId] = useState('');
  const [manualReviews, setManualReviews] = useState<EmcManualReview[]>(emptyReviews);
  const [exceptions, setExceptions] = useState<EmcException[]>([]);
  const [exceptionDrafts, setExceptionDrafts] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const panelId = useId();
  const tabList = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const request = useRef<AbortController | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const netName = (id: string) => board.nets.find((net) => net.id === id)?.name || id;
  const footprintName = (id: string) => {
    const fp = board.footprints.find((item) => item.id === id);
    return fp?.reference || fp?.value || fp?.libraryId || id;
  };
  const pads = useMemo(
    () =>
      board.footprints.flatMap((fp) =>
        fp.pads.map((pad) => ({
          value: pad.id,
          label:
            (fp.reference || fp.libraryId) +
            ' · Pad ' +
            (pad.number || '—') +
            (pad.netId
              ? ' · ' + (board.nets.find((net) => net.id === pad.netId)?.name || pad.netId)
              : ''),
        })),
      ),
    [board],
  );
  const padName = (id: string) => pads.find((pad) => pad.value === id)?.label || id;
  const netOptions = board.nets.map((net) => ({ value: net.id, label: net.name || net.id }));
  const footprintOptions = board.footprints.map((fp) => ({
    value: fp.id,
    label: footprintName(fp.id),
  }));
  const basis = useMemo(
    () => ({ host, board, revision, nets, decoupling, edgeConnectorIds, limitDrafts }),
    [host, board, revision, nets, decoupling, edgeConnectorIds, limitDrafts],
  );
  const current = state?.basis === basis ? state : null;
  const result = current?.status === 'complete' ? current.result : null;
  const pending = current?.status === 'pending';
  const parsed = useMemo(() => {
    const limits = Object.fromEntries(
      limitFields.map(([key, , unit]) => [
        key,
        unit
          ? readQuantity(limitDrafts[key], unit)
          : limitDrafts[key].trim()
            ? Number(limitDrafts[key])
            : NaN,
      ]),
    ) as EmcReviewInput['limits'];
    const input: EmcReviewInput = { nets, limits, decoupling, edgeConnectorIds };
    const checked = checkSchema(input);
    return { input, error: checked.valid ? '' : checked.error || 'Check the review limits.' };
  }, [nets, limitDrafts, decoupling, edgeConnectorIds]);
  const hasIntent = !!(nets.length || decoupling.length || edgeConnectorIds.length);
  const canCheck = hasIntent && !parsed.error && !pending && !isComposing;

  function invalidate() {
    request.current?.abort();
    request.current = null;
    setState(null);
    setActionError('');
    setExceptions([]);
    setManualReviews(emptyReviews());
    setSelectedFindingId('');
    setExceptionDrafts({});
  }
  useLayoutEffect(() => {
    invalidate();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [basis]);
  const visibleFindings =
    result?.findings.filter((finding) => filter === 'all' || finding.severity === filter) ?? [];
  const selectedFinding =
    visibleFindings.find((finding) => finding.id === selectedFindingId) ?? visibleFindings[0];
  const selectedException = exceptions.find((item) => item.findingId === selectedFinding?.id);
  const exceptionDraft = selectedFinding
    ? (exceptionDrafts[selectedFinding.id] ?? selectedException?.reason ?? '')
    : '';
  useLayoutEffect(() => {
    setActionError('');
  }, [selectedFinding?.id, selectedException?.reason]);
  const groups =
    result?.checks.flatMap((check) => {
      const findings = visibleFindings.filter((finding) => finding.checkId === check.id);
      return findings.length ? [{ ...check, findings }] : [];
    }) ?? [];

  async function check() {
    if (!canCheck || composing.current || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setActionError('');
    setState({ basis, status: 'pending' });
    try {
      const reply = (await host.query('emc.reviewLayout', parsed.input, {
        signal: controller.signal,
        expectedRevision: String(revision),
      })) as { boardId: string; revision: number; result: EmcReviewResult };
      if (request.current === controller && !controller.signal.aborted) {
        if (!reply || reply.boardId !== board.id || reply.revision !== revision)
          throw new Error(
            'The review response no longer matches this PCB revision. Check the current layout again.',
          );
        const accepted = validateEmcReviewResult(reply.result);
        setExceptions([]);
        setManualReviews(emptyReviews());
        setExceptionDrafts({});
        setState({ basis, status: 'complete', result: accepted });
        setSelectedFindingId(accepted.findings[0]?.id ?? '');
        setFilter('all');
        setTab('findings');
      }
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setState({
          basis,
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not review this PCB. Try again.',
        });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  function addNet() {
    if (
      composing.current ||
      !board.nets.some((net) => net.id === netDraft) ||
      nets.some((net) => net.netId === netDraft) ||
      nets.length >= EMC_REVIEW_LIMITS.intents
    )
      return;
    invalidate();
    setNets((previous) => [
      ...previous,
      {
        netId: netDraft,
        role: roleDraft,
        ...(referenceDraft ? { referenceNetId: referenceDraft } : {}),
        ...(layerDraft ? { referenceLayer: layerDraft as CopperLayer } : {}),
      },
    ]);
    setNetDraft('');
  }
  function addDecoupling() {
    if (
      composing.current ||
      !targetPadDraft ||
      !capacitorDraft ||
      !decouplingReferenceDraft ||
      decoupling.length >= EMC_REVIEW_LIMITS.intents ||
      decoupling.some(
        (item) =>
          item.targetPadId === targetPadDraft &&
          item.capacitorFootprintId === capacitorDraft &&
          item.referenceNetId === decouplingReferenceDraft,
      )
    )
      return;
    invalidate();
    setDecoupling((previous) => [
      ...previous,
      {
        targetPadId: targetPadDraft,
        capacitorFootprintId: capacitorDraft,
        referenceNetId: decouplingReferenceDraft,
      },
    ]);
  }
  function addConnector() {
    if (
      composing.current ||
      !connectorDraft ||
      edgeConnectorIds.includes(connectorDraft) ||
      edgeConnectorIds.length >= EMC_REVIEW_LIMITS.intents
    )
      return;
    invalidate();
    setEdgeConnectorIds((previous) => [...previous, connectorDraft]);
    setConnectorDraft('');
  }
  function supportedTarget(finding: EmcFinding) {
    return finding.objectIds.find(
      (id) =>
        board.tracks.some((item) => item.id === id) ||
        board.vias.some((item) => item.id === id) ||
        board.footprints.some((fp) => fp.id === id || fp.pads.some((pad) => pad.id === id)),
    );
  }
  function locate(finding: EmcFinding) {
    if (!result || !onLocate || composing.current) return;
    const target = supportedTarget(finding);
    let located = false;
    try {
      located = !!target && onLocate(target);
    } catch {
      /* Keep evidence retryable. */
    }
    setActionError(
      located
        ? ''
        : 'This object is unavailable. Check pending edits, visible layers and selection filters, then try again.',
    );
  }
  function recordException() {
    if (
      !result ||
      !selectedFinding ||
      composing.current ||
      !exceptionDraft.trim() ||
      exceptionDraft.length > 1000
    )
      return;
    setExceptions((previous) => [
      ...previous.filter((item) => item.findingId !== selectedFinding.id),
      { findingId: selectedFinding.id, reason: exceptionDraft.trim() },
    ]);
  }
  function exportReport(format: 'html' | 'json') {
    if (!result || composing.current || pending) return;
    try {
      const report = createEmcReport({
        boardId: board.id,
        revision,
        result,
        manualReviews,
        exceptions,
      });
      downloadText(
        format === 'html' ? renderEmcReportHtml(report) : serializeEmcReportJson(report),
        'emc-review.' + format,
        format === 'html' ? 'text/html;charset=utf-8' : 'application/json;charset=utf-8',
      );
      setActionError('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not export this report.');
    }
  }
  function guardComposingButton(event: MouseEvent) {
    if (
      composing.current &&
      event.target instanceof Element &&
      event.target.closest('button, summary')
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  const unitField = (key: LimitKey, label: string, unit: string) => (
    <label className="layout-field" key={key}>
      <span>{label}</span>
      {unit ? (
        <QuantityInput
          aria-label={label}
          value={limitDrafts[key]}
          unit={unit}
          onValueChange={(value) => {
            invalidate();
            setLimitDrafts((previous) => ({ ...previous, [key]: value }));
          }}
        />
      ) : (
        <input
          aria-label={label}
          inputMode="numeric"
          value={limitDrafts[key]}
          onChange={(event) => {
            invalidate();
            setLimitDrafts((previous) => ({ ...previous, [key]: event.target.value }));
          }}
        />
      )}
    </label>
  );
  return (
    <section
      className="emc-analysis-panel"
      data-docked
      aria-label="EMC Analysis"
      onCompositionStart={() => {
        composing.current = true;
        setIsComposing(true);
        if (request.current) {
          request.current.abort();
          request.current = null;
          setState(null);
        }
      }}
      onCompositionEnd={() => {
        composing.current = false;
        setIsComposing(false);
      }}
      onPointerDownCapture={guardComposingButton}
      onClickCapture={guardComposingButton}
      onKeyDownCapture={(event) => {
        if (
          composing.current ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.target instanceof Element && event.target.closest('button, summary'))
            event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' && !event.defaultPrevented && !composing.current) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="editor-dock-header">
        <h2>EMC Analysis</h2>
        <button
          className="tool-button"
          type="button"
          aria-label="Close EMC Analysis"
          title="Close"
          onClick={() => {
            if (!composing.current) onClose();
          }}
        >
          <X size={17} />
        </button>
      </header>
      <div
        className="emc-tabs"
        role="tablist"
        aria-label="EMC workflow"
        ref={tabList}
        onKeyDown={(event) => {
          const values = ['setup', 'findings', 'checklist'] as const;
          const index = values.indexOf(tab);
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % 3
              : event.key === 'ArrowLeft'
                ? (index + 2) % 3
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 2
                    : -1;
          if (next < 0 || composing.current) return;
          event.preventDefault();
          event.stopPropagation();
          setTab(values[next]);
          tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {(['setup', 'findings', 'checklist'] as const).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            id={panelId + '-tab-' + value}
            aria-selected={tab === value}
            aria-controls={panelId + '-panel'}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
          >
            {value === 'setup' ? 'Setup' : value === 'findings' ? 'Findings' : 'Checklist'}
          </button>
        ))}
      </div>
      <div
        className="emc-analysis-body"
        id={panelId + '-panel'}
        role="tabpanel"
        aria-labelledby={panelId + '-tab-' + tab}
      >
        {tab === 'setup' && (
          <div className="emc-setup">
            <section className="emc-section">
              <h3>Net intent</h3>
              <label className="layout-field">
                <span>Net</span>
                <Select
                  label="PCB net"
                  value={netDraft}
                  options={netOptions.filter(
                    (option) => !nets.some((net) => net.netId === option.value),
                  )}
                  placeholder="Choose a net"
                  onChange={setNetDraft}
                />
              </label>
              <label className="layout-field">
                <span>Role</span>
                <Select
                  label="Net role"
                  value={roleDraft}
                  options={roles}
                  onChange={(value) => setRoleDraft(value as EmcNetRole)}
                />
              </label>
              <label className="layout-field">
                <span>Reference net</span>
                <Select
                  label="Reference net"
                  value={referenceDraft}
                  options={[
                    { value: '', label: 'Unspecified' },
                    ...netOptions.filter((option) => option.value !== netDraft),
                  ]}
                  onChange={setReferenceDraft}
                />
              </label>
              <label className="layout-field">
                <span>Reference copper layer</span>
                <Select
                  label="Reference copper layer"
                  value={layerDraft}
                  options={[
                    { value: '', label: 'Unspecified' },
                    ...board.layers.map((layer) => ({ value: layer, label: layer })),
                  ]}
                  onChange={setLayerDraft}
                />
              </label>
              <button
                type="button"
                className="dialog-button quiet emc-add"
                disabled={!netDraft || nets.length >= EMC_REVIEW_LIMITS.intents}
                onClick={addNet}
              >
                <Plus size={14} />
                Add net
              </button>
              <div className="emc-intents">
                {nets.map((net) => (
                  <div className="emc-intent" key={net.netId}>
                    <div>
                      <strong>{netName(net.netId)}</strong>
                      <span>
                        {roles.find((role) => role.value === net.role)?.label}
                        {net.referenceNetId ? ' · ' + netName(net.referenceNetId) : ''}
                        {net.referenceLayer ? ' · ' + net.referenceLayer : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="tool-button"
                      aria-label={'Remove net ' + netName(net.netId)}
                      title="Remove net"
                      onClick={() => {
                        invalidate();
                        setNets((previous) => previous.filter((item) => item.netId !== net.netId));
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
            <details className="emc-section">
              <summary>Connections</summary>
              <h4>Edge-intended connectors</h4>
              <label className="layout-field">
                <span>Connector package</span>
                <Select
                  label="Edge connector"
                  value={connectorDraft}
                  options={footprintOptions.filter(
                    (option) => !edgeConnectorIds.includes(option.value),
                  )}
                  placeholder="Choose a package"
                  onChange={setConnectorDraft}
                />
              </label>
              <button
                type="button"
                className="dialog-button quiet emc-add"
                disabled={!connectorDraft || edgeConnectorIds.length >= EMC_REVIEW_LIMITS.intents}
                onClick={addConnector}
              >
                <Plus size={14} />
                Add connector
              </button>
              {edgeConnectorIds.map((id) => (
                <div className="emc-intent" key={id}>
                  <strong>{footprintName(id)}</strong>
                  <button
                    type="button"
                    className="tool-button"
                    aria-label={'Remove connector ' + footprintName(id)}
                    title="Remove connector"
                    onClick={() => {
                      invalidate();
                      setEdgeConnectorIds((previous) => previous.filter((item) => item !== id));
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <h4>Decoupling assignments</h4>
              <label className="layout-field">
                <span>Device supply pad</span>
                <Select
                  label="Device supply pad"
                  value={targetPadDraft}
                  options={pads}
                  placeholder="Choose a pad"
                  onChange={setTargetPadDraft}
                />
              </label>
              <label className="layout-field">
                <span>Capacitor package</span>
                <Select
                  label="Capacitor package"
                  value={capacitorDraft}
                  options={footprintOptions}
                  placeholder="Choose a package"
                  onChange={setCapacitorDraft}
                />
              </label>
              <label className="layout-field">
                <span>Return net</span>
                <Select
                  label="Decoupling return net"
                  value={decouplingReferenceDraft}
                  options={netOptions}
                  placeholder="Choose a net"
                  onChange={setDecouplingReferenceDraft}
                />
              </label>
              <button
                type="button"
                className="dialog-button quiet emc-add"
                disabled={
                  !targetPadDraft ||
                  !capacitorDraft ||
                  !decouplingReferenceDraft ||
                  decoupling.length >= EMC_REVIEW_LIMITS.intents
                }
                onClick={addDecoupling}
              >
                <Plus size={14} />
                Add assignment
              </button>
              {decoupling.map((item, index) => (
                <div
                  className="emc-intent"
                  key={
                    item.targetPadId + ':' + item.capacitorFootprintId + ':' + item.referenceNetId
                  }
                >
                  <div>
                    <strong>{padName(item.targetPadId)}</strong>
                    <span>
                      {footprintName(item.capacitorFootprintId)} · {netName(item.referenceNetId)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="tool-button"
                    aria-label={'Remove decoupling assignment ' + (index + 1)}
                    title="Remove assignment"
                    onClick={() => {
                      invalidate();
                      setDecoupling((previous) =>
                        previous.filter((_, position) => position !== index),
                      );
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </details>
            <details className="emc-section">
              <summary>Engineering limits</summary>
              <p className="emc-note">User review budgets, independent of regulatory limits.</p>
              {limitFields.map(([key, label, unit]) => unitField(key, label, unit))}
            </details>
            {parsed.error && (
              <p className="dialog-error" role="alert">
                {parsed.error}
              </p>
            )}
            {!hasIntent && (
              <p className="emc-note">Assign a net, connector or decoupling pair to review.</p>
            )}
          </div>
        )}
        {tab === 'findings' &&
          (!result ? (
            <div className="emc-empty">
              <ScanLine size={22} />
              <p>
                {pending
                  ? 'Reviewing the current layout…'
                  : 'Set design intent and run a layout check.'}
              </p>
            </div>
          ) : (
            <div className="emc-results" aria-label="Layout review results">
              <div className="emc-summary">
                <span>{result.summary.warning} warnings</span>
                <span>{result.summary.notVerified} not verified</span>
                <span>{result.summary.info} info</span>
              </div>
              <label className="layout-field">
                <span>Show</span>
                <Select
                  label="Finding severity"
                  value={filter}
                  options={[
                    { value: 'all', label: 'All findings' },
                    { value: 'warning', label: 'Warnings' },
                    { value: 'not-verified', label: 'Not verified' },
                    { value: 'info', label: 'Information' },
                  ]}
                  onChange={(value) => {
                    setFilter(value as Severity);
                    setSelectedFindingId('');
                  }}
                />
              </label>
              {groups.map((group) => (
                <section className="emc-finding-group" key={group.id}>
                  <h3>
                    {group.title}
                    <span>{group.findings.length}</span>
                  </h3>
                  {group.findings.map((finding) => (
                    <button
                      type="button"
                      className={'emc-finding emc-' + finding.severity}
                      key={finding.id}
                      aria-pressed={selectedFinding?.id === finding.id}
                      onClick={() => {
                        setSelectedFindingId(finding.id);
                        detail.current?.scrollIntoView({ block: 'nearest' });
                      }}
                    >
                      <span>{severityLabel(finding.severity)}</span>
                      <strong>{finding.title}</strong>
                      {exceptions.some((item) => item.findingId === finding.id) && (
                        <em>Exception recorded</em>
                      )}
                    </button>
                  ))}
                </section>
              ))}
              {!visibleFindings.length && (
                <p className="emc-note">No findings match this filter. Coverage remains partial.</p>
              )}
              {result.truncated && (
                <p className="emc-note">
                  Finding details are truncated. Review coverage before drawing conclusions.
                </p>
              )}
              {selectedFinding && (
                <div className="emc-finding-detail" ref={detail} aria-label="Finding details">
                  <div className="emc-detail-heading">
                    <h3>{selectedFinding.title}</h3>
                    <button
                      type="button"
                      className="tool-button"
                      title="Locate object"
                      aria-label="Locate finding object"
                      disabled={!onLocate || !supportedTarget(selectedFinding)}
                      onClick={() => locate(selectedFinding)}
                    >
                      <Crosshair size={16} />
                    </button>
                  </div>
                  <span className="emc-confidence">
                    {selectedFinding.confidence === 'geometric'
                      ? 'Geometric evidence'
                      : selectedFinding.confidence === 'missing'
                        ? 'Missing evidence'
                        : 'Limited evidence'}
                  </span>
                  <p>{selectedFinding.message}</p>
                  {selectedFinding.measured && (
                    <dl className="emc-readout">
                      <div>
                        <dt>Measured</dt>
                        <dd>
                          {format(selectedFinding.measured.value)} {selectedFinding.measured.unit}
                        </dd>
                      </div>
                      {selectedFinding.limit && (
                        <div>
                          <dt>User limit</dt>
                          <dd>
                            {format(selectedFinding.limit.value)} {selectedFinding.limit.unit}
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                  {selectedFinding.netIds.length > 0 && (
                    <p className="emc-note">{selectedFinding.netIds.map(netName).join(' · ')}</p>
                  )}
                  <h4>Review action</h4>
                  <p>{selectedFinding.recommendation}</p>
                  <details className="emc-exception">
                    <summary>
                      {selectedException ? 'Recorded exception' : 'Record an exception'}
                    </summary>
                    {selectedException && <p>{selectedException.reason}</p>}
                    <label className="layout-field">
                      <span>Justification</span>
                      <textarea
                        aria-label="Exception reason"
                        value={exceptionDraft}
                        maxLength={1000}
                        onChange={(event) => {
                          const value = event.target.value;
                          setExceptionDrafts((previous) => ({
                            ...previous,
                            [selectedFinding.id]: value,
                          }));
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="dialog-button quiet"
                      disabled={!exceptionDraft.trim() || exceptionDraft.length > 1000}
                      onClick={recordException}
                    >
                      Record exception
                    </button>
                    {selectedException && (
                      <button
                        type="button"
                        className="dialog-button quiet"
                        onClick={() =>
                          setExceptions((previous) =>
                            previous.filter((item) => item.findingId !== selectedFinding.id),
                          )
                        }
                      >
                        Remove exception
                      </button>
                    )}
                  </details>
                </div>
              )}
              <details className="emc-coverage">
                <summary>Check coverage</summary>
                {result.checks.map((item) => (
                  <div key={item.id}>
                    <strong>{item.title}</strong>
                    <span>{item.status.replaceAll('-', ' ')}</span>
                    {item.notes.map((note) => (
                      <p key={note}>{note}</p>
                    ))}
                  </div>
                ))}
                {result.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </details>
            </div>
          ))}
        {tab === 'checklist' &&
          (!result ? (
            <div className="emc-empty">
              <p>Run a layout check before recording reviews.</p>
            </div>
          ) : (
            <div className="emc-checklist" aria-label="Manual layout review">
              {EMC_MANUAL_CHECKS.map((item) => {
                const review = manualReviews.find((entry) => entry.checkId === item.id)!;
                return (
                  <details className="emc-section" key={item.id}>
                    <summary>
                      {item.title}
                      <span className="emc-manual-status">
                        {review.status === 'reviewed'
                          ? 'Reviewed'
                          : review.status === 'needs-work'
                            ? 'Needs work'
                            : 'Unreviewed'}
                      </span>
                    </summary>
                    <p className="emc-note">{item.prompt}</p>
                    <label className="layout-field">
                      <span>Status</span>
                      <Select
                        label={item.title + ' status'}
                        value={review.status}
                        options={[
                          { value: 'unreviewed', label: 'Unreviewed' },
                          { value: 'reviewed', label: 'Reviewed' },
                          { value: 'needs-work', label: 'Needs work' },
                        ]}
                        onChange={(value) =>
                          setManualReviews((previous) =>
                            previous.map((entry) =>
                              entry.checkId === item.id
                                ? { ...entry, status: value as EmcManualReview['status'] }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="layout-field">
                      <span>Evidence notes</span>
                      <textarea
                        aria-label={item.title + ' notes'}
                        value={review.notes}
                        maxLength={2000}
                        onChange={(event) =>
                          setManualReviews((previous) =>
                            previous.map((entry) =>
                              entry.checkId === item.id
                                ? { ...entry, notes: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                    </label>
                  </details>
                );
              })}
            </div>
          ))}
        {current?.status === 'error' && (
          <p className="dialog-error" role="alert">
            {current.message}
          </p>
        )}
        {actionError && (
          <p className="dialog-error" role="alert">
            {actionError}
          </p>
        )}
      </div>
      <footer className="emc-actions">
        <div className="emc-report-actions">
          <button
            type="button"
            className="tool-button"
            title="Export HTML report"
            aria-label="Export HTML report"
            disabled={!result || isComposing}
            onClick={() => exportReport('html')}
          >
            <FileCode2 size={16} />
          </button>
          <button
            type="button"
            className="tool-button"
            title="Export JSON report"
            aria-label="Export JSON report"
            disabled={!result || isComposing}
            onClick={() => exportReport('json')}
          >
            <FileJson size={16} />
          </button>
        </div>
        <span className="emc-check-status" role="status" aria-live="polite">
          {pending ? 'Checking…' : ''}
        </span>
        <button
          type="button"
          className="dialog-button quiet emc-check-button"
          disabled={!canCheck}
          aria-busy={pending}
          onClick={() => void check()}
        >
          <RotateCw size={14} />
          {current?.status === 'error' ? 'Retry' : result ? 'Recheck' : 'Check'}
        </button>
      </footer>
    </section>
  );
}
