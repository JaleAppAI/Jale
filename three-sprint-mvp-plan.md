# Jale MVP Three-Sprint Plan

## Context

This plan is based on the current MVP gap analysis for Jale and assumes:

- Three upcoming sprints, including the current sprint.
- Each sprint is one week.
- Two contributors: Ivan and Luis.
- Ivan has been handling most of the frontend and also owns backend logic that directly supports frontend behavior.
- Luis should focus more on deeper backend, migrations, infrastructure-adjacent work, queues, matching, authorization, and shared backend behavior.
- Realistic delivery capacity is estimated at around 4-5 focused dev-days per person per sprint after review, testing, fixes, meetings, and coordination.
- The feature split below is intentionally kept the same, but each sprint should be treated as an ambitious one-week push.

The full narrative backlog is larger than three sprints. The recommended focus is to close the core MVP marketplace loop first:

**Employer creates job -> candidates match -> employer messages worker -> worker is hired -> openings decrement/fill.**

## High-Level Effort Estimate

| Area | Estimate | Notes |
|---|---:|---|
| Job schema + job create/update UI/API | 7-10 days | Migration, validation, frontend modal, API types, tests |
| Hiring workflow + statuses | 3-5 days | `filled/paused`, `contacted/talking/hired/not_interested`, auto-decrement |
| Employer-to-worker messaging backend | 5-8 days | API, DB changes, outbox reuse, conversation audit |
| Employer conversations UI | 5-7 days | Thread list, thread view, message button, loading/error states |
| Matching materialization Lambda | 5-8 days | Missing key backend piece; needs careful RLS/role testing |
| Worker rerank consumer | 3-5 days | Depends on materialized candidate pipeline |
| Match explanation UI | 2-4 days | Worker cards + employer candidate/applicant lists |
| WhatsApp profile improvements | 5-8 days | Skills, language, AI summary persistence, maybe work history |
| Worker frontend polish | 6-10 days | Photos, pause visibility, web messaging fallback |
| Admin MVP | 8-14 days | New stack, admin auth, pages, lambdas from scratch |
| Saved workers | 3-5 days | Table, CRUD, frontend tab |

## Sprint 1: Job Model + Hiring Flow

### Goal

Complete the labor-need posting flow and hiring status workflow.

Employers should be able to create jobs with the real fields needed for blue-collar labor matching, track candidates through the correct statuses, and have jobs automatically move toward `filled` as workers are hired.

| Person | Work | 1-Week Estimate |
|---|---|---:|
| Ivan | Extend `PostJobModal` with pay, start date, duration, shift, transportation, language, headcount, trade, experience, and certifications | 1.5 days |
| Ivan | Update frontend API types, create/update payloads, form validation, and employer dashboard display | 1 day |
| Ivan | Update applicant status UI for `contacted/talking/hired/not_interested` | 1 day |
| Ivan | Frontend integration testing and polish | 1 day |
| Luis | Add migration for job fields, job statuses, headcount, and hired count | 1 day |
| Luis | Update create/update job Lambdas and backend validation | 1.5 days |
| Luis | Add hiring trigger or backend-safe hired transition logic | 1 day |
| Luis | Backend tests for migrations, create/update, status changes, and auto-filled behavior | 1 day |

### Estimated 1-Week Balance

| Person | Estimated 1-Week Load |
|---|---:|
| Ivan | 4.5 days |
| Luis | 4.5 days |

### Sprint 1 Deliverable

A complete employer job and hiring workflow:

- Employers can post complete jobs.
- Jobs support real labor fields like pay, shift, duration, headcount, and requirements.
- Applicant statuses match the MVP workflow.
- Hiring a worker updates hired counts.
- Jobs can automatically become `filled` when enough workers are hired.

## Sprint 2: Employer Messaging

### Goal

Employers can message workers from a job context and view conversations.

This closes a major product-loop gap: once an employer finds a worker, they should be able to contact them through Jale instead of leaving the platform.

