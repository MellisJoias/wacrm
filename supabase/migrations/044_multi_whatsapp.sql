BEGIN;

-- ============================================================
-- 044 - MULTI WHATSAPP POR ACCOUNT
-- ============================================================
--
-- Cada account pode possuir vários whatsapp_config.
--
-- A identidade do canal passa a ser:
--   whatsapp_config_id
--
-- Conversas:
--   account_id + whatsapp_config_id + contact_id
--
-- Templates:
--   whatsapp_config_id + name + language
--
-- Broadcasts:
--   whatsapp_config_id
--
-- ============================================================


-- ============================================================
-- 1. WHATSAPP_CONFIG
-- ============================================================

-- Antes: apenas um WhatsApp por account.
-- Agora: vários WhatsApps por account.
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS business_portfolio_id TEXT;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account
  ON whatsapp_config(account_id);


-- ============================================================
-- 2. CONVERSATIONS
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id)
  ON DELETE RESTRICT;

UPDATE conversations c
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL;


-- ============================================================
-- 3. MESSAGE_TEMPLATES
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id)
  ON DELETE RESTRICT;

UPDATE message_templates mt
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = mt.account_id
  AND mt.whatsapp_config_id IS NULL;


-- ============================================================
-- 4. BROADCASTS
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id)
  ON DELETE RESTRICT;

UPDATE broadcasts b
SET whatsapp_config_id = wc.id
FROM whatsapp_config wc
WHERE wc.account_id = b.account_id
  AND b.whatsapp_config_id IS NULL;


-- ============================================================
-- 5. VALIDAR BACKFILL
-- ============================================================

DO $$
DECLARE
  missing_conversations INTEGER;
  missing_templates INTEGER;
  missing_broadcasts INTEGER;
BEGIN

  SELECT COUNT(*)
  INTO missing_conversations
  FROM conversations
  WHERE whatsapp_config_id IS NULL;

  SELECT COUNT(*)
  INTO missing_templates
  FROM message_templates
  WHERE whatsapp_config_id IS NULL;

  SELECT COUNT(*)
  INTO missing_broadcasts
  FROM broadcasts
  WHERE whatsapp_config_id IS NULL;

  IF missing_conversations > 0 THEN
    RAISE EXCEPTION
      'Migration 044 abortada: % conversas estão sem whatsapp_config_id.',
      missing_conversations;
  END IF;

  IF missing_templates > 0 THEN
    RAISE EXCEPTION
      'Migration 044 abortada: % templates estão sem whatsapp_config_id.',
      missing_templates;
  END IF;

  IF missing_broadcasts > 0 THEN
    RAISE EXCEPTION
      'Migration 044 abortada: % broadcasts estão sem whatsapp_config_id.',
      missing_broadcasts;
  END IF;

END $$;


-- ============================================================
-- 6. VALIDAR ACCOUNT x WHATSAPP
-- ============================================================

DO $$
BEGIN

  IF EXISTS (
    SELECT 1
    FROM conversations c
    JOIN whatsapp_config wc
      ON wc.id = c.whatsapp_config_id
    WHERE c.account_id <> wc.account_id
  ) THEN
    RAISE EXCEPTION
      'Migration 044 abortada: conversa vinculada a whatsapp_config de outra account.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM message_templates mt
    JOIN whatsapp_config wc
      ON wc.id = mt.whatsapp_config_id
    WHERE mt.account_id <> wc.account_id
  ) THEN
    RAISE EXCEPTION
      'Migration 044 abortada: template vinculado a whatsapp_config de outra account.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM broadcasts b
    JOIN whatsapp_config wc
      ON wc.id = b.whatsapp_config_id
    WHERE b.account_id <> wc.account_id
  ) THEN
    RAISE EXCEPTION
      'Migration 044 abortada: broadcast vinculado a whatsapp_config de outra account.';
  END IF;

END $$;


-- ============================================================
-- 7. CANAL OBRIGATÓRIO
-- ============================================================

ALTER TABLE conversations
  ALTER COLUMN whatsapp_config_id SET NOT NULL;

ALTER TABLE message_templates
  ALTER COLUMN whatsapp_config_id SET NOT NULL;

ALTER TABLE broadcasts
  ALTER COLUMN whatsapp_config_id SET NOT NULL;


