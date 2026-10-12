-- ROLLBACK 007 -- elimina SOLO lo agregado por 007 (se pierden los datos de estas 5 columnas).
DROP INDEX IF EXISTS public.idx_dp_external_customer;
ALTER TABLE public.digital_prospects
  DROP COLUMN IF EXISTS external_customer_id,
  DROP COLUMN IF EXISTS source_owner,
  DROP COLUMN IF EXISTS priority_source,
  DROP COLUMN IF EXISTS last_billed_year,
  DROP COLUMN IF EXISTS trade_up_financial;
