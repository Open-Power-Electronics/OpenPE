import { responseText } from '@/lib/chat-stream';
import type { AgentProcessEntry } from '@/lib/agent-process';
import type { AgentToolActivity } from '@/lib/agent-tool-activity';

export type ActivityAnchor = {
  messageId: string;
  kind: 'process' | 'tool';
  id: string;
  offset: number;
};
type TurnPart =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'process'; key: string; entry: AgentProcessEntry }
  | { kind: 'tools'; key: string; entries: AgentToolActivity[] };

/** Keep the latest reply and unresolved reviews outside collapsible work. */
export function agentTurnSections(parts: TurnPart[]) {
  const last = parts.at(-1);
  const answer = last?.kind === 'text' ? last : undefined;
  const reviews: AgentToolActivity[] = [];
  const work = (answer ? parts.slice(0, -1) : parts).flatMap((part): TurnPart[] => {
    if (part.kind !== 'tools') return [part];
    const entries = part.entries.filter((entry) => {
      if (entry.status !== 'review' && entry.status !== 'applying') return true;
      reviews.push(entry);
      return false;
    });
    return entries.length ? [{ ...part, entries }] : [];
  });
  return { work, answer, reviews };
}

/** Sanitize the complete reply before splitting it around transient activity. */
export function agentTurnTimeline(
  text: string,
  anchors: ActivityAnchor[],
  progress: AgentProcessEntry[],
  tools: AgentToolActivity[],
): TurnPart[] {
  const visible = responseText(text);
  const parts: TurnPart[] = [];
  const processById = new Map(progress.map((entry) => [entry.id, entry]));
  const toolsById = new Map(tools.map((entry) => [entry.id, entry]));
  let cursor = 0;
  for (const anchor of anchors) {
    const entry = anchor.kind === 'process' ? processById.get(anchor.id) : toolsById.get(anchor.id);
    if (!entry) continue;
    const end = Math.max(cursor, Math.min(visible.length, anchor.offset));
    if (visible.slice(cursor, end).trim())
      parts.push({ kind: 'text', key: `text-${cursor}`, text: visible.slice(cursor, end) });
    cursor = end;
    if (anchor.kind === 'process') {
      parts.push({
        kind: 'process',
        key: `process-${anchor.id}`,
        entry: processById.get(anchor.id)!,
      });
    } else {
      const previous = parts.at(-1);
      const tool = toolsById.get(anchor.id)!;
      if (previous?.kind === 'tools') previous.entries.push(tool);
      else parts.push({ kind: 'tools', key: `tool-${anchor.id}`, entries: [tool] });
    }
  }
  if (visible.slice(cursor).trim())
    parts.push({ kind: 'text', key: `text-${cursor}`, text: visible.slice(cursor) });
  return parts;
}
