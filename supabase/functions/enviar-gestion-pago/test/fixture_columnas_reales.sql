-- SOLO PRUEBA LOCAL: agrega a la tabla stub las columnas reales que usa la gestion (nombres tomados de admin.html). No se aplica en ningun entorno real.
ALTER TABLE public.cotizaciones
  ADD COLUMN IF NOT EXISTS paciente text, ADD COLUMN IF NOT EXISTS rut text, ADD COLUMN IF NOT EXISTS paciente_email text,
  ADD COLUMN IF NOT EXISTS paciente_direccion text, ADD COLUMN IF NOT EXISTS paciente_whatsapp text, ADD COLUMN IF NOT EXISTS doctor text,
  ADD COLUMN IF NOT EXISTS items jsonb, ADD COLUMN IF NOT EXISTS profesional_sucursal text, ADD COLUMN IF NOT EXISTS profesional_direccion_despacho text;
