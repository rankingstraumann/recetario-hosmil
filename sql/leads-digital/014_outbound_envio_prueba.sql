-- LEADS DIGITAL · OUTBOUND 7 -- Contacto inicial por plantilla WhatsApp, SOLO MODO PRUEBA. Aditiva (sin DROP). No envia nada por si misma:
-- el envio lo hace la Edge Function `outbound-whatsapp-send` (server-side, kill switch OUTBOUND_WHATSAPP_ENABLED=false por defecto).
-- Esta migracion es la SEGUNDA barrera (la primera es la Edge Function): aunque alguien llame las RPC directo, un prospecto REAL se rechaza.
--   * claim_outbound_send   : valida y RESERVA el envio (una fila 'sending') de forma atomica => idempotencia / sin doble envio.
--   * finalize_outbound_send: registra el resultado; solo si Meta acepto ('sent') pasa outreach_status -> contacted + last_outreach_at.
--   * Un prospecto por llamada. No hay RPC masiva. Sin reintentos automaticos.
--   * No toca whatsapp_consent / consent_* (guardia de Outbound 6 intacta) ni crea prospectos.

CREATE TABLE IF NOT EXISTS public.digital_outbound_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id         uuid NOT NULL REFERENCES public.digital_prospects(id) ON DELETE CASCADE,
  template_name       text NOT NULL CHECK (template_name ~ '^[a-z0-9_]{1,200}$'),
  template_language   text NOT NULL CHECK (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  status              text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','failed','dry_run')),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  error_code          text CHECK (error_code IS NULL OR char_length(error_code) <= 60),
  error_message       text CHECK (error_message IS NULL OR char_length(error_message) <= 200),
  requested_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_email  text,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  sent_at             timestamptz,
  CHECK ((status = 'sending') = (completed_at IS NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status <> 'sent' OR provider_message_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_dos_prospect ON public.digital_outbound_sends (prospect_id, requested_at DESC);
-- Idempotencia: como maximo UN envio en curso o exitoso por prospecto (el doble clic / reintento cae aqui).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dos_prospect_active ON public.digital_outbound_sends (prospect_id) WHERE status IN ('sending','sent');

REVOKE ALL ON public.digital_outbound_sends FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.digital_outbound_sends TO authenticated;
GRANT ALL ON public.digital_outbound_sends TO service_role;
ALTER TABLE public.digital_outbound_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_outbound_sends_admin_select ON public.digital_outbound_sends
  FOR SELECT TO authenticated USING (public.is_lead_admin());

-- ---------------------------------------------------------------- reservar el envio
CREATE OR REPLACE FUNCTION public.claim_outbound_send(p_prospect_id uuid, p_template_name text, p_template_language text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  p       record;
  v_email text;
  v_id    uuid;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_prospect_id IS NULL OR p_template_name IS NULL OR p_template_name !~ '^[a-z0-9_]{1,200}$'
     OR p_template_language IS NULL OR p_template_language !~ '^[a-z]{2,3}(_[A-Z]{2})?$' THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;

  SELECT id, is_test, whatsapp_consent, phone_e164, outreach_status INTO p
    FROM public.digital_prospects WHERE id = p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_ENCONTRADO'; END IF;
  -- MODO PRUEBA: un prospecto REAL jamas se contacta en esta fase (segunda barrera, independiente del frontend y de la Edge Function)
  IF p.is_test IS NOT TRUE THEN RAISE EXCEPTION 'PROSPECTO_REAL_NO_PERMITIDO'; END IF;
  IF p.whatsapp_consent <> 'yes' THEN RAISE EXCEPTION 'SIN_CONSENTIMIENTO'; END IF;
  IF p.phone_e164 IS NULL OR p.phone_e164 !~ '^\+569[0-9]{8}$' THEN RAISE EXCEPTION 'SIN_MOVIL_VALIDO'; END IF;
  IF p.outreach_status <> 'pending' THEN RAISE EXCEPTION 'ESTADO_NO_PENDIENTE'; END IF;
  IF EXISTS (SELECT 1 FROM public.digital_outbound_sends WHERE prospect_id = p_prospect_id AND status = 'sending') THEN RAISE EXCEPTION 'ENVIO_EN_CURSO'; END IF;
  IF EXISTS (SELECT 1 FROM public.digital_outbound_sends WHERE prospect_id = p_prospect_id AND status = 'sent') THEN RAISE EXCEPTION 'YA_ENVIADO'; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  BEGIN
    INSERT INTO public.digital_outbound_sends (prospect_id, template_name, template_language, requested_by, requested_by_email)
    VALUES (p_prospect_id, p_template_name, p_template_language, auth.uid(), v_email) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'ENVIO_EN_CURSO';
  END;
  RETURN jsonb_build_object('send_id', v_id, 'to', p.phone_e164);
END
$f$;
REVOKE ALL ON FUNCTION public.claim_outbound_send(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_outbound_send(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- registrar el resultado
CREATE OR REPLACE FUNCTION public.finalize_outbound_send(p_send_id uuid, p_status text, p_provider_message_id text DEFAULT NULL,
                                                         p_error_code text DEFAULT NULL, p_error_message text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  s       record;
  v_pid   text := NULLIF(pg_catalog.btrim(COALESCE(p_provider_message_id, '')), '');
  v_code  text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(p_error_code, '')), 60), '');
  v_msg   text := NULLIF(pg_catalog.left(pg_catalog.btrim(COALESCE(p_error_message, '')), 200), '');
  v_now   timestamptz := pg_catalog.now();
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_send_id IS NULL OR p_status IS NULL OR p_status NOT IN ('sent','failed','dry_run') THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF p_status = 'sent' AND v_pid IS NULL THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF v_pid IS NOT NULL AND pg_catalog.char_length(v_pid) > 200 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;

  SELECT * INTO s FROM public.digital_outbound_sends WHERE id = p_send_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENVIO_NO_ENCONTRADO'; END IF;
  IF s.status <> 'sending' THEN RAISE EXCEPTION 'ENVIO_YA_FINALIZADO'; END IF;
  IF s.requested_by IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;

  PERFORM 1 FROM public.digital_prospects WHERE id = s.prospect_id FOR UPDATE;
  UPDATE public.digital_outbound_sends
     SET status = p_status, provider_message_id = v_pid, error_code = v_code, error_message = v_msg, completed_at = v_now,
         sent_at = CASE WHEN p_status = 'sent' THEN v_now ELSE NULL END
   WHERE id = p_send_id;
  -- Solo si Meta acepto el envio => contacted. Si fallo => failed. dry_run (simulacion) NO cambia el estado del prospecto.
  -- Nunca se pisa un estado distinto de pending (p. ej. opted_out que llego mientras tanto).
  IF p_status = 'sent' THEN
    UPDATE public.digital_prospects SET outreach_status = 'contacted', last_outreach_at = v_now
     WHERE id = s.prospect_id AND outreach_status = 'pending';
  ELSIF p_status = 'failed' THEN
    UPDATE public.digital_prospects SET outreach_status = 'failed'
     WHERE id = s.prospect_id AND outreach_status = 'pending';
  END IF;
  RETURN jsonb_build_object('send_id', p_send_id, 'status', p_status);
END
$f$;
REVOKE ALL ON FUNCTION public.finalize_outbound_send(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_outbound_send(uuid, text, text, text, text) TO authenticated;
