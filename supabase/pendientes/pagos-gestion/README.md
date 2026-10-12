# Automatización de gestión de pagos — MIGRACIONES PENDIENTES (NO APLICADAS)
B1 (estructuras), B2 (trigger), B3 (confirmaciones) y B4 (recepción) NO están aplicadas en producción y NO están en `supabase/migrations`.
Orden de aplicación futura: B1 → B2 → B3 → B4, solo con respaldo previo y autorización expresa. Rollbacks: ROLLBACK.sql (B1–B3) y ROLLBACK_B4.sql.
Defectos de seguridad: `envio_activo=false`, `confirmaciones_activo=false`, `modo=prueba`. Los scripts *_local / levantar_pg / tests son solo para la BD local desechable.
Funciones (no desplegadas): `supabase/functions/enviar-gestion-pago`, `recibir-respuesta-pago`; pruebas Deno en `_integracion_deno`.
