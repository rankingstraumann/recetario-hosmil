-- LEADS DIGITAL · OUTBOUND 1.1 -- Campos comerciales de la base fuente (solo ADD COLUMN, aditivo).
-- No modifica 006, ni outreach_status, ni RLS/grants (heredan los de la tabla), ni digital_leads.
ALTER TABLE public.digital_prospects
  ADD COLUMN IF NOT EXISTS external_customer_id text,   -- Sold-To SAP / id comercial externo
  ADD COLUMN IF NOT EXISTS source_owner         text,   -- cartera historica original; NO implica asignacion
  ADD COLUMN IF NOT EXISTS priority_source      text,   -- prioridad que traia la base fuente
  ADD COLUMN IF NOT EXISTS last_billed_year     integer CHECK (last_billed_year IS NULL OR last_billed_year BETWEEN 1990 AND 2100),
  ADD COLUMN IF NOT EXISTS trade_up_financial   boolean; -- el parser normaliza "O"/vacio -> NULL/false segun regla

COMMENT ON COLUMN public.digital_prospects.external_customer_id IS 'Sold-To SAP / identificador comercial externo. Duplicado fuerte si coincide exacto.';
COMMENT ON COLUMN public.digital_prospects.source_owner IS 'Cartera original historica de la base. No implica asignacion automatica.';

-- Indice NO unico para busqueda/deduplicacion (la politica de duplicados la aplica el parser, nunca un unique).
CREATE INDEX IF NOT EXISTS idx_dp_external_customer ON public.digital_prospects (external_customer_id)
  WHERE external_customer_id IS NOT NULL;
