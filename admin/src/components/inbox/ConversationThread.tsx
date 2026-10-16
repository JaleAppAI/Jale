import type { SupportConversation } from '@/lib/server/support-conversation';
import { MessageBubble } from './MessageBubble';
import { ThreadScroller } from './ThreadScroller';
import { MUTED } from './styles';

/** The conversation, oldest first, in a scroll box that opens at the newest message. */
export function ConversationThread({ caseId, messages, workerLabel }: { caseId: string; messages: SupportConversation['messages']; workerLabel: string }) {
  return (
    <ThreadScroller count={messages.length} label="Messages, oldest first">
      {messages.length === 0 ? (
        <p className={`p-5 text-center ${MUTED}`}>No messages yet.</p>
      ) : (
        <ol className="flex flex-col gap-3 p-4 sm:p-5">
          {messages.map((message) => (
            <MessageBubble caseId={caseId} key={message.id} message={message} workerLabel={workerLabel} />
          ))}
        </ol>
      )}
    </ThreadScroller>
  );
}