-- ============================================================
-- 8. CONVERSATIONS - NOVA IDENTIDADE
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

CREATE INDEX IF NOT EXISTS idx_conversations_account_whatsapp_config
  ON conversations(account_id, whatsapp_config_id);

DROP INDEX IF EXISTS idx_conversations_account_contact;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_conversations_account_whatsapp_contact_unique
  ON conversations(
    account_id,
    whatsapp_config_id,
    contact_id
  );


-- ============================================================
-- 9. MESSAGE_TEMPLATES - NOVA IDENTIDADE
-- ============================================================

DROP INDEX IF EXISTS message_templates_user_name_language_key;

CREATE UNIQUE INDEX IF NOT EXISTS
  message_templates_config_name_language_key
  ON message_templates(
    whatsapp_config_id,
    name,
    language
  );

CREATE INDEX IF NOT EXISTS
  idx_message_templates_whatsapp_config
  ON message_templates(whatsapp_config_id);


-- ============================================================
-- 10. BROADCASTS
-- ============================================================

CREATE INDEX IF NOT EXISTS
  idx_broadcasts_whatsapp_config
  ON broadcasts(whatsapp_config_id);

CREATE INDEX IF NOT EXISTS
  idx_broadcasts_account_whatsapp_config
  ON broadcasts(account_id, whatsapp_config_id);


-- ============================================================
-- 11. RPC - CREATE BROADCAST
-- ============================================================
--
-- A RPC anterior recebia:
--
--   account_id
--   user_id
--   name
--   template_name
--   template_language
--   total_recipients
--   contact_ids
--   template_params
--   header_media_url
--
-- Agora recebe também:
--
--   whatsapp_config_id
--
-- O canal é validado contra a account antes da criação.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id          UUID,
  p_user_id             UUID,
  p_name                TEXT,
  p_template_name       TEXT,
  p_template_language   TEXT,
  p_total_recipients    INTEGER,
  p_contact_ids         UUID[],
  p_template_params     JSONB[],
  p_header_media_url    TEXT DEFAULT NULL,
  p_whatsapp_config_id  UUID DEFAULT NULL
)
RETURNS TABLE(
  broadcast_id UUID,
  recipient_id UUID,
  contact_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
  v_config_account_id UUID;
BEGIN

  -- ----------------------------------------------------------
  -- Validar canal
  -- ----------------------------------------------------------

  IF p_whatsapp_config_id IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_config_id é obrigatório para criar um broadcast.';
  END IF;

  SELECT account_id
  INTO v_config_account_id
  FROM whatsapp_config
  WHERE id = p_whatsapp_config_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'WhatsApp config % não encontrada.',
      p_whatsapp_config_id;
  END IF;

  IF v_config_account_id <> p_account_id THEN
    RAISE EXCEPTION
      'WhatsApp config % não pertence à account %.',
      p_whatsapp_config_id,
      p_account_id;
  END IF;


  -- ----------------------------------------------------------
  -- Criar broadcast
  -- ----------------------------------------------------------

  INSERT INTO broadcasts (
    account_id,
    user_id,
    whatsapp_config_id,
    name,
    template_name,
    template_language,
    status,
    total_recipients,
    header_media_url
  )
  VALUES (
    p_account_id,
    p_user_id,
    p_whatsapp_config_id,
    p_name,
    p_template_name,
    p_template_language,
    'sending',
    p_total_recipients,
    NULLIF(TRIM(p_header_media_url), '')
  )
  RETURNING id
  INTO v_broadcast_id;


  -- ----------------------------------------------------------
  -- Criar recipients
  -- ----------------------------------------------------------

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id,
      contact_id,
      status,
      template_params
    )
    SELECT
      v_broadcast_id,
      t.cid,
      'pending',
      t.prm
    FROM unnest(
      p_contact_ids,
      p_template_params
    ) AS t(cid, prm)
    RETURNING id, contact_id
  )
  SELECT
    v_broadcast_id,
    ins.id,
    ins.contact_id
  FROM ins;

END;
$$;


-- ============================================================
-- 12. PERMISSÕES DA RPC
-- ============================================================

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT,
  UUID
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT,
  UUID
) FROM anon;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT,
  UUID
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT,
  UUID
) TO service_role;


COMMIT;