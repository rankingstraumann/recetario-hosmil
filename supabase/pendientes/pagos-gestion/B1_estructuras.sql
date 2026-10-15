-- ============================================================================
-- B1 — Estructuras de gestión interna de pagos (SIN trigger, SIN envíos, SIN cambios a tablas existentes)
-- Solo agrega objetos nuevos. No toca cotizaciones, cotizacion_pagos, RPCs ni correos existentes.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Precondición: los códigos de institución de las reglas existen en producción
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM (VALUES ('UDP'),('UNAB'),('UMAYOR'),('HOSMIL'),('PDI'),('ARMADA'),('UMAYORT')) v(c)
             WHERE NOT EXISTS (SELECT 1 FROM public.instituciones i WHERE i.codigo = v.c)) THEN
    RAISE EXCEPTION 'B1 abortada: falta algún codigo de institucion esperado';
  END IF;
END $$;

-- 1. Configuración / interruptores
CREATE TABLE public.pago_gestion_config (
  clave text PRIMARY KEY, valor text NOT NULL, nota text, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.pago_gestion_config(clave, valor, nota) VALUES
 ('encolado_activo','true','Trigger encola gestiones. false = el trigger no hace nada.'),
 ('envio_activo','false','Reclamo/envío. false = nada sale (apagado por defecto).'),
 ('confirmaciones_activo','false','Aplicación de respuestas CS/Finanzas (SAP / validación). false = no se aplica nada.'),
 ('modo','prueba','Cualquier valor distinto de exactamente real = PRUEBA (fail-closed): solo destinatario_prueba, sin CC ni BCC.'),
 ('destinatario_prueba','daniel.jordan@straumann.com','Único destinatario en modo prueba.'),
 ('sap_regex','^[0-9]{10}$','PROVISIONAL: formato de referencia. Un número que no calce va a revisión manual, nunca se descarta ni se corrige.');

-- 2. Destinatarios
CREATE TABLE public.pago_gestion_destinatarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('to','cc_fijo','cc_institucion')),
  institucion_codigo text,
  email text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'cc_institucion') = (institucion_codigo IS NOT NULL)));
CREATE UNIQUE INDEX pago_gestion_destinatarios_uq ON public.pago_gestion_destinatarios (tipo, coalesce(institucion_codigo,''), email);
INSERT INTO public.pago_gestion_destinatarios(tipo, institucion_codigo, email) VALUES
 ('to',NULL,'m.cl.customerservicechile@straumann.com'),
 ('to',NULL,'cobranza.cl@straumann.com'),
 ('cc_fijo',NULL,'daniel.jordan@straumann.com'),
 ('cc_institucion','UDP','isleinny.rojas@straumann.com'),
 ('cc_institucion','UNAB','isleinny.rojas@straumann.com'),
 ('cc_institucion','UMAYOR','isleinny.rojas@straumann.com'),
 ('cc_institucion','HOSMIL','gloria.trejos@straumann.com'),
 ('cc_institucion','PDI','gerardo.salgado@neodent.com'),
 ('cc_institucion','ARMADA','hebeline.salas@straumann.com'),
 ('cc_institucion','UMAYORT','bethania.henriquez@straumann.com');
-- UC: SIN regla a propósito (bloqueada hasta asignar ejecutivo)

