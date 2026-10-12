-- ROLLBACK LEADS DIGITAL V1 -- elimina SOLO objetos creados por 001/002/003/004.
-- Orden: realtime -> triggers -> funciones -> tablas.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='digital_leads') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.digital_leads';
  END IF;
END $$;
DROP TABLE IF EXISTS public.digital_lead_messages;
DROP TABLE IF EXISTS public.digital_lead_activities;
DROP TABLE IF EXISTS public.digital_leads;            -- elimina sus triggers
DROP TABLE IF EXISTS public.digital_lead_assignees;
DROP TABLE IF EXISTS public.lead_admin_users;
DROP FUNCTION IF EXISTS public.assign_digital_lead(uuid,text,text);
DROP FUNCTION IF EXISTS public.update_digital_lead_notes(uuid,text);
DROP FUNCTION IF EXISTS public.score_digital_lead();
DROP FUNCTION IF EXISTS public.touch_digital_lead();
DROP FUNCTION IF EXISTS public.is_lead_admin();
