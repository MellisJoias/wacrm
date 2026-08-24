-- ============================================================
-- 039_broadcast_header_media
--
-- Persist the campaign-level header media URL so server-side
-- delivery and resume can reconstruct the exact message.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN broadcasts.header_media_url IS
  'Media URL used by the broadcast template header when the template has an image, video, or document header.';

-- Recreate the atomic broadcast creation RPC with the media URL.
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[],
  p_header_media_url  TEXT DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id,
    user_id,
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
    p_name,
    p_template_name,
    p_template_language,
    'sending',
    p_total_recipients,
    NULLIF(TRIM(p_header_media_url), '')
  )
  RETURNING id INTO v_broadcast_id;

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

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) FROM anon;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], TEXT
) TO service_role;
