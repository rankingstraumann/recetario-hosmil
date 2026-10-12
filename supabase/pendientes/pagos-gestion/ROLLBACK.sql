-- ROLLBACK DE INSTALACIÓN (DESTRUCTIVO: borra también los datos registrados en las tablas pago_*). Para solo apagar, usar OPERATIVO_OFF.sql.
-- ROLLBACK total (orden obligatorio: primero el trigger, luego su función, luego el resto). Solo elimina objetos nuevos.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS trg_pago_gestion_encolar ON public.cotizaciones;
DROP FUNCTION IF EXISTS public.trg_pago_gestion_encolar();
DROP FUNCTION IF EXISTS public.pago_gestion_registrar_confirmacion(uuid,text,text,text,text,boolean);
DROP FUNCTION IF EXISTS public.pago_gestion_registrar_entrega(text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.pago_gestion_crear(uuid,text);
DROP FUNCTION IF EXISTS public.pago_gestion_destinatarios_de(text);
DROP FUNCTION IF EXISTS public.pago_gestion_validar_envio(text,text[],text[],text[]);
DROP FUNCTION IF EXISTS public.pago_gestion_reclamar(int);
DROP FUNCTION IF EXISTS public.pago_gestion_motivo_no_elegible(uuid);
DROP FUNCTION IF EXISTS public.pago_gestion_soltar(uuid,text);
DROP FUNCTION IF EXISTS public.pago_gestion_revisar_elegibilidad();
DROP FUNCTION IF EXISTS public.pago_gestion_finalizar_envio(uuid,boolean,text,text,text[],text[],text);
DROP FUNCTION IF EXISTS public.pago_gestion_marcar_inciertas();
DROP FUNCTION IF EXISTS public.pago_gestion_reconciliar();
DROP FUNCTION IF EXISTS public.pago_gestion_liberar_bloqueadas();
DROP TABLE IF EXISTS public.pago_gestion_eventos, public.pago_gestiones, public.pago_remitentes_autorizados, public.pago_gestion_destinatarios, public.pago_gestion_config;
COMMIT;
