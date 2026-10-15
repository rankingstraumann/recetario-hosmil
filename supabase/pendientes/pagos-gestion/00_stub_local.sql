-- SOLO PARA PRUEBA LOCAL: replica mínima del esquema real (no se aplica en producción)
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;      -- imita Supabase
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;   -- imita Supabase
CREATE TABLE public.instituciones (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), codigo text UNIQUE NOT NULL, nombre text);
INSERT INTO public.instituciones(codigo,nombre) VALUES ('ARMADA','a'),('HOSMIL','h'),('PDI','p'),('UC','uc'),('UDP','u'),('UMAYOR','m'),('UMAYORT','t'),('UNAB','n');
CREATE TABLE public.cotizaciones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero text, institucion text, institucion_codigo text, estado text NOT NULL DEFAULT 'Cotización generada',
  total numeric NOT NULL DEFAULT 100000, historial jsonb NOT NULL DEFAULT '[]', comprobante_path text, token text UNIQUE DEFAULT replace(gen_random_uuid()::text,'-',''), deleted_at timestamptz);
ALTER TABLE public.cotizaciones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "lectura segun permisos de institucion" ON public.cotizaciones FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE TABLE public.cotizacion_pagos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cotizacion_id uuid NOT NULL REFERENCES public.cotizaciones(id), comprobante_path text NOT NULL, monto numeric NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), archivo_hash text);
-- RPC real de producción (cuerpo copiado tal cual de pg_proc)
CREATE OR REPLACE FUNCTION public.registrar_pago_publico(p_token text, p_comprobante_path text, p_monto numeric, p_archivo_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_cotizacion_id uuid; v_total numeric; v_pagado numeric; v_nuevo_estado text;
BEGIN
  SELECT id, total INTO v_cotizacion_id, v_total FROM public.cotizaciones WHERE token = p_token;
  IF v_cotizacion_id IS NULL THEN RETURN jsonb_build_object('error', 'token_invalido'); END IF;
  INSERT INTO public.cotizacion_pagos (cotizacion_id, comprobante_path, monto, archivo_hash) VALUES (v_cotizacion_id, p_comprobante_path, p_monto, p_archivo_hash);
  SELECT COALESCE(SUM(monto), 0) INTO v_pagado FROM public.cotizacion_pagos WHERE cotizacion_id = v_cotizacion_id;
  v_nuevo_estado := CASE WHEN v_pagado >= v_total THEN 'Pago informado' ELSE 'Pagado parcialmente' END;
  UPDATE public.cotizaciones SET estado = v_nuevo_estado, comprobante_path = p_comprobante_path,
      historial = historial || jsonb_build_object('estado', v_nuevo_estado, 'fecha', now(), 'comprobante', true, 'monto_abonado', p_monto)
  WHERE id = v_cotizacion_id;
  RETURN jsonb_build_object('pagado', v_pagado, 'total', v_total, 'saldo', GREATEST(v_total - v_pagado, 0), 'estado', v_nuevo_estado);
END; $f$;
CREATE OR REPLACE FUNCTION public.set_institucion_codigo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_set_institucion_codigo BEFORE INSERT OR UPDATE OF institucion ON public.cotizaciones FOR EACH ROW EXECUTE FUNCTION public.set_institucion_codigo();

CREATE OR REPLACE FUNCTION public.marcar_pago_informado_publico(p_token text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_historial jsonb;
BEGIN
  SELECT historial INTO v_historial FROM public.cotizaciones WHERE token = p_token;
  IF v_historial IS NULL THEN RETURN; END IF;
  UPDATE public.cotizaciones SET estado = 'Pago informado', historial = historial || jsonb_build_object('estado', 'Pago informado', 'fecha', now()) WHERE token = p_token;
END; $f$;

-- Permisos del Admin (replica minima de las tablas reales; la policy real de cotizaciones depende de ellas)
CREATE TABLE public.admin_perfiles (user_id uuid PRIMARY KEY, es_super_admin boolean DEFAULT false, es_observador boolean DEFAULT false, es_vendedor boolean DEFAULT false, es_coordinador boolean DEFAULT false, es_customer_service boolean DEFAULT false, coordinador_id uuid);
CREATE TABLE public.admin_instituciones_permitidas (user_id uuid NOT NULL, institucion_codigo text NOT NULL);
REVOKE ALL ON public.admin_perfiles, public.admin_instituciones_permitidas FROM anon;
