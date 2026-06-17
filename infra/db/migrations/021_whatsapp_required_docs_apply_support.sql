-- ============================================================
-- 021_whatsapp_required_docs_apply_support.sql
-- Run manually AFTER 020_worker_pii_rls_hardening.sql
-- Connect as: jale_admin (NOT the RDS master user)
--
-- Allow WhatsApp applications to use the same required-doc helper as web.
-- Existing worker_documents RLS still requires app.current_internal_user_id.
-- ============================================================

GRANT SELECT, INSERT ON worker_documents TO jale_whatsapp;
