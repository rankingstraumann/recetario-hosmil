-- Rollback de 014 (Outbound 7). NO revierte outreach_status/last_outreach_at ya cambiados por envios de PRUEBA.
-- Respaldar antes: SELECT * FROM public.digital_outbound_sends;
-- Para volver prospectos de prueba a pending (solo si hace falta): UPDATE public.digital_prospects SET outreach_status='pending', last_outreach_at=NULL
--   WHERE is_test AND id IN (SELECT prospect_id FROM public.digital_outbound_sends);   -- ejecutar ANTES de dropear la tabla
DROP FUNCTION IF EXISTS public.finalize_outbound_send(uuid, text, text, text, text);
DROP FUNCTION IF EXISTS public.claim_outbound_send(uuid, text, text);
DROP TABLE IF EXISTS public.digital_outbound_sends;