-- 3. Remitentes autorizados a responder (lista blanca explícita)
CREATE TABLE public.pago_remitentes_autorizados (
  email text PRIMARY KEY CHECK (email = lower(email)),
  rol text NOT NULL CHECK (rol IN ('customer_service','finanzas')),
  tipo text NOT NULL DEFAULT 'individual' CHECK (tipo IN ('grupal','individual')),
  activo boolean NOT NULL DEFAULT true, nota text, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.pago_remitentes_autorizados(email, rol, tipo) VALUES
 ('m.cl.customerservicechile@straumann.com','customer_service','grupal'),
 ('cobranza.cl@straumann.com','finanzas','grupal');

-- 4. Gestión interna: UNA fila por cotización (idempotencia por UNIQUE)
CREATE TABLE public.pago_gestiones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cotizacion_id uuid NOT NULL UNIQUE REFERENCES public.cotizaciones(id) ON DELETE RESTRICT,   -- RESTRICT: protege la trazabilidad SAP/Finanzas ante borrados accidentales
  origen text NOT NULL DEFAULT 'sistema' CHECK (origen IN ('paciente','admin','sistema')),
  institucion_codigo text,
  estado_envio text NOT NULL DEFAULT 'pendiente' CHECK (estado_envio IN
     ('pendiente','enviando','aceptado','incierto','error','bloqueado_sin_regla','omitido_historico','no_elegible')),
  entrega_estado text CHECK (entrega_estado IN ('entregado','rebotado','queja','retrasado')),  -- distinto de "aceptado por Resend"
  intentos int NOT NULL DEFAULT 0,
  ultimo_error text,
  reclamado_hasta timestamptz,
  reply_token text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text,'-',''),
  resend_id text, asunto text, destinatarios_to text[], destinatarios_cc text[],
  cobertura jsonb,
  solicitado_en timestamptz NOT NULL DEFAULT now(), enviado_en timestamptz, entrega_en timestamptz,
  sap_numero text CHECK (sap_numero IS NULL OR length(btrim(sap_numero)) BETWEEN 1 AND 30),
  sap_registrado_en timestamptz, sap_evento_dedupe text,
  fin_confirmado_en timestamptz, fin_evento_dedupe text,
  pedido_aplicado_en timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX pago_gestiones_estado_idx ON public.pago_gestiones (estado_envio) WHERE estado_envio IN ('pendiente','enviando','error','incierto','bloqueado_sin_regla','no_elegible');
CREATE UNIQUE INDEX pago_gestiones_resend_idx ON public.pago_gestiones (resend_id) WHERE resend_id IS NOT NULL;

-- 5. Eventos (entrantes, entrega, errores, revisión manual). dedupe_key UNIQUE = procesamiento idempotente
CREATE TABLE public.pago_gestion_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gestion_id uuid,   -- sin FK a propósito: la bitácora de errores no debe depender de locks sobre pago_gestiones
  cotizacion_id uuid,
  tipo text NOT NULL CHECK (tipo IN ('actividad_posterior','sin_regla','respuesta_cs','respuesta_finanzas',
        'respuesta_no_autorizada','respuesta_ambigua','discrepancia_sap','entrega_resend','estado_no_aplicable','no_elegible','error_tecnico')),
  dedupe_key text NOT NULL UNIQUE,
  remitente text, detalle jsonb,
  revisado_en timestamptz, revisado_por text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX pago_gestion_eventos_rev_idx ON public.pago_gestion_eventos (created_at) WHERE revisado_en IS NULL AND tipo <> 'entrega_resend';

-- 6. Privilegios: Supabase concede ALL por defecto a anon/authenticated => se revoca explícitamente
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pago_gestion_config','pago_gestion_destinatarios','pago_remitentes_autorizados','pago_gestiones','pago_gestion_eventos'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP; END $$;
-- Lectura del N° SAP para el Admin: la tabla pago_gestiones queda PRIVADA (sin GRANT ni policy para anon/authenticated).
-- El Admin usa esta funcion de solo lectura, que devuelve unicamente (cotizacion_id, sap_numero) y SOLO de las cotizaciones que el usuario
-- ya puede ver: replica exactamente la policy SELECT de public.cotizaciones ("lectura segun permisos de institucion").
CREATE FUNCTION public.pago_sap_visibles() RETURNS TABLE (cotizacion_id uuid, sap_numero text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT g.cotizacion_id, g.sap_numero
  FROM public.pago_gestiones g JOIN public.cotizaciones c ON c.id = g.cotizacion_id
  WHERE g.sap_numero IS NOT NULL AND auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.admin_perfiles p WHERE p.user_id = auth.uid() AND (COALESCE(p.es_super_admin,false) OR COALESCE(p.es_observador,false)))
    OR EXISTS (SELECT 1 FROM public.admin_instituciones_permitidas i WHERE i.user_id = auth.uid() AND i.institucion_codigo = c.institucion_codigo));