| Person | Work | 1-Week Estimate |
|---|---|---:|
| Ivan | Build `/employer/conversations` list and thread view | 1.5 days |
| Ivan | Add "Message Worker" button/action from applicant or candidate views | 0.5 days |
| Ivan | Build frontend API client and UX states for send/loading/errors | 1 day |
| Ivan | Implement or pair on frontend-facing list/get message Lambda response shaping | 1.5 days |
| Luis | Add DB schema for job-scoped conversations and message audit log | 1 day |
| Luis | Implement send-message Lambda and authorization rules | 1.5 days |
| Luis | Reuse existing WhatsApp outbox/send path safely | 1 day |
| Luis | Add backend tests for job scoping, permissions, and message persistence | 1 day |

### Estimated 1-Week Balance

| Person | Estimated 1-Week Load |
|---|---:|
| Ivan | 4.5 days |
| Luis | 4.5 days |

### Sprint 2 Deliverable

An employer-to-worker messaging loop:

- Employers can start a message from a job applicant or candidate.
- Conversations are scoped to jobs.
- Messages are persisted in an audit/history table.
- Outbound messages reuse the existing WhatsApp outbox path.
- Employers can see conversation threads in the dashboard.

## Sprint 3: Matching + Match Visibility

### Goal

Jale should proactively generate candidates and show users why matches are good.

The backend already has matching tables, queues, scoring logic, and ranking pieces, but the materialization Lambda is missing. Without it, matching is not truly proactive. This sprint makes matching real and visible.

| Person | Work | 1-Week Estimate |
|---|---|---:|
| Ivan | Render match score, score band, and reasons on worker job cards | 0.75 days |
| Ivan | Render match score and reason chips in employer candidate/applicant lists | 1 day |
| Ivan | Update frontend types and API response handling | 0.75 days |
| Ivan | Add one worker profile improvement: skills display/edit or pause visibility toggle | 1.25 days |
| Ivan | UI testing and polish | 0.75 days |
| Luis | Build candidate materialization Lambda for the existing FIFO queue | 2 days |
| Luis | Wire materialization from job create/update and worker profile changes | 1 day |
| Luis | Add stale candidate cleanup and UPSERT behavior | 0.75 days |
| Luis | Add tests for candidate generation and matching edge cases | 1 day |

### Estimated 1-Week Balance

| Person | Estimated 1-Week Load |
|---|---:|
| Ivan | 4.5 days |
| Luis | 4.75 days |

### Sprint 3 Deliverable

Proactive and visible matching:

- Candidate matches are actually materialized.
- Stale candidate rows are cleaned up.
- Worker job cards show match score and reasons.
- Employer candidate/applicant lists show score bands and match reasons.
- Users can understand why a worker/job is a good fit.

## Recommended Ownership Model

Ivan should own:

- Screens and user flows.
- Frontend API contracts.
- UX validation and user-facing error states.
- Backend request/response shaping that directly supports frontend behavior.
- Light Lambda logic that is tightly coupled to the UI experience.

Luis should own:

- Database migrations.
- Queue consumers.
- Matching materialization.
- Authorization rules.
- Shared backend behavior.
- Deeper backend test coverage.
- Infrastructure-adjacent backend work.

This keeps the work balanced while matching the way the team already works: Ivan stays close to the product experience, while Luis carries the deeper backend and platform pieces that unblock it.

## Recommended Deferrals

These are valuable, but they should not be committed inside the three-sprint MVP scope unless they become launch blockers.

| Item | Reason to Defer |
|---|---|
| Full admin dashboard | New stack, admin auth, frontend pages, and lambdas from scratch |
| Anthropic job-text enrichment | External/service integration risk; may require extra networking review |
| Web chat fallback | WhatsApp messaging closes the MVP loop first |
| SMS fallback | Has Twilio sender and operations dependency |
| Magic-link employer auth | Useful, but not required for the core marketplace loop |
| Saved workers | Valuable after matching and messaging are working |
| Full worker photo gallery | Useful polish, but less important than job/match/message/hire |

## Summary

The best three-sprint target is not to finish the entire narrative backlog. The best target is to make the core Jale marketplace loop work end-to-end:

1. Employers can create complete jobs.
2. Workers can be matched proactively.
3. Employers can contact matched workers.
4. Hiring updates the job automatically.
5. Both sides can see enough match context to trust the system.

After these three sprints, the next logical sprint should focus on Admin MVP, saved workers, worker portfolio/photos, SMS/web fallback, and remaining narrative polish.
