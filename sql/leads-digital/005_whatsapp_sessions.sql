-- LEADS DIGITAL — FASE 2 / 005: sesiones de conversación WhatsApp.
-- Alcance: SOLO objetos del módulo Leads Digital. No cambia RLS ni GRANT existentes.
-- Precondición verificada: public.digital_lead_messages tiene 0 filas.

-- 1) Tabla nueva: solo backend (service_role). RLS activo, sin policies, sin acceso de frontend.
CREATE TABLE public.digital_lead_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  lead_id         uuid REFERENCES public.digital_leads(id) ON DELETE SET NULL,
  current_step    text NOT NULL DEFAULT 'start'
                  CHECK (current_step IN ('start','q1','q1b','q2','q3','q4','q5','done')),
  status          text NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started','q1','q2','q3','q4','q5','completed','handed_off','expired')),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dl_sessions_phone        ON public.digital_lead_sessions (phone_e164, created_at DESC);
CREATE UNIQUE INDEX uq_dl_sessions_active ON public.digital_lead_sessions (phone_e164)
  WHERE status NOT IN ('completed','expired','handed_off');
CREATE INDEX idx_dl_sessions_lead         ON public.digital_lead_sessions (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX idx_dl_sessions_last_msg     ON public.digital_lead_sessions (last_message_at DESC);

CREATE FUNCTION public.touch_digital_lead_session() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN NEW.updated_at := pg_catalog.now(); RETURN NEW; END $$;

CREATE TRIGGER trg_touch_digital_lead_session BEFORE UPDATE ON public.digital_lead_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_digital_lead_session();

ALTER TABLE public.digital_lead_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.digital_lead_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.digital_lead_sessions TO service_role;
REVOKE ALL ON FUNCTION public.touch_digital_lead_session() FROM PUBLIC, anon, authenticated;

-- 2) digital_lead_messages: mensajes previos a que exista el lead.
ALTER TABLE public.digital_lead_messages ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE public.digital_lead_messages
  ADD COLUMN session_id uuid REFERENCES public.digital_lead_sessions(id) ON DELETE CASCADE;
ALTER TABLE public.digital_lead_messages
  ADD CONSTRAINT digital_lead_messages_owner_check CHECK (lead_id IS NOT NULL OR session_id IS NOT NULL);
CREATE UNIQUE INDEX uq_dl_messages_provider_id ON public.digital_lead_messages (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_dl_messages_session ON public.digital_lead_messages (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_dl_messages_lead    ON public.digital_lead_messages (lead_id, created_at) WHERE lead_id IS NOT NULL;
