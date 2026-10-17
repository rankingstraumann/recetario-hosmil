# Checklist para autorizar la prueba aislada de recepción (nada de esto está ejecutado)

Estado al 2026-10-15. Marcar cada ítem antes de dar la autorización de despliegue.

## A. Condición de partida (bloqueante)
- [x] `authentication` real de un correo de Straumann consultado con `consultar_recepcion.ps1`: spf/dkim/dmarc = pass (2026-10-15, un remitente corporativo).
- [x] La API key usada (Full access, creada para la prueba) lee correos recibidos: HTTP 200. Pendiente decidir qué clave usará producción (ver PROCEDIMIENTO_PRUEBA_WEBHOOK.md, «Endurecimiento»).
- [x] `dmarc=pass` para el remitente probado. Si otro remitente real (CS/Finanzas) diera otro valor: se detiene y se decide la regla con evidencia (no se relaja por defecto).

## B. Qué se desplegaría (solo si A está completo y Daniel lo autoriza por escrito)
- [ ] Procedimiento PROCEDIMIENTO_PRUEBA_WEBHOOK.md leído y aceptado por Daniel.
- [ ] Solo `recepcion-prueba-pago` (sin JWT; 3 archivos propios; sin BD, sin service role, sin `npm:`; ver pruebas P1–P9, I2 y paridad).
- [ ] NO se despliega `recibir-respuesta-pago` ni `enviar-gestion-pago`; NO se aplican B1–B4.
- [ ] Un único webhook de Resend, evento `email.received`, apuntando a la función de prueba. (Los webhooks de Resend podrían ser de cuenta completa, no por dominio: no está documentado. La función ignora todo lo que no vaya a `prueba-*@` / `reply+<token>@pedidos…`.)
- [ ] Secretos de la prueba cargados por Daniel con nombres PROPIOS (`PRUEBA_RESEND_WEBHOOK_SECRET`, `PRUEBA_RESEND_API_KEY`, opcional `PRUEBA_DOMINIO`), nunca por chat. NO usar `RESEND_API_KEY`: es la clave de envío de producción y se sobrescribiría.
- [ ] Plan de Resend con cuota: cada correo recibido cuenta como uno (Free: 100/día, compartidos con cotizaciones y recordatorios). La prueba usa < 10.
- [ ] Ventana de prueba acordada (hora de inicio y fin) y responsable de borrar webhook, función y secretos al terminar.

## C. Controles para que ninguna prueba altere cotizaciones reales
| Control | Cómo se garantiza | Verificado |
|---|---|---|
| La función de prueba no toca datos | Sin cliente de BD ni service role; análisis estático en test I2; solo GET hacia Resend | Local (I2) |
| Alcance de direcciones | Solo `prueba-*@pedidos…` y `reply+<32 hex>@pedidos…`; el resto responde 200 sin leer ni registrar (P4) | Local (P4) |
| Sin cuerpo ni direcciones en logs | Solo dominio del remitente, banderas y enumerados (P1) | Local (P1) |
| Producción sin cambios | `recibir-respuesta-pago` no desplegada; B1–B4 sin aplicar; `confirmaciones_activo=false` por defecto | Por revisar el día del despliegue |
| Cotizaciones reales protegidas en modo prueba | Lista explícita de prueba + 4 capas SQL/receptor (ver abajo) | Local (M1–M12, P1–P13) |
| Aislamiento comprobado en BD (fase posterior a B1) | `auditoria_aislamiento.sql` (solo lectura) lista las cotizaciones tocadas; tras el ensayo solo deben aparecer las de PRUEBA | Local (I3) |
| Canarios | Cotizaciones ajenas (sin gestión, pendiente, enviada sin respuesta) quedan idénticas byte a byte tras procesar otra (I1) | Local (I1) |

