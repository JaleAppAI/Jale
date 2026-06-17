BEGIN;

CREATE TABLE IF NOT EXISTS job_conversations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                 UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  employer_id            UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  worker_id              UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  application_id         UUID NOT NULL REFERENCES job_applications(id) ON DELETE RESTRICT,
  status                 TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'closed')),
  last_message_at        TIMESTAMPTZ,
  last_worker_message_at TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS job_conversations_open_unique
  ON job_conversations (job_id, employer_id, worker_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_job_conversations_employer_last
  ON job_conversations (employer_id, last_message_at DESC NULLS LAST, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_conversations_worker_open
  ON job_conversations (worker_id, last_message_at DESC NULLS LAST, created_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS job_conversation_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES job_conversations(id) ON DELETE CASCADE,
  sender_type         TEXT NOT NULL CHECK (sender_type IN ('employer', 'worker', 'system')),
  direction           TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  body                TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'waiting_worker_reply', 'sent', 'delivered', 'failed', 'received')),
  twilio_message_sid  TEXT,
  twilio_from         TEXT,
  twilio_to           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_messages_conversation_created
  ON job_conversation_messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS job_message_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID NOT NULL REFERENCES job_conversations(id) ON DELETE CASCADE,
  message_id          UUID REFERENCES job_conversation_messages(id) ON DELETE SET NULL,
  whatsapp_number     VARCHAR(20) NOT NULL,
  send_kind           TEXT NOT NULL CHECK (send_kind IN ('template', 'freeform')),
  content_template    TEXT,
  content_variables   JSONB,
  body                TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed')),
  sender_key          TEXT NOT NULL DEFAULT 'jale_whatsapp_default',
  twilio_message_sid  TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  CHECK (
    (send_kind = 'template' AND content_template IS NOT NULL)
    OR (send_kind = 'freeform' AND body IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_job_message_outbox_pending
  ON job_message_outbox (status, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TRIGGER job_conversations_updated_at
  BEFORE UPDATE ON job_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

GRANT SELECT, INSERT, UPDATE ON job_conversations TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON job_conversation_messages TO jale_admin;
GRANT SELECT, INSERT, UPDATE ON job_message_outbox TO jale_admin;

GRANT SELECT, INSERT, UPDATE ON job_conversations TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON job_conversation_messages TO jale_whatsapp;
GRANT SELECT, INSERT, UPDATE ON job_message_outbox TO jale_whatsapp;

ALTER TABLE job_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE job_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE job_message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_message_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_conversations_employer_all ON job_conversations;
CREATE POLICY job_conversations_employer_all
  ON job_conversations FOR ALL TO jale_admin
  USING (employer_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (employer_id::text = current_setting('app.current_internal_user_id', true));

DROP POLICY IF EXISTS job_messages_employer_all ON job_conversation_messages;
CREATE POLICY job_messages_employer_all
  ON job_conversation_messages FOR ALL TO jale_admin
  USING (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_conversation_messages.conversation_id
        AND jc.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_conversation_messages.conversation_id
        AND jc.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

DROP POLICY IF EXISTS job_outbox_employer_all ON job_message_outbox;
CREATE POLICY job_outbox_employer_all
  ON job_message_outbox FOR ALL TO jale_admin
  USING (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_message_outbox.conversation_id
        AND jc.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_message_outbox.conversation_id
        AND jc.employer_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

DROP POLICY IF EXISTS job_conversations_worker_all ON job_conversations;
CREATE POLICY job_conversations_worker_all
  ON job_conversations FOR ALL TO jale_whatsapp
  USING (worker_id::text = current_setting('app.current_internal_user_id', true))
  WITH CHECK (worker_id::text = current_setting('app.current_internal_user_id', true));

DROP POLICY IF EXISTS job_messages_worker_all ON job_conversation_messages;
CREATE POLICY job_messages_worker_all
  ON job_conversation_messages FOR ALL TO jale_whatsapp
  USING (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_conversation_messages.conversation_id
        AND jc.worker_id::text = current_setting('app.current_internal_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_conversation_messages.conversation_id
        AND jc.worker_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

DROP POLICY IF EXISTS job_outbox_worker_all ON job_message_outbox;
CREATE POLICY job_outbox_worker_all
  ON job_message_outbox FOR ALL TO jale_whatsapp
  USING (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_message_outbox.conversation_id
        AND jc.worker_id::text = current_setting('app.current_internal_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM job_conversations jc
      WHERE jc.id = job_message_outbox.conversation_id
        AND jc.worker_id::text = current_setting('app.current_internal_user_id', true)
    )
  );

COMMIT;
