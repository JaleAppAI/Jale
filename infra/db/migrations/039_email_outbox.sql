-- 039_email_outbox.sql
-- Generic durable email outbox. Billing is a narrow producer; jale_admin is
-- the scheduled sender. Forward-only; apply after 037.

BEGIN;

CREATE TABLE email_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_email   TEXT NOT NULL CHECK (length(recipient_email) BETWEEN 3 AND 320 AND position('@' IN recipient_email) > 1),
  subject           TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body_text         TEXT NOT NULL CHECK (length(body_text) BETWEEN 1 AND 100000),
  body_html         TEXT CHECK (body_html IS NULL OR length(body_html) BETWEEN 1 AND 200000),
  source_type       TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 64 AND source_type ~ '^[a-z0-9_:-]+$'),
  source_id         UUID NOT NULL,
  idempotency_key   TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 255),
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed', 'send_unknown')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
  next_attempt_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  CHECK ((status = 'sent' AND sent_at IS NOT NULL) OR status <> 'sent')
);

CREATE UNIQUE INDEX email_outbox_idempotency_unique
  ON email_outbox (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX email_outbox_sweeper_idx
  ON email_outbox (next_attempt_at ASC NULLS FIRST, created_at ASC, id ASC)
  WHERE status IN ('pending', 'failed') AND attempt_count < 5;

ALTER TABLE email_outbox OWNER TO jale_admin;
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_outbox FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT ON email_outbox TO jale_billing;
GRANT SELECT, UPDATE ON email_outbox TO jale_admin;

CREATE POLICY email_outbox_billing_select
  ON email_outbox FOR SELECT TO jale_billing
  USING (source_type = 'billing_pause');

CREATE POLICY email_outbox_billing_insert
  ON email_outbox FOR INSERT TO jale_billing
  WITH CHECK (source_type = 'billing_pause');

CREATE POLICY email_outbox_admin_select
  ON email_outbox FOR SELECT TO jale_admin
  USING (true);

CREATE POLICY email_outbox_admin_update
  ON email_outbox FOR UPDATE TO jale_admin
  USING (true)
  WITH CHECK (true);

COMMIT;
