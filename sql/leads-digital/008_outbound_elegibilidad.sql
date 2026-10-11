-- LEADS DIGITAL · OUTBOUND 1.2 -- Elegibilidad derivada (fuente unica de verdad).
-- 1) Elimina outreach_status='eligible'  2) agrega whatsapp_eligible (columna generada STORED).
-- Elegible != listo para contactar: "listo" = whatsapp_eligible AND outreach_status='pending'.

-- 1) Migrar filas con 'eligible' a 'pending' y reemplazar el CHECK
UPDATE public.digital_prospects SET outreach_status = 'pending' WHERE outreach_status = 'eligible';

ALTER TABLE public.digital_prospects DROP CONSTRAINT IF EXISTS digital_prospects_outreach_status_check;
ALTER TABLE public.digital_prospects ADD CONSTRAINT digital_prospects_outreach_status_check
  CHECK (outreach_status IN ('pending','contacted','replied','opted_out','failed','converted'));

-- 2) Elegibilidad derivada: no se puede escribir ni queda inconsistente con consentimiento/telefono/estado
ALTER TABLE public.digital_prospects
  ADD COLUMN whatsapp_eligible boolean GENERATED ALWAYS AS (
    whatsapp_consent = 'yes'
    AND phone_e164 IS NOT NULL
    AND phone_e164 ~ '^\+[1-9][0-9]{6,14}$'
    AND outreach_status NOT IN ('opted_out','converted')
  ) STORED;

COMMENT ON COLUMN public.digital_prospects.whatsapp_eligible IS
  'Derivada: consent=yes, telefono E.164 valido, estado no opted_out/converted. Listo para contactar = whatsapp_eligible AND outreach_status=pending.';

CREATE INDEX IF NOT EXISTS idx_dp_listos ON public.digital_prospects (created_at DESC)
  WHERE whatsapp_eligible AND outreach_status = 'pending';
