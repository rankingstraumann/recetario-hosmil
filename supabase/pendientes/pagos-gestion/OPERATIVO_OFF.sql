-- ROLLBACK OPERATIVO: desactiva la automatización SIN borrar nada (tablas, gestiones, eventos y SAP registrados se conservan).
-- Reversible: los mismos UPDATE con 'true' reactivan. No toca cotizaciones ni las RPCs del paciente.
BEGIN;
SET LOCAL lock_timeout = '5s';
UPDATE public.pago_gestion_config SET valor='false', updated_at=now() WHERE clave IN ('encolado_activo','envio_activo','confirmaciones_activo');
UPDATE public.pago_gestion_config SET valor='prueba', updated_at=now() WHERE clave='modo';
-- (Fases posteriores, mismo script) además:  SELECT cron.unschedule('<job pago-gestion>');  y retirar el webhook entrante en Resend.
-- Corte más duro, opcional (toma lock breve sobre cotizaciones):  ALTER TABLE public.cotizaciones DISABLE TRIGGER trg_pago_gestion_encolar;
COMMIT;
