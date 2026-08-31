-- ============================================================
-- CONTACT CARD MESSAGES
-- ============================================================
-- WhatsApp Cloud API sends shared contact cards as:
--
--   message.type = 'contacts'
--
-- The previous messages schema had no representation for this
-- message type, causing the webhook to fall back to 'text' and
-- discard the structured contact-card data.
--
-- Store the complete normalized contact-card payload as JSONB so
-- the Inbox can render the card without losing fields supplied by
-- WhatsApp.

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (
    content_type IN (
      'text',
      'image',
      'document',
      'audio',
      'video',
      'location',
      'template',
      'interactive',
      'contact'
    )
  );

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS contact_card JSONB;

COMMENT ON COLUMN messages.contact_card IS
  'Structured WhatsApp contact card received from a customer. Populated when content_type = contact.';
