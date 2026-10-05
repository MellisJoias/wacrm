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

  IF p_whatsapp_config_id IS NULL THEN
    RAISE EXCEPTION
      'whatsapp_config_id é obrigatório para criar um broadcast.';
  END IF;

  SELECT wc.account_id
  INTO v_config_account_id
  FROM public.whatsapp_config AS wc
  WHERE wc.id = p_whatsapp_config_id;

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

  INSERT INTO public.broadcasts (
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

  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.broadcast_recipients AS br (
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
    RETURNING br.id, br.contact_id
  )
  SELECT
    v_broadcast_id,
    ins.id,
    ins.contact_id
  FROM ins;

END;
$$;
