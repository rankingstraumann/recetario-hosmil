-- ROLLBACK 008 -- quita whatsapp_eligible y restaura el CHECK original (con 'eligible').
-- Las filas que 008 paso de 'eligible' a 'pending' permanecen en 'pending' (no se restauran).
DROP INDEX IF EXISTS public.idx_dp_listos;
ALTER TABLE public.digital_prospects DROP COLUMN IF EXISTS whatsapp_eligible;
ALTER TABLE public.digital_prospects DROP CONSTRAINT IF EXISTS digital_prospects_outreach_status_check;
ALTER TABLE public.digital_prospects ADD CONSTRAINT digital_prospects_outreach_status_check
  CHECK (outreach_status IN ('pending','eligible','contacted','replied','opted_out','failed','converted'));
