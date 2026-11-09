import { CircleAlert } from 'lucide-react';
import type { AgentToolActivity } from '@/lib/agent-tool-activity';

export function summarizeToolIssues(entries: readonly AgentToolActivity[]) {
  let failed = 0;
  let undelivered = 0;
  for (const entry of entries) {
    if (entry.status === 'failed') failed++;
    if (entry.deliveryError) undelivered++;
  }
  if (!failed && !undelivered) return undefined;
  const labels = [];
  if (failed) labels.push(`${failed} ${failed === 1 ? 'tool failed' : 'tools failed'}`);
  if (undelivered)
    labels.push(`${undelivered} result delivery ${undelivered === 1 ? 'error' : 'errors'}`);
  return { count: failed + undelivered, label: labels.join(', ') };
}

export type ToolIssues = NonNullable<ReturnType<typeof summarizeToolIssues>>;

export function revealNewestToolIssue(container: HTMLElement, selector: string) {
  const target = Array.from(container.querySelectorAll(selector)).at(-1);
  if (!target) return false;
  container.scrollTop +=
    target.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    container.clientTop;
  return true;
}

export default function AgentToolIssues({ issues, id }: { issues: ToolIssues; id?: string }) {
  return (
    <span
      className="agent-tool-issues"
      id={id}
      role="img"
      aria-label={issues.label}
      title={issues.label}
    >
      <CircleAlert size={13} aria-hidden="true" />
      <span aria-hidden="true">{issues.count}</span>
    </span>
  );
}
