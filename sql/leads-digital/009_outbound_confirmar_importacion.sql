-- LEADS DIGITAL · OUTBOUND 3 -- Confirmar importacion (V1, SOLO datos de prueba)
-- Cambios (aditivos):
--   * digital_prospect_imports.file_sha256 / file_size  -> identifican el archivo; indice UNICO parcial = no se puede confirmar dos veces el mismo archivo.
--   * RPC public.confirm_prospect_import(...) SECURITY DEFINER: unica via de escritura. Atomica (una funcion = una transaccion).
-- NO cambia RLS ni grants de las tablas: authenticated sigue SIN INSERT/UPDATE/DELETE directo.
-- La RPC exige is_lead_admin(); la invoca la Edge Function con el JWT del usuario (sin service_role), tras RE-ANALIZAR el archivo en servidor.
-- V1: toda fila importada queda is_test=true, whatsapp_consent='unknown', outreach_status='pending'. No envia nada por WhatsApp.

ALTER TABLE public.digital_prospect_imports
  ADD COLUMN IF NOT EXISTS file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS file_size   integer CHECK (file_size IS NULL OR file_size >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dpi_file_sha256 ON public.digital_prospect_imports (file_sha256) WHERE file_sha256 IS NOT NULL;

CREATE OR REPLACE FUNCTION public.confirm_prospect_import(
  p_filename   text,
  p_sha256     text,
  p_size       integer,
  p_total      integer,   -- filas de datos analizadas en el archivo
  p_invalid    integer,   -- filas invalidas (no se insertan)
  p_duplicates integer,   -- duplicados fuertes detectados por el analisis (no se insertan)
  p_rows       jsonb      -- SOLO filas listas para importar (VALIDO / ADVERTENCIA)
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $f$
DECLARE
  v_import uuid;
  v_in     integer;
  v_ins    integer;
  v_omit   integer;
  v_bad    integer;
BEGIN
  IF NOT public.is_lead_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501';
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF COALESCE(p_total,-1) < 0 OR COALESCE(p_invalid,-1) < 0 OR COALESCE(p_duplicates,-1) < 0 THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  v_in := jsonb_array_length(p_rows);
  IF v_in > 5000 THEN RAISE EXCEPTION 'LOTE_EXCEDIDO'; END IF;
  IF v_in + p_invalid + p_duplicates <> p_total THEN RAISE EXCEPTION 'CONTEOS_INCONSISTENTES'; END IF;

  -- Defensa en profundidad: el Sold-To es opcional, pero si viene debe ser valido (el parser ya lo garantiza).
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) e(v)
   WHERE NULLIF(e.v ->> 'external_customer_id', '') IS NOT NULL
     AND (e.v ->> 'external_customer_id') !~ '^[A-Za-z0-9-]{1,20}$';
  IF v_bad > 0 THEN RAISE EXCEPTION 'FILA_INVALIDA'; END IF;

  -- Evita doble confirmacion (incluida la carrera de dos clics): serializa por hash y revisa
  PERFORM pg_advisory_xact_lock(hashtext('prospect_import:' || p_sha256));
  IF EXISTS (SELECT 1 FROM public.digital_prospect_imports WHERE file_sha256 = p_sha256) THEN
    RAISE EXCEPTION 'IMPORT_YA_CONFIRMADO';
  END IF;

  INSERT INTO public.digital_prospect_imports
    (filename, source_name, total_rows, imported_rows, skipped_rows, duplicate_rows, created_by, file_sha256, file_size, metadata)
  VALUES
    (left(p_filename, 200), left(p_filename, 200), p_total, 0, p_invalid, p_duplicates, auth.uid(), p_sha256, p_size,
     jsonb_build_object('is_test', true, 'phase', 'outbound_v1_test', 'consent_default', 'unknown'))
  RETURNING id INTO v_import;

  WITH src AS (
    SELECT e.ord, e.v
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(v, ord)
  ), conid AS (  -- por si el cliente enviara dos veces el mismo Sold-To: primera ocurrencia
    SELECT DISTINCT ON (v ->> 'external_customer_id') ord, v
      FROM src WHERE NULLIF(v ->> 'external_customer_id', '') IS NOT NULL
     ORDER BY v ->> 'external_customer_id', ord
  ), dedup AS (  -- filas sin Sold-To se importan siempre (no pueden ser duplicado fuerte)
    SELECT ord, v FROM conid
    UNION ALL
    SELECT ord, v FROM src WHERE NULLIF(v ->> 'external_customer_id', '') IS NULL
  ), fresh AS (  -- re-chequeo contra la base: duplicado fuerte -> OMITIR (no actualizar, no fusionar)
    SELECT d.ord, d.v FROM dedup d
     WHERE NULLIF(d.v ->> 'external_customer_id', '') IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.digital_prospects p WHERE p.external_customer_id = d.v ->> 'external_customer_id')
  ), ins AS (
    INSERT INTO public.digital_prospects
      (import_id, source, source_detail, external_customer_id, full_name, clinic_name, source_owner, priority_source,
       last_billed_year, trade_up_financial, phone_raw, phone_e164, email, notes,
       whatsapp_consent, outreach_status, is_test, raw_payload, created_by)
    SELECT v_import, 'import_excel', left(p_filename, 150) || ' / ' || left(COALESCE(f.v ->> 'sheet', ''), 80),
           NULLIF(f.v ->> 'external_customer_id', ''),
           left(NULLIF(f.v ->> 'full_name', ''), 300), left(NULLIF(f.v ->> 'clinic_name', ''), 300),
           left(NULLIF(f.v ->> 'source_owner', ''), 300), left(NULLIF(f.v ->> 'priority_source', ''), 300),
           NULLIF(f.v ->> 'last_billed_year', '')::integer, NULLIF(f.v ->> 'trade_up_financial', '')::boolean,
           left(NULLIF(f.v ->> 'phone_raw', ''), 300), NULLIF(f.v ->> 'phone_e164', ''),
           left(NULLIF(f.v ->> 'email', ''), 300), left(NULLIF(f.v ->> 'notes', ''), 2000),
           'unknown', 'pending', true,
           COALESCE(NULLIF(f.v -> 'raw_payload', 'null'::jsonb), '{}'::jsonb)
             || jsonb_build_object('_sheet', f.v ->> 'sheet', '_row', f.v -> 'row'),
           auth.uid()
      FROM fresh f
    RETURNING 1
  )
  SELECT count(*) INTO v_ins FROM ins;

  v_omit := v_in - v_ins;  -- duplicados fuertes detectados otra vez en la base / dentro del lote
  UPDATE public.digital_prospect_imports
     SET imported_rows = v_ins, duplicate_rows = p_duplicates + v_omit
   WHERE id = v_import;

  RETURN jsonb_build_object('import_id', v_import, 'total', p_total, 'imported', v_ins,
                            'duplicates_omitted', p_duplicates + v_omit, 'invalid', p_invalid);
END
$f$;

REVOKE ALL ON FUNCTION public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb) TO authenticated;
