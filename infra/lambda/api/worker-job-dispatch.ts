import type { ApiHandler } from '../lib/path-dispatch';
import { handler as detailHandler } from './worker-jobs-detail';
import { handler as viewHandler } from './worker-jobs-view';

/**
 * The worker job Lambda (WorkerJobsDetailLambda): GET /worker/jobs/{jobId}
 * (job detail) and, since sprint 28, POST /worker/jobs/{jobId}/view (the job
 * view capture, contract K3.6).
 *
 * WHY ONE LAMBDA: a Lambda-backed route costs JaleApiStack about eight
 * resources against CloudFormation's 500 (see lib/api-integration.ts and
 * api-stack-resource-ceiling.test.ts). Both routes run on the request login
 * with the same database grant, so serving the view from the detail Lambda
 * adds only the `view` Resource, its two Methods and one Permission, and
 * widens nothing. path-dispatch.ts picks by a path parameter; these two
 * differ by method and resource, so the choice is made here.
 *
 * Only POST on the view resource reaches the view handler. Everything else
 * goes to the job detail handler exactly as before, with the event passed by
 * reference and the delegate's response returned verbatim.
 */
export const VIEW_RESOURCE = '/worker/jobs/{jobId}/view';

export const handler: ApiHandler = (event) => (
  event.httpMethod === 'POST' && event.resource === VIEW_RESOURCE
    ? viewHandler(event)
    : detailHandler(event)
);
