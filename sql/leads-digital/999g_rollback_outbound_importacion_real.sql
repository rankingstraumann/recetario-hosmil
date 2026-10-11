-- Rollback de 010 (vuelve al comportamiento de 009: todo lote = PRUEBA, unicidad solo por archivo).
-- NO borra datos. Si ya existen lotes REAL y PRUEBA del mismo archivo, recrear el indice unico por sha fallara: borrar/ajustar antes.
DROP FUNCTION IF EXISTS public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb, boolean, boolean);
DROP INDEX IF EXISTS public.uq_dpi_file_sha256_modo;
-- Despues: re-ejecutar la seccion CREATE OR REPLACE FUNCTION + REVOKE/GRANT + CREATE UNIQUE INDEX uq_dpi_file_sha256 de 009_outbound_confirmar_importacion.sql
ALTER TABLE public.digital_prospect_imports DROP COLUMN IF EXISTS is_test;
