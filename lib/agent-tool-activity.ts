import type { AgentCapabilityRequest } from './chat-stream';

export type ToolStatus =
  'running' | 'completed' | 'review' | 'applying' | 'applied' | 'rejected' | 'failed' | 'cancelled';
export type ToolPreview = { text: string; truncated: boolean };
export type AgentToolActivity = {
  id: string;
  messageId: string;
  tool: AgentCapabilityRequest['tool'];
  name: string;
  status: ToolStatus;
  arguments: ToolPreview;
  result?: ToolPreview;
  error?: string;
  deliveryError?: string;
};

/** Presentation only: never retain a full tool envelope, token or result object. */
export function toolPreview(value: unknown): ToolPreview {
  let nodes = 0;
  let truncated = false;
  const trim = (text: string, limit: number) => {
    if (text.length <= limit) return text;
    truncated = true;
    return text.slice(0, limit - 1) + '…';
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 200 || depth > 6) {
      truncated = true;
      return '…';
    }
    if (typeof item === 'string') return trim(item, 2000);
    if (!item || typeof item !== 'object') return item;
    if (Array.isArray(item)) {
      const items = [];
      for (const child of item) {
        if (items.length >= 40 || nodes >= 200) {
          truncated = true;
          break;
        }
        items.push(visit(child, depth + 1));
      }
      return items;
    }
    const entries: [string, unknown][] = [];
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (entries.length >= 40 || nodes >= 200) {
        truncated = true;
        break;
      }
      entries.push([trim(key, 200), visit((item as Record<string, unknown>)[key], depth + 1)]);
    }
    return Object.fromEntries(entries);
  };
  try {
    const text = trim(JSON.stringify(visit(value, 0), null, 2) ?? 'null', 6000);
    return { text, truncated };
  } catch {
    return { text: 'Preview unavailable.', truncated: true };
  }
}

export function toolResultStatus(result: unknown): ToolStatus {
  const status = result && typeof result === 'object' && 'status' in result ? result.status : '';
  if (status === 'review-required') return 'review';
  if (status === 'cancelled') return 'cancelled';
  return 'completed';
}

export function appendToolActivity(items: AgentToolActivity[], item: AgentToolActivity) {
  const next = [...items, item];
  // Keep pending reviews and in-flight calls visible; the bridge bounds both.
  while (next.length > 256) {
    const index = next.findIndex(
      (entry) => !['running', 'review', 'applying'].includes(entry.status),
    );
    if (index < 0) break;
    next.splice(index, 1);
  }
  return next;
}
