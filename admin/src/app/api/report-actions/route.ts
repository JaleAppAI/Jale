import { handleReportActionRequest } from '@/lib/server/report-actions';
import { getCurrentAdminSession } from '@/lib/server/session';

// The Reports actions (reveal, screenshot, status, note, settings). Their own
// route and policy; the case actions keep /api/admin-actions.
export async function POST(request: Request): Promise<Response> {
  return handleReportActionRequest(request, await getCurrentAdminSession());
}
