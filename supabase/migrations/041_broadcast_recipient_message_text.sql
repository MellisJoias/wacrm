ALTER TABLE broadcast_recipients
ADD COLUMN IF NOT EXISTS message_text TEXT;

COMMENT ON COLUMN broadcast_recipients.message_text IS
'Texto renderizado do template enviado ao destinatário.';
