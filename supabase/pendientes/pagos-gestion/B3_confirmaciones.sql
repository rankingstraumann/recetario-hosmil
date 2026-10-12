-- ============================================================================
-- B3 — Procesamiento de respuestas (se aplica en Fase E/F, junto al webhook). Requiere B1.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION public.pago_gestion_registrar_confirmacion(p_gestion_id uuid, p_tipo text, p_dedupe text, p_valor text, p_remitente text, p_auth_ok boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE g public.pago_gestiones; c record; v_regex text; v_nuevo text; v_rem text; v_rol text; v_motivo text;
BEGIN
  IF p_tipo NOT IN ('sap','finanzas') THEN RAISE EXCEPTION 'tipo invalido'; END IF;
  IF coalesce((SELECT valor FROM public.pago_gestion_config WHERE clave='confirmaciones_activo'),'false') <> 'true' THEN RETURN 'desactivado'; END IF;
  SELECT * INTO g FROM public.pago_gestiones WHERE id = p_gestion_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'gestion_inexistente'; END IF;
  IF g.estado_envio = 'omitido_historico' THEN RETURN 'ignorado_historico'; END IF;
  -- IDENTIDAD Y AUTORIZACIÓN: antes de registrar CUALQUIER cosa (SAP o validación financiera)
  v_rem := lower(btrim(coalesce(p_remitente,'')));
  v_rol := (SELECT a.rol FROM public.pago_remitentes_autorizados a WHERE a.activo AND a.email = v_rem);
  v_motivo := CASE
    WHEN p_auth_ok IS DISTINCT FROM true THEN 'autenticacion_correo_fallida_o_no_verificada'
    WHEN v_rem !~ '^[^@\s<>"'',;]+@[^@\s<>"'',;]+\.[^@\s<>"'',;]+$' THEN 'remitente_no_es_direccion_simple'
    WHEN v_rol IS NULL THEN 'remitente_no_autorizado'
    WHEN p_tipo = 'sap' AND v_rol <> 'customer_service' THEN 'rol_incorrecto_para_sap'
    WHEN p_tipo = 'finanzas' AND v_rol <> 'finanzas' THEN 'rol_incorrecto_para_validacion_financiera'
    ELSE NULL END;
  IF v_motivo IS NOT NULL THEN
    INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, remitente, detalle)
    VALUES (g.id, g.cotizacion_id, 'respuesta_no_autorizada', 'na:'||p_dedupe, left(p_remitente,200), jsonb_build_object('motivo',v_motivo,'tipo_intentado',p_tipo)) ON CONFLICT DO NOTHING;
    RETURN 'no_autorizado';
  END IF;
  -- idempotencia del mensaje entrante
  INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, remitente, detalle)
  VALUES (g.id, g.cotizacion_id, CASE p_tipo WHEN 'sap' THEN 'respuesta_cs' ELSE 'respuesta_finanzas' END, p_dedupe, p_remitente,
          jsonb_build_object('valor', CASE WHEN p_tipo='sap' THEN p_valor END)) ON CONFLICT (dedupe_key) DO NOTHING;
  IF NOT FOUND THEN RETURN 'duplicado'; END IF;

  IF p_tipo = 'sap' THEN
    v_regex := (SELECT valor FROM public.pago_gestion_config WHERE clave='sap_regex');
    v_nuevo := btrim(p_valor);
    IF v_nuevo IS NULL OR v_regex IS NULL OR v_nuevo !~ v_regex THEN
      INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, remitente, detalle)
      VALUES (g.id, g.cotizacion_id, 'respuesta_ambigua', 'amb:'||p_dedupe, p_remitente, jsonb_build_object('motivo','sap_formato_no_reconocido','valor',left(p_valor,40))) ON CONFLICT DO NOTHING;
      RETURN 'sap_a_revision';
    END IF;
    IF g.sap_numero IS NULL THEN
      UPDATE public.pago_gestiones SET sap_numero=v_nuevo, sap_registrado_en=now(), sap_evento_dedupe=p_dedupe, updated_at=now() WHERE id=g.id;
    ELSIF g.sap_numero <> v_nuevo THEN
      INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, remitente, detalle)
      VALUES (g.id, g.cotizacion_id, 'discrepancia_sap', 'disc:'||p_dedupe, p_remitente, jsonb_build_object('original',g.sap_numero,'nuevo',v_nuevo)) ON CONFLICT DO NOTHING;
      RETURN 'discrepancia_sap';   -- el original NO se reemplaza
    END IF;
  ELSE
    IF g.fin_confirmado_en IS NULL THEN
      UPDATE public.pago_gestiones SET fin_confirmado_en=now(), fin_evento_dedupe=p_dedupe, updated_at=now() WHERE id=g.id;
    END IF;
  END IF;

  -- Avance de estado (evaluado tras CADA confirmación; cualquier orden)
  SELECT * INTO g FROM public.pago_gestiones WHERE id = p_gestion_id;
  SELECT id, estado INTO c FROM public.cotizaciones WHERE id = g.cotizacion_id FOR UPDATE;
  IF g.fin_confirmado_en IS NOT NULL AND g.sap_numero IS NOT NULL AND c.estado IN ('Pago informado','Pago validado') THEN
    UPDATE public.cotizaciones SET estado='Pedido ingresado al sistema',
       historial = historial || jsonb_build_object('estado','Pedido ingresado al sistema','fecha',now(),'origen','gestion_interna')
    WHERE id = c.id;
    UPDATE public.pago_gestiones SET pedido_aplicado_en=now(), updated_at=now() WHERE id=g.id AND pedido_aplicado_en IS NULL;
    RETURN 'pedido_ingresado';
  ELSIF p_tipo='finanzas' AND c.estado = 'Pago informado' THEN
    UPDATE public.cotizaciones SET estado='Pago validado',
       historial = historial || jsonb_build_object('estado','Pago validado','fecha',now(),'origen','gestion_interna') WHERE id = c.id;
    RETURN 'pago_validado';
  ELSIF g.fin_confirmado_en IS NOT NULL AND g.sap_numero IS NOT NULL THEN
    INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
    VALUES (g.id, g.cotizacion_id, 'estado_no_aplicable', 'sna:'||p_dedupe, jsonb_build_object('estado_actual',c.estado)) ON CONFLICT DO NOTHING;
    RETURN 'estado_no_aplicable';
  END IF;
  RETURN 'registrado';
END $f$;

CREATE FUNCTION public.pago_gestion_registrar_entrega(p_resend_id text, p_estado text, p_dedupe text, p_detalle jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE g public.pago_gestiones;
BEGIN
  IF p_estado NOT IN ('entregado','rebotado','queja','retrasado') THEN RAISE EXCEPTION 'estado invalido'; END IF;
  SELECT * INTO g FROM public.pago_gestiones WHERE resend_id = p_resend_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
  VALUES (g.id, g.cotizacion_id, 'entrega_resend', p_dedupe, p_detalle) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.pago_gestiones SET entrega_estado = CASE WHEN g.entrega_estado='rebotado' THEN 'rebotado' ELSE p_estado END,
         entrega_en = now(), updated_at = now() WHERE id = g.id;
  RETURN true;
END $f$;
REVOKE ALL ON FUNCTION public.pago_gestion_registrar_confirmacion(uuid,text,text,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pago_gestion_registrar_entrega(text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pago_gestion_registrar_confirmacion(uuid,text,text,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.pago_gestion_registrar_entrega(text,text,text,jsonb) TO service_role;
COMMIT;
