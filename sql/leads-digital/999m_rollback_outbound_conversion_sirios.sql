-- Rollback de 016 (Outbound 9B). ORDEN: primero restaurar get_prospect_timeline (version 015, sin las columnas nuevas), luego dropear la RPC y las columnas.
-- ATENCION: DROP COLUMN elimina los datos comerciales (perfil/ruta/interes/CTA) de los leads. Respaldar antes:
--   SELECT id, customer_profile, commercial_route, product_interest, cta_selected FROM public.digital_leads WHERE customer_profile IS NOT NULL OR commercial_route IS NOT NULL OR product_interest IS NOT NULL OR cta_selected IS NOT NULL;
-- NO revierte prospectos ya convertidos (outreach_status/linked_lead_id): si se necesita, hacerlo manualmente solo para prospectos de PRUEBA:
--   UPDATE public.digital_prospects SET outreach_status='replied', linked_lead_id=NULL WHERE is_test AND outreach_status='converted';
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
    SELECT jsonb_build_object('id', l.id, 'created_at', l.created_at, 'score', l.score, 'temperature', l.temperature, 'status', l.status, 'is_test', l.is_test)
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

DROP FUNCTION IF EXISTS public.complete_outbound_conversion(uuid, uuid, jsonb, text);
ALTER TABLE public.digital_leads
  DROP CONSTRAINT IF EXISTS digital_leads_customer_profile_check,
  DROP CONSTRAINT IF EXISTS digital_leads_commercial_route_check,
  DROP CONSTRAINT IF EXISTS digital_leads_product_interest_check,
  DROP CONSTRAINT IF EXISTS digital_leads_cta_selected_check;
ALTER TABLE public.digital_leads
  DROP COLUMN IF EXISTS customer_profile,
  DROP COLUMN IF EXISTS commercial_route,
  DROP COLUMN IF EXISTS product_interest,
  DROP COLUMN IF EXISTS cta_selected;
