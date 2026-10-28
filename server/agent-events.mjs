// One decoder per run: final snapshots reconcile streamed text without duplication.
export function createEventNormalizer(provider) {
  if (!['codex', 'claude', 'pi'].includes(provider))
    throw new Error('Unknown agent event protocol.');
  const messages = new Map();
  const blocks = new Map();
  let text = '',
    claudeId = 'assistant',
    piId = 'assistant',
    piSequence = 0;
  const update = (id, value, append = false) => {
    messages.set(id, append ? (messages.get(id) || '') + value : value);
    const next = [...messages.values()].filter(Boolean).join('\n\n');
    if (next === text) return [];
    const event = next.startsWith(text)
      ? { type: 'text-delta', delta: next.slice(text.length) }
      : { type: 'text-replace', text: next };
    text = next;
    if (text.length > 2_000_000) throw new Error('Agent response exceeds the 2 MB limit.');
    return [event];
  };
  const status = (stage, text) => [{ type: 'status', stage, text }];
  return (event) => {
    if (provider === 'codex') {
      const p = event.params || {};
      if (event.method === 'item/agentMessage/delta' && typeof p.delta === 'string')
        return update(p.itemId, p.delta, true);
      if (event.method === 'item/completed' && p.item?.type === 'agentMessage')
        return update(p.item.id, p.item.text || '');
      if (event.method === 'turn/started') return status('waiting', 'Waiting for the model…');
      if (
        event.method?.startsWith('item/reasoning/') ||
        (event.method === 'item/started' && p.item?.type === 'reasoning')
      )
        return status('thinking', 'Model is reasoning…');
      if (event.method === 'error') {
        const text = p.error?.message || 'Codex run failed.';
        return p.willRetry ? status('retrying', `Retrying: ${text}`) : [{ type: 'error', text }];
      }
      if (event.method === 'turn/completed') {
        const outcome = p.turn?.status;
        return outcome === 'completed'
          ? [{ type: 'complete' }]
          : [
              {
                type: 'error',
                text:
                  p.turn?.error?.message ||
                  (outcome === 'interrupted'
                    ? 'The agent interrupted this response.'
                    : 'Codex run failed.'),
              },
            ];
      }
    } else if (provider === 'pi') {
      if (event.type === 'agent_start' || event.type === 'turn_start')
        return status('waiting', 'Waiting for the model…');
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        piId = `assistant-${++piSequence}`;
        blocks.set(piId, new Map());
      }
      if (event.type === 'message_update') {
        const item = event.assistantMessageEvent || {};
        if (item.type === 'thinking_delta' || item.type === 'thinking_start')
          return status('thinking', 'Model is reasoning…');
        if (item.type === 'error')
          return [
            {
              type: 'error',
              text: item.error?.errorMessage || item.error?.message || 'Pi model response failed.',
            },
          ];
        if (
          (item.type === 'text_delta' && typeof item.delta === 'string') ||
          (item.type === 'text_end' && typeof item.content === 'string')
        ) {
          const parts = blocks.get(piId) || new Map();
          parts.set(
            item.contentIndex,
            item.type === 'text_end'
              ? item.content
              : (parts.get(item.contentIndex) || '') + item.delta,
          );
          blocks.set(piId, parts);
          return update(
            piId,
            [...parts.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, value]) => value)
              .join('\n'),
          );
        }
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const message = event.message;
        if (message.stopReason === 'error' || message.stopReason === 'aborted')
          return [{ type: 'error', text: message.errorMessage || 'Pi model response failed.' }];
        if (Array.isArray(message.content))
          return update(
            piId,
            message.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text || '')
              .join('\n'),
          );
      }
      if (event.type === 'auto_retry_start')
        return status('retrying', 'Retrying the Pi model request…');
      if (event.type === 'auto_retry_end' && event.success === false)
        return [{ type: 'error', text: event.finalError || 'Pi model response failed.' }];
      if (event.type === 'agent_settled')
        return event.aborted
          ? [{ type: 'error', text: 'Pi interrupted this response.' }]
          : [{ type: 'complete' }];
    } else {
      // Subagent events are not part of the displayed main response.
      if (event.parent_tool_use_id) return [];
      if (event.type === 'system' && event.subtype === 'init')
        return status('waiting', 'Waiting for the model…');
      if (event.type === 'stream_event') {
        const e = event.event || {};
        if (e.type === 'message_start') {
          claudeId = e.message?.id || `assistant-${messages.size}`;
          blocks.set(claudeId, new Map());
          return status('waiting', 'Model response started…');
        }
        if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta')
          return status('thinking', 'Model is reasoning…');
        const initial = e.type === 'content_block_start' && e.content_block?.type === 'text';
        if (initial || (e.type === 'content_block_delta' && e.delta?.type === 'text_delta')) {
          const parts = blocks.get(claudeId) || new Map();
          const value = initial ? e.content_block.text : e.delta.text;
          parts.set(e.index, (initial ? '' : parts.get(e.index) || '') + (value || ''));
          blocks.set(claudeId, parts);
          return update(
            claudeId,
            [...parts.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, t]) => t)
              .join('\n'),
          );
        }
      }
      if (event.type === 'assistant') {
        const value = event.message?.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (typeof value === 'string') return update(event.message.id || claudeId, value);
      }
      if (event.type === 'result') {
        if (event.is_error || (event.subtype && event.subtype !== 'success'))
          return [
            {
              type: 'error',
              text: event.result || event.errors?.join('\n') || 'Claude Code run failed.',
            },
          ];
        const final = !text && event.result ? update(claudeId, event.result) : [];
        return [...final, { type: 'complete' }];
      }
    }
    return [];
  };
}
