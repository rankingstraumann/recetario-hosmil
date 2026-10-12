-- LEADS DIGITAL · OUTBOUND 6 -- Control de consentimiento WhatsApp (gestion segura y trazable). SIN DROP. No envia nada.
-- Almacenamiento: se CONSERVAN los valores existentes de digital_prospects.whatsapp_consent ('yes'|'no'|'unknown') porque
--   la columna generada whatsapp_eligible y los CHECK dependen de ellos. La API/UI/auditoria usan granted|denied|unknown:
--   yes = granted (Autorizado), no = denied (No autorizado), unknown = Sin definir.
-- Cambios (aditivos):
--   * digital_prospect_consent_log : historial/auditoria de CADA cambio de consentimiento (quien, cuando, fuente, fecha, nota).
--   * digital_prospects.contact_ready (columna generada): prospecto REAL + movil +569XXXXXXXX + consent granted + outreach_status='pending'.
--   * trigger guard_prospect_consent: el consentimiento SOLO puede cambiar si existe una fila de auditoria sin aplicar de ESTA transaccion
--     (cada fila autoriza exactamente un cambio). Bloquea UPDATE masivo / manual / INSERT con consentimiento != unknown.
--   * RPC public.set_prospect_consent(...) SECURITY DEFINER: unica via, un prospecto por llamada (sin actualizacion masiva).
-- NO cambia outreach_status, RLS ni grants de digital_prospects (authenticated sigue SIN UPDATE directo).

CREATE TABLE IF NOT EXISTS public.digital_prospect_consent_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id     uuid NOT NULL REFERENCES public.digital_prospects(id) ON DELETE CASCADE,
  previous_state  text NOT NULL CHECK (previous_state IN ('unknown','granted','denied')),
  new_state       text NOT NULL CHECK (new_state IN ('unknown','granted','denied')),
  source          text,
  consent_date    date,
  note            text,
  changed_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_email text,
  changed_at      timestamptz NOT NULL DEFAULT now(),
  txid            bigint NOT NULL DEFAULT pg_catalog.txid_current(),
  applied_at      timestamptz,
  CHECK (previous_state <> new_state),
  CHECK (new_state <> 'granted' OR (source IS NOT NULL AND consent_date IS NOT NULL AND length(btrim(COALESCE(note,''))) >= 5))
);
CREATE INDEX IF NOT EXISTS idx_dpcl_prospect ON public.digital_prospect_consent_log (prospect_id, changed_at DESC);

REVOKE ALL ON public.digital_prospect_consent_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.digital_prospect_consent_log TO authenticated;
GRANT ALL ON public.digital_prospect_consent_log TO service_role;
ALTER TABLE public.digital_prospect_consent_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_prospect_consent_log_admin_select ON public.digital_prospect_consent_log
  FOR SELECT TO authenticated USING (public.is_lead_admin());

-- "Listo para contactar": una sola fuente de verdad en la base.
ALTER TABLE public.digital_prospects ADD COLUMN IF NOT EXISTS contact_ready boolean GENERATED ALWAYS AS (
  is_test = false
  AND phone_e164 IS NOT NULL AND phone_e164 ~ '^\+569[0-9]{8}$'
  AND whatsapp_consent = 'yes'
  AND outreach_status = 'pending'
) STORED;
COMMENT ON COLUMN public.digital_prospects.contact_ready IS
  'Derivada: prospecto REAL + movil +569XXXXXXXX + consentimiento granted (yes) + outreach_status=pending. Unica definicion de "Listo para contactar".';

CREATE OR REPLACE FUNCTION public.guard_prospect_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  v_new text;
  v_log uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.whatsapp_consent <> 'unknown' OR NEW.consent_source IS NOT NULL OR NEW.consent_at IS NOT NULL THEN
      RAISE EXCEPTION 'CONSENTIMIENTO_SOLO_VIA_RPC' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.whatsapp_consent IS DISTINCT FROM OLD.whatsapp_consent
     OR NEW.consent_source IS DISTINCT FROM OLD.consent_source
     OR NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    v_new := CASE NEW.whatsapp_consent WHEN 'yes' THEN 'granted' WHEN 'no' THEN 'denied' ELSE 'unknown' END;
    SELECT l.id INTO v_log FROM public.digital_prospect_consent_log l
     WHERE l.prospect_id = NEW.id AND l.txid = pg_catalog.txid_current() AND l.applied_at IS NULL AND l.new_state = v_new
     ORDER BY l.changed_at DESC LIMIT 1 FOR UPDATE;
    IF v_log IS NULL THEN RAISE EXCEPTION 'CONSENTIMIENTO_SOLO_VIA_RPC' USING ERRCODE = '42501'; END IF;
    UPDATE public.digital_prospect_consent_log SET applied_at = pg_catalog.now() WHERE id = v_log;
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION public.guard_prospect_consent() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_guard_prospect_consent BEFORE INSERT OR UPDATE ON public.digital_prospects
  FOR EACH ROW EXECUTE FUNCTION public.guard_prospect_consent();

