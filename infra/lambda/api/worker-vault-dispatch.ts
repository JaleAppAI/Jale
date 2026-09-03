import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as uploadUrlAuthHandler } from './worker-doc-upload-url-auth';
import { handler as confirmAuthHandler } from './worker-doc-confirm-auth';

/**
 * POST /worker/vault/{doc_type} — worker authorizer.
 *
 * A special case of the `{action}` pattern: `/worker/vault` ALREADY had a
 * variable child, `{doc_type}`, serving `DELETE /worker/vault/{doc_type}`, and
 * API Gateway forbids two variable siblings under one parent. So instead of a
 * new `{action}` node this mounts a POST on the EXISTING `{doc_type}`
 * resource, which costs a Method + Permission and no Resource or OPTIONS at
 * all — and leaves the DELETE method, its handler and its logical id
 * completely untouched (no CloudFormation replacement of the delete route).
 *
 * The consequence is that the path parameter carrying the action is named
 * `doc_type`, and its two values (`upload-url`, `confirm`) sit in the same
 * slot a real doc type occupies on the DELETE. That is safe in both
 * directions:
 *
 *   - Neither delegate reads `pathParameters` — both take `doc_type` from the
 *     request BODY — so nothing is confused by `pathParameters.doc_type`
 *     saying `'upload-url'`. The event is forwarded unmodified.
 *   - A POST to a REAL doc type (`/worker/vault/id_card`) 404s here. It was a
 *     403 from API Gateway before, since no such route existed; either way it
 *     mints nothing. `worker-vault-dispatch.test.ts` asserts this for every
 *     member of `DOC_TYPES`, and that no doc type is ever named after an
 *     action.
 *
 * `worker-doc-delete` deliberately stays a separate Lambda: merging it would
 * hand this handler's role the bucket's `grantDelete`.
 */
export const handler: ApiHandler = dispatchOnPathParameter('doc_type', new Map([
  ['upload-url', uploadUrlAuthHandler],
  ['confirm', confirmAuthHandler],
]));
