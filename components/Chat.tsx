'use client';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, CircuitBoard, Check, CheckCheck } from 'lucide-react';
import { circuitFingerprint, type Circuit } from '@/lib/circuit';
import type { PCB } from '@/lib/pcb';
import { layoutAnnotationContext } from '@/lib/pcb-annotations';
import type { AgentWorkspaceContext } from '@/context/agent-workspace-context';
import type { Message } from '@/lib/chat-sessions';
import { suggestedSessionTitle, withoutSessionTitle } from '@/lib/session-title';
import type { KiCadProjectFiles } from '@/lib/kicad-project';
import { agentName } from '@/lib/agent-providers';
import { api } from '@/lib/bridge';
import { extractProposal, type Operation } from '@/lib/proposals';
import SidebarToggle from './SidebarToggle';
import AgentLogo from './AgentLogo';
import AgentComposer from './AgentComposer';
import AgentToolCall from './AgentToolCall';
import AgentFileChanges from './AgentFileChanges';
import {
  changedAgentFiles,
  mergeAgentFileChanges,
  type AgentFileChanges as FileChanges,
} from '@/lib/agent-file-changes';
import {
  appendToolActivity,
  toolPreview,
  toolResultStatus,
  type AgentToolActivity,
} from '@/lib/agent-tool-activity';
import AnnotationAttachments from './AnnotationAttachments';
import {
  annotationContext,
  validateAnnotations,
  type AgentAnnotation,
} from '@/lib/agent-annotations';
import {
  readChatEvents,
  responseText,
  resolveAgentCapability,
  type AgentCapabilities,
  type AgentCapabilityRequest,
  type AgentCommandReview,
  type ChatOutcome,
  type ChatTimings,
  type ReasoningEffort,
} from '@/lib/chat-stream';
import { ChatTiming, ChatProgress } from './ChatTiming';

const AgentMarkdown = lazy(() => import('./AgentMarkdown'));
const AssistantResponse = memo(function AssistantResponse({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="message-text agent-markdown">{responseText(text)}</div>}>
      <AgentMarkdown text={text} />
    </Suspense>
  );
});

