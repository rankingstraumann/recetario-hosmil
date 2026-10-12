-- ROLLBACK exacto de 005. Elimina los mensajes sin lead (solo existen por 005) antes de restaurar NOT NULL.
DELETE FROM public.digital_lead_messages WHERE lead_id IS NULL;
DROP INDEX IF EXISTS public.idx_dl_messages_lead;
DROP INDEX IF EXISTS public.idx_dl_messages_session;
DROP INDEX IF EXISTS public.uq_dl_messages_provider_id;
ALTER TABLE public.digital_lead_messages DROP CONSTRAINT IF EXISTS digital_lead_messages_owner_check;
ALTER TABLE public.digital_lead_messages DROP COLUMN IF EXISTS session_id;
ALTER TABLE public.digital_lead_messages ALTER COLUMN lead_id SET NOT NULL;
DROP TABLE IF EXISTS public.digital_lead_sessions;
DROP FUNCTION IF EXISTS public.touch_digital_lead_session();
