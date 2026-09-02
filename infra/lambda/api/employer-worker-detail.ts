import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as profileHandler } from './employer-worker-profile';
import { handler as documentsHandler } from './employer-worker-docs';
import { handler as postsHandler } from './employer-worker-posts';

/**
 * GET /employer/workers/{worker_id}/{action} — employer authorizer.
 *
 * One Lambda behind one API Gateway resource for what used to be three
 * literal siblings (`/profile`, `/documents`, `/posts`), each costing
 * JaleApiStack a Resource + OPTIONS + Method + Permission. See
 * `lib/path-dispatch.ts` for the budget this buys back and why the event is
 * forwarded untouched — all three delegates read `worker_id` off
 * `pathParameters`, which the `{action}` mount leaves in place.
 *
 * The three URLs are unchanged, so the frontend (`frontend/src/lib/api/
 * employer.ts`) is not touched: API Gateway prefers a literal child over a
 * variable one, and with the literals gone `/profile` simply binds
 * `{action} = 'profile'`.
 *
 * STACK PLACEMENT: this lives in MediaBoardStack, not DocumentsStack, even
 * though two of the three delegates were DocumentsStack's. The union of
 * grants spans BOTH buckets — the documents bucket (DocumentsStack) for
 * `documents`, the worker-media bucket for `posts` — and the media bucket is
 * created by WhatsAppStack, which already consumes `DocumentsStack.bucket`.
 * Giving DocumentsStack a `mediaBucket` prop would therefore close a cycle
 * (DocumentsStack -> WhatsAppStack -> DocumentsStack) and fail synthesis,
 * whereas MediaBoardStack is constructed after both and can hold all three
 * grants. Which stack calls `addResource`/`addMethod` does not affect the
 * route's CloudFormation logical id — those are derived from the URL path
 * under `RestApi.root`, which lives in ApiStack either way.
 */
export const handler: ApiHandler = dispatchOnPathParameter('action', new Map([
  ['profile', profileHandler],
  ['documents', documentsHandler],
  ['posts', postsHandler],
]));
