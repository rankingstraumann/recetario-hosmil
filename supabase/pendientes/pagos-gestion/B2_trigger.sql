-- ============================================================================
-- B2 — Trigger. Requiere B1. Aislamiento: cualquier error se captura y se descarta; el pago del paciente nunca falla por esto.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION public.trg_pago_gestion_encolar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET lock_timeout = '250ms' AS $f$
DECLARE v_id uuid; v_prev text;
BEGIN
  BEGIN   -- sub-transacción: si algo falla aquí dentro, SOLO se revierte este bloque
    IF coalesce((SELECT valor FROM public.pago_gestion_config WHERE clave='encolado_activo'),'false') <> 'true' THEN RETURN NEW; END IF;
    SELECT estado_envio INTO v_prev FROM public.pago_gestiones WHERE cotizacion_id = NEW.id;
    IF v_prev IS NULL AND NEW.estado = 'Pago informado' AND OLD.estado IS DISTINCT FROM 'Pago informado' THEN
      PERFORM public.pago_gestion_crear(NEW.id, CASE WHEN auth.uid() IS NOT NULL THEN 'admin' ELSE 'paciente' END);
    ELSIF v_prev IS NOT NULL AND v_prev <> 'omitido_historico' THEN
      -- ya hubo gestión: NO se envía otro correo; se registra para revisión
      INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
      SELECT g.id, NEW.id, 'actividad_posterior', 'h'||NEW.id||':'||jsonb_array_length(NEW.historial),
             jsonb_build_object('estado_anterior',OLD.estado,'estado_nuevo',NEW.estado,'comprobante_cambio',NEW.comprobante_path IS DISTINCT FROM OLD.comprobante_path)
      FROM public.pago_gestiones g WHERE g.cotizacion_id = NEW.id ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.pago_gestion_eventos(cotizacion_id, tipo, dedupe_key, detalle)
      VALUES (NEW.id, 'error_tecnico', 'trg:'||NEW.id||':'||clock_timestamp()::text, jsonb_build_object('sqlstate',SQLSTATE,'msg',left(SQLERRM,300)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NEW;
END $f$;
REVOKE ALL ON FUNCTION public.trg_pago_gestion_encolar() FROM PUBLIC, anon, authenticated;

-- Cierra la ventana B1→B2: lo que haya llegado a estados posteriores entretanto queda como histórico
INSERT INTO public.pago_gestiones(cotizacion_id, origen, institucion_codigo, estado_envio)
SELECT c.id,'sistema',c.institucion_codigo,'omitido_historico' FROM public.cotizaciones c
WHERE c.estado NOT IN ('Borrador','Cotización generada','Enviada al paciente','Pendiente de pago','Pagado parcialmente')
  AND (c.estado <> 'Anulado' OR EXISTS (SELECT 1 FROM public.cotizacion_pagos p WHERE p.cotizacion_id=c.id)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c.historial,'[]'::jsonb)) h WHERE h->>'estado'='Pago informado'))
ON CONFLICT (cotizacion_id) DO NOTHING;

CREATE TRIGGER trg_pago_gestion_encolar AFTER UPDATE OF estado, comprobante_path ON public.cotizaciones
FOR EACH ROW WHEN ((NEW.estado IS DISTINCT FROM OLD.estado AND NEW.estado = 'Pago informado')
                   OR NEW.comprobante_path IS DISTINCT FROM OLD.comprobante_path)
EXECUTE FUNCTION public.trg_pago_gestion_encolar();
COMMIT;
