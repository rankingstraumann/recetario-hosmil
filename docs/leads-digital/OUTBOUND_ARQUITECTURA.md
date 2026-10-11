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
- `digital_prospects`: datos de contacto, `phone_raw` + `phone_e164` (formato `+[1-9]\d{6,14}` o NULL = inválido), `whatsapp_consent` (yes/no/unknown) + `consent_source/at`, `outreach_status` (pending/contacted/replied/opted_out/failed/converted; `eligible` eliminado en 008), `last_outreach_at`, `linked_lead_id → digital_leads` (SET NULL), `is_test`, `raw_payload`, timestamps (trigger `updated_at`).
- Índices no únicos (teléfono, lote, estado, fecha, lead). La política de duplicados se define en la fase del parser.

## Campos comerciales (migración `007`)
`external_customer_id` (Sold-To SAP), `source_owner` (cartera histórica; **no** asigna), `priority_source`, `last_billed_year`, `trade_up_financial`. Lo no mapeado se conserva en `raw_payload`.

## Duplicados (regla para el parser; sin unique sobre teléfono)
1. `external_customer_id` exacto → mismo prospecto (duplicado fuerte). 2. `phone_e164` exacto → posible duplicado, se reporta para revisión. 3. nombre normalizado → solo advertencia, nunca se fusiona automáticamente.

## Elegibilidad (migración `008`): una sola fuente de verdad
- `outreach_status` válidos: `pending, contacted, replied, opted_out, failed, converted` (se eliminó `eligible`: era redundante y podía contradecir al consentimiento/teléfono).
- Columna **generada STORED** `whatsapp_eligible` = `whatsapp_consent='yes'` ∧ `phone_e164` válido ∧ `outreach_status` ∉ {`opted_out`,`converted`}. No se puede escribir a mano ni queda desactualizada. `unknown` y `no` → `false`.
- **Elegible ≠ listo para contactar.** *Listo para contactar* = `whatsapp_eligible = true AND outreach_status = 'pending'`. Un prospecto `contacted`/`replied` sigue siendo elegible pero NO está listo.
- Regla futura del botón "Contactar por WhatsApp": *listo para contactar* (hoy deshabilitado; no hay envío). La UI no recalcula la elegibilidad: lee `whatsapp_eligible`. El parser y el backend de envío deben usar la misma columna.

## Seguridad
- RLS activo en ambas tablas. Única policy: `SELECT` para `authenticated` con `is_lead_admin()` (solo Daniel).
- `authenticated`: solo `SELECT` (sin INSERT/UPDATE/DELETE). `anon`: sin acceso. `service_role`: acceso total (procesos backend futuros).
- No se modificó `digital_leads`, webhook, scoring, secrets, Meta ni cotizaciones.

## UI (admin.html)
Leads Digital → sub-pestañas **[ Leads ] [ Prospectos ]**. Prospectos: contadores (Total, Listos para contactar, Pendientes, Contactados, Respondieron, Convertidos), filtros (búsqueda, origen, consentimiento, estado de contacto, importación, incluir prueba) y tabla. Elegibilidad leída de `whatsapp_eligible`; No / Sin definir / teléfono inválido / baja = no contactar. Botón "Contactar por WhatsApp" **deshabilitado** (no envía nada).

## Outbound 2 — Importador con PREVIEW (no inserta nada)
Prospectos → **⬆ Importar prospectos** → elegir `.xlsx`/`.csv` → Edge Function `prospect-import-preview` → resumen + tabla filtrable. **"Confirmar importación" está deshabilitado**; todo el análisis es de solo lectura (`import_performed:false`).

**Seguridad de la función:** exige sesión y `is_lead_admin()` con el JWT del usuario (sin `service_role`; los duplicados contra BD se leen con RLS del usuario). El archivo se procesa en memoria: no se guarda en Storage ni en la base. Parsing determinista, sin IA ni servicios externos. No se evalúan fórmulas (solo valores). Logs: solo contadores. Límites: 5 MB, 5.000 filas, 20 hojas, 60 columnas, celdas ≤ 2.000 caracteres; extensión y firma (zip/no-zip) validadas.
**Librería:** SheetJS 0.20.3 oficial, build **mini** (solo XLSX) vendorizado en `supabase/functions/prospect-import-preview/vendor/xlsx.mini.mjs` (contenido oficial + una línea `export { XLSX };`; origen, transformación y SHA-256 en `vendor/VENDOR.md`). El CSV NO usa SheetJS: lo procesa `parseCsv`/`decodeCsv`. **Estado de despliegue:** la función desplegada en Supabase aún usa `npm:xlsx@0.18.5` hasta publicar esta versión.