**Brecha cerrada localmente (2026-10-15) — protección del modo prueba (en B1/B3/B4, NO aplicada en producción):** mientras `config.modo` no sea EXACTAMENTE `real` (fila ausente, vacío, `Real`, ` real`, typo… = prueba), solo las cotizaciones de la lista explícita `pago_gestion_cotizaciones_prueba` pueden recibir confirmaciones SAP/financieras o respuestas ambiguas. Capas independientes:
1. Receptor: `pago_gestion_resolver_respuesta` devuelve `modificable`; si es `false` responde `bloqueado_modo_prueba` sin leer el cuerpo ni escribir nada.
2. `pago_gestion_registrar_confirmacion` y `pago_gestion_registrar_ambigua` devuelven `bloqueado_modo_prueba` antes de cualquier escritura (ni siquiera eventos de «no autorizado»).
3. Segunda barrera: `pago_gestion_exigir_modificable` justo antes de cada UPDATE de `cotizaciones` hecho por la gestión.
4. Trigger `pago_gestiones_guardia_modo`: ninguna escritura de SAP / validación / pedido aplicado sobre una gestión real pasa en modo prueba, ni con UPDATE directo de `service_role`.
La lista nace VACÍA y solo se llena con una orden manual (`INSERT INTO pago_gestion_cotizaciones_prueba(cotizacion_id, nota) VALUES (...)`); nada la llena sola ni por patrón de nombre. No toca RPC públicas ni el flujo de pacientes. En modo `real` (activación futura, con autorización explícita) el comportamiento es el previsto. Fuera de alcance: quien sea dueño de la BD puede desactivar el trigger o editar la lista (es el administrador; está auditado por `auditoria_aislamiento.sql`).
Pruebas: `tests.sh` T18 (P1–P13), `modo_prueba.integracion.test.mjs` (M1–M12; verificadas con mutaciones: quitar cada capa hace fallar la prueba correspondiente).
Nota: un correo = un rol (clave primaria por `email`). Un ensayo completo SAP+Finanzas necesita **dos** direcciones de prueba (una por rol).

## D. Qué ya está validado localmente (BD desechable, Resend simulado)
- Identificación del hilo (H1–H6): token en `to`/`cc`/`received_for`; dos hilos entrelazados; asunto/cuerpo/cita no cuentan; tokens casi válidos descartados; dos tokens distintos = ambiguo; token opaco (32 hex de `gen_random_uuid()`, 122 bits aleatorios).
- Orden y duplicados (R1–R5, O1–O2): CS→Finanzas, Finanzas→CS, en paralelo; mismo Message-ID; reenvíos; sin pisar lo registrado.
- No autorizados (R10–R14, O3–O4): antes/entre/después de los legítimos; nombre visible falso; dominio parecido; remitente desactivado a mitad.
- Autenticación (R12, P7, paridad): solo `dmarc=pass`; `processing_failed` reintenta; todo lo demás no cambia estados.

## E. Después de la prueba
- [ ] Borrar webhook, función y secretos de prueba.
- [ ] Anotar resultados (tolerancia de firma, reintentos, valores de `authentication` por remitente) y ajustar el receptor si hace falta.
- [ ] Recién entonces: respaldo + restauración verificados → autorización explícita de B1 → siguiente fase.

## F. Checklist final de despliegue — aislamiento de secretos y cotizaciones existentes (para revisión; nada ejecutado)
**Secretos**
- [ ] Antes de cargar nada: `supabase secrets list` (solo nombres/hashes) guardado como línea base; `RESEND_API_KEY` presente y SIN cambios de hash al final.
- [ ] La función de prueba lee únicamente `PRUEBA_RESEND_WEBHOOK_SECRET`, `PRUEBA_RESEND_API_KEY`, `PRUEBA_DOMINIO` (test P10 + revisión de `index.ts`); ninguna referencia a `RESEND_API_KEY`, `SUPABASE_*` ni `SERVICE_ROLE`.
- [ ] Secretos cargados por panel de Supabase o `--env-file` fuera del repo; nunca en chat, repo ni logs.
- [ ] Clave Full access de la prueba: se elimina en Resend al terminar; el hash de `RESEND_API_KEY` no cambió.
- [ ] Receptor productivo: propuesta `RESEND_API_KEY_RECEPCION` documentada (procedimiento §10); sin implementar.
**Cotizaciones existentes**
- [ ] La función de prueba no tiene cliente de BD (test estático I2); el webhook de prueba no llega a `recibir-respuesta-pago`.
- [ ] B1–B4 NO aplicadas: no existen tablas ni funciones de gestión de pago en producción.
- [ ] Función `enviar-cotizacion` y recordatorios sin redeploy ni cambios; RPC públicas de pacientes y comprobantes sin cambios.
- [ ] Antes y después: conteo y huella (`count(*)`, `max(updated_at)`) de `cotizaciones` iguales (solo lectura).
- [ ] Respaldo + restauración de Supabase verificados antes de cualquier B1.
- [ ] Para fases con BD: `modo` distinto de `real`, `envio_activo=false`, `confirmaciones_activo=false`, lista de prueba vacía salvo cotizaciones de PRUEBA; `auditoria_aislamiento.sql` sin ALERTA.
