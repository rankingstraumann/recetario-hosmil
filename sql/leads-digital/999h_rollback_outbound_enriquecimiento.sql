-- Rollback de 011 (Outbound 5). NO revierte datos por si solo.
-- PASO 0 (opcional, SOLO si hay que deshacer enriquecimientos ya aplicados): como el enriquecimiento solo llena campos que estaban VACIOS,
-- el estado previo era NULL. Para un enriquecimiento concreto <ENR_ID>, vaciar unicamente los campos que ese enriquecimiento lleno:
--   UPDATE public.digital_prospects d SET
--     full_name  = CASE WHEN 'full_name' = ANY (i.fields) THEN NULL ELSE d.full_name END,
--     phone_raw  = CASE WHEN 'phone'     = ANY (i.fields) THEN NULL ELSE d.phone_raw END,
--     phone_e164 = CASE WHEN 'phone'     = ANY (i.fields) THEN NULL ELSE d.phone_e164 END,
--     email      = CASE WHEN 'email'     = ANY (i.fields) THEN NULL ELSE d.email END
--   FROM public.digital_prospect_enrichment_items i
--   WHERE i.enrichment_id = '<ENR_ID>' AND d.id = i.prospect_id;
-- (revisar antes con un SELECT; si despues alguien edito esos campos, no ejecutar a ciegas)
DROP FUNCTION IF EXISTS public.confirm_prospect_enrichment(text, text, integer, integer, integer, jsonb);
DROP TABLE IF EXISTS public.digital_prospect_enrichment_items;
DROP TABLE IF EXISTS public.digital_prospect_enrichments;
