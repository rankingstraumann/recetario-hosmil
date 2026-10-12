# Runbook de aplicación de B1 — LISTO, NO EJECUTADO (espera: confirmación de backup + autorización explícita)
Alcance exclusivo: B1_estructuras.sql. NO B2, NO B3, sin trigger, sin Edge Functions, sin cron, sin DNS, sin despliegues.
Pruebas locales: 142/142 PASS (tests.sh) · controles posteriores 19/19 PASS · huella estructural idéntica antes/después.

## Decisiones incorporadas en esta versión
- FK `pago_gestiones -> cotizaciones` = ON DELETE RESTRICT. Verificado en producción: la app NO borra cotizaciones físicamente (solo `deleted_at`), no existe RPC con DELETE ni política DELETE sobre `cotizaciones`; ya existe una FK NO ACTION hacia cotizaciones (recordatorios_ejecuciones). Consecuencia: un DELETE físico (solo posible desde SQL/service role) de una cotización con gestión fallará; hay que decidir conscientemente borrar la gestión primero. El borrado lógico sigue funcionando y conserva SAP/Finanzas. La bitácora `pago_gestion_eventos` no tiene FK, así que sobrevive.
- ELEGIBILIDAD de envío (probada): una gestión solo se reclama si la cotización existe, no está eliminada lógicamente, no está anulada, sigue exactamente en "Pago informado" (si Nicole/Finanzas ya la movieron a mano, no se envía) y el pago acumulado (cotizacion_pagos) cubre el total.
  · `pago_gestion_reclamar` la aplica en el momento de reclamar. · El emisor la revalida justo antes de Resend con `pago_gestion_motivo_no_elegible` y, si falló, llama `pago_gestion_soltar` (nunca se envía).
  · `pago_gestion_revisar_elegibilidad` (barrido de cron, fases siguientes) marca `no_elegible` + evento para revisión manual, y REACTIVA si vuelve a ser elegible. No toca gestiones ya enviadas (aceptado/incierto).
- Hallazgo de producción que justifica la regla de cobertura: `marcar_pago_informado_publico(p_token)` (botón "avisar" del paciente) fija "Pago informado" SIN condiciones, aun con pago parcial o sin pagos registrados; además puede reabrir "Pago informado" sobre cotizaciones ya avanzadas (comportamiento existente, no se modifica). Desde 2026-10 las 14 cotizaciones en "Pago informado" tienen pagos que cubren el total; antes de fines de septiembre la mayoría no tenía filas en cotizacion_pagos (por eso el histórico se marca `omitido_historico`).

## A. Checklist PREVIO (todos deben cumplirse; si uno falla, no se aplica)
[ ] 1. Backup MANUAL (plan Free sin respaldos automáticos): seguir RESPALDO_MANUAL.md el mismo día de B1: pg_dump (Session pooler) cifrado, en 2 destinos fuera del proyecto, RESUMEN.txt revisado (SHA256), prueba de restauración aislada PASS y ensayo de B1 sobre la copia = 19/19 PASS con huella idéntica. Anotar fecha/hora y destinos: __________
[ ] 2. Línea base: ejecutar HUELLA_estructural.sql y comprobar que las 8 filas coinciden con LINEA_BASE_PRE_B1.txt (tomada hoy). Si difieren, detener y revisar qué cambió.
[ ] 3. Sin objetos pago_* previos (esperado 0 tablas).
[ ] 4. Sin transacciones largas ni locks sobre cotizaciones (pg_stat_activity); ventana de baja actividad.
[ ] 5. Edge Functions en las mismas versiones (enviar-cotizacion v29, enviar-recordatorio-pago v24, procesar-recordatorios-pago v26, cotizador-ia-v2 v18, whatsapp-webhook v16).
[ ] 6. Confirmación expresa de Daniel por escrito en el chat: "AUTORIZADO aplicar B1".

## B. Aplicación (un solo paso atómico)
apply_migration, nombre `recetario_pagos_b1_estructuras`, contenido de B1_estructuras.sql SIN las líneas BEGIN/COMMIT (la migración ya es transaccional). `SET LOCAL lock_timeout='5s'`: si no consigue el lock breve de la FK, aborta limpio. Cualquier error => nada queda a medias.

## C. Controles POSTERIORES (inmediatos)
(Control 19 corregido: sin `AND false`; verifica 3 funciones + coincidencia de la elegibilidad con un predicado independiente en TODAS las cotizaciones reales + 0 gestiones reclamables. Probado con datos variados y 4 escenarios dañados que deben dar FAIL.)
[ ] 1. CONTROLES_POST_B1.sql => 19 filas PASS (si la #16 dice REVISAR, hay una cotización en "Pago informado" sin gestión: manejar a mano).
[ ] 2. HUELLA_estructural.sql => 8 filas IDÉNTICAS a la línea base (prueba de que ninguna tabla, función, política, índice, trigger propio ni cron productivo cambió).
[ ] 3. Único cambio declarado en cotizaciones: +2 triggers INTERNOS de la FK (restrict de DELETE/UPDATE de clave). Sin columnas, datos, políticas ni funciones nuevas en ella. Verificar `select count(*) from pg_trigger where tgrelid='cotizaciones'::regclass and tgisinternal` = valor previo + 2.
[ ] 4. Edge Functions sin cambio de versión; sin errores nuevos en logs de Postgres/API.
[ ] 5. Conteos: pago_gestiones = nº histórico estimado (229 el 12-oct; puede variar por altas), todas `omitido_historico`; 0 eventos.
[ ] 6. Prueba de humo del paciente: NO se realiza con datos reales (B1 no tiene trigger; el flujo del paciente no puede verse afectado). Se verificará en B2 con una cotización de prueba marcada.

## D. Reversa
- Instalación (destructivo, borra datos pago_*): ROLLBACK.sql — probado: deja cotizaciones y pagos idénticos y la huella = línea base.
- Operativo (conserva datos): OPERATIVO_OFF.sql — con B1 solo ya está todo apagado (envio_activo=false, confirmaciones_activo=false, modo=prueba).
- Criterio: cualquier FAIL en C.1/C.2 => ROLLBACK.sql y re-verificar la huella.

## E. Qué NO cambia con B1
Sin trigger: ninguna escritura del paciente toca estas tablas. Sin Edge Function ni cron: nada envía ni lee. Interruptores apagados; modo prueba => solo Daniel; guardia `pago_gestion_validar_envio` rechaza CS/Finanzas/ejecutivos/BCC. RPCs del paciente, correos de cotización y recordatorios: intactos.
