-- 048_worker_domain_outbox_user_fk.sql
--
-- Delete-hardening follow-up to 047: `worker_domain_outbox.aggregate_id`
-- was declared as a bare UUID with no foreign key (042), so domain events
-- outlived the worker they belong to when the `users` row was deleted —
-- orphaned rows that no release lane can ever render (the category
-- renderers resolve the recipient from `users` and skip when it is gone),
-- i.e. retained personal-workflow data with no consumer.
--
-- Both current event types ('assessment.requested', 'worker.ready') use the
-- worker's user id as the aggregate, so the FK targets public.users. If a
-- future event type introduces a non-user aggregate, split it into its own
-- column/table rather than loosening this constraint.
--
-- Forward-only; apply manually through the migration runbook (the prod
-- deploy pipeline refuses diffs that touch infra/db/migrations/**).

BEGIN;

-- Orphans predating this constraint would fail validation; remove them
-- first. Today both event types key aggregate_id to users.id, so any row
-- without a matching user is exactly the orphan class this migration exists
-- to prevent.
DELETE FROM public.worker_domain_outbox o
WHERE NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = o.aggregate_id);

ALTER TABLE public.worker_domain_outbox
  DROP CONSTRAINT IF EXISTS worker_domain_outbox_aggregate_id_fkey;
ALTER TABLE public.worker_domain_outbox
  ADD CONSTRAINT worker_domain_outbox_aggregate_id_fkey
  FOREIGN KEY (aggregate_id) REFERENCES public.users(id) ON DELETE CASCADE;

COMMIT;