CREATE OR REPLACE FUNCTION public.set_prospect_consent(
  p_prospect_id  uuid,
  p_state        text,   -- 'granted' | 'denied' | 'unknown'
  p_source       text,   -- granted: obligatorio (lista cerrada). denied: opcional.
  p_consent_date date,   -- granted: obligatorio. denied: opcional (defecto hoy).
  p_note         text    -- granted: obligatoria (>=5). unknown: obligatoria (>=5). denied: motivo opcional.
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  p       record;
  v_prev  text;
  v_db    text;
  v_note  text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_src   text := NULLIF(btrim(COALESCE(p_source, '')), '');
  v_date  date;
  v_today date := (pg_catalog.now() AT TIME ZONE 'America/Santiago')::date;
  v_email text;
  v_log   uuid;
  v_ready boolean;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_prospect_id IS NULL OR p_state IS NULL OR p_state NOT IN ('granted','denied','unknown') THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF v_src IS NOT NULL AND v_src NOT IN ('formulario_web','correo_electronico','whatsapp_optin','telefono_registrado','presencial','evento','otro') THEN
    RAISE EXCEPTION 'FUENTE_INVALIDA';
  END IF;

  IF p_state = 'granted' THEN
    IF v_src IS NULL THEN RAISE EXCEPTION 'FUENTE_REQUERIDA'; END IF;
    IF p_consent_date IS NULL THEN RAISE EXCEPTION 'FECHA_REQUERIDA'; END IF;
    IF p_consent_date > v_today OR p_consent_date < DATE '2015-01-01' THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;
    IF v_note IS NULL OR length(v_note) < 5 THEN RAISE EXCEPTION 'NOTA_REQUERIDA'; END IF;
    v_date := p_consent_date;
  ELSIF p_state = 'denied' THEN
    IF p_consent_date IS NOT NULL AND (p_consent_date > v_today OR p_consent_date < DATE '2015-01-01') THEN RAISE EXCEPTION 'FECHA_INVALIDA'; END IF;
    v_date := COALESCE(p_consent_date, v_today);
  ELSE  -- unknown: volver a "Sin definir" exige motivo
    IF v_note IS NULL OR length(v_note) < 5 THEN RAISE EXCEPTION 'NOTA_REQUERIDA'; END IF;
    v_src := NULL; v_date := NULL;
  END IF;

  SELECT id, whatsapp_consent, outreach_status INTO p FROM public.digital_prospects WHERE id = p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_ENCONTRADO'; END IF;
  v_prev := CASE p.whatsapp_consent WHEN 'yes' THEN 'granted' WHEN 'no' THEN 'denied' ELSE 'unknown' END;
  IF v_prev = p_state THEN RAISE EXCEPTION 'SIN_CAMBIO'; END IF;
  IF p_state = 'granted' AND p.outreach_status = 'opted_out' THEN RAISE EXCEPTION 'PROSPECTO_DADO_DE_BAJA'; END IF;

  v_db := CASE p_state WHEN 'granted' THEN 'yes' WHEN 'denied' THEN 'no' ELSE 'unknown' END;
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

  -- 1) auditoria PRIMERO (autoriza exactamente este cambio ante el trigger guard)
  INSERT INTO public.digital_prospect_consent_log
    (prospect_id, previous_state, new_state, source, consent_date, note, changed_by, changed_by_email)
  VALUES (p_prospect_id, v_prev, p_state, v_src, v_date, v_note, auth.uid(), v_email)
  RETURNING id INTO v_log;

  -- 2) cambio: SOLO consentimiento (no toca outreach_status ni nada mas)
  UPDATE public.digital_prospects SET
    whatsapp_consent = v_db,
    consent_source   = v_src,
    consent_at       = CASE WHEN v_date IS NULL THEN NULL ELSE ((v_date::text || ' 12:00')::timestamp AT TIME ZONE 'America/Santiago') END
   WHERE id = p_prospect_id
  RETURNING contact_ready INTO v_ready;

  RETURN jsonb_build_object('log_id', v_log, 'prospect_id', p_prospect_id, 'previous_state', v_prev, 'new_state', p_state, 'contact_ready', v_ready);
END
$f$;
REVOKE ALL ON FUNCTION public.set_prospect_consent(uuid, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_prospect_consent(uuid, text, text, date, text) TO authenticated;
