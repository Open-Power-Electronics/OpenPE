'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  CircuitBoard,
  Check,
  CheckCheck,
  Quote,
  Search,
} from 'lucide-react';
import { circuitFingerprint, type Circuit } from '@/lib/circuit';
import type { PCB } from '@/lib/pcb';
import { layoutAnnotationContext } from '@/lib/pcb-annotations';
import type { AgentWorkspaceContext } from '@/context/agent-workspace-context';
import type { Message } from '@/lib/chat-sessions';
import { suggestedSessionTitle, withoutSessionTitle } from '@/lib/session-title';
import { agentName } from '@/lib/agent-providers';
import { api } from '@/lib/bridge';
import { extractProposal, type Operation } from '@/lib/proposals';
import SidebarToggle from './SidebarToggle';
import AgentLogo from './AgentLogo';
import AgentComposer from './AgentComposer';
import { useAgentSettings } from './AgentSettings';
import AgentMessageQueue from './AgentMessageQueue';
import AgentMessageActions from './AgentMessageActions';
import AgentConversationSearch, { isConversationFindShortcut } from './AgentConversationSearch';
import {
  nextConversationMatch,
  renderedSearchMatch,
  revealSearchMatch,
} from './agent-search-match';
import { isGoToCodeLineShortcut } from './agent-code-navigation';
import AgentAttentionNavigation from './AgentAttentionNavigation';
import useRetiringConversationControl from './useRetiringConversationControl';
import AgentUserMessage from './AgentUserMessage';
import AgentToolCall from './AgentToolCall';
import AgentTurn from './AgentTurn';
import AgentResponse from './AgentResponse';
import AgentDiagnostic from './AgentDiagnostic';
import type { ActivityAnchor } from './agent-turn-timeline';
import AgentQuestions from './AgentQuestions';
import { updateAgentProcess, type AgentProcessEntry } from '@/lib/agent-process';
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
  type AgentQuestionRequest,
  type ChatOutcome,
  type ChatTimings,
  type ReasoningEffort,
} from '@/lib/chat-stream';
import { ChatProgress } from './ChatTiming';

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
type QueuedMessage = {
  id: string;
  text: string;
  annotations: AgentAnnotation[];
  provider: string;
  model: string;
  effort: ReasoningEffort | undefined;
  parameters?: { id: string; value: string }[];
  approvalMode: 'review' | 'auto';
};

const readingScrollAreas = [
  '.agent-process-body',
  '.agent-tool-history-body',
  '.agent-process-text',
  '.agent-code-block > pre',
  '.message-table',
  '.agent-math-scroll',
  '.tool-preview > pre',
  '.agent-questions textarea',
  '.agent-question-answers',
  '.agent-diagnostic-text',
].join(', ');

const maxDraftLength = 16000;

function selectedAnswerRange(selection: Selection | null, container: HTMLElement) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const start = range.startContainer;
  const answer = (start instanceof Element ? start : start.parentElement)?.closest(
    '.agent-answer-part',
  );
  if (
    answer &&
    container.contains(answer) &&
    answer.contains(range.endContainer) &&
    !Array.from(answer.querySelectorAll('button, .katex, .katex-error')).some((element) =>
      range.intersectsNode(element),
    )
  )
    return range;
}

type QuotePlacement = { left: number; top: number } | 'header' | null;
type LatestPlacement = number | 'occluded';

function quotePlacementFor(
  range: Range,
  container: HTMLElement,
  rects: readonly DOMRect[],
): QuotePlacement {
  const bounds = container.getBoundingClientRect();
  const innerReader = range.startContainer.parentElement?.closest(
    '.agent-code-block > pre, .message-table',
  );
  const readerBounds = innerReader?.getBoundingClientRect();
  const left = Math.max(0, bounds.left + container.clientLeft, readerBounds?.left ?? 0);
  const right = Math.min(
    window.innerWidth,
    bounds.left + container.clientLeft + container.clientWidth,
    readerBounds?.right ?? Infinity,
  );
  const top = Math.max(0, bounds.top, readerBounds?.top ?? 0);
  const bottom = Math.min(window.innerHeight, bounds.bottom, readerBounds?.bottom ?? Infinity);
  const size = 30;
  const gap = 6;
  let first: DOMRect | undefined;
  let last: DOMRect | undefined;
  for (const rect of rects) {
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.left < right &&
      rect.bottom > top &&
      rect.top < bottom
    ) {
      first ??= rect;
      last = rect;
    }
  }
  if (!first || !last || right - left < size + 2 * gap) return 'header';
  const above = first.top - gap - size >= top;
  const y = above ? first.top - gap - size : last.bottom + gap;
  if (y + size > bottom) return 'header';
  const x = (above ? first : last).right - size;
  return {
    left: Math.round(Math.max(left + gap, Math.min(x, right - size - gap))),
    top: Math.round(y),
  };
}

function latestPlacementFor(
  rects: readonly DOMRect[],
  container: HTMLElement,
  quote: QuotePlacement,
): LatestPlacement {
  const layer = container.querySelector('.chat-scroll-controls');
  const button = layer?.querySelector('button');
  if (!rects.length || !layer || !button) return 0;
  const anchor = layer.getBoundingClientRect().top;
  const bounds = button.getBoundingClientRect();
  const gap = 6;
  const viewportTop = Math.max(0, container.getBoundingClientRect().top);
  const blockers = rects.filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.left < bounds.right &&
      rect.right > bounds.left &&
      rect.bottom > viewportTop &&
      rect.top < anchor,
  );
  if (quote && quote !== 'header' && quote.left < bounds.right && quote.left + 30 > bounds.left)
    blockers.push(new DOMRect(quote.left, quote.top, 30, 30));
  let top = anchor - bounds.height;
  for (const rect of blockers.sort((a, b) => b.bottom - a.bottom)) {
    if (rect.top < top + bounds.height + gap && rect.bottom > top - gap)
      top = rect.top - bounds.height - gap;
  }
  if (top < viewportTop) return document.activeElement === button ? 0 : 'occluded';
  return Math.ceil(anchor - bounds.height - top);
}

function readingScrollArea(target: Element) {
  let area = target.closest(readingScrollAreas);
  while (area) {
    if (area.scrollHeight > area.clientHeight + 1 || area.scrollWidth > area.clientWidth + 1)
      return area;
    area = area.parentElement?.closest(readingScrollAreas) ?? null;
  }
  return null;
}

function reusablePromptId(message: Message, previous?: Message) {
  // Send appends the opening prompt and its reply together. Accepted steering follows the reply.
  const interrupted = message.outcome === 'failed' || message.outcome === 'cancelled';
  const prompt = message.role === 'user' ? message : interrupted ? previous : undefined;
  if (prompt?.role === 'user' && (prompt.text || prompt.annotations?.length)) return prompt.id;
}

