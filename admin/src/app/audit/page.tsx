import { redirect } from 'next/navigation';

// The action log page was replaced by the access history,
// which shows those records as legacy entries. Old links land there.
export default function AuditRedirect() {
  redirect('/access-history');
}
