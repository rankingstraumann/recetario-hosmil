-- ============================================================================
-- B4 - Soporte de RECEPCION de respuestas (Fase E). SOLO LOCAL hasta que Daniel autorice. Requiere B1 y B3. Atomica.
-- Tres funciones internas (solo service_role). No toca tablas existentes ni RPC publicas.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Resuelve el token del hilo (Reply-To) a la gestion. recibe=true solo si el correo interno YA salio (aceptado) o pudo haber salido (incierto).
CREATE FUNCTION public.pago_gestion_resolver_respuesta(p_token text)
RETURNS TABLE(gestion_id uuid, cotizacion_id uuid, estado_envio text, institucion_codigo text, recibe boolean, modificable boolean)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $f$
  SELECT g.id, g.cotizacion_id, g.estado_envio, g.institucion_codigo, g.estado_envio IN ('aceptado','incierto'), public.pago_gestion_puede_modificar(g.cotizacion_id)
  FROM public.pago_gestiones g WHERE length(coalesce(p_token,'')) = 32 AND g.reply_token = p_token $f$;

-- Rol del remitente segun la lista autorizada (null = no autorizado o inactivo). La decision final sigue en pago_gestion_registrar_confirmacion.
CREATE FUNCTION public.pago_remitente_rol(p_email text) RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $f$
  SELECT a.rol FROM public.pago_remitentes_autorizados a WHERE a.activo AND a.email = lower(btrim(coalesce(p_email,''))) $f$;

-- Respuesta AMBIGUA de un remitente autorizado: solo queda un evento para revision manual. NUNCA cambia estados ni SAP.
CREATE FUNCTION public.pago_gestion_registrar_ambigua(p_gestion_id uuid, p_dedupe text, p_remitente text, p_motivo text, p_extracto text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE g public.pago_gestiones;
BEGIN
  IF coalesce((SELECT valor FROM public.pago_gestion_config WHERE clave='confirmaciones_activo'),'false') <> 'true' THEN RETURN 'desactivado'; END IF;
  SELECT * INTO g FROM public.pago_gestiones WHERE id = p_gestion_id;
  IF NOT FOUND THEN RETURN 'gestion_inexistente'; END IF;
  IF g.estado_envio = 'omitido_historico' THEN RETURN 'ignorado_historico'; END IF;
  IF NOT public.pago_gestion_puede_modificar(g.cotizacion_id) THEN RETURN 'bloqueado_modo_prueba'; END IF;   -- modo prueba: nada se escribe sobre cotizaciones reales
  IF public.pago_remitente_rol(p_remitente) IS NULL THEN RETURN 'no_autorizado'; END IF;
  INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, remitente, detalle)
  VALUES (g.id, g.cotizacion_id, 'respuesta_ambigua', 'amb:'||p_dedupe, left(p_remitente,200),
          jsonb_build_object('motivo', left(p_motivo,80), 'extracto', left(p_extracto,300))) ON CONFLICT (dedupe_key) DO NOTHING;
  IF NOT FOUND THEN RETURN 'duplicado'; END IF;
  RETURN 'ambigua_registrada';
END $f$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['pago_gestion_resolver_respuesta(text)','pago_remitente_rol(text)','pago_gestion_registrar_ambigua(uuid,text,text,text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP; END $$;
COMMIT;
