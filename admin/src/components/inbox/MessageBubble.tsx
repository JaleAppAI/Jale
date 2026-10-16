import { LocalTime } from '@/components/LocalTime';
import type { ConversationMessage } from '@/lib/server/support-conversation';
import { MediaMessage } from './MediaMessage';
import { adminByline, deliveryText } from './inbox-view';

const BUBBLE = 'max-w-[85%] rounded-2xl px-3.5 py-2.5 sm:max-w-[78%]';
const WORDS = 'mt-1 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]';

/**
 * One message. The worker sits left, admins right, system notes centred. Who
 * wrote it is always in words (byline), not only in the side or the colour.
 */
export function MessageBubble({ caseId, message, workerLabel }: { caseId: string; message: ConversationMessage; workerLabel: string }) {
  if (message.from === 'system') {
    return (
      <li className="flex justify-center" data-from="system">
        <p className="max-w-full rounded-full border border-[var(--jale-divider)] bg-[var(--jale-card)] px-3 py-1.5 text-center text-xs text-[var(--jale-ink-2)] [overflow-wrap:anywhere]">
          {message.text} · <LocalTime iso={message.at} />
        </p>
      </li>
    );
  }
  if (message.from === 'admin') {
    return (
      <li className="flex justify-end" data-from="admin">
        <div className={`${BUBBLE} rounded-br-sm bg-[var(--jale-blue-500)] text-white`}>
          <p className="text-xs font-bold">{adminByline(message.byRole)}</p>
          <p className={WORDS}>{message.text}</p>
          <p className="mt-1.5 text-right text-xs"><LocalTime iso={message.at} /> · {deliveryText(message)}</p>
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start" data-from="worker">
      <div className={`${BUBBLE} rounded-bl-sm border border-[var(--jale-divider)] bg-[var(--jale-card)] text-[var(--jale-ink)]`}>
        <p className="text-xs font-bold text-[var(--jale-ink-2)]">{workerLabel}</p>
        {message.kind === 'media' ? <MediaMessage caseId={caseId} message={message} /> : <p className={WORDS}>{message.text}</p>}
        <p className="mt-1.5 text-right text-xs text-[var(--jale-ink-2)]"><LocalTime iso={message.at} /></p>
      </div>
    </li>
  );
}
