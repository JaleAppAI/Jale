import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from './http';

/** The shape every `lambda/api/*.ts` module exports as `handler`. */
export type ApiHandler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

/**
 * Builds a Lambda handler that routes ONE API Gateway resource's requests to
 * one of several existing handlers, picked by a path parameter.
 *
 * WHY THIS EXISTS: CloudFormation refuses more than 500 resources in a stack,
 * and every Lambda-backed route on the shared RestApi costs `JaleApiStack`
 * four of them when it needs a new Resource — the Resource, its CORS OPTIONS,
 * the Method and the invoke Permission (see `lib/api-integration.ts` for the
 * other two levers on the same budget). Four throttle-free sibling groups were
 * spending 4 resources each on paths that differ only in their last segment:
 *
 *   /employer/workers/{worker_id}/{profile,documents,posts}
 *   /worker/documents/{upload-url,confirm,submit}
 *   /worker/vault/{upload-url,confirm}
 *   /worker/posts/upload-urls
 *
 * Collapsing each group onto ONE variable resource (`{action}`, or the
 * `{doc_type}`/`{post_id}` node that group already had) costs one Resource
 * instead of N and moves the last-segment decision from API Gateway into this
 * function. Deployed URLs are byte-identical: API Gateway matches a literal
 * child before a variable one, so with no literal siblings left,
 * `/worker/documents/confirm` binds `{action} = 'confirm'` and lands here.
 *
 * WHAT IT DOES NOT DO: it never touches the event. The delegates read their
 * own inputs off it — `worker_id` from `pathParameters`, tokens and doc types
 * from the body — so the event is forwarded by reference, unmodified, and the
 * delegate's response is returned verbatim. A rejection propagates: the
 * dispatcher must not turn a delegate's crash into a 404.
 *
 * WHY A `Map`, NOT AN OBJECT LITERAL: the key comes from the URL, i.e. from
 * the caller. `routes['__proto__']` on an object literal resolves to
 * `Object.prototype` and `routes['constructor']` to a function — either would
 * be "found" and then invoked. `Map.get` has no prototype chain to walk.
 *
 * THE COST: the merged Lambdas become one Lambda, so its IAM role holds the
 * UNION of their grants and its bundle the union of their imports. Keep a
 * route out of a dispatcher when that union would widen permissions in a way
 * that matters — `worker-doc-delete` deliberately stays on its own Lambda so
 * `grantDelete` is not handed to the upload/confirm path.
 */
export function dispatchOnPathParameter(
  parameterName: string,
  routes: ReadonlyMap<string, ApiHandler>,
): ApiHandler {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const action = event.pathParameters?.[parameterName];
    const delegate = typeof action === 'string' ? routes.get(action) : undefined;

    if (!delegate) {
      // Same shape as every other 404 in `lambda/api/` — and it carries CORS
      // headers, because API Gateway's OPTIONS preflight only covers the
      // preflight: a Lambda proxy response that omits them is unreadable to
      // the browser (see `lib/http.ts`).
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'not_found' }),
      };
    }

    return delegate(event);
  };
}
