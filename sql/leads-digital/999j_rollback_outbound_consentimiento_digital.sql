-- Rollback de 013 (Outbound 6B). NO revierte consentimientos ya registrados via formulario (quedan en digital_prospects y en
-- digital_prospect_consent_log). Respaldar antes: SELECT * FROM public.digital_prospect_consent_invitations;
DROP FUNCTION IF EXISTS public.submit_consent_invitation(text, text, boolean);
DROP FUNCTION IF EXISTS public.get_consent_invitation(text);
DROP FUNCTION IF EXISTS public.revoke_consent_invitation(uuid);
DROP FUNCTION IF EXISTS public.create_consent_invitation(uuid, integer);
DROP TABLE IF EXISTS public.digital_prospect_consent_invitations;
