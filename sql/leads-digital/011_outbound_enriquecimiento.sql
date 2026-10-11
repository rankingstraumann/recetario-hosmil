-- LEADS DIGITAL · OUTBOUND 5 -- Enriquecimiento controlado de prospectos REALES (completar nombre / movil / email).
-- Cambios (aditivos, sin DROP):
--   * digital_prospect_enrichments       : auditoria de cada enriquecimiento aplicado (1 fila por archivo; sha256 UNICO = no se aplica dos veces).
--   * digital_prospect_enrichment_items  : que campos se completaron en cada prospecto (permite rollback dirigido; solo ids y nombres de campo, sin datos personales).
--   * RPC public.confirm_prospect_enrichment(...) SECURITY DEFINER: unica via de escritura. Atomica (una funcion = una transaccion).
-- Reglas que la RPC impone por si sola (defensa en profundidad, aunque la Edge Function ya las aplica):
--   * solo prospectos EXISTENTES con is_test=false y Sold-To (external_customer_id) EXACTO igual al enviado; nunca INSERT en digital_prospects.
--   * solo columnas full_name, phone_raw+phone_e164, email; SOLO si el valor actual esta vacio (jamas sobrescribe ni borra).
--   * NO toca whatsapp_consent, consent_*, outreach_status ni ninguna otra columna. No envia nada por WhatsApp.
--   * si UN prospecto no calza, aborta TODO (nada se actualiza).
-- NO cambia RLS ni grants de digital_prospects: authenticated sigue SIN INSERT/UPDATE/DELETE directo.

CREATE TABLE IF NOT EXISTS public.digital_prospect_enrichments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text NOT NULL,
  file_sha256   text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  file_size     integer CHECK (file_size IS NULL OR file_size >= 0),
  total_rows    integer NOT NULL CHECK (total_rows >= 0),
  matched_rows  integer NOT NULL CHECK (matched_rows >= 0),
  updated_rows  integer NOT NULL CHECK (updated_rows >= 0),
  fields_filled jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpe_file_sha256 ON public.digital_prospect_enrichments (file_sha256);

CREATE TABLE IF NOT EXISTS public.digital_prospect_enrichment_items (
  enrichment_id uuid NOT NULL REFERENCES public.digital_prospect_enrichments(id) ON DELETE CASCADE,
  prospect_id   uuid NOT NULL REFERENCES public.digital_prospects(id) ON DELETE CASCADE,
  fields        text[] NOT NULL,
  PRIMARY KEY (enrichment_id, prospect_id)
);

REVOKE ALL ON public.digital_prospect_enrichments, public.digital_prospect_enrichment_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.digital_prospect_enrichments, public.digital_prospect_enrichment_items TO authenticated;
GRANT ALL ON public.digital_prospect_enrichments, public.digital_prospect_enrichment_items TO service_role;
ALTER TABLE public.digital_prospect_enrichments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_prospect_enrichment_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY digital_prospect_enrichments_admin_select ON public.digital_prospect_enrichments
  FOR SELECT TO authenticated USING (public.is_lead_admin());
CREATE POLICY digital_prospect_enrichment_items_admin_select ON public.digital_prospect_enrichment_items
  FOR SELECT TO authenticated USING (public.is_lead_admin());

