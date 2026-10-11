-- LEADS DIGITAL · OUTBOUND 4 -- Habilitacion controlada de importacion REAL (modo del lote decidido por el servidor)
-- Cambios:
--   * digital_prospect_imports.is_test (modo del lote). Backfill desde metadata.is_test (lotes previos = PRUEBA).
--   * Doble importacion: unicidad por (file_sha256, is_test) -> una importacion de PRUEBA NO bloquea la REAL del mismo archivo; el mismo archivo en el mismo modo si.
--   * Duplicados fuertes contra la BD: solo dentro del mismo modo (los prospectos de prueba no vuelven "duplicado" a un prospecto real).
--   * RPC confirm_prospect_import con p_is_test + p_real_confirmed (REAL exige confirmacion explicita). Se ELIMINA la firma anterior (7 args) para que no quede una via sin modo.
-- Sin cambios de RLS/grants de tablas. consent='unknown', outreach_status='pending'. No envia nada por WhatsApp.

ALTER TABLE public.digital_prospect_imports ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT true;
UPDATE public.digital_prospect_imports SET is_test = COALESCE((metadata ->> 'is_test')::boolean, true);

DROP INDEX IF EXISTS public.uq_dpi_file_sha256;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dpi_file_sha256_modo ON public.digital_prospect_imports (file_sha256, is_test) WHERE file_sha256 IS NOT NULL;

DROP FUNCTION IF EXISTS public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb);

CREATE FUNCTION public.confirm_prospect_import(
  p_filename   text,
  p_sha256     text,
  p_size       integer,
  p_total      integer,   -- filas de datos analizadas en el archivo
  p_invalid    integer,   -- filas invalidas (no se insertan)
  p_duplicates integer,   -- duplicados fuertes detectados por el analisis (no se insertan)
  p_rows       jsonb,     -- SOLO filas listas para importar (VALIDO / ADVERTENCIA)
  p_is_test    boolean,   -- modo del lote: true = PRUEBA, false = REAL (lo decide la Edge Function, no el navegador)
  p_real_confirmed boolean -- segunda confirmacion explicita; obligatoria para REAL
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
  IF p_is_test IS NULL THEN RAISE EXCEPTION 'PARAMETROS_INVALIDOS'; END IF;
  IF p_is_test = false AND COALESCE(p_real_confirmed, false) IS NOT TRUE THEN RAISE EXCEPTION 'CONFIRMACION_REAL_REQUERIDA'; END IF;
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

  -- Doble confirmacion: la clave es (archivo, modo). Una importacion de PRUEBA no bloquea la REAL del mismo archivo.
  PERFORM pg_advisory_xact_lock(hashtext('prospect_import:' || p_sha256 || ':' || CASE WHEN p_is_test THEN 'test' ELSE 'real' END));
  IF EXISTS (SELECT 1 FROM public.digital_prospect_imports WHERE file_sha256 = p_sha256 AND is_test = p_is_test) THEN
    RAISE EXCEPTION 'IMPORT_YA_CONFIRMADO';
  END IF;

  INSERT INTO public.digital_prospect_imports
    (filename, source_name, total_rows, imported_rows, skipped_rows, duplicate_rows, created_by, file_sha256, file_size, is_test, metadata)
  VALUES
    (left(p_filename, 200), left(p_filename, 200), p_total, 0, p_invalid, p_duplicates, auth.uid(), p_sha256, p_size, p_is_test,
     jsonb_build_object('is_test', p_is_test, 'mode', CASE WHEN p_is_test THEN 'test' ELSE 'real' END, 'consent_default', 'unknown'))
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
  ), fresh AS (  -- re-chequeo contra la base, SOLO dentro del mismo modo: duplicado fuerte -> OMITIR (no actualizar, no fusionar)
    SELECT d.ord, d.v FROM dedup d
     WHERE NULLIF(d.v ->> 'external_customer_id', '') IS NULL
        OR NOT EXISTS (SELECT 1 FROM public.digital_prospects p WHERE p.is_test = p_is_test AND p.external_customer_id = d.v ->> 'external_customer_id')
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
           'unknown', 'pending', p_is_test,
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

REVOKE ALL ON FUNCTION public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb, boolean, boolean) TO authenticated;