export type Agent = {
  id: string;
  available: boolean;
  installed?: boolean;
  version?: string;
  error?: string;
  path?: string;
  supportsEffort?: boolean;
  supportsCapabilities?: boolean;
};
export type ChatDesign = { doc: Circuit; pcb?: PCB | null; pcbSchematic?: Circuit };
export default function Chat({
  doc,
  pcb,
  pcbSchematic,
  getDesign,
  getNativeFiles,
  agents,
  provider,
  effort,
  setEffort,
  approvalMode,
  setApprovalMode,
  model,
  setModel,
  messages,
  setMessages,
  onSettings,
  onApply,
  active,
  sessionId,
  conversationTitle,
  requestTitle = false,
  onSuggestedTitle,
  sidebarVisible,
  onToggleSidebar,
  input,
  setInput,
  onRunningChange,
  annotations,
  setAnnotations,
  getWorkspaceContext,
  capabilities,
}: {
  doc: Circuit;
  pcb?: PCB | null;
  pcbSchematic?: Circuit;
  getDesign?: () => ChatDesign;
  getNativeFiles?: () => KiCadProjectFiles;
  agents: Agent[];
  provider: string;
  effort: ReasoningEffort;
  setEffort: (value: ReasoningEffort) => void;
  approvalMode: 'review' | 'auto';
  setApprovalMode: (value: 'review' | 'auto') => void;
  model: string;
  setModel: (value: string) => void;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  onSettings: () => void;
  onApply: (ops: Operation[], basis?: string) => boolean;
  active: boolean;
  sessionId: string;
  conversationTitle: string;
  requestTitle?: boolean;
  onSuggestedTitle?: (title: string, messageId: string) => void;
  sidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  input: string;
  setInput: (value: string) => void;
  onRunningChange: (id: string, running: boolean) => void;
  annotations: AgentAnnotation[];
  setAnnotations: (annotations: AgentAnnotation[]) => void;
  getWorkspaceContext?: (
    signal?: AbortSignal,
  ) => AgentWorkspaceContext | Promise<AgentWorkspaceContext>;
  capabilities?: AgentCapabilities;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streamedText, setStreamedText] = useState('');
  const [liveModel, setLiveModel] = useState('');
  const [startedAt, setStartedAt] = useState(0);
  const [sendError, setSendError] = useState('');
  const [toolCalls, setToolCalls] = useState<AgentToolActivity[]>([]);
  const [fileChanges, setFileChanges] = useState<Record<string, FileChanges>>({});
  const [showLatest, setShowLatest] = useState(false);
  const [commandReviews, setCommandReviews] = useState<
    {
      messageId: string;
      command: AgentCommandReview;
      host: AgentCapabilities;
      status: 'pending' | 'applying' | 'applied' | 'rejected' | 'failed' | 'cancelled';
    }[]
  >([]);
  const reviewControls = useRef(new Map<string, AbortController>());
  const reviewClaims = useRef(new Set<string>());
  const reviewSizes = useRef(new Map<string, number>());
  const approvalLatest = useRef(approvalMode);
  approvalLatest.current = approvalMode;
  const currentBasis = useMemo(
    () => (annotations.length ? circuitFingerprint(doc) : ''),
    [doc, annotations.length],
  );
  const layoutSchematic = pcbSchematic || doc;
  const layoutContext = useMemo(
    () => (annotations.length && pcb ? layoutAnnotationContext(pcb, layoutSchematic) : undefined),
    [pcb, layoutSchematic, annotations.length],
  );
  const follow = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const applyLatest = useRef(onApply);
  applyLatest.current = onApply;
  const scroll = useRef<HTMLDivElement>(null);
  const agent = agents.find((a) => a.id === provider);
  useEffect(() => {
    // Follow within the conversation only; never scroll the editor's ancestors.
    if (active && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, streamedText, toolCalls, fileChanges, active]);
  useEffect(
    () => () => {
      controller.current?.abort();
      for (const control of reviewControls.current.values()) control.abort();
    },
    [],
  );
  useEffect(() => {
    const ids = new Set(messages.map((message) => message.id));
    setToolCalls((items) => items.filter((item) => ids.has(item.messageId)));
    setFileChanges((items) =>
      Object.fromEntries(Object.entries(items).filter(([id]) => ids.has(id))),
    );
    setCommandReviews((items) =>
      items.filter((item) => {
        if (ids.has(item.messageId)) return true;
        reviewSizes.current.delete(item.command.id);
        reviewClaims.current.delete(item.command.id);
        return false;
      }),
    );
  }, [messages]);
  useEffect(() => {
    onRunningChange(sessionId, busy);
    return () => onRunningChange(sessionId, false);
  }, [busy, sessionId, onRunningChange]);
  function stopGeneration() {
    const control = controller.current;
    if (!control || control.signal.aborted) return;
    setStatus('Stopping…');
    control.abort();
  }
  function captureFiles(messageId: string) {
    if (!getNativeFiles) return;
    try {
      return getNativeFiles();
    } catch {
      setFileChanges((items) => ({
        ...items,
        [messageId]: {
          ...(items[messageId] ?? { files: [], truncated: false }),
          unavailable: true,
        },
      }));
    }
  }
  function recordFiles(messageId: string, before: KiCadProjectFiles | undefined) {
    if (!before) return;
    const after = captureFiles(messageId);
    if (!after) return;
    const changes = changedAgentFiles(before, after);
    if (!changes.length) return;
    setFileChanges((items) => ({
      ...items,
      [messageId]: mergeAgentFileChanges(
        items[messageId] ?? { files: [], truncated: false },
        changes,
      ),
    }));
  }
  async function executeWithFiles(
    messageId: string,
    host: AgentCapabilities,
    name: string,
    input: unknown,
    options: Parameters<AgentCapabilities['execute']>[2],
  ) {
    const before = captureFiles(messageId);
    const result = await host.execute(name, input, options);
    if (!options?.signal?.aborted && toolResultStatus(result) !== 'cancelled')
      recordFiles(messageId, before);
    return result;
  }
  function applyProposal(messageId: string, ops: Operation[], basis?: string, apply = onApply) {
    const before = captureFiles(messageId);
    const applied = apply(ops, basis);
    if (applied) recordFiles(messageId, before);
    return applied;
  }
  async function send(resolvedEffort: ReasoningEffort | undefined) {
    if ((!input.trim() && !annotations.length) || busy || controller.current) return;
    if (!agent?.available) {
      onSettings();
      return;
    }
    // Capture the live design once at submission. Empty retained conversations
    // need no render or document fingerprint when an editor transaction changes.
    const submitted = getDesign?.() ?? { doc, pcb, pcbSchematic };
    const submittedDoc = submitted.doc;
    const submittedLayout = submitted.pcb
      ? layoutAnnotationContext(submitted.pcb, submitted.pcbSchematic ?? submittedDoc)
      : undefined;
    let workspace: AgentWorkspaceContext | undefined;
    try {
      validateAnnotations(annotations);
    } catch (e) {
      setSendError((e as Error).message);
      return;
    }
    setSendError('');
    const prompt = input.trim() || 'Review the attached design annotations.';
    const sentAnnotations = annotations;
    setInput('');
    setAnnotations([]);
    setBusy(true);
    setStatus('Connecting…');
    const id = crypto.randomUUID();
    if (getNativeFiles)
      setFileChanges((items) => ({ ...items, [id]: { files: [], truncated: false } }));
    const basis = circuitFingerprint(submittedDoc);
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        role: 'user',
        text: input.trim(),
        ...(sentAnnotations.length ? { annotations: sentAnnotations } : {}),
      },
      { id, role: 'assistant', text: '', basis, provider },
    ]);
    const control = new AbortController();
    controller.current = control;
    const started = performance.now();
    setStartedAt(started);
    setActiveId(id);
    setStreamedText('');
    setLiveModel('');
    follow.current = true;
    setShowLatest(false);
    let text = '',
      failure = '',
      done = false;
    let outcome = 'failed' as ChatOutcome;
    let timings: ChatTimings = {};
    let responseModel = '';
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      setStreamedText(text);
    };
    const runtime = capabilities;
    const observedRevision: { current: string | undefined } = { current: undefined };
    const handledRequests = new Set<string>();
    let reviewCount = 0;
    const capabilityRequest = async (event: AgentCapabilityRequest) => {
      if (
        event.sessionId !== sessionId ||
        control.signal.aborted ||
        handledRequests.has(event.requestId)
      )
        return;
      handledRequests.add(event.requestId);
      setToolCalls((items) =>
        appendToolActivity(items, {
          id: event.requestId,
          messageId: id,
          tool: event.tool,
          name:
            event.tool === 'openpe_observe' ? 'Project events' : event.arguments.name || event.tool,
          status: 'running',
          arguments: toolPreview(event.arguments),
        }),
      );
      const updateTool = (update: Partial<AgentToolActivity>) => {
        if (control.signal.aborted) return;
        setToolCalls((items) =>
          items.map((item) =>
            item.messageId === id && item.id === event.requestId ? { ...item, ...update } : item,
          ),
        );
      };
      const response = {
        sessionId,
        runId: event.runId,
        requestId: event.requestId,
        token: event.token,
      };
      let payload: typeof response & { result?: unknown; error?: string };
      try {
        if (!runtime) throw new Error('The originating workbench capability host is unavailable.');
        const result = await resolveAgentCapability(
          event,
          {
            query: (...args) => runtime.query(...args),
            observe: (...args) => runtime.observe(...args),
            execute: (name, input, options) => executeWithFiles(id, runtime, name, input, options),
          },
          approvalLatest.current,
          (command) => {
            if (++reviewCount > 32)
              throw new Error('Review the pending commands before requesting more changes.');
            const bytes = new TextEncoder().encode(JSON.stringify(command)).byteLength;
            const retained = [...reviewSizes.current.values()].reduce(
              (total, value) => total + value,
              0,
            );
            if (reviewSizes.current.size >= 64 || retained + bytes > 32 * 1024 * 1024)
              throw new Error(
                'The review queue is full. Clear the conversation before requesting more reviewed commands.',
              );
            reviewSizes.current.set(command.id, bytes);
            updateTool({
              arguments: toolPreview({
                name: command.name,
                input: command.input,
                expectedRevision: command.expectedRevision,
              }),
            });
            setCommandReviews((items) => [
              ...items,
              { messageId: id, command, host: runtime, status: 'pending' },
            ]);
          },
          control.signal,
          observedRevision,
        );
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32 * 1024 * 1024 - 4096)
          throw new Error(
            'Capability result exceeds the response budget. Use a narrower query or page.',
          );
        payload = { ...response, result };
        const activityStatus = toolResultStatus(result);
        updateTool({
          status: activityStatus,
          result: activityStatus === 'review' ? undefined : toolPreview(result),
        });
      } catch (error) {
        payload = { ...response, error: String((error as Error).message).slice(0, 4000) };
        updateTool({
          status: 'failed',
          error: payload.error,
        });
      }
      if (control.signal.aborted) return;
      try {
        await api('chat/tool-result', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal: control.signal,
        });
      } catch (error) {
        updateTool({ deliveryError: `Result delivery failed: ${(error as Error).message}` });
      }
    };
    try {
      workspace = await getWorkspaceContext?.(control.signal);
      control.signal.throwIfAborted();
      const submittedRevision = workspace?.ui.revision;
      observedRevision.current =
        typeof submittedRevision === 'string' || typeof submittedRevision === 'number'
          ? String(submittedRevision)
          : undefined;
      const res = await api('chat', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          ...(requestTitle ? { requestTitle: true } : {}),
          capabilities: Boolean(runtime),
          provider,
          prompt,
          annotations: sentAnnotations,
          effort: resolvedEffort,
          model: model || undefined,
          context: {
            title: submittedDoc.title,
            id: submittedDoc.id,
            basis,
            parts: submittedDoc.parts.map(({ raw, ...p }) => p),
            wires: submittedDoc.wires,
            labels: submittedDoc.labels,
            junctions: submittedDoc.junctions,
            noConnects: submittedDoc.noConnects ?? [],
            ...(workspace ? { workspace } : {}),
            ...(submittedLayout ? { layout: submittedLayout } : {}),
          },
          history: messages
            .filter(
              (m) =>
                (!m.error || m.outcome === 'cancelled') &&
                (withoutSessionTitle(m.text) || m.annotations?.length),
            )
            .slice(-16)
            .map((m) => ({
              role: m.role,
              text:
                withoutSessionTitle(m.text) +
                (m.annotations?.length
                  ? '\nPrevious annotation metadata (screenshots remain in the conversation UI; not reattached): ' +
                    JSON.stringify(annotationContext(m.annotations))
                  : ''),
            })),
        }),
        signal: control.signal,
      });
      timings.connectionMs = Math.round(performance.now() - started);
      if (!res.body) throw new Error('The local service returned no response stream.');
      await readChatEvents(
        res.body,
        (e) => {
          if (e.type === 'capability-request') void capabilityRequest(e);
          if (e.type === 'status') setStatus(e.text);
          if (e.type === 'agent-info') {
            responseModel = [e.model, e.reasoningEffort].filter(Boolean).join(' · ');
            setLiveModel(responseModel);
          }
          if (e.type === 'timing') {
            timings = { ...timings, ...e.timings };
          }
          if (e.type === 'text' || e.type === 'text-delta' || e.type === 'text-replace') {
            if (e.type === 'text-delta') text += e.delta;
            else if (e.type === 'text-replace') text = e.text;
            else text += (text ? '\n\n' : '') + e.text;
            if (text && timings.clientFirstTextMs === undefined) {
              timings.clientFirstTextMs = Math.round(performance.now() - started);
            }
            setStatus('Receiving response…');
            // Keep token updates local and batch paints; persist only the finished response.
            flushTimer ??= setTimeout(flush, 40);
          }
          if (e.type === 'error') failure = e.text;
          if (e.type === 'done') {
            done = true;
            outcome = e.outcome || (failure ? 'failed' : 'completed');
          }
        },
        control.signal,
      );
      if (!done)
        throw new Error('Connection closed before the response completed. Partial text was kept.');
      if (failure) outcome = 'failed';
      if (outcome === 'completed' && !withoutSessionTitle(text) && !failure) {
        failure = 'No response content received.';
        outcome = 'failed';
      }
      if (outcome === 'failed' && !failure) failure = 'The agent could not finish this response.';
      if (outcome === 'cancelled' && !failure) failure = 'Generation stopped.';
    } catch (e) {
      outcome = control.signal.aborted ? 'cancelled' : 'failed';
      failure = outcome === 'cancelled' ? 'Generation stopped.' : (e as Error).message;
    } finally {
      clearTimeout(flushTimer);
      if (control.signal.aborted) {
        outcome = 'cancelled';
        failure = 'Generation stopped.';
      }
      let applied = false;
      if (outcome === 'completed' && !control.signal.aborted && approvalMode === 'auto') {
        try {
          const ops = extractProposal(text);
          if (ops) applied = applyProposal(id, ops, basis, applyLatest.current);
        } catch {
          // Invalid proposals remain visible for review and never change the schematic.
        }
      }
      timings.clientTotalMs = Math.round(performance.now() - started);
      setMessages((m) =>
        m.map((x) =>
          x.id === id
            ? {
                ...x,
                text,
                errorText: failure || undefined,
                error: outcome !== 'completed',
                outcome,
                timings,
                model: responseModel,
                applied,
              }
            : x,
        ),
      );
      if (requestTitle && outcome === 'completed' && !control.signal.aborted) {
        const title = suggestedSessionTitle(text);
        if (title) onSuggestedTitle?.(title, id);
      }
      setBusy(false);
      setStatus('');
      setActiveId(null);
      setToolCalls((items) =>
        items.map((item) =>
          item.messageId === id && item.status === 'running'
            ? { ...item, status: 'cancelled', error: 'Tool response interrupted.' }
            : item,
        ),
      );
      // EOF, provider failure and server shutdown cancel any host command still
      // awaiting a tool response. Review buttons own separate user controllers.
      control.abort();
      controller.current = null;
    }
  }

  async function applyCommandReview(reviewId: string) {
    if (reviewClaims.current.has(reviewId)) return;
    const item = commandReviews.find((entry) => entry.command.id === reviewId);
    if (!item || item.status !== 'pending') return;
    reviewClaims.current.add(reviewId);
    const control = new AbortController();
    reviewControls.current.set(reviewId, control);
    const updateTool = (update: Partial<AgentToolActivity>) =>
      setToolCalls((items) =>
        items.map((entry) =>
          entry.messageId === item.messageId && entry.id === reviewId
            ? { ...entry, ...update }
            : entry,
        ),
      );
    updateTool({ status: 'applying', result: undefined });
    setCommandReviews((items) =>
      items.map((entry) =>
        entry.command.id === reviewId ? { ...entry, status: 'applying' } : entry,
      ),
    );
    try {
      const result = await executeWithFiles(
        item.messageId,
        item.host,
        item.command.name,
        item.command.input,
        {
          expectedRevision: item.command.expectedRevision,
          signal: control.signal,
        },
      );
      const cancelled =
        !!result &&
        typeof result === 'object' &&
        'status' in result &&
        result.status === 'cancelled';
      updateTool({
        status: cancelled ? 'cancelled' : 'applied',
        result: toolPreview(result),
      });
      setCommandReviews((items) =>
        items.map((entry) =>
          entry.command.id === reviewId
            ? { ...entry, status: cancelled ? 'cancelled' : 'applied' }
            : entry,
        ),
      );
    } catch (error) {
      updateTool({
        status: 'failed',
        error: (error as Error).message,
      });
      setCommandReviews((items) =>
        items.map((entry) =>
          entry.command.id === reviewId
            ? {
                ...entry,
                status: 'failed',
              }
            : entry,
        ),
      );
    } finally {
      reviewControls.current.delete(reviewId);
    }
  }

  function proposal(message: Message) {
    let ops: Operation[] | null = null;
    try {
      ops = extractProposal(message.text);
    } catch {
      return (
        <div className="proposal-invalid">Invalid proposal format. No changes were applied.</div>
      );
    }
    if (!ops) return null;
    return (
      <div className="proposal">
        <div className="proposal-header">
          <CircuitBoard size={15} aria-hidden="true" />
          <strong>
            {ops.length} {ops.length === 1 ? 'change' : 'changes'}
          </strong>
          {message.applied ? (
            <span className="proposal-status">
              <CheckCheck size={14} aria-hidden="true" />
              Applied
            </span>
          ) : (
            <button
              className="proposal-apply"
              aria-label="Apply to schematic"
              onClick={() => {
                if (applyProposal(message.id, ops!, message.basis))
                  setMessages((m) =>
                    m.map((x) => (x.id === message.id ? { ...x, applied: true } : x)),
                  );
              }}
            >
              <Check size={14} aria-hidden="true" />
              Apply
            </button>
          )}
        </div>
        <ul>
          {ops.map((op, i) => (
            <li key={i}>
              {op.type === 'setValue'
                ? `${op.ref} → ${op.value}`
                : op.type === 'addPart'
                  ? `Add ${op.kind} · ${op.value || 'default value'}`
                  : `Remove ${op.ref}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <aside className="chat-panel" hidden={!active}>
      <div className="chat-header">
        <div className="session-picker">
          <h2 className="session-title">{conversationTitle}</h2>
        </div>
        {onToggleSidebar && (
          <SidebarToggle side="left" visible={Boolean(sidebarVisible)} onToggle={onToggleSidebar} />
        )}
      </div>
      <div className="chat-body">
        <div
          ref={scroll}
          className="chat-scroll"
          onScroll={(event) => {
            const el = event.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            setShowLatest(!follow.current);
          }}
        >
          <div className="chat-transcript">
            {!messages.length ? (
              <div className="chat-welcome">
                {[
                  'Design a 12 V to 5 V, 1 A buck converter',
                  'Build a bridge rectifier with a smoothing capacitor',
                  'Design an RC filter to smooth a 20 kHz PWM signal',
                ].map((s) => (
                  <button key={s} className="suggestion" onClick={() => setInput(s)}>
                    <span>{s}</span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            ) : (
              messages.map((m) => (
                <article key={m.id} className={`message ${m.role} ${m.error ? 'error' : ''}`}>
                  {m.role === 'assistant' && (
                    <div className="message-author">
                      <span className="tiny-agent">
                        <AgentLogo provider={m.provider || provider} size={14} />
                      </span>
                      <span className="message-agent-name">
                        {agentName(m.provider || provider)}
                      </span>
                      {m.id === activeId && (
                        <ChatProgress
                          status={
                            toolCalls.some(
                              (item) => item.messageId === m.id && item.status === 'running',
                            )
                              ? 'Using OpenPE tools…'
                              : status || 'Connecting…'
                          }
                          startedAt={startedAt}
                        />
                      )}
                      {m.id !== activeId && m.timings && <ChatTiming timings={m.timings} />}
                    </div>
                  )}
                  {toolCalls.some((item) => item.messageId === m.id) && (
                    <div className="agent-tool-list" aria-label="OpenPE tool activity">
                      {toolCalls
                        .filter((item) => item.messageId === m.id)
                        .map((item) => {
                          const review = commandReviews.find(
                            (entry) => entry.messageId === m.id && entry.command.id === item.id,
                          );
                          return (
                            <AgentToolCall
                              key={item.id}
                              activity={item}
                              reviewCommand={review?.command}
                              onApply={
                                review?.status === 'pending'
                                  ? () => void applyCommandReview(item.id)
                                  : undefined
                              }
                              onReject={
                                review?.status === 'pending'
                                  ? () => {
                                      reviewClaims.current.add(item.id);
                                      setCommandReviews((items) =>
                                        items.map((entry) =>
                                          entry.command.id === item.id
                                            ? { ...entry, status: 'rejected' }
                                            : entry,
                                        ),
                                      );
                                      setToolCalls((items) =>
                                        items.map((entry) =>
                                          entry.messageId === m.id && entry.id === item.id
                                            ? { ...entry, status: 'rejected', result: undefined }
                                            : entry,
                                        ),
                                      );
                                    }
                                  : undefined
                              }
                            />
                          );
                        })}
                    </div>
                  )}
                  {m.role === 'assistant' ? (
                    <AssistantResponse
                      text={
                        (m.id === activeId ? streamedText : m.text) ||
                        (!busy && !m.errorText ? 'No response content.' : '')
                      }
                    />
                  ) : m.text ? (
                    <div className="message-text">{m.text}</div>
                  ) : null}
                  {!!m.annotations?.length && <AnnotationAttachments annotations={m.annotations} />}
                  {m.errorText && (
                    <div className="message-error" role="status">
                      {m.errorText}
                    </div>
                  )}
                  {m.role === 'assistant' && !m.error && m.id !== activeId && proposal(m)}
                  {m.role === 'assistant' &&
                    fileChanges[m.id] &&
                    (m.id !== activeId ||
                      fileChanges[m.id].files.length > 0 ||
                      fileChanges[m.id].unavailable) && (
                      <AgentFileChanges changes={fileChanges[m.id]} />
                    )}
                </article>
              ))
            )}
          </div>
        </div>
        {showLatest && (
          <button
            className="chat-jump-latest"
            onClick={() => {
              follow.current = true;
              setShowLatest(false);
              if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            <ArrowDown size={14} aria-hidden="true" />
            Latest messages
          </button>
        )}
      </div>
      <div className="composer-area">
        {sendError && (
          <p className="dialog-error" role="alert">
            {sendError}
          </p>
        )}
        <AgentComposer
          attachments={
            annotations.length > 0 ? (
              <AnnotationAttachments
                annotations={annotations}
                layoutBasis={layoutContext?.basis}
                onChange={setAnnotations}
                basis={currentBasis}
              />
            ) : undefined
          }
          hasAttachments={annotations.length > 0}
          provider={provider}
          available={Boolean(agent?.available)}
          agentSupportsEffort={agent?.supportsEffort}
          effort={effort}
          setEffort={setEffort}
          approvalMode={approvalMode}
          setApprovalMode={setApprovalMode}
          model={model}
          setModel={setModel}
          input={input}
          setInput={setInput}
          busy={busy}
          autoFocus={active && Boolean(input)}
          observedModel={
            (
              (busy ? liveModel : '') ||
              [...messages]
                .reverse()
                .find((message) => message.provider === provider && message.model)?.model ||
              ''
            ).split(' · ')[0]
          }
          onSubmit={(resolvedEffort) => void send(resolvedEffort)}
          onStop={stopGeneration}
        />
      </div>
    </aside>
  );
}
