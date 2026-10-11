-- LEADS DIGITAL · OUTBOUND 6B -- Captura DIGITAL de consentimiento WhatsApp por link individual. Aditiva (sin DROP). No envia nada.
-- Flujo: Lead Admin genera invitacion -> cliente abre consentimiento-whatsapp.html?t=<token> -> acepta/rechaza -> registro auditado.
-- Seguridad:
--   * token = 32 bytes de gen_random_bytes (CSPRNG), base64url (43 car.). En la base SOLO se guarda su SHA-256. No contiene datos del prospecto.
--   * un solo uso (status pending -> accepted|rejected) y con vencimiento (expires_at). Vencido/usado/invalido => respuesta neutra, sin modificar nada.
--   * anon NO tiene acceso a ninguna tabla; solo EXECUTE de 2 RPC que exigen un token valido y operan UNICAMENTE sobre el prospecto asociado.
--   * reutiliza la auditoria de Outbound 6 (digital_prospect_consent_log) y su guardia trg_guard_prospect_consent.
--   * no crea prospectos, no cambia outreach_status, respeta opted_out (no se puede autorizar a quien se dio de baja).

CREATE TABLE IF NOT EXISTS public.digital_prospect_consent_invitations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id    uuid NOT NULL REFERENCES public.digital_prospects(id) ON DELETE CASCADE,
  token_hash     text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','revoked')),
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  decision       text CHECK (decision IS NULL OR decision IN ('granted','denied')),
  consent_log_id uuid REFERENCES public.digital_prospect_consent_log(id) ON DELETE SET NULL,
  evidence       jsonb,
  CHECK (expires_at > created_at),
  CHECK ((status IN ('accepted','rejected')) = (used_at IS NOT NULL AND decision IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpci_token_hash ON public.digital_prospect_consent_invitations (token_hash);
CREATE INDEX IF NOT EXISTS idx_dpci_prospect ON public.digital_prospect_consent_invitations (prospect_id, created_at DESC);

REVOKE ALL ON public.digital_prospect_consent_invitations FROM PUBLIC, anon, authenticated;
-- Lead Admin lee estado/fechas; NUNCA token_hash ni evidence (la evidencia se consulta con SQL de administracion).
GRANT SELECT (id, prospect_id, status, created_by, created_at, expires_at, used_at, decision, consent_log_id)
  ON public.digital_prospect_consent_invitations TO authenticated;
GRANT ALL ON public.digital_prospect_consent_invitations TO service_role;
ALTER TABLE public.digital_prospect_consent_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_prospect_consent_invitations_admin_select ON public.digital_prospect_consent_invitations
  FOR SELECT TO authenticated USING (public.is_lead_admin());

-- ---------------------------------------------------------------- Lead Admin: generar / revocar
CREATE OR REPLACE FUNCTION public.create_consent_invitation(p_prospect_id uuid, p_ttl_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  p       record;
  v_token text;
  v_id    uuid;
  v_exp   timestamptz;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_prospect_id IS NULL OR p_ttl_days IS NULL OR p_ttl_days < 1 OR p_ttl_days > 60 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  SELECT id, whatsapp_consent, outreach_status INTO p FROM public.digital_prospects WHERE id = p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_ENCONTRADO'; END IF;
  IF p.outreach_status = 'opted_out' THEN RAISE EXCEPTION 'PROSPECTO_DADO_DE_BAJA'; END IF;
  IF p.whatsapp_consent <> 'unknown' THEN RAISE EXCEPTION 'CONSENTIMIENTO_YA_DEFINIDO'; END IF;

  -- un solo link vigente por prospecto: los pendientes aun vigentes quedan revocados
  UPDATE public.digital_prospect_consent_invitations SET status = 'revoked'
   WHERE prospect_id = p_prospect_id AND status = 'pending' AND expires_at > pg_catalog.now();

  v_token := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_exp   := pg_catalog.now() + make_interval(days => p_ttl_days);
  INSERT INTO public.digital_prospect_consent_invitations (prospect_id, token_hash, created_by, expires_at)
  VALUES (p_prospect_id, encode(pg_catalog.sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid(), v_exp)
  RETURNING id INTO v_id;

  -- el token solo existe en esta respuesta; no queda guardado
  RETURN jsonb_build_object('invitation_id', v_id, 'token', v_token, 'expires_at', v_exp);
END
$f$;
REVOKE ALL ON FUNCTION public.create_consent_invitation(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_consent_invitation(uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.revoke_consent_invitation(p_invitation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE v_n integer;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_invitation_id IS NULL THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  UPDATE public.digital_prospect_consent_invitations SET status = 'revoked' WHERE id = p_invitation_id AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RAISE EXCEPTION 'INVITACION_NO_PENDIENTE'; END IF;
  RETURN jsonb_build_object('invitation_id', p_invitation_id, 'status', 'revoked');
END
$f$;
REVOKE ALL ON FUNCTION public.revoke_consent_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_consent_invitation(uuid) TO authenticated;

-- ---------------------------------------------------------------- Publico (anon): solo con token valido
-- Respuesta deliberadamente neutra: no revela si el token es invalido, usado, vencido o si el prospecto existe.
CREATE OR REPLACE FUNCTION public.get_consent_invitation(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE i record;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN jsonb_build_object('valid', false); END IF;
  SELECT v.status, v.expires_at, p.outreach_status INTO i
    FROM public.digital_prospect_consent_invitations v JOIN public.digital_prospects p ON p.id = v.prospect_id
   WHERE v.token_hash = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND OR i.status <> 'pending' OR i.expires_at <= pg_catalog.now() OR i.outreach_status = 'opted_out' THEN
    RETURN jsonb_build_object('valid', false);
  END IF;
  RETURN jsonb_build_object('valid', true);
END
$f$;
REVOKE ALL ON FUNCTION public.get_consent_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_consent_invitation(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_consent_invitation(p_token text, p_decision text, p_checkbox boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  c_text CONSTANT text := 'Autorizo a Straumann Group Chile a enviarme mensajes por WhatsApp relacionados con soluciones digitales Straumann, incluyendo SIRIOS/SIRIOS X3, oportunidades Trade Up y coordinación de demostraciones. Puedo retirar esta autorización en cualquier momento.';
  c_ver  CONSTANT text := 'consent_wa_v1';
  inv     record;
  p       record;
  v_prev  text;
  v_db    text;
  v_today date := (pg_catalog.now() AT TIME ZONE 'America/Santiago')::date;
  v_hdr   json;
  v_ip    text;
  v_ua    text;
  v_note  text;
  v_log   uuid;
  v_ev    jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN RETURN jsonb_build_object('ok', false); END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('granted','denied') THEN RETURN jsonb_build_object('ok', false); END IF;
  IF p_decision = 'granted' AND p_checkbox IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok', false); END IF;

  SELECT * INTO inv FROM public.digital_prospect_consent_invitations
   WHERE token_hash = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex') FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'pending' OR inv.expires_at <= pg_catalog.now() THEN RETURN jsonb_build_object('ok', false); END IF;

  -- SOLO el prospecto asociado a este token
  SELECT id, whatsapp_consent, outreach_status INTO p FROM public.digital_prospects WHERE id = inv.prospect_id FOR UPDATE;
  IF NOT FOUND OR (p.outreach_status = 'opted_out' AND p_decision = 'granted') THEN RETURN jsonb_build_object('ok', false); END IF;

  -- evidencia automatica del formulario (la IP/UA llegan por cabeceras de PostgREST; nada de esto se escribe en logs)
  BEGIN
    v_hdr := current_setting('request.headers', true)::json;
    v_ip  := left(btrim(split_part(COALESCE(v_hdr ->> 'x-forwarded-for', v_hdr ->> 'cf-connecting-ip', ''), ',', 1)), 64);
    v_ua  := left(COALESCE(v_hdr ->> 'user-agent', ''), 300);
  EXCEPTION WHEN OTHERS THEN v_ip := NULL; v_ua := NULL;
  END;
  v_ev := jsonb_build_object('channel', 'formulario_web', 'text_version', c_ver,
            'text_sha256', encode(pg_catalog.sha256(convert_to(c_text, 'UTF8')), 'hex'),
            'checkbox_checked', (p_checkbox IS TRUE), 'decision', p_decision, 'submitted_at', pg_catalog.now(),
            'ip', NULLIF(v_ip, ''), 'user_agent', NULLIF(v_ua, ''));

  v_prev := CASE p.whatsapp_consent WHEN 'yes' THEN 'granted' WHEN 'no' THEN 'denied' ELSE 'unknown' END;
  v_db   := CASE p_decision WHEN 'granted' THEN 'yes' ELSE 'no' END;

  IF v_prev <> p_decision THEN
    v_note := CASE p_decision
      WHEN 'granted' THEN 'Formulario web de consentimiento WhatsApp (texto ' || c_ver || ', casilla marcada por el cliente). Invitacion ' || left(inv.id::text, 8)
      ELSE 'Formulario web: el cliente rechazo recibir mensajes por WhatsApp. Invitacion ' || left(inv.id::text, 8) END;
    -- misma auditoria que Outbound 6; la fila de auditoria autoriza el cambio ante el trigger guard
    INSERT INTO public.digital_prospect_consent_log (prospect_id, previous_state, new_state, source, consent_date, note, changed_by, changed_by_email)
    VALUES (inv.prospect_id, v_prev, p_decision, 'formulario_web', v_today, v_note, NULL, 'cliente (formulario web)')
    RETURNING id INTO v_log;
    UPDATE public.digital_prospects SET whatsapp_consent = v_db, consent_source = 'formulario_web', consent_at = pg_catalog.now()
     WHERE id = inv.prospect_id;   -- solo consentimiento: outreach_status y demas columnas intactas
  END IF;

  UPDATE public.digital_prospect_consent_invitations
     SET status = CASE p_decision WHEN 'granted' THEN 'accepted' ELSE 'rejected' END,
         used_at = pg_catalog.now(), decision = p_decision, consent_log_id = v_log, evidence = v_ev
   WHERE id = inv.id;

  RETURN jsonb_build_object('ok', true, 'decision', p_decision);
END
$f$;
REVOKE ALL ON FUNCTION public.submit_consent_invitation(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_consent_invitation(text, text, boolean) TO anon, authenticated;
