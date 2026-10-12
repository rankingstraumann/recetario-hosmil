-- Rollback de 012 (Outbound 6). NO revierte datos de consentimiento: si ya se registraron consentimientos, guardar antes
--   SELECT * FROM public.digital_prospect_consent_log;  (se perdera al borrar la tabla). Los valores de whatsapp_consent quedan como estan.
DROP TRIGGER IF EXISTS trg_guard_prospect_consent ON public.digital_prospects;
DROP FUNCTION IF EXISTS public.guard_prospect_consent();
DROP FUNCTION IF EXISTS public.set_prospect_consent(uuid, text, text, date, text);
ALTER TABLE public.digital_prospects DROP COLUMN IF EXISTS contact_ready;
DROP TABLE IF EXISTS public.digital_prospect_consent_log;
