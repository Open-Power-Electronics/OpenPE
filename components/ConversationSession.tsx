import { memo, useCallback, type ComponentProps, type Dispatch, type SetStateAction } from 'react';
import { applySuggestedSessionTitle, sessionTitle, type ChatSession } from '@/lib/chat-sessions';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import Chat, { type ChatDesign } from './Chat';

type ChatProps = ComponentProps<typeof Chat>;
type Props = Omit<
  ChatProps,
  | 'doc'
  | 'pcb'
  | 'pcbSchematic'
  | 'sessionId'
  | 'conversationTitle'
  | 'input'
  | 'annotations'
  | 'messages'
  | 'setInput'
  | 'setAnnotations'
  | 'setMessages'
  | 'getDesign'
  | 'onSuggestedTitle'
  | 'requestTitle'
> & {
  session: ChatSession;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  getDesign: () => ChatDesign;
  annotationDesign?: ChatDesign;
};
const emptyAnnotations: AgentAnnotation[] = [];

/** Session changes render the conversation; unrelated document edits stay local. */
export default memo(function ConversationSession({
  session,
  setSessions,
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
  const design = annotationDesign ?? getDesign();
  const onSuggestedTitle = useCallback(
    (title: string, messageId: string) => {
      setSessions((items) => applySuggestedSessionTitle(items, id, messageId, title));
    },
    [id, setSessions],
  );
  return (
    <Chat
      {...props}
      {...design}
      getDesign={getDesign}
      sessionId={id}
      conversationTitle={sessionTitle(session)}
      requestTitle={session.name === undefined}
      onSuggestedTitle={onSuggestedTitle}
      input={session.draft}
      annotations={session.annotations ?? emptyAnnotations}
      messages={session.messages}
      setInput={setInput}
      setAnnotations={setAnnotations}
      setMessages={setMessages}
    />
  );
});
