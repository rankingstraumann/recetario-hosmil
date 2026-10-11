# Leads Digital · Outbound (Prospectos) — Arquitectura

Rama: `leads-outbound-v1-preview` (desde `49192dd`, sin merge a main). Estado: **Fase 1 — fundación** (estructura + UI de solo lectura).

## Modelo
```
Planilla / base comercial
  → digital_prospect_imports (lote)  →  digital_prospects (una fila por persona)
  → [futuro] plantilla WhatsApp aprobada, solo si consentimiento = yes y teléfono válido
  → respuesta del prospecto → MISMO bot (Q1–Q5, whatsapp-webhook) → digital_leads (scoring HOT/Tibio/Frío)
  → derivación manual existente.  Al crearse el lead: digital_prospects.linked_lead_id + outreach_status = converted
```
No hay un segundo bot ni un segundo scoring. Los prospectos **no** son leads: no entran a "Nuevos hoy", HOT, Tibios, Fríos, Sin asignar ni Asignados hasta convertirse.

## Tablas (migración `006_outbound_prospectos.sql`)
- `digital_prospect_imports`: filename, source_name, total/imported/skipped/duplicate_rows, created_by, created_at, metadata.
- `digital_prospects`: datos de contacto, `phone_raw` + `phone_e164` (formato `+[1-9]\d{6,14}` o NULL = inválido), `whatsapp_consent` (yes/no/unknown) + `consent_source/at`, `outreach_status` (pending/eligible/contacted/replied/opted_out/failed/converted), `last_outreach_at`, `linked_lead_id → digital_leads` (SET NULL), `is_test`, `raw_payload`, timestamps (trigger `updated_at`).
- Índices no únicos (teléfono, lote, estado, fecha, lead). La política de duplicados se define en la fase del parser.

## Seguridad
- RLS activo en ambas tablas. Única policy: `SELECT` para `authenticated` con `is_lead_admin()` (solo Daniel).
- `authenticated`: solo `SELECT` (sin INSERT/UPDATE/DELETE). `anon`: sin acceso. `service_role`: acceso total (procesos backend futuros).
- No se modificó `digital_leads`, webhook, scoring, secrets, Meta ni cotizaciones.

## UI (admin.html)
Leads Digital → sub-pestañas **[ Leads ] [ Prospectos ]**. Prospectos: contadores (Total, Elegibles WhatsApp, Pendientes, Contactados, Respondieron, Convertidos), filtros (búsqueda, origen, consentimiento, estado de contacto, importación, incluir prueba) y tabla. Elegibilidad **visual**: consentimiento Sí + teléfono válido + no contactado = elegible; No / Sin definir / teléfono inválido / baja = no contactar. Botón "Contactar por WhatsApp" **deshabilitado** (no envía nada).

## Pendiente (fases siguientes)
Parser Excel/CSV (normalización E.164, duplicados, consentimiento), RPC/Edge Function de importación, plantilla WhatsApp aprobada y envío con control de consentimiento/baja, vínculo prospecto→lead en el webhook (match por teléfono), opt-out.

## Rollback
`sql/leads-digital/999c_rollback_outbound_prospectos.sql` (solo elimina `digital_prospects`, `digital_prospect_imports`, `touch_digital_prospect()`). Revertir UI: `git revert` del commit o volver a `49192dd`.
