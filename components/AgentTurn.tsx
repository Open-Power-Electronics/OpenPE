'use client';
import { type ReactNode, useRef } from 'react';
import type { AgentProcessEntry } from '@/lib/agent-process';
import type { AgentToolActivity } from '@/lib/agent-tool-activity';
import type { ChatOutcome, ChatTimings } from '@/lib/chat-stream';
import AgentProcess from './AgentProcess';
import AgentAnswerOutline from './AgentAnswerOutline';
import { summarizeToolIssues } from './AgentToolIssues';
import AgentToolList from './AgentToolList';
import { agentTurnSections, agentTurnTimeline, type ActivityAnchor } from './agent-turn-timeline';

export default function AgentTurn({
  text,
  anchors,
  progress,
  tools,
  running,
  visible = true,
  heading,
  startedAt,
  timings,
  outcome,
  renderText,
  renderTool,
  onNavigateHeading,
}: {
  text: string;
  anchors: ActivityAnchor[];
  progress: AgentProcessEntry[];
  tools: AgentToolActivity[];
  running: boolean;
  visible?: boolean;
  heading: ReactNode;
  startedAt?: number;
  timings?: ChatTimings;
  outcome?: ChatOutcome;
  renderText: (text: string) => ReactNode;
  renderTool: (tool: AgentToolActivity) => ReactNode;
  onNavigateHeading: (heading: HTMLElement) => void;
}) {
  const answerRef = useRef<HTMLDivElement>(null);
  const { work, answer, reviews } = agentTurnSections(
    agentTurnTimeline(text, anchors, progress, tools),
  );
  const latestTools = work.findLast((part) => part.kind === 'tools');
  const latestCallId = latestTools?.kind === 'tools' ? latestTools.entries.at(-1)?.id : undefined;
  return (
    <>
      <AgentProcess
        running={running}
        visible={visible}
        timings={timings}
        outcome={outcome}
        heading={heading}
        startedAt={startedAt}
        hasWork={work.length > 0}
        issues={
          running
            ? undefined
            : summarizeToolIssues(
                work.flatMap((part) => (part.kind === 'tools' ? part.entries : [])),
              )
        }
      >
        {work.map((part) =>
          part.kind === 'tools' ? (
            <AgentToolList
              key={part.key}
              latestCallId={latestCallId}
              running={part.entries.some((entry) => entry.status === 'running')}
              issues={summarizeToolIssues(part.entries)}
            >
              {part.entries.map(renderTool)}
            </AgentToolList>
          ) : (
            <div
              className="agent-process-text"
              key={part.key}
              role={running ? undefined : 'region'}
              aria-label={running ? undefined : 'Work note'}
              tabIndex={running ? undefined : 0}
            >
              {renderText(part.kind === 'text' ? part.text : part.entry.text)}
            </div>
          ),
        )}
      </AgentProcess>
      {answer && (
        <>
          {!running && (
            <AgentAnswerOutline
              answer={answerRef}
              active={visible}
              onNavigate={onNavigateHeading}
            />
          )}
          <div ref={answerRef} className="agent-answer-part">
            {renderText(answer.text)}
          </div>
        </>
      )}
      {reviews.map(renderTool)}
    </>
  );
}
