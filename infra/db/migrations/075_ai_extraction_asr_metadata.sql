-- 075_ai_extraction_asr_metadata.sql
-- Adds asr_metadata JSONB to worker_profile_ai_extractions (011): per-attempt
-- ASR (speech-to-text) quality metadata for the voice-message transcript
-- that produced this extraction --
-- {provider, languages, avg_confidence, word_count, low_confidence_word_count}.
-- Written by ai-profile-writer (lambda change tracked separately; not part
-- of this migration). Nullable, no default: existing rows and any
-- extraction path that predates the ASR-metadata write simply leave it
-- NULL, and no downstream query depends on it being present.
--
-- Existing worker_profile_ai_extractions RLS policy (worker_profile_ai_extractions_self,
-- 011_ai_profile_media.sql) and jale_whatsapp table-level grant (SELECT,
-- INSERT, UPDATE, also 011) both cover new columns automatically -- no
-- policy or grant changes needed here.
--
-- Run AFTER 074_job_optional_requirements.sql, connected as jale_admin
-- (NOT the RDS master user). Forward-only (ADR-005).

BEGIN;

ALTER TABLE worker_profile_ai_extractions
  ADD COLUMN IF NOT EXISTS asr_metadata JSONB;

COMMIT;
