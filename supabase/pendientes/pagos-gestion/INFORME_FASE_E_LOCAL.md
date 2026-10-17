# Fase E (LOCAL) — Recepción de respuestas Finanzas / Customer Service + columna «N° Pedido SAP»

ESTADO: solo desarrollo local. Sin producción, sin B1/B2/B3/B4 aplicadas, sin deploy, sin push, sin commits, sin Resend real. Por defecto `envio_activo=false`, `confirmaciones_activo=false`, `modo=prueba`.

## Pruebas (144 en verde)
| Suite | Qué prueba | Resultado |
|---|---|---|
| gestion.test.mjs | Fidelidad del contenido vs. botón «Copiar gestión completa» original | 23/23 |
| envio.integracion.test.mjs | Emisor: idempotencia, dudosas→incierto, guard, enlaces firmados (bloqueo si falta uno), destinatarios | 30/30 |
| respuesta.test.mjs | Firma Svix, token, remitente, autenticación, análisis Finanzas/SAP, texto citado | 56/56 |
| recepcion.integracion.test.mjs | Cadena completa contra Postgres local B1–B4, ambos órdenes, duplicados, no autorizados, ambiguas | 26/26 |
| deno.integracion.test.mjs | Los `index.ts` REALES bajo Deno 2.9.6 + PostgREST 12.2.3 real (valida columnas y rutas RPC reales), Storage y Resend simulados | 9/9 |
| test_admin.py (Playwright) | Columna SAP en copia de admin.html | 12/12 |
Mutaciones (5/5 detectadas) en la suite del receptor.

## Archivos
Nuevos (sin commit): `supabase/functions/enviar-gestion-pago/`, `supabase/functions/recibir-respuesta-pago/`, `supabase/functions/_integracion_deno/`.
Fuera del repo: `B4_recepcion.sql` + `ROLLBACK_B4.sql`, `entrega_fase_e/admin.html` (copia), `admin_sap.diff`, capturas. El `admin.html` del repo NO se tocó.

## Cambios Fase C pedidos
- Si falta cualquier enlace firmado (no https / vacío) el correo se BLOQUEA, no se envía incompleto y queda `error` registrado (D4 + I5/I5b).
- Columnas reales de `index.ts` validadas con PostgREST real (D3).

## Admin (copia local)
Columna final «N° Pedido SAP» + botón copiar (📋). Carga `pago_gestiones.sap_numero` solo lectura; si la tabla no existe (pre-B1) muestra «-». Las 7 columnas anteriores quedan idénticas; copiar no expande la fila. Diff: `admin_sap.diff`.

## Regla de avance
«Pedido ingresado al sistema» solo con pago validado por Finanzas autorizado Y N° SAP de Customer Service autorizado, en cualquier orden. Remitente no autorizado, sin autenticación, ambigua o duplicada: no cambia estados (queda evento). El rol y la autenticación se re-verifican en la BD (B3).

## Riesgos / pendientes (requieren decisión o verificación con servicios reales)
1. Resend inbound (actualizado 2026-10-15): endpoint de lectura `GET /emails/receiving/{id}` y objeto `authentication {spf,dkim,dmarc}` CONFIRMADOS en la documentación de Resend (no en vivo). El receptor ya usa ese objeto: solo `dmarc=pass` verifica; el resto falla cerrado. Por comprobar en la prueba aislada (PRUEBA_RECEPCION.md): permisos de la API key, valores reales para remitentes Straumann, tolerancia/reintentos del webhook, prefijo `whsec_`.
2. DNS/MX de `pedidos.recetariostra.cl` y dominio Resend sin configurar; Reply-To puede perderse con «Responder a todos» según cliente.
3. Frases de Finanzas, formato SAP (10 dígitos), remitentes individuales autorizados y ejecutivo UC: provisionales/sin definir (UC sigue bloqueada).
4. Sin UI de revisión manual (`incierto`, `error`, ambiguas) ni cron del emisor; «aceptado» ≠ «entregado».
5. Enlaces firmados caducan a 7 días.
6. Producción requiere B1 (con respaldo manual y restauración probada, hoy en pausa), B2, B3, B4, deploy y secretos: cada paso con autorización expresa.
7. Rama `leads-outbound-v1-preview`: este desarrollo es ajeno a Leads Digital; recomiendo rama propia (p. ej. `pagos-gestion-v1`) antes de cualquier commit. No hice commits.

## Demostración
Ver `DEMO_FLUJO_SALIDA.txt` (script `_integracion_deno/demo_flujo.mjs`): «Pago informado» → correo (Para CS+Cobranza, CC Daniel + ejecutiva de la institución) → CS/Finanzas en ambos órdenes → «Pedido ingresado al sistema»; más caso de respuestas inválidas sin cambios.


## Actualización 2026-10-15 (noche) — Fase 0 cerrada
Prueba real con Resend: `GET /emails/receiving/{id}` → HTTP 200 y `authentication {spf: pass, dkim: pass, dmarc: pass}` para un remitente corporativo de Straumann; la regla del receptor (`dmarc=pass`) lo da por VERIFICADO. Pendiente: remitentes reales de CS/Finanzas, Reply-To en «Responder/Responder a todos», tolerancia/reintentos del webhook (ver PROCEDIMIENTO_PRUEBA_WEBHOOK.md).
