# Code Review Findings

Scope: quick pass over the current `ivan/sprint6-worker-marketplace` branch and related infra/frontend paths.

## Findings

### 1. [P1] Employer worker-profile page exposes a save control that does not persist anything

- File: [`frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx`](C:/Users/chaco/Documents/Coding/Jale/frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx)
- Location: lines 57-60 and 167-169

The `Save status` button is wired to `handleSaveStatus`, but that handler only flips `saving` on and off with a `setTimeout`. It never calls an API, never updates backend state, and never refreshes the page data. The UI therefore presents a status-edit control that appears functional but cannot persist anything.

Why it matters:
- Employers can click the control and believe they changed an application status, but nothing is saved.
- This is a direct product behavior bug, not just a missing enhancement.

### 2. [P1] Employer worker-profile page crashes when `full_name` is missing

- File: [`frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx`](C:/Users/chaco/Documents/Coding/Jale/frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx)
- Location: line 86

The avatar initials logic does `profile.full_name.split(' ')` without guarding against `null` or an empty string. The codebase already allows partially-complete worker profiles, so opening this page for a worker with a missing `full_name` will throw and break the page.

Why it matters:
- Newly provisioned or partially completed workers can crash the employer profile view.
- This is especially risky during WhatsApp onboarding / reset flows, where profile data can be incomplete for a while.

### 3. [P2] Employer worker-profile page can hang forever if `job_id` is missing

- File: [`frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx`](C:/Users/chaco/Documents/Coding/Jale/frontend/src/app/[locale]/employer/workers/[worker_id]/page.tsx)
- Location: lines 33-45

The page only clears `loading` inside the `Promise.all(...).finally(...)` block. If the query string does not include `job_id`, the effect returns early and `setLoading(false)` never runs. The page stays stuck on the loading state indefinitely.

Why it matters:
- The normal navigation path includes `job_id`, but a direct link, bookmark, or manual URL edit leaves the page unusable.
- It is easy to miss in testing because it only appears on incomplete URLs.

## Notes

- I did not see a separate frontend deployment target in this branch; the app is still pointing at the live AWS API Gateway endpoint from `.env.local`.
- The worker jobs 500s we debugged earlier were backend/schema mismatches, not a React-side issue.