export default function Chat({
  doc,
  pcb,
  pcbSchematic,
  getDesign,
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
  const agentSettings = useAgentSettings();
  const followUpMode = agentSettings.settings.followUpMode;
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queue = useRef<QueuedMessage[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const paused = useRef(false);
  const [inputTarget, setInputTarget] = useState<Extract<
    import('@/lib/chat-stream').ChatEvent,
    { type: 'input-ready' }
  > | null>(null);
  const [steering, setSteering] = useState(false);
  const steeringRequest = useRef<{
    runId: string;
    requestId: string;
    prompt: string;
    queuedId?: string;
  } | null>(null);
  const steeringItems = useRef(new Map<string, string>());
  const steeringPending = useRef(false);
  const turnSettings = useRef<Pick<QueuedMessage, 'provider' | 'model' | 'effort'> | null>(null);
  function sameAgent(item: QueuedMessage) {
    return (
      item.provider === turnSettings.current?.provider &&
      item.model === turnSettings.current.model &&
      item.effort === turnSettings.current.effort
    );
  }
  const inputLatest = useRef(input);
  inputLatest.current = input;
  const mounted = useRef(true);
  function updateQueue(next: QueuedMessage[]) {
    queue.current = next;
    setQueued(next);
  }
  function pauseQueue(value: boolean) {
    paused.current = value;
    setQueuePaused(value);
  }
  const [toolCalls, setToolCalls] = useState<AgentToolActivity[]>([]);
  const [processEntries, setProcessEntries] = useState<AgentProcessEntry[]>([]);
  const [activityAnchors, setActivityAnchors] = useState<ActivityAnchor[]>([]);
  useEffect(() => {
    const retained = new Set([
      ...toolCalls.map((item) => JSON.stringify([item.messageId, 'tool', item.id])),
      ...processEntries.map((item) => JSON.stringify([item.messageId, 'process', item.id])),
    ]);
    // An older effect must not prune anchors added by a newer streamed event.
    const expired = new Set(
      activityAnchors.filter(
        (item) => !retained.has(JSON.stringify([item.messageId, item.kind, item.id])),
      ),
    );
    if (expired.size) setActivityAnchors((items) => items.filter((item) => !expired.has(item)));
  }, [toolCalls, processEntries, activityAnchors]);
  const [questions, setQuestions] = useState<
    (Pick<AgentQuestionRequest, 'requestId' | 'questions'> & {
      messageId: string;
      closed?: boolean;
      delivery: 'pending' | 'sending' | 'sent';
    })[]
  >([]);
  const activeQuestions = questions.filter((item) => item.messageId === activeId && !item.closed);
  const pendingQuestions = activeQuestions.filter((item) => item.delivery === 'pending');
  const questionRequests = useRef(new Map<string, AgentQuestionRequest>());
  const answering = useRef(new Set<string>());
  const [showLatest, setShowLatest] = useState(false);
  const [commandReviews, setCommandReviews] = useState<
    {
      messageId: string;
      command: AgentCommandReview;
      description: string;
      host: AgentCapabilities;
      status: 'pending' | 'applying' | 'applied' | 'rejected' | 'failed' | 'cancelled';
    }[]
  >([]);
  const reviewControls = useRef(new Map<string, AbortController>());
  const pendingReviews = useMemo(() => {
    const ids = new Set(messages.map((message) => message.id));
    return commandReviews.filter((item) => item.status === 'pending' && ids.has(item.messageId));
  }, [commandReviews, messages]);
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
  const reading = useRef(false);
  const selectingReply = useRef(false);
  const pauseFollowing = useCallback((manual = false) => {
    if (manual) reading.current = true;
    follow.current = false;
    setShowLatest(true);
  }, []);
  const controller = useRef<AbortController | null>(null);
  const applyLatest = useRef(onApply);
  applyLatest.current = onApply;
  const scroll = useRef<HTMLDivElement>(null);
  const attentionClearance = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const allowFollowing = useCallback(() => {
    reading.current = false;
    const element = scroll.current;
    if (
      element &&
      !selectingReply.current &&
      element.scrollHeight - element.scrollTop - element.clientHeight < 2
    ) {
      follow.current = true;
      setShowLatest(false);
    }
  }, []);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const retiredReviewFocus = useRef<string | null>(null);
  const retainReviewFocus = useCallback((messageId: string) => {
    retiredReviewFocus.current = messageId;
  }, []);
  const restoreDraftFocus = useRef<'draft' | 'focused-draft' | 'focused-draft-start' | null>(null);
  const recalledDraft = useRef<{ id: string; text: string; annotations: AgentAnnotation[] } | null>(
    null,
  );
  const draftComposing = useRef(false);
  const compositionTarget = useRef<EventTarget | null>(null);
  const agent = agents.find((a) => a.id === provider);
  const presentationActive = active && sidebarVisible !== false;
  const [quotePlacement, setQuotePlacement] = useState<QuotePlacement>(null);
  const [latestPlacement, setLatestPlacement] = useState<LatestPlacement>(0);
  const placeSelectionControls = useCallback(
    (element: HTMLElement, selection: Selection | null) => {
      const answerRange = selectedAnswerRange(selection, element);
      const range =
        selection && !selection.isCollapsed && selection.rangeCount > 0
          ? selection.getRangeAt(0)
          : undefined;
      const rects = range?.intersectsNode(element) ? Array.from(range.getClientRects()) : [];
      const quote = answerRange ? quotePlacementFor(answerRange, element, rects) : null;
      setLatestPlacement(latestPlacementFor(rects, element, quote));
      setQuotePlacement((previous) =>
        previous &&
        previous !== 'header' &&
        quote &&
        quote !== 'header' &&
        previous.left === quote.left &&
        previous.top === quote.top
          ? previous
          : quote,
      );
    },
    [],
  );
  useLayoutEffect(() => {
    if (presentationActive && showLatest && scroll.current)
      placeSelectionControls(scroll.current, window.getSelection());
  }, [presentationActive, showLatest, placeSelectionControls]);
  const retainQuoteSelection = useRetiringConversationControl(presentationActive, () => {
    composerInput.current?.focus({ preventScroll: true });
  });
  function quoteSelection() {
    const container = scroll.current;
    const field = composerInput.current;
    const selection = window.getSelection();
    if (
      !presentationActive ||
      draftComposing.current ||
      steeringPending.current ||
      steeringRequest.current ||
      !container ||
      !field ||
      !selection ||
      !selectedAnswerRange(selection, container)
    )
      return;
    const text = selection.toString().replace(/\r\n?/g, '\n');
    if (!text.trim()) return;
    const draft = field.value;
    const separator = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
    const quoted = text
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
    const next = `${draft}${separator}${quoted}\n\n`;
    if (next.length > maxDraftLength) {
      setSendError('The selected quote is too long for this draft.');
      return;
    }
    pauseFollowing(true);
    field.focus({ preventScroll: true });
    restoreDraftFocus.current = 'focused-draft';
    selection.removeAllRanges();
    setQuotePlacement(null);
    setInput(next);
    setSendError('');
  }
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const pendingSearchTarget = useRef<{ id: string; term: string } | null>(null);
  const lastSearchTarget = useRef<{ id: string; term: string; range?: Range } | null>(null);
  const searchHighlight = useRef<{ highlight: Highlight; focus: HTMLElement } | null>(null);
  const clearSearchHighlight = useCallback(() => {
    if (
      searchHighlight.current &&
      CSS.highlights.get('agent-search-hit') === searchHighlight.current.highlight
    )
      CSS.highlights.delete('agent-search-hit');
    searchHighlight.current = null;
  }, []);
  useLayoutEffect(() => clearSearchHighlight, [presentationActive, clearSearchHighlight]);
  const searchFieldOrigin = useRef<{
    field: HTMLTextAreaElement;
    value: string;
    start: number;
    end: number;
    direction: HTMLTextAreaElement['selectionDirection'];
    scrollTop: number;
    scrollLeft: number;
  } | null>(null);
  const revealConversationSearchTarget = useCallback(
    (selected: { id: string; term: string }, direction: 1 | -1 = 1, after?: Range) => {
      const container = scroll.current;
      if (!presentationActive || !container?.getClientRects().length) return;
      const target = container.querySelector<HTMLElement>(
        `.message[data-message-id="${CSS.escape(selected.id)}"]`,
      );
      if (!target) return;
      const match = renderedSearchMatch(target, selected.term, direction, after);
      if (after && !match) return false;
      lastSearchTarget.current = selected.term ? { ...selected, range: match?.range } : null;
      pauseFollowing(true);
      clearSearchHighlight();
      const focus = match?.reader ?? target;
      focus.focus({ preventScroll: true });
      const top = match ? revealSearchMatch(match) : target.getBoundingClientRect().top;
      if (match) {
        const highlight = new Highlight(match.range);
        searchHighlight.current = { highlight, focus };
        CSS.highlights.set('agent-search-hit', highlight);
      }
      container.scrollTop += top - container.getBoundingClientRect().top - (match ? 12 : 4);
      return true;
    },
    [presentationActive, pauseFollowing, clearSearchHighlight],
  );
  const navigateAnswerHeading = useCallback(
    (heading: HTMLElement) => {
      const container = scroll.current;
      if (
        !presentationActive ||
        draftComposing.current ||
        !container?.contains(heading) ||
        !heading.getClientRects().length
      )
        return;
      pauseFollowing(true);
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      container.scrollTop +=
        heading.getBoundingClientRect().top - container.getBoundingClientRect().top - 8;
    },
    [presentationActive, pauseFollowing],
  );
  useLayoutEffect(() => {
    if (!presentationActive) {
      setConversationSearchOpen(false);
      lastSearchTarget.current = null;
    }
    if (conversationSearchOpen) return;
    const origin = searchFieldOrigin.current;
    searchFieldOrigin.current = null;
    if (
      presentationActive &&
      origin?.field === document.activeElement &&
      origin.field.value === origin.value
    ) {
      origin.field.setSelectionRange(origin.start, origin.end, origin.direction);
      origin.field.scrollTop = origin.scrollTop;
      origin.field.scrollLeft = origin.scrollLeft;
    }
    const selected = pendingSearchTarget.current;
    pendingSearchTarget.current = null;
    if (selected) revealConversationSearchTarget(selected);
  }, [presentationActive, conversationSearchOpen, revealConversationSearchTarget]);
  const retainLatestControl = useRetiringConversationControl(presentationActive, () => {
    composerInput.current?.focus({ preventScroll: true });
  });
  function revealAttention(container: HTMLElement, card: HTMLElement, target: HTMLElement) {
    pauseFollowing(true);
    target.focus({ preventScroll: true });
    const bounds = container.getBoundingClientRect();
    const clearance =
      Number.parseFloat(getComputedStyle(container).paddingBottom) +
      (attentionClearance.current?.getBoundingClientRect().height ?? 0);
    const available = container.clientHeight - clearance;
    const cardBounds = card.getBoundingClientRect();
    const view = cardBounds.height <= available ? cardBounds : target.getBoundingClientRect();
    const top = bounds.top + container.clientTop;
    if (view.top < top) container.scrollTop += view.top - top;
    else if (view.bottom > top + available) container.scrollTop += view.bottom - top - available;
  }
  function attentionComposing() {
    return (
      draftComposing.current ||
      Boolean(compositionTarget.current && compositionTarget.current === document.activeElement)
    );
  }
  function navigateReview() {
    const container = scroll.current;
    if (!presentationActive || attentionComposing() || !container) return;
    for (const item of pendingReviews) {
      const card = container.querySelector<HTMLElement>(
        `[data-tool-status="review"][data-review-id="${CSS.escape(item.command.id)}"]`,
      );
      const target = card?.querySelector<HTMLButtonElement>(
        '.proposal-apply:not(.tool-reject):not(:disabled):not([aria-disabled="true"])',
      );
      if (!card || !target?.getClientRects().length) continue;
      revealAttention(container, card, target);
      return;
    }
  }
  function navigateQuestion() {
    const container = scroll.current;
    if (!presentationActive || attentionComposing() || !container) return;
    for (const item of pendingQuestions) {
      const card = container.querySelector<HTMLElement>(
        `.agent-questions[data-state="pending"][data-question-request="${CSS.escape(item.requestId)}"]`,
      );
      const target =
        card?.querySelector<HTMLElement>('fieldset[data-awaiting-answer] > legend') ??
        card?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)');
      if (!card || !target?.getClientRects().length) continue;
      revealAttention(container, card, target);
      return;
    }
  }
  function focusAttentionComposer() {
    if (presentationActive) composerInput.current?.focus({ preventScroll: true });
  }
  const focusDraftEnd = useCallback(() => {
    const field = composerInput.current;
    if (!presentationActive || !field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollTop = field.scrollHeight;
  }, [presentationActive]);
  const canRestoreDraft = useCallback(
    () =>
      presentationActive &&
      !steeringPending.current &&
      !steeringRequest.current &&
      !draftComposing.current &&
      !restoreDraftFocus.current,
    [presentationActive],
  );
  const restoreMessageDraft = useCallback(
    (message: Message | undefined, historyStep?: 'older' | 'newer' | 'first') => {
      const text = message?.text ?? '';
      const restoredAnnotations = structuredClone(message?.annotations ?? []);
      recalledDraft.current =
        historyStep && message ? { id: message.id, text, annotations: restoredAnnotations } : null;
      composerInput.current?.focus({ preventScroll: true });
      restoreDraftFocus.current = historyStep === 'older' ? 'focused-draft-start' : 'focused-draft';
      setInput(text);
      setAnnotations(restoredAnnotations);
      setSendError('');
    },
    [setInput, setAnnotations],
  );
  const emptyDraft = useCallback(
    () =>
      !inputLatest.current.length && !composerInput.current?.value.length && !annotations.length,
    [annotations.length],
  );
  const reuseMessage = useCallback(
    (messageId: string) => {
      const message = messages.find((item) => item.id === messageId && item.role === 'user');
      if (message && canRestoreDraft() && emptyDraft()) restoreMessageDraft(message);
    },
    [messages, canRestoreDraft, emptyDraft, restoreMessageDraft],
  );
  const canReuseMessage =
    presentationActive &&
    !input.length &&
    !annotations.length &&
    !steering &&
    !steeringRequest.current;
  const recalled = recalledDraft.current;
  const browsingHistory = recalled?.text === input && recalled.annotations === annotations;
  function stepDraftHistory(direction: -1 | 1) {
    if (!canRestoreDraft()) return false;
    const history = messages.filter(
      (message) => message.role === 'user' && (message.text || message.annotations?.length),
    );
    const current =
      browsingHistory && recalledDraft.current === recalled
        ? history.findIndex((message) => message.id === recalled.id)
        : -1;
    if (current < 0 && (direction === 1 || !emptyDraft())) return false;
    const next = current < 0 ? history.length - 1 : current + direction;
    if (next < 0) return false;
    restoreMessageDraft(history[next], current < 0 ? 'first' : direction < 0 ? 'older' : 'newer');
    return true;
  }
  useLayoutEffect(() => {
    if (!presentationActive || !browsingHistory) recalledDraft.current = null;
  }, [presentationActive, browsingHistory]);
  const latestAssistantIndex = messages.findLastIndex((message) => message.role === 'assistant');
  const latestAssistant = messages[latestAssistantIndex];
  const latestAssistantId = latestAssistant?.id;
  const hasPromptRecovery =
    latestAssistant &&
    latestAssistantId !== activeId &&
    reusablePromptId(latestAssistant, messages[latestAssistantIndex - 1]);
  useLayoutEffect(() => {
    const messageId = retiredReviewFocus.current;
    if (!messageId) return;
    retiredReviewFocus.current = null;
    if (!presentationActive || document.activeElement !== document.body) return;
    const message = scroll.current?.querySelector<HTMLElement>(
      `.message[data-message-id="${CSS.escape(messageId)}"]`,
    );
    const target =
      message?.querySelector<HTMLElement>(
        '[data-tool-status="review"] .tool-actions > .proposal-apply:not(.tool-reject)',
      ) ||
      message?.querySelector<HTMLElement>('.agent-process > summary') ||
      composerInput.current;
    if (target?.getClientRects().length) target.focus({ preventScroll: true });
  });
  useLayoutEffect(() => {
    const request = restoreDraftFocus.current;
    if (!request) return;
    restoreDraftFocus.current = null;
    const field = composerInput.current;
    if (request !== 'draft' && document.activeElement !== field) return;
    if (request === 'focused-draft-start') {
      if (!presentationActive || !field) return;
      field.setSelectionRange(0, 0);
      field.scrollTop = 0;
    } else focusDraftEnd();
  }, [focusDraftEnd, input, annotations, queued, presentationActive]);
  useLayoutEffect(() => {
    // Follow within the conversation only; never scroll the editor's ancestors.
    if (presentationActive && follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, streamedText, toolCalls, processEntries, questions, presentationActive]);
  useEffect(() => {
    const element = scroll.current;
    if (!presentationActive || !element) return;
    let placementFrame = 0;
    const schedulePlacement = () => {
      if (placementFrame || window.getSelection()?.isCollapsed !== false) return;
      placementFrame = requestAnimationFrame(() => {
        placementFrame = 0;
        placeSelectionControls(element, window.getSelection());
      });
    };
    const update = () => {
      const selection = window.getSelection();
      placeSelectionControls(element, selection);
      selectingReply.current = Boolean(
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        selection.getRangeAt(0).intersectsNode(element),
      );
      if (selectingReply.current) {
        pauseFollowing();
      }
    };
    document.addEventListener('selectionchange', update);
    element.addEventListener('scroll', schedulePlacement, { capture: true, passive: true });
    window.addEventListener('scroll', schedulePlacement, { passive: true });
    window.addEventListener('resize', schedulePlacement);
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
      schedulePlacement();
    });
    observer.observe(element);
    // Deferred Markdown and disclosures can change content height without a stream update.
    if (transcript.current) observer.observe(transcript.current);
    update();
    return () => {
      document.removeEventListener('selectionchange', update);
      element.removeEventListener('scroll', schedulePlacement, true);
      window.removeEventListener('scroll', schedulePlacement);
      window.removeEventListener('resize', schedulePlacement);
      observer.disconnect();
      cancelAnimationFrame(placementFrame);
      selectingReply.current = false;
      setQuotePlacement(null);
      setLatestPlacement(0);
    };
  }, [presentationActive, pauseFollowing, placeSelectionControls]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      for (const control of reviewControls.current.values()) control.abort();
    };
  }, []);
  useEffect(() => {
    const ids = new Set(messages.map((message) => message.id));
    setToolCalls((items) => items.filter((item) => ids.has(item.messageId)));
    setProcessEntries((items) => items.filter((item) => ids.has(item.messageId)));
    setQuestions((items) => items.filter((item) => ids.has(item.messageId)));
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
    pauseQueue(true);
    const control = controller.current;
    if (!control || control.signal.aborted) return;
    setStatus('Stopping…');
    control.abort();
  }
  const sendLatest = useRef(send);
  sendLatest.current = send;
  useEffect(() => {
    if (
      mounted.current &&
      !busy &&
      !paused.current &&
      !queuePaused &&
      queued.length &&
      !controller.current
    )
      void sendLatest.current(queued[0].effort, queued[0]);
  }, [busy, queuePaused, queued]);

  async function steerMessage(prompt: string, queuedId?: string) {
    const control = controller.current;
    if (!inputTarget || !control || control.signal.aborted || steeringPending.current) return;
    if (queuedId) {
      const item = queue.current.find((entry) => entry.id === queuedId);
      if (!item || item.annotations.length || !sameAgent(item)) return;
    }
    const previous = steeringRequest.current;
    const request =
      previous?.runId === inputTarget.runId &&
      previous.prompt === prompt &&
      previous.queuedId === queuedId
        ? previous
        : {
            runId: inputTarget.runId,
            requestId: crypto.randomUUID(),
            prompt,
            queuedId,
          };
    if (
      queuedId &&
      !steeringItems.current.has(request.requestId) &&
      steeringItems.current.size >= 32
    )
      return setSendError('The steering limit for this run has been reached.');
    steeringRequest.current = request;
    if (queuedId) steeringItems.current.set(request.requestId, queuedId);
    steeringPending.current = true;
    setSteering(true);
    setSendError('');
    try {
      await api('chat/steer', {
        method: 'POST',
        signal: control.signal,
        body: JSON.stringify({
          runId: request.runId,
          requestId: request.requestId,
          prompt,
          sessionId,
          token: inputTarget.token,
        }),
      });
    } catch (error) {
      if (!control.signal.aborted && steeringRequest.current?.requestId === request.requestId) {
        if (queuedId) pauseQueue(true);
        if ((error as { code?: string }).code === 'OPENPE_STEER_REJECTED') {
          steeringItems.current.delete(request.requestId);
          steeringRequest.current = null;
        }
        setSendError((error as Error).message);
      }
    } finally {
      steeringPending.current = false;
      if (mounted.current) setSteering(false);
    }
  }

  async function submit(
    resolvedEffort: ReasoningEffort | undefined,
    parameters?: { id: string; value: string }[],
  ) {
    if (steeringPending.current) return;
    if (!controller.current && !busy && !queue.current.length) {
      pauseQueue(false);
      return send(resolvedEffort, undefined, parameters);
    }
    if (!input.trim() && !annotations.length) return;
    if (input.length > maxDraftLength)
      return setSendError('Messages are limited to 16,000 characters.');
    try {
      validateAnnotations(annotations);
    } catch (error) {
      setSendError((error as Error).message);
      return;
    }
    if (
      followUpMode === 'steer' &&
      busy &&
      inputTarget &&
      !controller.current?.signal.aborted &&
      !annotations.length
    )
      return steerMessage(input.trim());
    if (queue.current.length >= 16)
      return setSendError(
        'The message queue is full. Remove a queued message before adding another.',
      );
    updateQueue([
      ...queue.current,
      {
        id: crypto.randomUUID(),
        text: input.trim(),
        annotations: structuredClone(annotations),
        provider,
        model,
        effort: resolvedEffort,
        ...(parameters?.length ? { parameters } : {}),
        approvalMode,
      },
    ]);
    setInput('');
    setAnnotations([]);
    setSendError('');
  }

  async function send(
    resolvedEffort: ReasoningEffort | undefined,
    pending?: QueuedMessage,
    parameters?: { id: string; value: string }[],
  ) {
    const submittedText = pending?.text ?? input.trim();
    const sentAnnotations = pending?.annotations ?? annotations;
    const turnProvider = pending?.provider ?? provider;
    const turnModel = pending?.model ?? model;
    const turnApproval = pending?.approvalMode ?? approvalMode;
    const turnParameters = pending ? pending.parameters : parameters;
    if ((!submittedText && !sentAnnotations.length) || busy || controller.current) return;
    if (!agents.find((item) => item.id === turnProvider)?.available) {
      if (pending) {
        pauseQueue(true);
        setSendError('The queued Agent is unavailable. Check Agent connections before resuming.');
      }
      onSettings();
      return;
    }
    // Capture the live design once at submission. Empty retained conversations
    // need no render or document fingerprint when an editor transaction changes.
    let submitted: ChatDesign;
    try {
      submitted = getDesign?.() ?? { doc, pcb, pcbSchematic };
    } catch (error) {
      if (pending) pauseQueue(true);
      setSendError((error as Error).message);
      return;
    }
    const submittedDoc = submitted.doc;
    const submittedLayout = submitted.pcb
      ? layoutAnnotationContext(submitted.pcb, submitted.pcbSchematic ?? submittedDoc)
      : undefined;
    let workspace: AgentWorkspaceContext | undefined;
    try {
      validateAnnotations(sentAnnotations);
      if (submittedText.length > maxDraftLength)
        throw new Error('Messages are limited to 16,000 characters.');
    } catch (e) {
      if (pending) pauseQueue(true);
      setSendError((e as Error).message);
      return;
    }
    setSendError('');
    const prompt = submittedText || 'Review the attached design annotations.';
    if (pending) updateQueue(queue.current.filter((item) => item.id !== pending.id));
    else {
      setInput('');
      setAnnotations([]);
    }
    setBusy(true);
    setStatus('Connecting…');
    const id = crypto.randomUUID();
    const basis = circuitFingerprint(submittedDoc);
    setMessages((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        role: 'user',
        text: submittedText,
        ...(sentAnnotations.length ? { annotations: sentAnnotations } : {}),
      },
      { id, role: 'assistant', text: '', basis, provider: turnProvider },
    ]);
    const control = new AbortController();
    controller.current = control;
    steeringItems.current.clear();
    steeringRequest.current = null;
    turnSettings.current = { provider: turnProvider, model: turnModel, effort: resolvedEffort };
    const started = performance.now();
    setStartedAt(started);
    setActiveId(id);
    setStreamedText('');
    questionRequests.current.clear();
    setLiveModel('');
    selectingReply.current = false;
    reading.current = false;
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
    const handledRequests = new Set<string>();
    const anchorActivity = (kind: ActivityAnchor['kind'], activityId: string) => {
      const offset = responseText(text).length;
      setStreamedText(text);
      setActivityAnchors((items) =>
        items.some((item) => item.messageId === id && item.kind === kind && item.id === activityId)
          ? items
          : [...items, { messageId: id, kind, id: activityId, offset }],
      );
    };
    let reviewCount = 0;
    const pendingLifecycleActions = new Set<Promise<void>>();
    const capabilityRequest = async (event: AgentCapabilityRequest) => {
      if (
        event.sessionId !== sessionId ||
        control.signal.aborted ||
        handledRequests.has(event.requestId)
      )
        return;
      handledRequests.add(event.requestId);
      anchorActivity('tool', event.requestId);
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
      let acknowledge = (_delivered: boolean) => {};
      const resultDelivery = new Promise<boolean>((resolve) => {
        acknowledge = resolve;
      });
      try {
        if (!runtime) throw new Error('The originating workbench capability host is unavailable.');
        const result = await resolveAgentCapability(
          event,
          {
            query: (...args) => runtime.query(...args),
            observe: (...args) => runtime.observe(...args),
            execute: (name, input, options) =>
              runtime.execute(name, input, {
                ...options,
                resultDelivery,
                onAfterResult: (completion) => {
                  pendingLifecycleActions.add(completion);
                  void completion.then(() => pendingLifecycleActions.delete(completion));
                },
              }),
          },
          approvalLatest.current,
          (command, description) => {
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
              }),
            });
            setCommandReviews((items) => [
              ...items,
              { messageId: id, command, description, host: runtime, status: 'pending' },
            ]);
          },
          control.signal,
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
        acknowledge(false);
        payload = { ...response, error: String((error as Error).message).slice(0, 4000) };
        updateTool({
          status: 'failed',
          error: payload.error,
        });
      }
      if (control.signal.aborted) {
        acknowledge(false);
        return;
      }
      try {
        await api('chat/tool-result', {
          method: 'POST',
          body: JSON.stringify(payload),
          signal: control.signal,
        });
        acknowledge(!control.signal.aborted);
      } catch (error) {
        acknowledge(false);
        updateTool({ deliveryError: `Result delivery failed: ${(error as Error).message}` });
      }
    };
    try {
      workspace = await getWorkspaceContext?.(control.signal);
      control.signal.throwIfAborted();
      const res = await api('chat', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          ...(requestTitle ? { requestTitle: true } : {}),
          capabilities: Boolean(runtime),
          provider: turnProvider,
          prompt,
          annotations: sentAnnotations,
          effort: resolvedEffort,
          ...(turnParameters?.length ? { parameters: turnParameters } : {}),
          model: turnModel || undefined,
          context: {
            title: submittedDoc.title,
            id: submittedDoc.id,
            basis,
            ...(workspace
              ? { workspace }
              : {
                  parts: submittedDoc.parts.map(({ raw, ...p }) => p),
                  wires: submittedDoc.wires,
                  labels: submittedDoc.labels,
                  junctions: submittedDoc.junctions,
                  noConnects: submittedDoc.noConnects ?? [],
                }),
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
      setStatus('Waiting for the model…');
      await readChatEvents(
        res.body,
        (e) => {
          if (e.type === 'input-ready' && e.sessionId === sessionId) setInputTarget(e);
          if (e.type === 'input-accepted' && e.sessionId === sessionId) {
            setMessages((items) => {
              if (items.some((item) => item.id === e.requestId)) return items;
              // Keep accepted steering after the response that was already in progress.
              return [...items, { id: e.requestId, role: 'user', text: e.prompt }];
            });
            const queuedId = steeringItems.current.get(e.requestId);
            if (queuedId) {
              updateQueue(queue.current.filter((item) => item.id !== queuedId));
              steeringItems.current.delete(e.requestId);
            }
            const request = steeringRequest.current;
            if (request?.requestId === e.requestId) {
              if (!request.queuedId && inputLatest.current.trim() === e.prompt) setInput('');
              steeringRequest.current = null;
              setSendError('');
            }
          }
          if (e.type === 'process') {
            anchorActivity('process', e.id);
            setProcessEntries((items) => updateAgentProcess(items, id, e));
          }
          if (e.type === 'question-closed' && e.sessionId === sessionId) {
            questionRequests.current.delete(e.requestId);
            setQuestions((items) =>
              items.map((item) =>
                item.requestId === e.requestId ? { ...item, closed: true } : item,
              ),
            );
          }
          if (
            e.type === 'question-request' &&
            e.sessionId === sessionId &&
            !control.signal.aborted &&
            !questionRequests.current.has(e.requestId)
          ) {
            questionRequests.current.set(e.requestId, e);
            setQuestions((items) =>
              [
                ...items,
                {
                  requestId: e.requestId,
                  questions: e.questions,
                  messageId: id,
                  delivery: 'pending' as const,
                },
              ].slice(-64),
            );
          }
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
      questionRequests.current.clear();
      clearTimeout(flushTimer);
      // A provider may finish immediately after consuming a tool result. Drain
      // only serialized lifecycle requests; unresolved commands still cancel.
      if (outcome === 'completed' && !control.signal.aborted)
        await Promise.allSettled([...pendingLifecycleActions]);
      if (control.signal.aborted) {
        outcome = 'cancelled';
        failure = 'Generation stopped.';
      }
      let applied = false;
      if (outcome === 'completed' && !control.signal.aborted && turnApproval === 'auto') {
        try {
          const ops = extractProposal(text);
          if (ops) applied = applyLatest.current(ops, basis);
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
      setInputTarget(null);
      if (outcome !== 'completed') pauseQueue(true);
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
      steeringItems.current.clear();
      steeringRequest.current = null;
      turnSettings.current = null;
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
      const result = await item.host.execute(item.command.name, item.command.input, {
        signal: control.signal,
      });
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
                if (onApply(ops!, message.basis))
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
    <aside
      className="chat-panel"
      hidden={!active}
      onBlurCapture={(event) => {
        if (event.target === searchHighlight.current?.focus) clearSearchHighlight();
      }}
      onCompositionStartCapture={(event) => {
        compositionTarget.current = event.target;
        if (event.target === composerInput.current) draftComposing.current = true;
      }}
      onCompositionEndCapture={(event) => {
        if (compositionTarget.current === event.target) compositionTarget.current = null;
        if (event.target === composerInput.current) draftComposing.current = false;
      }}
      onPointerDownCapture={(event) => {
        if (
          attentionComposing() &&
          event.target instanceof Element &&
          event.target.closest('.agent-attention-navigation button')
        )
          event.preventDefault();
        if (
          draftComposing.current &&
          event.target instanceof Element &&
          event.target.closest(
            '.agent-message-reuse, .annotation-attachments-pending button, .agent-message-queue button, .agent-attention-navigation button, .chat-jump-latest, .chat-conversation-search-trigger, .agent-code-go-to-line, .agent-code-disclosure, .agent-answer-outline-trigger, .agent-table-freeze, .message-actions[data-streaming] .copy-action button',
          )
        )
          event.preventDefault();
      }}
      onClickCapture={(event) => {
        if (
          draftComposing.current &&
          event.target instanceof Element &&
          event.target.closest(
            '.annotation-attachments-pending button, .agent-message-queue button, .agent-attention-navigation button, .agent-code-go-to-line, .agent-code-disclosure, .agent-answer-outline-trigger, .agent-table-freeze, .message-actions[data-streaming] .copy-action button',
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          presentationActive &&
          event.target instanceof Element &&
          event.target.matches('.agent-code-block > pre[data-numbered]') &&
          isGoToCodeLineShortcut(event.nativeEvent)
        ) {
          if (draftComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
            event.preventDefault();
            event.stopPropagation();
          } else if (!event.repeat) pauseFollowing(true);
          return;
        }
        const priorSearch = lastSearchTarget.current;
        const stepSearch =
          priorSearch && event.key === 'F3' && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (
          presentationActive &&
          messages.length &&
          !draftComposing.current &&
          compositionTarget.current !== event.target &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229 &&
          event.target instanceof Element &&
          event.currentTarget.contains(event.target) &&
          (stepSearch || isConversationFindShortcut(event.nativeEvent))
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (event.repeat) return;
          if (stepSearch) {
            const direction = event.shiftKey ? -1 : 1;
            if (
              priorSearch.range &&
              revealConversationSearchTarget(priorSearch, direction, priorSearch.range)
            )
              return;
            const match = nextConversationMatch(messages, activeId, priorSearch, direction);
            if (match) revealConversationSearchTarget(match, direction);
          } else {
            const field = event.target;
            if (field instanceof HTMLTextAreaElement) {
              searchFieldOrigin.current = {
                field,
                value: field.value,
                start: field.selectionStart,
                end: field.selectionEnd,
                direction: field.selectionDirection,
                scrollTop: field.scrollTop,
                scrollLeft: field.scrollLeft,
              };
            }
            setConversationSearchOpen(true);
          }
          return;
        }
        if (
          (draftComposing.current || event.nativeEvent.isComposing || event.keyCode === 229) &&
          event.target instanceof Element &&
          event.target.closest(
            '.agent-message-queue button, .chat-conversation-search-trigger, .agent-code-go-to-line, .agent-code-disclosure, .agent-answer-outline-trigger, .agent-table-freeze, .message-actions[data-streaming] .copy-action button',
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div className="chat-header">
        <div className="session-picker">
          <h2 className="session-title">{conversationTitle}</h2>
        </div>
        {presentationActive && messages.length > 0 && (
          <button
            type="button"
            className="icon-button chat-conversation-search-trigger"
            aria-label="Find in conversation"
            aria-keyshortcuts="Control+F Meta+F"
            aria-haspopup="dialog"
            title="Find in conversation (Ctrl+F / ⌘F)"
            onClick={() => {
              if (!draftComposing.current) setConversationSearchOpen(true);
            }}
          >
            <Search size={17} aria-hidden="true" />
          </button>
        )}
        {presentationActive && quotePlacement && (
          <button
            ref={retainQuoteSelection}
            type="button"
            className="icon-button chat-quote-selection"
            data-floating={quotePlacement !== 'header' || undefined}
            style={quotePlacement === 'header' ? undefined : quotePlacement}
            aria-label="Quote selected reply"
            title="Quote selected reply"
            disabled={Boolean(steering || steeringRequest.current)}
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onClick={quoteSelection}
            onKeyDown={(event) => {
              if (draftComposing.current || event.nativeEvent.isComposing || event.keyCode === 229)
                event.preventDefault();
            }}
          >
            <Quote size={17} aria-hidden="true" />
          </button>
        )}
        {onToggleSidebar && (
          <SidebarToggle side="left" visible={Boolean(sidebarVisible)} onToggle={onToggleSidebar} />
        )}
      </div>
      {presentationActive && conversationSearchOpen && (
        <AgentConversationSearch
          messages={messages}
          activeReplyId={activeId}
          onClose={() => setConversationSearchOpen(false)}
          onSelect={(id, term) => {
            pendingSearchTarget.current = { id, term };
            setConversationSearchOpen(false);
          }}
        />
      )}
      <div className="chat-body">
        <div
          ref={scroll}
          className="chat-scroll"
          onClickCapture={(event) => {
            const target = event.target;
            if (!(target instanceof Element) || target.closest('.copy-action')) return;
            if (
              target.closest(
                `summary, a[data-openpe-footnote], .agent-user-toggle, .agent-code-actions > button, .agent-code-disclosure, .agent-answer-outline-trigger, .agent-table-freeze, ${readingScrollAreas}`,
              )
            )
              pauseFollowing(true);
          }}
          onKeyDownCapture={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              (event.target instanceof Element &&
                event.target.closest('input, textarea, select, button, a, [contenteditable]'))
            )
              return;
            if (
              [
                'ArrowUp',
                'ArrowDown',
                'ArrowLeft',
                'ArrowRight',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                ' ',
              ].includes(event.key) &&
              event.target instanceof Element
            ) {
              if (readingScrollArea(event.target)) pauseFollowing(true);
              else if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') allowFollowing();
            }
          }}
          onWheelCapture={(event) => {
            if ((event.deltaX || event.deltaY) && event.target instanceof Element) {
              if (readingScrollArea(event.target)) pauseFollowing(true);
              else if (event.deltaY) allowFollowing();
            }
          }}
          onPointerDownCapture={(event) => {
            if (event.defaultPrevented) return;
            if (
              event.target === event.currentTarget ||
              (event.pointerType === 'touch' &&
                event.target instanceof Element &&
                !readingScrollArea(event.target))
            )
              reading.current = false;
          }}
          onScroll={(event) => {
            const el = event.currentTarget;
            follow.current =
              !reading.current &&
              !selectingReply.current &&
              el.scrollHeight - el.scrollTop - el.clientHeight < 2;
            setShowLatest(!follow.current);
          }}
        >
          <div ref={transcript} className="chat-transcript">
            {!messages.length ? (
              <div className="chat-welcome">
                {[
                  'Design a 12 V to 5 V, 1 A buck converter',
                  'Build a bridge rectifier with a smoothing capacitor',
                  'Design an RC filter to smooth a 20 kHz PWM signal',
                ].map((s) => (
                  <button
                    key={s}
                    className="suggestion"
                    onClick={() => {
                      if (input === s) {
                        focusDraftEnd();
                        return;
                      }
                      restoreDraftFocus.current = 'draft';
                      setInput(s);
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229)
                        event.preventDefault();
                    }}
                  >
                    <span>{s}</span>
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            ) : (
              messages.map((m, index) => (
                <article
                  key={m.id}
                  data-message-id={m.id}
                  className={`message ${m.role} ${m.error ? 'error' : ''}`}
                  tabIndex={-1}
                  data-latest-response={
                    (m.role === 'assistant' && m.id === latestAssistantId) || undefined
                  }
                >
                  {m.role === 'assistant' && (
                    <AgentTurn
                      visible={presentationActive}
                      heading={
                        <>
                          <span className="tiny-agent">
                            <AgentLogo provider={m.provider || provider} size={14} />
                          </span>
                          <span className="message-agent-name">
                            {agentName(m.provider || provider)}
                          </span>
                        </>
                      }
                      startedAt={m.id === activeId ? startedAt : undefined}
                      text={
                        (m.id === activeId ? streamedText : m.text) ||
                        (!busy && !m.errorText ? 'No response content.' : '')
                      }
                      anchors={activityAnchors.filter((item) => item.messageId === m.id)}
                      progress={processEntries.filter((item) => item.messageId === m.id)}
                      tools={toolCalls.filter((item) => item.messageId === m.id)}
                      running={m.id === activeId}
                      timings={m.id !== activeId ? m.timings : undefined}
                      outcome={m.outcome}
                      renderText={(text) => (
                        <AgentResponse text={text} active={presentationActive} />
                      )}
                      onNavigateHeading={navigateAnswerHeading}
                      renderTool={(item) => {
                        const review = commandReviews.find(
                          (entry) => entry.messageId === m.id && entry.command.id === item.id,
                        );
                        return (
                          <AgentToolCall
                            key={item.id}
                            activity={item}
                            reviewCommand={review?.command}
                            reviewDescription={review?.description}
                            onRetireFocus={
                              review?.status === 'pending' || review?.status === 'applying'
                                ? retainReviewFocus
                                : undefined
                            }
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
                      }}
                    />
                  )}
                  {questions
                    .filter((question) => question.messageId === m.id)
                    .map((question) => (
                      <AgentQuestions
                        key={question.requestId}
                        requestId={question.requestId}
                        questions={question.questions}
                        disabled={m.id !== activeId || question.closed === true}
                        onAnswer={async (answers) => {
                          const request = questionRequests.current.get(question.requestId);
                          if (
                            !request ||
                            controller.current?.signal.aborted ||
                            answering.current.has(request.requestId)
                          )
                            throw new Error('This Agent question is no longer active.');
                          answering.current.add(request.requestId);
                          const showDelivery = (delivery: 'pending' | 'sending' | 'sent') =>
                            setQuestions((items) =>
                              items.map((item) =>
                                item.requestId === request.requestId ? { ...item, delivery } : item,
                              ),
                            );
                          showDelivery('sending');
                          try {
                            await api('chat/answer', {
                              method: 'POST',
                              body: JSON.stringify({
                                runId: request.runId,
                                sessionId: request.sessionId,
                                requestId: request.requestId,
                                token: request.token,
                                answers,
                              }),
                              signal: controller.current?.signal,
                            });
                            questionRequests.current.delete(request.requestId);
                            showDelivery('sent');
                          } catch (error) {
                            showDelivery('pending');
                            throw error;
                          } finally {
                            answering.current.delete(request.requestId);
                          }
                        }}
                      />
                    ))}
                  {m.role === 'user' && m.text && (
                    <AgentUserMessage text={m.text} active={presentationActive} />
                  )}
                  {!!m.annotations?.length && <AnnotationAttachments annotations={m.annotations} />}
                  {m.errorText && (
                    <AgentDiagnostic label="Response diagnostic" text={m.errorText} />
                  )}
                  {m.role === 'assistant' && !m.error && m.id !== activeId && proposal(m)}
                  <AgentMessageActions
                    text={m.id === activeId ? streamedText : m.text}
                    role={m.role}
                    streaming={m.id === activeId}
                    reuseMessageId={
                      m.id !== activeId ? reusablePromptId(m, messages[index - 1]) : undefined
                    }
                    onReuse={reuseMessage}
                    reuseDisabled={!canReuseMessage}
                  />
                </article>
              ))
            )}
            {activeId && (
              <ChatProgress
                questionState={
                  pendingQuestions.length
                    ? 'waiting'
                    : activeQuestions.some((item) => item.delivery === 'sending')
                      ? 'sending'
                      : undefined
                }
                status={
                  toolCalls.some((item) => item.messageId === activeId && item.status === 'running')
                    ? 'Using OpenPE tools…'
                    : status || 'Connecting…'
                }
              />
            )}
          </div>
          {(pendingReviews.length > 0 || pendingQuestions.length > 0 || hasPromptRecovery) && (
            <div ref={attentionClearance} className="chat-attention-clearance" aria-hidden="true" />
          )}
          <div className="chat-scroll-controls">
            {showLatest && (
              <button
                className="chat-jump-latest"
                data-selection-occluded={latestPlacement === 'occluded' || undefined}
                style={
                  typeof latestPlacement === 'number' && latestPlacement
                    ? { bottom: latestPlacement }
                    : undefined
                }
                ref={retainLatestControl}
                onClick={() => {
                  if (!presentationActive || draftComposing.current) return;
                  composerInput.current?.focus({ preventScroll: true });
                  selectingReply.current = false;
                  reading.current = false;
                  follow.current = true;
                  setShowLatest(false);
                  if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229)
                    event.preventDefault();
                }}
              >
                <ArrowDown size={14} aria-hidden="true" />
                Latest messages
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="composer-area">
        <AgentAttentionNavigation
          kind="question"
          count={pendingQuestions.reduce((count, request) => count + request.questions.length, 0)}
          active={presentationActive}
          onNavigate={navigateQuestion}
          onFocusInput={focusAttentionComposer}
        />
        <AgentAttentionNavigation
          kind="review"
          count={pendingReviews.length}
          active={presentationActive}
          onNavigate={navigateReview}
          onFocusInput={focusAttentionComposer}
        />
        {sendError && (
          <p className="dialog-error" role="alert">
            {sendError}
          </p>
        )}
        <AgentComposer
          inputRef={composerInput}
          expandableDraft={presentationActive}
          onAgentSettings={onSettings}
          agentAvailabilityKnown={agents.length > 0}
          attachments={
            <>
              <AgentMessageQueue
                active={presentationActive}
                items={queued.map((item) => ({ ...item, sameAgent: sameAgent(item) }))}
                paused={queuePaused}
                busy={busy}
                canSteer={Boolean(inputTarget) && !controller.current?.signal.aborted}
                submitting={steering}
                canEdit={!input.length && !annotations.length}
                onResume={() => pauseQueue(false)}
                onSteer={(id) => {
                  const item = queue.current.find((entry) => entry.id === id);
                  if (item && !item.annotations.length) void steerMessage(item.text, item.id);
                }}
                onRemove={(id) => updateQueue(queue.current.filter((item) => item.id !== id))}
                onFocusInput={() => {
                  if (presentationActive) composerInput.current?.focus({ preventScroll: true });
                }}
                onFirst={(id) => {
                  const item = queue.current.find((entry) => entry.id === id);
                  if (item)
                    updateQueue([item, ...queue.current.filter((entry) => entry.id !== id)]);
                }}
                onEdit={(id) => {
                  const item = queue.current.find((entry) => entry.id === id);
                  if (!presentationActive || !item || input.length || annotations.length) return;
                  restoreDraftFocus.current = 'draft';
                  setInput(item.text);
                  setAnnotations(item.annotations);
                  updateQueue(queue.current.filter((entry) => entry.id !== id));
                }}
              />
              {annotations.length > 0 ? (
                <AnnotationAttachments
                  annotations={annotations}
                  layoutBasis={layoutContext?.basis}
                  onChange={setAnnotations}
                  onFocusInput={() => {
                    if (presentationActive) composerInput.current?.focus({ preventScroll: true });
                  }}
                  basis={currentBasis}
                />
              ) : undefined}
            </>
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
          setInput={(value) => {
            recalledDraft.current = null;
            setInput(value);
          }}
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
          followUpMode={followUpMode}
          allowFollowUp
          canSteer={Boolean(inputTarget) && !controller.current?.signal.aborted}
          submitting={steering || !agentSettings.ready}
          maxLength={maxDraftLength}
          onRecall={
            browsingHistory ||
            (canReuseMessage &&
              messages.some(
                (message) =>
                  message.role === 'user' && (message.text || message.annotations?.length),
              ))
              ? stepDraftHistory
              : undefined
          }
          onSubmit={(resolvedEffort, parameters) => void submit(resolvedEffort, parameters)}
          onStop={stopGeneration}
        />
      </div>
    </aside>
  );
}