$f$;
REVOKE ALL ON FUNCTION public.pago_sap_visibles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pago_sap_visibles() TO authenticated, service_role;

-- 7. Funciones internas (solo service_role)
CREATE FUNCTION public.pago_gestion_crear(p_cotizacion_id uuid, p_origen text DEFAULT 'sistema') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE c record; v_pagado numeric; v_n int; v_regla boolean; v_id uuid;
BEGIN
  SELECT id, institucion_codigo, total INTO c FROM public.cotizaciones WHERE id = p_cotizacion_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT coalesce(sum(monto),0), count(*) INTO v_pagado, v_n FROM public.cotizacion_pagos WHERE cotizacion_id = c.id;
  v_regla := c.institucion_codigo IS NOT NULL AND EXISTS (SELECT 1 FROM public.pago_gestion_destinatarios d
             WHERE d.tipo='cc_institucion' AND d.activo AND d.institucion_codigo = c.institucion_codigo);
  INSERT INTO public.pago_gestiones(cotizacion_id, origen, institucion_codigo, estado_envio, ultimo_error, cobertura)
  VALUES (c.id, p_origen, c.institucion_codigo, CASE WHEN v_regla THEN 'pendiente' ELSE 'bloqueado_sin_regla' END,
          CASE WHEN v_regla THEN NULL ELSE 'sin_regla_destinatarios:'||coalesce(c.institucion_codigo,'NULL') END,
          jsonb_build_object('pagado',v_pagado,'total',c.total,'n_pagos',v_n,'cubre',v_pagado >= c.total))
  ON CONFLICT (cotizacion_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL AND NOT v_regla THEN
    INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
    VALUES (v_id, c.id, 'sin_regla', 'sinregla:'||v_id, jsonb_build_object('institucion_codigo', c.institucion_codigo)) ON CONFLICT DO NOTHING;
  END IF;
  RETURN v_id;
END $f$;

-- ÚNICO punto que decide destinatarios. Fail-closed: solo el valor exacto 'real' habilita TO/CC reales.
-- En cualquier otro caso (prueba, vacío, typo, config ausente) => solo destinatario_prueba, y SOLO si ese correo es un CC fijo interno (Daniel).
CREATE FUNCTION public.pago_gestion_destinatarios_de(p_institucion_codigo text)
RETURNS TABLE(to_emails text[], cc_emails text[], tiene_regla boolean, es_prueba boolean)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $f$
DECLARE v_modo text; v_prueba text; v_regla boolean;
BEGIN
  v_modo := (SELECT valor FROM public.pago_gestion_config WHERE clave='modo');
  v_regla := EXISTS (SELECT 1 FROM public.pago_gestion_destinatarios WHERE tipo='cc_institucion' AND activo AND institucion_codigo = p_institucion_codigo);
  IF v_modo IS NOT DISTINCT FROM 'real' THEN
    RETURN QUERY SELECT CASE WHEN v_regla THEN (SELECT array_agg(DISTINCT d.email ORDER BY d.email) FROM public.pago_gestion_destinatarios d WHERE d.tipo='to' AND d.activo) ELSE '{}'::text[] END,
                        CASE WHEN v_regla THEN (SELECT array_agg(DISTINCT d.email ORDER BY d.email) FROM public.pago_gestion_destinatarios d WHERE d.activo AND (d.tipo='cc_fijo' OR (d.tipo='cc_institucion' AND d.institucion_codigo = p_institucion_codigo))) ELSE '{}'::text[] END,
                        v_regla, false;
  ELSE
    v_prueba := lower(btrim((SELECT valor FROM public.pago_gestion_config WHERE clave='destinatario_prueba')));
    IF v_prueba IS NULL OR NOT EXISTS (SELECT 1 FROM public.pago_gestion_destinatarios d WHERE d.tipo='cc_fijo' AND d.activo AND d.email = v_prueba) THEN
      RETURN QUERY SELECT '{}'::text[], '{}'::text[], false, true;           -- destinatario de prueba inválido => no se envía a nadie
    ELSE
      RETURN QUERY SELECT ARRAY[v_prueba], '{}'::text[], v_regla, true;      -- sin CC, sin ejecutivos, sin CS/Finanzas
    END IF;
  END IF;
END $f$;

-- Guardia que el emisor DEBE llamar justo antes de Resend con lo que realmente va a enviar. true = permitido.
CREATE FUNCTION public.pago_gestion_validar_envio(p_institucion_codigo text, p_to text[], p_cc text[], p_bcc text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $f$
DECLARE d record; v_to text[]; v_cc text[];
BEGIN
  IF coalesce(cardinality(p_bcc),0) > 0 THEN RETURN false; END IF;           -- ningún BCC (no heredar RESEND_BCC_*)
  SELECT * INTO d FROM public.pago_gestion_destinatarios_de(p_institucion_codigo);
  IF coalesce(cardinality(d.to_emails),0) = 0 THEN RETURN false; END IF;
  v_to := (SELECT array_agg(DISTINCT lower(x) ORDER BY lower(x)) FROM unnest(coalesce(p_to,'{}')) x);
  v_cc := (SELECT array_agg(DISTINCT lower(x) ORDER BY lower(x)) FROM unnest(coalesce(p_cc,'{}')) x);
  RETURN v_to IS NOT DISTINCT FROM d.to_emails AND coalesce(v_cc,'{}') IS NOT DISTINCT FROM coalesce(d.cc_emails,'{}');
END $f$;

-- ELEGIBILIDAD DE ENVÍO: null = elegible; texto = motivo. Fuente única para reclamar, para el emisor (justo antes de Resend) y para el barrido.
-- Una gestión solo se envía si la cotización: existe, no está eliminada lógicamente, no está anulada, sigue EXACTAMENTE en "Pago informado"
-- (si Nicole/Finanzas ya la movieron a mano, no se envía) y el pago acumulado cubre el total.
CREATE FUNCTION public.pago_gestion_motivo_no_elegible(p_cotizacion_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $f$
DECLARE c record; v_pagado numeric;
BEGIN
  SELECT estado, total, deleted_at INTO c FROM public.cotizaciones WHERE id = p_cotizacion_id;
  IF NOT FOUND THEN RETURN 'cotizacion_inexistente'; END IF;
  IF c.deleted_at IS NOT NULL THEN RETURN 'eliminada_logicamente'; END IF;
  IF c.estado = 'Anulado' THEN RETURN 'anulada'; END IF;
  IF c.estado IS DISTINCT FROM 'Pago informado' THEN RETURN 'estado_actual:'||coalesce(c.estado,'NULL'); END IF;
  SELECT coalesce(sum(monto),0) INTO v_pagado FROM public.cotizacion_pagos WHERE cotizacion_id = p_cotizacion_id;
  IF v_pagado < c.total THEN RETURN 'pago_acumulado_no_cubre_total'; END IF;
  RETURN NULL;
END $f$;

-- El emisor la llama si, ya reclamada una gestión, justo antes de Resend descubre que dejó de ser elegible. Nunca se envía.
CREATE FUNCTION public.pago_gestion_soltar(p_id uuid, p_motivo text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE g public.pago_gestiones;
BEGIN
  UPDATE public.pago_gestiones SET estado_envio='no_elegible', ultimo_error=left(p_motivo,200), reclamado_hasta=NULL, updated_at=now()
  WHERE id = p_id AND estado_envio = 'enviando' RETURNING * INTO g;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
  VALUES (g.id, g.cotizacion_id, 'no_elegible', 'ne:'||g.id||':'||md5(coalesce(p_motivo,'')), jsonb_build_object('motivo',p_motivo,'momento','pre_envio')) ON CONFLICT DO NOTHING;
  RETURN true;
END $f$;

-- Barrido (cron, Fase C+): marca no_elegible lo pendiente/error que dejó de serlo (visible para revisión) y REACTIVA lo que volvió a serlo
-- (p. ej. el paciente avisó "pago realizado" y luego completó el monto). Solo toca gestiones que NUNCA se enviaron.
CREATE FUNCTION public.pago_gestion_revisar_elegibilidad() RETURNS TABLE(marcadas int, reactivadas int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE r record; m int := 0; a int := 0; v_motivo text;
BEGIN
  FOR r IN SELECT g.id, g.cotizacion_id, g.estado_envio FROM public.pago_gestiones g
           WHERE g.estado_envio IN ('pendiente','error','no_elegible') AND g.enviado_en IS NULL AND g.resend_id IS NULL LOOP
    v_motivo := public.pago_gestion_motivo_no_elegible(r.cotizacion_id);
    IF v_motivo IS NOT NULL AND r.estado_envio <> 'no_elegible' THEN
      UPDATE public.pago_gestiones SET estado_envio='no_elegible', ultimo_error=left(v_motivo,200), updated_at=now() WHERE id=r.id;
      INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
      VALUES (r.id, r.cotizacion_id, 'no_elegible', 'ne:'||r.id||':'||md5(v_motivo), jsonb_build_object('motivo',v_motivo,'momento','barrido')) ON CONFLICT DO NOTHING;
      m := m + 1;
    ELSIF v_motivo IS NULL AND r.estado_envio = 'no_elegible' THEN
      UPDATE public.pago_gestiones g SET ultimo_error=NULL, updated_at=now(),
             estado_envio = CASE WHEN EXISTS (SELECT 1 FROM public.pago_gestion_destinatarios d WHERE d.tipo='cc_institucion' AND d.activo AND d.institucion_codigo=g.institucion_codigo) THEN 'pendiente' ELSE 'bloqueado_sin_regla' END
      WHERE g.id = r.id;
      a := a + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT m, a;
END $f$;

CREATE FUNCTION public.pago_gestion_reclamar(p_limite int DEFAULT 5)
RETURNS TABLE(gestion_id uuid, cotizacion_id uuid, reply_token text, intentos int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  IF coalesce((SELECT valor FROM public.pago_gestion_config WHERE clave='envio_activo'),'false') <> 'true' THEN RETURN; END IF;
  RETURN QUERY
  WITH cand AS (
    SELECT g.id FROM public.pago_gestiones g
    WHERE (g.estado_envio = 'pendiente' OR (g.estado_envio = 'error' AND g.intentos < 3 AND g.updated_at < now() - interval '15 minutes'))
      AND public.pago_gestion_motivo_no_elegible(g.cotizacion_id) IS NULL   -- anulada / eliminada / ya movida / pago no cubre total => NUNCA se reclama
    ORDER BY g.solicitado_en LIMIT least(greatest(p_limite,1),20) FOR UPDATE SKIP LOCKED)
  UPDATE public.pago_gestiones g SET estado_envio='enviando', intentos=g.intentos+1, reclamado_hasta=now()+interval '10 minutes', updated_at=now()
  FROM cand WHERE g.id = cand.id
  RETURNING g.id, g.cotizacion_id, g.reply_token, g.intentos;
END $f$;

CREATE FUNCTION public.pago_gestion_finalizar_envio(p_id uuid, p_ok boolean, p_resend_id text, p_asunto text, p_to text[], p_cc text[], p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  UPDATE public.pago_gestiones SET
     estado_envio = CASE WHEN p_ok THEN 'aceptado' ELSE 'error' END,
     resend_id = coalesce(p_resend_id, resend_id), asunto = coalesce(p_asunto, asunto),
     destinatarios_to = coalesce(p_to, destinatarios_to), destinatarios_cc = coalesce(p_cc, destinatarios_cc),
     enviado_en = CASE WHEN p_ok THEN now() ELSE enviado_en END,
     ultimo_error = CASE WHEN p_ok THEN NULL ELSE left(p_error,500) END, reclamado_hasta = NULL, updated_at = now()
  WHERE id = p_id AND estado_envio IN ('enviando','incierto');
  RETURN FOUND;
END $f$;

CREATE FUNCTION public.pago_gestion_marcar_inciertas() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE n int;
BEGIN
  WITH u AS (UPDATE public.pago_gestiones SET estado_envio='incierto', updated_at=now()
             WHERE estado_envio='enviando' AND reclamado_hasta < now() RETURNING id, cotizacion_id, intentos)
  INSERT INTO public.pago_gestion_eventos(gestion_id, cotizacion_id, tipo, dedupe_key, detalle)
  SELECT id, cotizacion_id, 'error_tecnico', 'incierto:'||id||':'||intentos,
         jsonb_build_object('msg','envio sin confirmacion de registro; NO se reenvia automaticamente; verificar en Resend') FROM u ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $f$;

CREATE FUNCTION public.pago_gestion_reconciliar() RETURNS int   -- red de seguridad si el trigger falló
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT c.id FROM public.cotizaciones c WHERE c.deleted_at IS NULL AND c.estado='Pago informado'
           AND NOT EXISTS (SELECT 1 FROM public.pago_gestiones g WHERE g.cotizacion_id=c.id) LOOP
    IF public.pago_gestion_crear(r.id,'sistema') IS NOT NULL THEN n := n+1; END IF;
  END LOOP; RETURN n;
END $f$;

CREATE FUNCTION public.pago_gestion_liberar_bloqueadas() RETURNS int   -- tras asignar ejecutivo a una institución
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  WITH u AS (UPDATE public.pago_gestiones g SET estado_envio='pendiente', ultimo_error=NULL, updated_at=now()
             WHERE g.estado_envio='bloqueado_sin_regla' AND EXISTS (SELECT 1 FROM public.pago_gestion_destinatarios d
               WHERE d.tipo='cc_institucion' AND d.activo AND d.institucion_codigo=g.institucion_codigo) RETURNING 1)
  SELECT count(*)::int FROM u $f$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['pago_gestion_crear(uuid,text)','pago_gestion_destinatarios_de(text)','pago_gestion_validar_envio(text,text[],text[],text[])','pago_gestion_motivo_no_elegible(uuid)','pago_gestion_soltar(uuid,text)','pago_gestion_revisar_elegibilidad()','pago_gestion_reclamar(int)',
     'pago_gestion_finalizar_envio(uuid,boolean,text,text,text[],text[],text)','pago_gestion_marcar_inciertas()','pago_gestion_reconciliar()','pago_gestion_liberar_bloqueadas()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP; END $$;

-- 8. Histórico: lo ya gestionado a mano NUNCA genera correo (solo marca, no envía)
INSERT INTO public.pago_gestiones(cotizacion_id, origen, institucion_codigo, estado_envio)
SELECT c.id, 'sistema', c.institucion_codigo, 'omitido_historico'
FROM public.cotizaciones c
WHERE c.estado NOT IN ('Borrador','Cotización generada','Enviada al paciente','Pendiente de pago','Pagado parcialmente')
  AND (c.estado <> 'Anulado' OR EXISTS (SELECT 1 FROM public.cotizacion_pagos p WHERE p.cotizacion_id=c.id)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(c.historial,'[]'::jsonb)) h WHERE h->>'estado'='Pago informado'))
ON CONFLICT (cotizacion_id) DO NOTHING;
COMMIT;
