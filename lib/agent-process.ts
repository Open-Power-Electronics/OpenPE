export type AgentProcessEntry = { id: string; messageId: string; text: string };

// Retain bounded, provider-supplied progress independently of the final answer.
export function updateAgentProcess(
  items: AgentProcessEntry[],
  messageId: string,
  event: { id: string; text: string; append?: boolean },
): AgentProcessEntry[] {
  if (
    typeof event.id !== 'string' ||
    !event.id ||
    event.id.length > 300 ||
    typeof event.text !== 'string'
  )
    throw new Error('Invalid Agent progress event.');
  const existing = items.find((item) => item.messageId === messageId && item.id === event.id);
  const text = (event.append ? existing?.text || '' : '') + event.text;
  const limit = 128000;
  const next = {
    id: event.id,
    messageId,
    text: text.length > limit ? text.slice(0, limit) + '\n[Progress truncated]' : text,
  };
  return (
    existing ? items.map((item) => (item === existing ? next : item)) : [...items, next]
  ).slice(-128);
}
