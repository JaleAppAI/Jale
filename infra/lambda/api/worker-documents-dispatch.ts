import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as uploadUrlHandler } from './worker-doc-upload-url';
import { handler as confirmHandler } from './worker-doc-confirm';
import { handler as submitHandler } from './worker-doc-submit';

/**
 * POST /worker/documents/{action} — NO authorizer.
 *
 * The unauthenticated, tokenized document flow: an employer-shared link or a
 * pre-account WhatsApp onboarding carries an upload token in the request
 * BODY, which is what each delegate validates. Nothing here reads or needs an
 * identity, and the 404 for an unknown action is reachable without one — by
 * design, since it replaces API Gateway's own 403 "Missing Authentication
 * Token" for a path that no longer exists as a literal resource.
 *
 * Three literal siblings (`/upload-url`, `/confirm`, `/submit`) collapsed to
 * one `{action}` resource; the three URLs are byte-identical to before.
 * `lib/path-dispatch.ts` has the reasoning and the resource arithmetic.
 */
export const handler: ApiHandler = dispatchOnPathParameter('action', new Map([
  ['upload-url', uploadUrlHandler],
  ['confirm', confirmHandler],
  ['submit', submitHandler],
]));
