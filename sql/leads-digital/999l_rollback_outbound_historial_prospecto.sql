-- Rollback de 015 (Outbound 8). Funcion de solo lectura: no hay datos que revertir.
DROP FUNCTION IF EXISTS public.get_prospect_timeline(uuid);
