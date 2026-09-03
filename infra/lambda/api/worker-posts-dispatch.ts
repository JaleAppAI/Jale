import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as uploadUrlsHandler } from './worker-post-upload-urls';

/**
 * POST /worker/posts/{post_id} — worker authorizer.
 *
 * `POST /worker/posts/upload-urls` folded onto the EXISTING `{post_id}`
 * resource, which already serves `DELETE /worker/posts/{post_id}`. Same
 * shape as `worker-vault-dispatch.ts`: `/worker/posts` cannot hold a second
 * variable child, so the literal `upload-urls` node (Resource + OPTIONS +
 * Method + Permission) becomes a POST method on `{post_id}` (Method +
 * Permission), and the DELETE keeps its own method, its own Lambda and its
 * own logical id.
 *
 * Only the POST is dispatched — there is exactly one action today, so the map
 * has one entry and its real job is the 404: a POST to an actual post id
 * (`/worker/posts/<uuid>`) must not mint upload URLs for it. That request was
 * a 403 from API Gateway before this consolidation and is a 404 now.
 *
 * NOT MERGED: `GET`/`POST /worker/posts` (list and create) could have become
 * a single `ANY` method for two more resources, but `ANY` also swallows
 * `PUT`/`PATCH`/`DELETE /worker/posts`, which API Gateway rejects cleanly
 * today. Two resources is not worth widening the method surface.
 */
export const handler: ApiHandler = dispatchOnPathParameter('post_id', new Map([
  ['upload-urls', uploadUrlsHandler],
]));
