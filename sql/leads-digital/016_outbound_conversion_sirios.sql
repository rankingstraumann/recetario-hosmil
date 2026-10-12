-- LEADS DIGITAL · OUTBOUND 9B -- Activacion TEST + conversion prospecto -> lead + trazabilidad. ADITIVA. Preparada, NO aplicada sin autorizacion.
--  1) digital_leads: 4 columnas NULLABLE con CHECK (perfil, ruta comercial, interes de producto, CTA). No rompe leads existentes (todo NULL).
--  2) complete_outbound_conversion(session, prospecto, campos, resumen): conversion ATOMICA e IDEMPOTENTE (una sola transaccion).
--       Solo service_role (la llama la Edge Function whatsapp-webhook). Barreras en BD (independientes del frontend y de la Edge Function):
--       prospecto is_test=true, consentimiento 'yes', no opted_out, envio 'sent' valido, la sesion corresponde al prospecto (telefono + context.o.prospect_id),
--       un prospecto jamas apunta a dos leads. NO toca consentimiento. El scoring lo calcula el trigger existente (score_digital_lead): sin cambios.
--  3) get_prospect_timeline: la conversion ahora incluye perfil / ruta / interes / CTA / intencion fuerte (sin contenido de mensajes ni PII).

-- ---------------------------------------------------------------- 1) columnas
ALTER TABLE public.digital_leads
  ADD COLUMN IF NOT EXISTS customer_profile  text,
  ADD COLUMN IF NOT EXISTS commercial_route  text,
  ADD COLUMN IF NOT EXISTS product_interest  text,
  ADD COLUMN IF NOT EXISTS cta_selected      text;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'digital_leads_customer_profile_check' AND conrelid = 'public.digital_leads'::regclass) THEN
    ALTER TABLE public.digital_leads ADD CONSTRAINT digital_leads_customer_profile_check
      CHECK (customer_profile IS NULL OR customer_profile IN ('owner_partner','clinician','postgraduate','explorer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'digital_leads_commercial_route_check' AND conrelid = 'public.digital_leads'::regclass) THEN
    ALTER TABLE public.digital_leads ADD CONSTRAINT digital_leads_commercial_route_check
      CHECK (commercial_route IS NULL OR commercial_route IN ('trade_up','first_scanner','renewal_workflow','postgraduate_influencer','exploration'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'digital_leads_product_interest_check' AND conrelid = 'public.digital_leads'::regclass) THEN
    ALTER TABLE public.digital_leads ADD CONSTRAINT digital_leads_product_interest_check
      CHECK (product_interest IS NULL OR product_interest IN ('sirios','sirios_x3','compare','undecided'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'digital_leads_cta_selected_check' AND conrelid = 'public.digital_leads'::regclass) THEN
    ALTER TABLE public.digital_leads ADD CONSTRAINT digital_leads_cta_selected_check
      CHECK (cta_selected IS NULL OR cta_selected IN ('request_evaluation','trade_up_evaluation','demo','specialist','financing','share_clinic','compare','learn_sirios','learn_sirios_x3','information'));
  END IF;
END
$c$;

-- ---------------------------------------------------------------- 2) conversion atomica
CREATE OR REPLACE FUNCTION public.complete_outbound_conversion(p_session_id uuid, p_prospect_id uuid, p_fields jsonb, p_summary text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  p        record;
  s        record;
  l        record;
  v_f      jsonb := COALESCE(p_fields, '{}'::jsonb);
  v_lead   uuid;
  v_new    boolean := false;
  v_was    text;
  v_hi     boolean := (v_f ->> 'high_intent') = 'true';
  v_uses   boolean := CASE WHEN jsonb_typeof(v_f -> 'uses_intraoral_scanner') = 'boolean' THEN (v_f ->> 'uses_intraoral_scanner')::boolean END;
  v_demo   boolean := CASE WHEN jsonb_typeof(v_f -> 'wants_demo') = 'boolean' THEN (v_f ->> 'wants_demo')::boolean END;
  v_quote  boolean := CASE WHEN jsonb_typeof(v_f -> 'wants_quote') = 'boolean' THEN (v_f ->> 'wants_quote')::boolean END;
  v_scan   text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(v_f ->> 'current_scanner', '')), 60), '');
  v_need   text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'need', '')), '');
  v_tl     text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'purchase_timeline', '')), '');
  v_name   text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(v_f ->> 'contact_name', '')), 80), '');
  v_clin   text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(v_f ->> 'clinic_name', '')), 100), '');
  v_comm   text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(v_f ->> 'commune', '')), 60), '');
  v_prof   text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'customer_profile', '')), '');
  v_route  text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'commercial_route', '')), '');
  v_prod   text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'product_interest', '')), '');
  v_cta    text := NULLIF(pg_catalog.btrim(COALESCE(v_f ->> 'cta_selected', '')), '');
  v_why    text := CASE WHEN v_hi THEN NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(v_f ->> 'high_intent_reason', '')), 160), '') END;
  v_sum    text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(p_summary, '')), 800), '');