**Mapeo (Trade Up):** Sold-To→`external_customer_id` (texto), Cliente→`clinic_name`, Contacto→`full_name` (vacío = vacío, no se inventa), Cartera original→`source_owner`, Prioridad→`priority_source`, Último año facturado→`last_billed_year`, Trade Up financiero→`trade_up_financial`, Observación→`notes`, el resto (Uso VV, Interés, Próxima acción, Fecha…)→`raw_payload` (todas las columnas originales). `source`='Trade Up', `source_detail`=archivo/hoja, `whatsapp_consent`='unknown', `outreach_status`='pending', `phone_e164`=null si no hay teléfono.

**Validaciones:** Sold-To decimal/científico/caracteres raros → INVÁLIDO; año no entero o fuera de 1990–2100 → INVÁLIDO; fila sin Sold-To/cliente/contacto/teléfono/correo → INVÁLIDO; texto > 300 caracteres → INVÁLIDO; encabezados repetidos dentro de la hoja → excluidos; hojas vacías o sin encabezados reconocibles → informadas y omitidas. Trade Up financiero: `O/SI/SÍ/TRUE/VERDADERO/YES/1`→true, `NO/FALSE/FALSO/0`→false, **vacío→null** (ausencia de marca ≠ "no"), cualquier otro valor→null + advertencia. Teléfonos: celular chileno de 9 dígitos (con/sin 56/+56) → `+569…`; otro formato → sin teléfono + advertencia.
**Duplicados:** Sold-To exacto (archivo o BD) → DUPLICADO (en el archivo queda la primera aparición, las siguientes son duplicados); teléfono exacto → ADVERTENCIA en todos los miembros; nombre normalizado → ADVERTENCIA. Nunca se fusiona.

**Tests:** `supabase/functions/prospect-import-preview/test/` (`make-fixtures.mjs` genera fixtures 100 % ficticios; `run-tests.sh`: 25 casos del análisis + 8 de la confirmación).

## Outbound 3 — Confirmar importación (V1: SOLO datos de prueba)
Flujo: preview válido → **Confirmar importación** (se habilita solo si hay filas listas) → diálogo simple → la UI reenvía **el mismo archivo** con `mode=confirm` a `prospect-import-preview` → la función **re-ejecuta todo el análisis en servidor** (no usa nada del preview del frontend) → llama a la RPC `public.confirm_prospect_import` con el JWT del usuario → resultado «N prospectos importados / N duplicado omitido / N inválidos» → se recarga Prospectos con el filtro **Importación** posicionado en el lote.
- **Qué se inserta:** 1 fila en `digital_prospect_imports` + solo las filas VALIDO/ADVERTENCIA en `digital_prospects`. Duplicado fuerte (Sold-To) → **omitido** (no actualiza ni fusiona; se re-chequea contra la BD dentro de la RPC). Inválidas → no se insertan. Filas sin Sold-To se importan (no pueden ser duplicado fuerte). Advertencias de nombre/teléfono se importan.
- **Valores fijados por la RPC (el cliente no los dicta):** `whatsapp_consent='unknown'`, `outreach_status='pending'`, `is_test=true` (V1), `source='import_excel'`, `phone_e164` NULL si no hay teléfono válido. `raw_payload` conserva las columnas originales (+ `_sheet`, `_row`). Códigos siempre como texto.
- **Seguridad:** RPC `SECURITY DEFINER` (`search_path=pg_catalog`) que exige `is_lead_admin()`; `EXECUTE` solo a `authenticated` (no `anon`/`public`). **No se abrió INSERT directo** a ninguna tabla. Sin `service_role`. Logs: solo contadores.
- **Atómica:** toda la importación ocurre dentro de una sola llamada/transacción; si algo falla (p. ej. teléfono con formato inválido en una fila) no queda nada. **Doble confirmación:** `file_sha256` (SHA-256 del archivo) con índice único + `pg_advisory_xact_lock` → un mismo archivo no puede confirmarse dos veces (409 «ya fue importado»); en la UI el botón queda deshabilitado tras importar.
- **Conteos registrados** en el lote: `total_rows`, `imported_rows`, `duplicate_rows`, `skipped_rows` (= inválidas); `metadata.is_test=true`. Invariante validada en servidor y en la RPC: importadas + inválidas + duplicados = total.
- **Migración:** `sql/leads-digital/009_outbound_confirmar_importacion.sql` (rollback `999f_…`; no borra datos importados).
- **Despliegue:** requiere publicar la versión nueva de la Edge Function (ver estado de despliegue arriba); hasta entonces la UI mostrará error al confirmar.

## Pendiente (fases siguientes)
Parser Excel/CSV (normalización E.164, duplicados, consentimiento), RPC/Edge Function de importación, plantilla WhatsApp aprobada y envío con control de consentimiento/baja, vínculo prospecto→lead en el webhook (match por teléfono), opt-out.

## Rollback
`sql/leads-digital/999f_rollback_outbound_confirmar_importacion.sql` (revierte 009), `999d_rollback_outbound_campos_comerciales.sql` (revierte 007) y `999c_rollback_outbound_prospectos.sql` (solo elimina `digital_prospects`, `digital_prospect_imports`, `touch_digital_prospect()`). Revertir UI: `git revert` del commit o volver a `49192dd`.
