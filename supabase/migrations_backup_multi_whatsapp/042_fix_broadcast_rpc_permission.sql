REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  INTEGER,
  UUID[],
  JSONB[],
  TEXT
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
  TEXT
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
  TEXT
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
  TEXT
) TO service_role;