BEGIN
  IF p_session_id IS NULL OR p_prospect_id IS NULL THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;

  -- 1) bloquear prospecto y sesion
  SELECT * INTO p FROM public.digital_prospects WHERE id = p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_ENCONTRADO'; END IF;
  SELECT * INTO s FROM public.digital_lead_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESION_NO_ENCONTRADA'; END IF;

  -- 2) barreras (TEST-ONLY: un prospecto REAL jamas se convierte por este camino)
  IF p.is_test IS NOT TRUE THEN RAISE EXCEPTION 'PROSPECTO_REAL_NO_PERMITIDO'; END IF;
  IF p.whatsapp_consent <> 'yes' THEN RAISE EXCEPTION 'SIN_CONSENTIMIENTO'; END IF;
  IF p.outreach_status = 'opted_out' THEN RAISE EXCEPTION 'PROSPECTO_OPT_OUT'; END IF;
  IF p.outreach_status NOT IN ('contacted', 'replied', 'converted') THEN RAISE EXCEPTION 'ESTADO_NO_VALIDO'; END IF;
  IF p.outreach_status = 'converted' AND p.linked_lead_id IS NULL THEN RAISE EXCEPTION 'ESTADO_NO_VALIDO'; END IF;
  IF p.phone_e164 IS NULL OR s.phone_e164 IS DISTINCT FROM p.phone_e164
     OR (s.context ->> 'journey') IS DISTINCT FROM 'outbound_sirios'
     OR (s.context -> 'o' ->> 'prospect_id') IS DISTINCT FROM p.id::text THEN RAISE EXCEPTION 'SESION_NO_CORRESPONDE'; END IF;
  IF p.outreach_status IN ('contacted', 'replied')
     AND NOT EXISTS (SELECT 1 FROM public.digital_outbound_sends d WHERE d.prospect_id = p.id AND d.status = 'sent') THEN RAISE EXCEPTION 'SIN_ENVIO_VALIDO'; END IF;
  IF p.linked_lead_id IS NOT NULL AND s.lead_id IS NOT NULL AND p.linked_lead_id <> s.lead_id THEN RAISE EXCEPTION 'LEAD_CONFLICTO'; END IF;

  v_was := p.outreach_status;
  v_lead := COALESCE(p.linked_lead_id, s.lead_id);

  -- 3-5) crear o reutilizar el lead; persistir campos comerciales; la intencion fuerte activa el override (el trigger de scoring garantiza min 70)
  IF v_lead IS NOT NULL THEN
    SELECT * INTO l FROM public.digital_leads WHERE id = v_lead FOR UPDATE;
    IF NOT FOUND THEN v_lead := NULL; ELSIF l.is_test IS NOT TRUE THEN RAISE EXCEPTION 'LEAD_NO_ES_PRUEBA'; END IF;
  END IF;
  IF v_lead IS NULL THEN
    INSERT INTO public.digital_leads (source_channel, phone_e164, is_test, contact_name, clinic_name, commune, uses_intraoral_scanner, current_scanner, need,
                                      purchase_timeline, wants_demo, wants_quote, high_intent_override, high_intent_reason, ai_summary,
                                      customer_profile, commercial_route, product_interest, cta_selected)
    VALUES ('meta_whatsapp', p.phone_e164, true, v_name, v_clin, v_comm, v_uses, v_scan, v_need, v_tl, v_demo, v_quote, v_hi, v_why, v_sum,
            v_prof, v_route, v_prod, v_cta)
    RETURNING id INTO v_lead;
    v_new := true;
  ELSE
    UPDATE public.digital_leads SET
      contact_name = COALESCE(v_name, contact_name), clinic_name = COALESCE(v_clin, clinic_name), commune = COALESCE(v_comm, commune),
      uses_intraoral_scanner = COALESCE(v_uses, uses_intraoral_scanner), current_scanner = COALESCE(v_scan, current_scanner), need = COALESCE(v_need, need),
      purchase_timeline = COALESCE(v_tl, purchase_timeline), wants_demo = COALESCE(v_demo, wants_demo), wants_quote = COALESCE(v_quote, wants_quote),
      high_intent_override = (high_intent_override OR v_hi), high_intent_reason = COALESCE(high_intent_reason, v_why), ai_summary = COALESCE(v_sum, ai_summary),
      customer_profile = COALESCE(v_prof, customer_profile), commercial_route = COALESCE(v_route, commercial_route),
      product_interest = COALESCE(v_prod, product_interest), cta_selected = COALESCE(v_cta, cta_selected)
    WHERE id = v_lead;
  END IF;

  -- 6-7) vincular y convertir (un prospecto nunca apunta a dos leads: linked_lead_id es una sola columna y se valido el conflicto arriba)
  UPDATE public.digital_prospects SET linked_lead_id = v_lead, outreach_status = 'converted' WHERE id = p.id;
  UPDATE public.digital_lead_sessions SET lead_id = v_lead WHERE id = s.id AND lead_id IS DISTINCT FROM v_lead;
  UPDATE public.digital_lead_messages SET lead_id = v_lead WHERE session_id = s.id AND lead_id IS NULL;

  -- 8) auditoria (solo en la primera conversion; reprocesar no duplica)
  IF v_was <> 'converted' THEN
    INSERT INTO public.digital_lead_activities (lead_id, event_type, detail)
    VALUES (v_lead, 'outbound_sirios_conversion', jsonb_build_object('session_id', s.id, 'prospect_id', p.id, 'lead_created', v_new,
            'customer_profile', v_prof, 'commercial_route', v_route, 'product_interest', v_prod, 'cta_selected', v_cta, 'high_intent', v_hi));
  END IF;

  -- 9) resultado
  SELECT * INTO l FROM public.digital_leads WHERE id = v_lead;
  RETURN jsonb_build_object('lead_id', l.id, 'score', l.score, 'temperature', l.temperature, 'status', l.status,
                            'lead_created', v_new, 'already_converted', (v_was = 'converted'));
