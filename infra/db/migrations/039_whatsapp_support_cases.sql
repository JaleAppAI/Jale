-- ============================================================
-- 039_whatsapp_support_cases.sql
-- Worker-initiated support cases from the WhatsApp command flow.
-- Connect as: jale_admin (NOT the RDS master user)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION create_admin_support_case(
  p_user_id UUID,
  p_conversation_id UUID,
  p_summary TEXT,
  p_last_message TEXT
)
RETURNS TABLE (case_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_case_id UUID;
  v_summary TEXT;
  v_last_message TEXT;
BEGIN
  IF p_user_id IS NULL OR p_conversation_id IS NULL THEN
    RAISE EXCEPTION 'worker and conversation are required'
      USING ERRCODE = '22004';
  END IF;

  -- Serialize concurrent support commands for one worker so two different
  -- inbound MessageSids cannot create duplicate open cases.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- Do not trust a caller-supplied worker/conversation pair. Accept an
  -- already-linked conversation, or an unlinked conversation only when its
  -- exact E.164 number matches a verified worker phone field. This fallback
  -- never binds or updates whatsapp_conversations.user_id.
  IF NOT EXISTS (
    SELECT 1
      FROM whatsapp_conversations wc
      JOIN users u ON u.id = p_user_id
     WHERE wc.id = p_conversation_id
       AND u.user_type = 'worker'
       AND (
         wc.user_id = p_user_id
         OR (
           wc.user_id IS NULL
           AND (
             wc.whatsapp_number = u.whatsapp_number
             OR wc.whatsapp_number = u.phone
           )
         )
       )
  ) THEN
    RAISE EXCEPTION 'conversation is not linked to worker'
      USING ERRCODE = '23503';
  END IF;

  SELECT c.id
    INTO v_case_id
    FROM admin_cases c
   WHERE c.case_type = 'help_request'
     AND c.user_id = p_user_id
     AND c.status IN ('open', 'pending_worker', 'pending_admin')
   ORDER BY c.created_at ASC, c.id ASC
   LIMIT 1
   FOR UPDATE;

  IF v_case_id IS NOT NULL THEN
    RETURN QUERY SELECT v_case_id, false;
    RETURN;
  END IF;

  v_summary := COALESCE(NULLIF(BTRIM(p_summary), ''), 'Worker requested WhatsApp support');
  v_last_message := COALESCE(NULLIF(BTRIM(p_last_message), ''), 'support');

  INSERT INTO admin_cases (
    case_type,
    status,
    priority,
    user_id,
    conversation_id,
    summary,
    details
  )
  VALUES (
    'help_request',
    'open',
    70,
    p_user_id,
    p_conversation_id,
    LEFT(v_summary, 500),
    jsonb_build_object(
      'subjectType', 'worker',
      'workerLabel', 'Worker',
      'conversationRef', p_conversation_id::text,
      'lastMessage', LEFT(v_last_message, 2000),
      'source', 'whatsapp_support_command'
    )
  )
  RETURNING id INTO v_case_id;

  INSERT INTO admin_case_events (
    case_id,
    event_type,
    actor_type,
    actor_id,
    payload
  )
  VALUES (
    v_case_id,
    'case_created',
    'worker',
    p_user_id::text,
    jsonb_build_object(
      'title', 'Worker requested help',
      'detail', LEFT(v_summary, 500),
      'source', 'whatsapp_support_command'
    )
  );

  RETURN QUERY SELECT v_case_id, true;
END;
$$;

ALTER FUNCTION create_admin_support_case(UUID, UUID, TEXT, TEXT) OWNER TO jale_admin;
REVOKE ALL ON FUNCTION create_admin_support_case(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_admin_support_case(UUID, UUID, TEXT, TEXT) TO jale_whatsapp;

COMMIT;
