-- Rollback de 009. Quita la RPC, el indice unico y las dos columnas.
-- NO borra datos importados (si existen, quedan; para borrar un lote de prueba usar un script de limpieza aparte y autorizado).
DROP FUNCTION IF EXISTS public.confirm_prospect_import(text, text, integer, integer, integer, integer, jsonb);
DROP INDEX IF EXISTS public.uq_dpi_file_sha256;
ALTER TABLE public.digital_prospect_imports DROP COLUMN IF EXISTS file_sha256, DROP COLUMN IF EXISTS file_size;
