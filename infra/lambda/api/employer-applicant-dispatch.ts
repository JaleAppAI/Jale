import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as statusUpdateHandler } from './employer-application-status-update';
import { handler as hireDetailsHandler } from './employer-application-hire-details';

/**
 * The applicant routes on one Lambda (`EmployerApplicationStatusUpdateLambda`):
 *
 *   PATCH /employer/jobs/{jobId}/applicants/{workerId}                 status change
 *   PUT   /employer/jobs/{jobId}/applicants/{workerId}/hire-details    F19 start details
 *
 * The bare `{workerId}` resource carries no `action` parameter, so a request
 * without one is the status change, forwarded unchanged. The `{action}` child
 * routes through `dispatchOnPathParameter` (see `lib/path-dispatch.ts`), so
 * an unknown action is a 404 and a new one costs no new Lambda. Both
 * delegates run on the same login and env, so merging them widens nothing.
 */
const byAction: ApiHandler = dispatchOnPathParameter('action', new Map([
  ['hire-details', hireDetailsHandler],
]));

export const handler: ApiHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => (
  event.pathParameters?.action === undefined ? statusUpdateHandler(event) : byAction(event)
);
