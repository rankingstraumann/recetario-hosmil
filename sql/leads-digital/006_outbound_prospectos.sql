-- LEADS DIGITAL · OUTBOUND 1 (FUNDACION) -- Prospectos importados
-- Solo objetos NUEVOS. No toca digital_leads, webhook, scoring, cotizaciones, secrets ni RLS existentes.
-- Lectura: solo lead admin (is_lead_admin()). Escritura desde el cliente: NO (fase futura via RPC / service_role).
-- Esta fase NO envia nada por WhatsApp.

CREATE TABLE IF NOT EXISTS public.digital_prospect_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename      text,
  source_name   text,
  total_rows    integer NOT NULL DEFAULT 0 CHECK (total_rows     >= 0),
  imported_rows integer NOT NULL DEFAULT 0 CHECK (imported_rows  >= 0),
  skipped_rows  integer NOT NULL DEFAULT 0 CHECK (skipped_rows   >= 0),
  duplicate_rows integer NOT NULL DEFAULT 0 CHECK (duplicate_rows >= 0),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_dpi_created_at ON public.digital_prospect_imports (created_at DESC);

CREATE TABLE IF NOT EXISTS public.digital_prospects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid REFERENCES public.digital_prospect_imports(id) ON DELETE SET NULL,
  source           text,
  source_detail    text,
  full_name        text,
  clinic_name      text,
  commune          text,
  phone_raw        text,
  phone_e164       text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email            text,
  notes            text,
  whatsapp_consent text NOT NULL DEFAULT 'unknown' CHECK (whatsapp_consent IN ('yes','no','unknown')),
  consent_source   text,
  consent_at       timestamptz,
  outreach_status  text NOT NULL DEFAULT 'pending' CHECK (outreach_status IN
                     ('pending','eligible','contacted','replied','opted_out','failed','converted')),
  last_outreach_at timestamptz,
  linked_lead_id   uuid REFERENCES public.digital_leads(id) ON DELETE SET NULL,
  is_test          boolean NOT NULL DEFAULT false,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Indices NO unicos: la politica de duplicados se decide en la fase del parser.
CREATE INDEX IF NOT EXISTS idx_dp_phone      ON public.digital_prospects (phone_e164);
CREATE INDEX IF NOT EXISTS idx_dp_import     ON public.digital_prospects (import_id);
CREATE INDEX IF NOT EXISTS idx_dp_status     ON public.digital_prospects (outreach_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_created_at ON public.digital_prospects (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dp_lead       ON public.digital_prospects (linked_lead_id);

CREATE OR REPLACE FUNCTION public.touch_digital_prospect()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog'
AS $f$ BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;

CREATE TRIGGER trg_touch_digital_prospect
BEFORE UPDATE ON public.digital_prospects
FOR EACH ROW EXECUTE FUNCTION public.touch_digital_prospect();

-- ---------------- Privilegios ----------------
REVOKE ALL ON FUNCTION public.touch_digital_prospect() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.digital_prospect_imports, public.digital_prospects FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.digital_prospect_imports, public.digital_prospects TO authenticated; -- filtrado por RLS
GRANT ALL    ON public.digital_prospect_imports, public.digital_prospects TO service_role;   -- procesos backend futuros

-- ---------------- RLS ----------------
ALTER TABLE public.digital_prospect_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_prospects        ENABLE ROW LEVEL SECURITY;

CREATE POLICY digital_prospect_imports_admin_select ON public.digital_prospect_imports
  FOR SELECT TO authenticated USING (public.is_lead_admin());
CREATE POLICY digital_prospects_admin_select ON public.digital_prospects
  FOR SELECT TO authenticated USING (public.is_lead_admin());
-- Sin policies de INSERT/UPDATE/DELETE para authenticated: la escritura queda cerrada en esta fase.
-- service_role omite RLS (BYPASSRLS).
