'use client';

import { createContext, use } from 'react';
import type { InboxActionInput, InboxActionName, InboxRunResult } from './inbox-view';

// The seam between the Inbox controls and the network. Controls (reply box,
// media, reveal, lockout reset) read it with useInboxActions().
// InboxActionsProvider supplies it through adminFetchJson; the check script
// renders the controls inside a plain value of this shape.
export type InboxActionsValue = {
  /** The action in flight on this page, or null. One at a time. */
  pending: InboxActionName | null;
  /** Sends one action. The provider gives every attempt a new requestId. */
  run: (input: InboxActionInput) => Promise<InboxRunResult>;
};

export const InboxActionsContext = createContext<InboxActionsValue | null>(null);

export function useInboxActions(): InboxActionsValue {
  const value = use(InboxActionsContext);
  if (!value) {
    throw new Error('Inbox action controls must be placed inside <InboxActionsProvider>.');
  }
  return value;
}
