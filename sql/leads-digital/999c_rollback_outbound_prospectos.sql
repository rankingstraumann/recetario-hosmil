-- ROLLBACK OUTBOUND 1 -- elimina SOLO lo creado por 006. No toca digital_leads ni otros objetos.
-- Orden: tabla hija -> tabla padre -> funcion (el trigger cae con la tabla; las policies tambien).
DROP TABLE IF EXISTS public.digital_prospects;
DROP TABLE IF EXISTS public.digital_prospect_imports;
DROP FUNCTION IF EXISTS public.touch_digital_prospect();
