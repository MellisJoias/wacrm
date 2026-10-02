ALTER TABLE public.broadcasts
ADD COLUMN IF NOT EXISTS header_media_url text;
