import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { corsHeaders } from '../lib/http';
import { isTeamManagementEnabled } from '../lib/org-team';
import { dispatchOnPathParameter, type ApiHandler } from '../lib/path-dispatch';
import { handler as list } from './employer-team-list';
import { handler as membership } from './employer-membership';
import { handler as create } from './employer-team-invite-create';
import { handler as resend } from './employer-team-invite-resend';
import { handler as revoke } from './employer-team-invite-revoke';
import { handler as remove } from './employer-team-member-remove';
import { handler as reassign } from './employer-team-job-reassign';

/**
 * Team management on one Lambda (`EmployerTeamLambda`, JaleBillingStack),
 * behind the single `/employer/team/{action}` resource:
 *
 *   GET  /employer/team/members      the owner's team list (seats, members, invites)
 *   GET  /employer/team/membership   the caller's own membership (any employer login)
 *   POST /employer/team/invite       invite a foreman (owner)
 *   POST /employer/team/resend       resend an invite (owner; inviteId in the body)
 *   POST /employer/team/revoke       revoke an invite (owner; inviteId in the body)
 *   POST /employer/team/remove       remove a foreman, reassigning their jobs (owner)
 *   POST /employer/team/reassign     move one job to another member (owner)
 *   POST /employer/team/membership   start my own company (a login with no company)
 *
 * One resource instead of one per route keeps JaleApiStack under its
 * resource gate (`lambda/lib/path-dispatch.ts`; 480 since 2026-10-27, raised
 * temporarily from 470 until the JaleApiStack split). Membership was folded in
 * here for the same reason (467 of 470 with it; 473 as its own resource).
 *
 * The feature flag is checked FIRST: with TEAM_MANAGEMENT_ENABLED anything but
 * 'true', every route answers 404 not_found before any delegate (or the
 * database) is reached, so the rollback is "set the flag off and redeploy".
 * The delegates still check the flag themselves.
 *
 * Every delegate here runs on the request login, so merging them widens no
 * database right. The Lambda's role does hold the Cognito admin grant the
 * invite, revoke and remove delegates need (member access); the list,
 * membership and reassign delegates never call Cognito.
 */
const getRoutes: ApiHandler = dispatchOnPathParameter('action', new Map([
  ['members', list],
  ['membership', membership],
]));

const postRoutes: ApiHandler = dispatchOnPathParameter('action', new Map([
  ['invite', create],
  ['resend', resend],
  ['revoke', revoke],
  ['remove', remove],
  ['reassign', reassign],
  ['membership', membership],
]));

const routesByMethod: ReadonlyMap<string, ApiHandler> = new Map([
  ['GET', getRoutes],
  ['POST', postRoutes],
]);

function notFound(): APIGatewayProxyResult {
  return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'not_found' }) };
}

export const handler: ApiHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (!isTeamManagementEnabled()) return notFound();
  // Only GET and POST are routed. API Gateway carries no other method on
  // this resource but OPTIONS (a MOCK preflight), so anything else is a 404
  // here rather than a fall-through onto the POST delegates.
  const routes = routesByMethod.get(event.httpMethod);
  return routes ? routes(event) : notFound();
};
