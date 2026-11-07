'use client';
import { type ReactNode } from 'react';
import type { AgentProcessEntry } from '@/lib/agent-process';
import type { AgentToolActivity } from '@/lib/agent-tool-activity';
import AgentProcess from './AgentProcess';
import AgentToolList from './AgentToolList';
import { agentTurnTimeline, type ActivityAnchor, type TurnPart } from './agent-turn-timeline';

export default function AgentTurn({
  text,
  anchors,
  progress,
  tools,
  running,
  renderText,
  renderTool,
}: {
  text: string;
  anchors: ActivityAnchor[];
  progress: AgentProcessEntry[];
  tools: AgentToolActivity[];
  running: boolean;
  renderText: (text: string) => ReactNode;
  renderTool: (tool: AgentToolActivity) => ReactNode;
}) {
  const groups: { key: string; parts: TurnPart[] }[] = [];
  for (const part of agentTurnTimeline(text, anchors, progress, tools)) {
    const previous = groups.at(-1);
    if (part.kind !== 'text' && previous && previous.parts[0].kind !== 'text')
      previous.parts.push(part);
    else groups.push({ key: part.key, parts: [part] });
  }
  return groups.map((group) => {
    const first = group.parts[0];
    if (first.kind === 'text')
      return (
        <div key={group.key} className="agent-answer-part">
          {renderText(first.text)}
        </div>
      );
    return (
      <AgentProcess
        key={group.key}
        running={running}
        attention={group.parts.some(
          (part) =>
            part.kind === 'tools' &&
            part.entries.some((entry) => ['review', 'applying', 'failed'].includes(entry.status)),
        )}
      >
        {group.parts.map((part) =>
          part.kind === 'process' ? (
            <div className="agent-process-text" key={part.key}>
              {renderText(part.entry.text)}
            </div>
          ) : part.kind === 'tools' ? (
            <AgentToolList key={part.key}>{part.entries.map(renderTool)}</AgentToolList>
          ) : null,
        )}
      </AgentProcess>
    );
  });
}
