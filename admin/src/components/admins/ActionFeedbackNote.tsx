import { InlineFeedback } from '@/components/ui/inline-feedback';
import type { FormFeedback } from './admin-actions';

/** An action's answer: a saved change waiting for its directory step warns; anything else failed. */
export function ActionFeedbackNote({ feedback }: { feedback?: FormFeedback }) {
  if (!feedback) return null;
  return (
    <InlineFeedback tone={feedback.retry === 'same_request' ? 'warning' : 'danger'}>
      {feedback.message}
    </InlineFeedback>
  );
}
