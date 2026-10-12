-- Reversion de B4 (solo funciones; no hay datos propios). Atomica.
BEGIN;
DROP FUNCTION IF EXISTS public.pago_gestion_registrar_ambigua(uuid,text,text,text,text);
DROP FUNCTION IF EXISTS public.pago_remitente_rol(text);
DROP FUNCTION IF EXISTS public.pago_gestion_resolver_respuesta(text);
COMMIT;
