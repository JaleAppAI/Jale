-- 007_trust_signal_layer.sql
-- Adds trust signal storage to the users table.
-- Apply BEFORE deploying the updated JaleWhatsAppStack.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS trust_signals JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS trust_signals_completed_at TIMESTAMPTZ;

-- Column-level grants for the jale_whatsapp role.
GRANT SELECT (trust_signals, trust_signals_completed_at) ON users TO jale_whatsapp;
GRANT UPDATE (trust_signals, trust_signals_completed_at) ON users TO jale_whatsapp;

COMMENT ON COLUMN users.trust_signals IS
  'JSONB map of { specialization, seniority, tasks }; each value is { questionKey, optionKey, label, answeredAt }.';
COMMENT ON COLUMN users.trust_signals_completed_at IS
  'Set when all three trust-signal questions have been answered. NULL means trust flow is pending.';

COMMIT;