CREATE OR REPLACE FUNCTION public.confirm_prospect_enrichment(
  p_filename text,
  p_sha256   text,
  p_size     integer,
  p_total    integer,   -- filas de datos del archivo
  p_matched  integer,   -- filas con match exacto (informativo para la auditoria)
  p_updates  jsonb      -- [{id, external_customer_id, full_name?, phone_raw?, phone_e164?, email?}] SOLO filas con algo que completar
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  v_enr   uuid;
  v_n     integer;
  v_bad   integer;
  e       record;
  p       record;
  v_flds  text[];
  v_upd   integer := 0;
  v_name  integer := 0;
  v_phone integer := 0;
  v_mail  integer := 0;
  v_skip  integer := 0;
BEGIN
  IF NOT public.is_lead_admin() THEN RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501'; END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF COALESCE(p_total,-1) < 0 OR COALESCE(p_matched,-1) < 0 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  v_n := jsonb_array_length(p_updates);
  IF v_n = 0 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF v_n > 5000 THEN RAISE EXCEPTION 'LOTE_EXCEDIDO'; END IF;
  IF v_n > p_matched OR p_matched > p_total THEN RAISE EXCEPTION 'CONTEOS_INCONSISTENTES'; END IF;

  -- Forma de cada elemento: objeto con id uuid y Sold-To validos; solo claves permitidas; formatos de telefono/email.
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_updates) x(v)
   WHERE jsonb_typeof(x.v) <> 'object'
      OR (x.v ->> 'id') IS NULL OR (x.v ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (x.v ->> 'external_customer_id') IS NULL OR (x.v ->> 'external_customer_id') !~ '^[A-Za-z0-9-]{1,20}$'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(x.v) k WHERE k NOT IN ('id','external_customer_id','full_name','phone_raw','phone_e164','email'))
      OR ((x.v ? 'phone_e164') <> (x.v ? 'phone_raw'))
      OR (x.v ->> 'phone_e164') !~ '^\+[1-9][0-9]{6,14}$'
      OR (x.v ->> 'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
      OR (NOT (x.v ? 'full_name' OR x.v ? 'phone_e164' OR x.v ? 'email'));
  IF v_bad > 0 THEN RAISE EXCEPTION 'FILA_INVALIDA'; END IF;
  IF (SELECT count(DISTINCT x.v ->> 'id') FROM jsonb_array_elements(p_updates) x(v)) <> v_n THEN RAISE EXCEPTION 'FILA_INVALIDA'; END IF;

  -- Anti doble aplicacion (incluye carrera de dos clics)
  PERFORM pg_advisory_xact_lock(hashtext('prospect_enrich:' || p_sha256));
  IF EXISTS (SELECT 1 FROM public.digital_prospect_enrichments WHERE file_sha256 = p_sha256) THEN
    RAISE EXCEPTION 'ENRIQUECIMIENTO_YA_APLICADO';
  END IF;

  INSERT INTO public.digital_prospect_enrichments (filename, file_sha256, file_size, total_rows, matched_rows, updated_rows, created_by)
  VALUES (left(p_filename, 200), p_sha256, p_size, p_total, p_matched, 0, auth.uid())
  RETURNING id INTO v_enr;

  FOR e IN SELECT x.v FROM jsonb_array_elements(p_updates) x(v) LOOP
    -- el prospecto debe existir, ser REAL y tener ese Sold-To EXACTO; se bloquea la fila durante la actualizacion
    SELECT id, full_name, phone_raw, phone_e164, email INTO p
      FROM public.digital_prospects
     WHERE id = (e.v ->> 'id')::uuid AND is_test = false AND external_customer_id = e.v ->> 'external_customer_id'
       FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROSPECTO_NO_VALIDO'; END IF;

    v_flds := ARRAY[]::text[];
    IF (e.v ? 'full_name') AND NULLIF(btrim(COALESCE(p.full_name, '')), '') IS NULL THEN v_flds := array_append(v_flds, 'full_name'::text); END IF;
    IF (e.v ? 'phone_e164') AND NULLIF(btrim(COALESCE(p.phone_e164, '')), '') IS NULL AND NULLIF(btrim(COALESCE(p.phone_raw, '')), '') IS NULL THEN v_flds := array_append(v_flds, 'phone'::text); END IF;
    IF (e.v ? 'email') AND NULLIF(btrim(COALESCE(p.email, '')), '') IS NULL THEN v_flds := array_append(v_flds, 'email'::text); END IF;

    IF cardinality(v_flds) = 0 THEN v_skip := v_skip + 1; CONTINUE; END IF;  -- ya tenia dato (carrera): no se sobrescribe

    UPDATE public.digital_prospects d SET
      full_name  = CASE WHEN 'full_name' = ANY (v_flds) THEN left(e.v ->> 'full_name', 300) ELSE d.full_name END,
      phone_raw  = CASE WHEN 'phone'     = ANY (v_flds) THEN left(e.v ->> 'phone_raw', 300) ELSE d.phone_raw END,
      phone_e164 = CASE WHEN 'phone'     = ANY (v_flds) THEN e.v ->> 'phone_e164'           ELSE d.phone_e164 END,
      email      = CASE WHEN 'email'     = ANY (v_flds) THEN left(e.v ->> 'email', 300)     ELSE d.email END
     WHERE d.id = p.id;

    INSERT INTO public.digital_prospect_enrichment_items (enrichment_id, prospect_id, fields) VALUES (v_enr, p.id, v_flds);
    v_upd := v_upd + 1;
    IF 'full_name' = ANY (v_flds) THEN v_name := v_name + 1; END IF;
    IF 'phone'     = ANY (v_flds) THEN v_phone := v_phone + 1; END IF;
    IF 'email'     = ANY (v_flds) THEN v_mail := v_mail + 1; END IF;
  END LOOP;

  UPDATE public.digital_prospect_enrichments
     SET updated_rows = v_upd, fields_filled = jsonb_build_object('full_name', v_name, 'phone', v_phone, 'email', v_mail)
   WHERE id = v_enr;

  RETURN jsonb_build_object('enrichment_id', v_enr, 'total', p_total, 'matched', p_matched, 'updated', v_upd,
                            'skipped_already_filled', v_skip, 'full_name', v_name, 'phone', v_phone, 'email', v_mail);
END
$f$;

REVOKE ALL ON FUNCTION public.confirm_prospect_enrichment(text, text, integer, integer, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_prospect_enrichment(text, text, integer, integer, integer, jsonb) TO authenticated;
