import { redirect } from 'next/navigation';

// The per-item verification review was retired with its four actions in
// roadmap 1b (they edited demo admin_cases rows only). /verifications is now a
// read-only lockout list; old links land there.
export default function VerificationDetailRedirect() {
  redirect('/verifications');
}