END
$f$;
REVOKE ALL ON FUNCTION public.complete_outbound_conversion(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_outbound_conversion(uuid, uuid, jsonb, text) TO service_role;

-- ---------------------------------------------------------------- 3) historial (Outbound 8): la conversion muestra el recorrido comercial
CREATE OR REPLACE FUNCTION public.get_prospect_timeline(p_prospect_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  p          record;
  v_events   jsonb;
  v_lead     jsonb := NULL;
  v_last     timestamptz;
  v_reply    timestamptz := NULL;
  v_shared   boolean := false;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_prospect_id IS NULL THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  SELECT id, import_id, source, source_detail, is_test, whatsapp_consent, consent_source, consent_at, outreach_status,
         last_outreach_at, linked_lead_id, phone_e164, created_at
    INTO p FROM public.digital_prospects WHERE id = p_prospect_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_ENCONTRADO'; END IF;

  -- lead asociado (si esta convertido)
  IF p.linked_lead_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', l.id, 'created_at', l.created_at, 'score', l.score, 'temperature', l.temperature, 'status', l.status, 'is_test', l.is_test,
           'customer_profile', l.customer_profile, 'commercial_route', l.commercial_route, 'product_interest', l.product_interest, 'cta_selected', l.cta_selected, 'high_intent', l.high_intent_override)
      INTO v_lead FROM public.digital_leads l WHERE l.id = p.linked_lead_id;
  END IF;

  -- respuesta: primer inbound del telefono posterior al ultimo envio exitoso
  IF p.outreach_status IN ('replied', 'converted') AND p.phone_e164 IS NOT NULL THEN
    SELECT COALESCE(max(s.sent_at), p.last_outreach_at) INTO v_last FROM public.digital_outbound_sends s WHERE s.prospect_id = p.id AND s.status = 'sent';
    IF v_last IS NOT NULL THEN
      SELECT min(m.created_at) INTO v_reply
        FROM public.digital_lead_messages m JOIN public.digital_lead_sessions se ON se.id = m.session_id
       WHERE m.direction = 'inbound' AND se.phone_e164 = p.phone_e164 AND m.created_at > v_last;
    END IF;
    SELECT EXISTS (SELECT 1 FROM public.digital_prospects o WHERE o.phone_e164 = p.phone_e164 AND o.id <> p.id) INTO v_shared;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('ts', e.ts, 'kind', e.kind, 'data', e.data) ORDER BY e.ts NULLS LAST, e.ord), '[]'::jsonb)
    INTO v_events
  FROM (
    SELECT COALESCE(i.created_at, p.created_at) AS ts, 1 AS ord, 'import'::text AS kind,
           jsonb_build_object('filename', i.filename, 'source_name', i.source_name, 'batch_is_test', i.is_test,
                              'source', p.source, 'source_detail', p.source_detail, 'prospect_is_test', p.is_test) AS data
      FROM (SELECT 1) one LEFT JOIN public.digital_prospect_imports i ON i.id = p.import_id
    UNION ALL
    SELECT en.created_at, 2, 'enrichment', jsonb_build_object('filename', en.filename, 'fields', to_jsonb(it.fields))
      FROM public.digital_prospect_enrichment_items it JOIN public.digital_prospect_enrichments en ON en.id = it.enrichment_id
     WHERE it.prospect_id = p.id
    UNION ALL
    SELECT cl.changed_at, 3, 'consent', jsonb_build_object('previous_state', cl.previous_state, 'new_state', cl.new_state, 'source', cl.source,
             'consent_date', cl.consent_date, 'note', cl.note, 'changed_by_email', cl.changed_by_email)
      FROM public.digital_prospect_consent_log cl WHERE cl.prospect_id = p.id
    UNION ALL
    SELECT iv.created_at, 4, 'invitation_created', jsonb_build_object('status', iv.status, 'expired', (iv.status = 'pending' AND iv.expires_at <= pg_catalog.now()),
             'expires_at', iv.expires_at, 'created_by_email', (SELECT u.email FROM auth.users u WHERE u.id = iv.created_by))
      FROM public.digital_prospect_consent_invitations iv WHERE iv.prospect_id = p.id
    UNION ALL
    SELECT iv.used_at, 5, 'invitation_used', jsonb_build_object('status', iv.status, 'decision', iv.decision,
             'text_version', iv.evidence ->> 'text_version', 'channel', iv.evidence ->> 'channel')
      FROM public.digital_prospect_consent_invitations iv WHERE iv.prospect_id = p.id AND iv.used_at IS NOT NULL
    UNION ALL
    SELECT sd.requested_at, 6, 'send', jsonb_build_object('template_name', sd.template_name, 'template_language', sd.template_language,
             'status', sd.status, 'completed_at', sd.completed_at, 'sent_at', sd.sent_at, 'provider_message_id', sd.provider_message_id,
             'error_code', sd.error_code, 'error_message', sd.error_message, 'requested_by_email', sd.requested_by_email)
      FROM public.digital_outbound_sends sd WHERE sd.prospect_id = p.id
    UNION ALL
    SELECT v_reply, 7, 'reply', jsonb_build_object('via', 'telefono', 'shared_phone', v_shared) WHERE v_reply IS NOT NULL
    UNION ALL
    SELECT (v_lead ->> 'created_at')::timestamptz, 8, 'conversion', v_lead WHERE v_lead IS NOT NULL
  ) e;

  RETURN jsonb_build_object(
    'prospect', jsonb_build_object('id', p.id, 'is_test', p.is_test, 'source', p.source, 'source_detail', p.source_detail,
        'outreach_status', p.outreach_status, 'last_outreach_at', p.last_outreach_at, 'whatsapp_consent', p.whatsapp_consent,
        'consent_source', p.consent_source, 'consent_at', p.consent_at, 'linked_lead_id', p.linked_lead_id),
    'lead', v_lead,
    'events', v_events);
END
$f$;
REVOKE ALL ON FUNCTION public.get_prospect_timeline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_prospect_timeline(uuid) TO authenticated;
