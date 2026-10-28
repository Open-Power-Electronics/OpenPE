import { memo, useCallback, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import type { ChatSession } from '@/lib/chat-sessions';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import Chat, { type ChatDesign } from './Chat';

type ChatProps = ComponentProps<typeof Chat>;
type Props = Omit<
  ChatProps,
  | 'doc'
  | 'pcb'
  | 'pcbSchematic'
  | 'sessionId'
  | 'input'
  | 'annotations'
  | 'messages'
  | 'setInput'
  | 'setAnnotations'
  | 'setMessages'
  | 'onClear'
  | 'getDesign'
> & {
  session: ChatSession;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  onClearSession: (id: string) => void;
  getDesign: () => ChatDesign;
  annotationDesign?: ChatDesign;
};
const emptyAnnotations: AgentAnnotation[] = [];

/** Session changes render the conversation; unrelated document edits stay local. */
export default memo(function ConversationSession({
  session,
  setSessions,
  onClearSession,
  getDesign,
  annotationDesign,
  ...props
}: Props) {
  const id = session.id;
  const setInput = useCallback(
    (draft: string) =>
      setSessions((items) => items.map((item) => (item.id === id ? { ...item, draft } : item))),
    [id, setSessions],
  );
  const setAnnotations = useCallback(
    (annotations: AgentAnnotation[]) =>
      setSessions((items) =>
        items.map((item) => (item.id === id ? { ...item, annotations } : item)),
      ),
    [id, setSessions],
  );
  const setMessages = useCallback<ChatProps['setMessages']>(
    (update) =>
      setSessions((items) =>
        items.map((item) =>
          item.id === id
            ? { ...item, messages: typeof update === 'function' ? update(item.messages) : update }
            : item,
        ),
      ),
    [id, setSessions],
  );
  const onClear = useCallback(() => onClearSession(id), [id, onClearSession]);
  const design = annotationDesign ?? getDesign();
  return (
    <Chat
      {...props}
      {...design}
      getDesign={getDesign}
      sessionId={id}
      input={session.draft}
      annotations={session.annotations ?? emptyAnnotations}
      messages={session.messages}
      setInput={setInput}
      setAnnotations={setAnnotations}
      setMessages={setMessages}
      onClear={onClear}
    />
  );
});
