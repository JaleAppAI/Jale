import { responseFieldNames, type AccessEvent } from './record';

/** The parts of a conversation detail document (lib/job-messaging) a record names. */
export interface ConversationDetailShape {
  conversation: { id: string; job_id: string; worker_id: string };
  messages: readonly object[];
}

type ConversationSurface =
  | 'employer.conversation_detail'
  | 'employer.conversation_create'
  | 'employer.conversation_send'
  | 'employer.conversation_update';

/**
 * The access event for a response that carries one thread: the worker, the
 * conversation, how many messages it returns, and the job it belongs to. The
 * field names are the conversation's and the messages', never their text.
 */
export function conversationReadEvent(surface: ConversationSurface, detail: ConversationDetailShape): AccessEvent {
  return {
    surface,
    subjectUserIds: [detail.conversation.worker_id],
    recordIds: [detail.conversation.id],
    resultCount: detail.messages.length,
    fieldNames: responseFieldNames(detail.conversation, detail.messages),
    purpose: { kind: 'job', id: detail.conversation.job_id },
  };
}
