# Procedimiento — prueba aislada del webhook `recepcion-prueba-pago`
**Estado: preparado, NO ejecutado.** Nada se despliega ni se crea hasta que Daniel lo autorice por escrito. Fase 0 (recepción + `authentication`) ya está cerrada (ver PRUEBA_RECEPCION.md).
Proyecto Supabase: `gzimllusbxjorbsbtsse` · URL de la función: `https://gzimllusbxjorbsbtsse.supabase.co/functions/v1/recepcion-prueba-pago` · Dominio de la prueba: `pedidos.recetariostra.cl`.

## 0. Reglas de la prueba
- Solo correos FICTICIOS a `prueba-NNN@pedidos…` o `reply+<32 hex ficticios>@pedidos…`. Nada con datos de pacientes.
- No se aplica B1–B4; no se despliega `recibir-respuesta-pago` ni `enviar-gestion-pago`; no se toca DNS ni la configuración de dominios.
- La clave *Full access* de la prueba vive solo en (a) la terminal de Daniel al ejecutar `consultar_recepcion.ps1` (se pide sin eco) y (b) el secreto `PRUEBA_RESEND_API_KEY` de Supabase. Nunca en el repositorio ni en el chat. Se borra al final.
- Ventana acordada: inicio ____ fin ____ (hora Chile). Responsable de la limpieza: Daniel.

## 1. Antes de empezar (solo lectura)
1. `supabase secrets list --project-ref gzimllusbxjorbsbtsse` → anotar los NOMBRES existentes (los valores no se muestran). Confirmar que NO existe ningún `PRUEBA_*` y que `RESEND_API_KEY` existe y **no se tocará**.
2. `supabase functions list --project-ref gzimllusbxjorbsbtsse` → anotar las funciones actuales (línea base).
3. Resend → Webhooks: anotar los webhooks existentes (se espera ninguno). Resend → API Keys: anotar las claves existentes y cuál es la de la prueba.
4. En la rama `pagos-gestion-v1`: `sha256sum supabase/functions/recepcion-prueba-pago/*.ts` → guardar los 3 hashes (sirven para comprobar qué quedó desplegado).

## 2. Configuración en Supabase (paso a paso)
| # | Quién | Acción |
|---|---|---|
| 2.1 | Daniel (o Claude con autorización expresa, vía herramienta de Supabase) | Desplegar SOLO esta función: `supabase functions deploy recepcion-prueba-pago --no-verify-jwt --project-ref gzimllusbxjorbsbtsse` (desde la raíz del repo). `--no-verify-jwt` es obligatorio: Resend no envía JWT de Supabase. |
| 2.2 | Daniel | Comprobar que quedó sin JWT: `curl -i https://gzimllusbxjorbsbtsse.supabase.co/functions/v1/recepcion-prueba-pago` → debe responder **405** (método no permitido). Un **401** significa que se desplegó con JWT: redesplegar con `--no-verify-jwt`. |
| 2.3 | Claude (lectura) | Descargar el código desplegado y comparar los 3 hashes con los del paso 1.4. Si difiere → detener. |
| 2.4 | Daniel | Cargar los secretos (ver sección 3) **después** de crear el webhook (necesita su *signing secret*). Mientras falten, la función responde 500 `config` y no procesa nada. |

## 3. Secretos necesarios (nombres propios de la prueba)
| Secreto | Valor | Dónde / cómo |
|---|---|---|
| `PRUEBA_RESEND_WEBHOOK_SECRET` | *Signing secret* del webhook (empieza con `whsec_`), visible en Resend → Webhooks → el webhook | Supabase → Edge Functions → Secrets (panel web). Si se usa CLI, no escribir el valor en la línea de comandos (queda en el historial): usar un archivo temporal FUERA del repo con `--env-file` y borrarlo. |
| `PRUEBA_RESEND_API_KEY` | Clave Full access creada para la prueba | Igual. Solo la lee la función de prueba, solo para `GET /emails/receiving/{id}`. |
| `PRUEBA_DOMINIO` (opcional) | `pedidos.recetariostra.cl` (ya es el valor por defecto) | Opcional. |
**NO usar** los nombres `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` ni `GESTION_PAGOS_*`: `RESEND_API_KEY` es la clave de envío de producción (cotizaciones, recordatorios) y un `secrets set` con ese nombre la sobrescribiría; borrar después la clave de prueba rompería los correos reales. Un test automático (P10) falla si `index.ts` lee cualquier nombre que no sea `PRUEBA_*`.
Si tras cargar los secretos la función sigue respondiendo `config`, redesplegar (los secretos los lee al arrancar).

## 4. Configuración en Resend (paso a paso)
1. Resend → Webhooks → **Add Webhook**. Endpoint = la URL de la función (sección superior). Eventos: **solo `email.received`**. Crear.
2. Copiar el *signing secret* y guardarlo directamente como `PRUEBA_RESEND_WEBHOOK_SECRET` (sección 3). No pegarlo en el chat.
3. Anotar si el panel permite desactivar el webhook (la API de Resend admite `status: enabled|disabled` en `PATCH /webhooks/{id}`) y si muestra el historial de entregas con código HTTP.
4. Dejar UN solo webhook activo. Resend no documenta si los webhooks son por dominio o de toda la cuenta; la función ignora todo lo que no vaya a `prueba-*@pedidos…` o `reply+<token>@pedidos…`, así que el resto responde 200 sin leer ni registrar.

## 5. Cómo comprobar la firma y la lectura del correo
**Firma (sin datos reales):**
- Firma falsa: `curl -i -X POST <URL> -H "svix-id: x" -H "svix-timestamp: 1" -H "svix-signature: v1,AAAA" -d "{}"` → **401** `firma_invalida` (con `skew_s` enorme, `secreto_con_prefijo_whsec: true`).
- Firma real: enviar el escenario A (abajo) → en los logs `firma_valida=true`, `skew_s` pequeño (anotarlo: mide el desfase real del reloj/entrega), `secreto_con_prefijo_whsec`. En Resend → Webhooks → entregas: HTTP 200.
**Lectura del correo y `authentication`:** en el mismo log: `lectura=ok`, `lectura_http=200`, `auth_spf/dkim/dmarc`, `veredicto_regla_actual` (esperado `verificado` para remitentes Straumann), `cabeceras_nombres`, `cuerpo_texto/html`, `adjuntos_n`. `sin_permiso_api_key` = la clave no puede leer.
**Dónde ver los logs:** Supabase → Edge Functions → `recepcion-prueba-pago` → Logs; o Claude los lee con la herramienta de Supabase (solo lectura). Solo contienen metadatos (dominio del remitente, banderas, enumerados), nunca cuerpo ni direcciones completas (test P1).
**Escenarios** (anotar hora de cada envío; todo ficticio):
- A. `prueba-002@pedidos…` desde su buzón corporativo.
- B. Responder y «Responder a todos» sobre un correo con Reply-To `reply+<32 hex ficticios>@pedidos…` → `hilo_token_en_destino=true`.
- C. Desde los buzones reales de Customer Service y Finanzas (o una persona de cada área, avisándole): su `authentication`. Son los remitentes reales del flujo.
- D. Control externo (Gmail personal) a `prueba-003@`: debe llegar y reportarse.
- E. Reenviar el mismo evento desde Resend (si el panel lo permite) y comprobar firma y `skew_s`.
- F. Fuera de alcance: correo a `otra-cosa@pedidos…` → log `fuera_de_alcance`, sin lectura.

## 6. Cómo asegurar que la función NO escribe en la base de datos
1. **Por construcción:** el código no importa ningún cliente de BD (`index.ts` solo usa `Deno.serve` y `fetch` GET a `api.resend.com`; `logic.ts` y `reglas_copia.ts` son funciones puras). Tests: I2 (análisis estático: sin `createClient`, `supabase-js`, `SERVICE_ROLE`, `.rpc(`, tablas), P10 (solo lee `PRUEBA_*`, nunca `SUPABASE_*`), paridad, P1–P9.
2. **Qué quedó desplegado:** paso 2.3 (hashes del código descargado = hashes locales).
3. **Sin credenciales de BD en uso:** Supabase inyecta `SUPABASE_URL`/`SERVICE_ROLE_KEY` en toda función, pero la de prueba nunca las lee (P10).
4. **Control antes/después (informativo, solo lectura):** `SELECT count(*), max(updated_at) FROM cotizaciones;` y `SELECT count(*) FROM cotizacion_pagos;` antes y después. Si cambian, puede ser tráfico normal de pacientes: verificar que ninguna fila cambiada tenga relación con la prueba (no hay cotizaciones de prueba ni gestiones, B1 no está aplicado).
5. B1–B4 no se aplican: las tablas `pago_*` ni existen, así que no hay dónde escribir.

## 7. Desactivar y eliminar al finalizar (en este orden)
1. **Desactivar** el webhook (Resend → Webhooks → desactivar, o `PATCH /webhooks/{id}` con `status: disabled`). Comprobar que no llegan más entregas.
2. **Eliminar** el webhook (Resend → Webhooks → Delete). Comprobar que la lista queda vacía (como en la línea base).
3. **Eliminar la función:** `supabase functions delete recepcion-prueba-pago --project-ref gzimllusbxjorbsbtsse`. Comprobar con `supabase functions list` que vuelve a la línea base.
4. **Eliminar los secretos:** `supabase secrets unset PRUEBA_RESEND_WEBHOOK_SECRET PRUEBA_RESEND_API_KEY PRUEBA_DOMINIO --project-ref gzimllusbxjorbsbtsse` (o panel). Comprobar con `supabase secrets list` que no queda ningún `PRUEBA_*` y que `RESEND_API_KEY` sigue.
5. **Eliminar la clave Full access** de la prueba (Resend → API Keys → Delete). Borrar cualquier copia local (archivo `--env-file` temporal, notas).
6. **Comprobar producción intacta:** un correo de cotización normal sigue saliendo (usa `RESEND_API_KEY`, que no se tocó); sin cambios en Vercel, DNS ni dominios de Resend.
7. Registrar resultados (tolerancia de firma, valores de `authentication` por remitente, escenarios B/C) en INFORME_FASE_E_LOCAL.md.

## 8. Criterios de éxito (todos)
- S1 GET a la URL → 405 (sin JWT) · S2 firma falsa → 401 · S3 escenario A: `firma_valida=true`, `lectura=ok`, `auth_dmarc=pass`, entrega HTTP 200 en Resend.
- S4 Escenario C: se conoce el `authentication` de CS y Finanzas (si ≠ `pass`, se detiene y se decide con evidencia; no se relaja la regla).
- S5 Escenario B: se sabe si el token llega en «Responder» y «Responder a todos».
- S6 Escenarios D y F: reportado / ignorado sin lectura.
- S7 Logs sin direcciones, cuerpo ni nombres. · S8 Sin cambios atribuibles en BD, sin impacto en correos existentes. · S9 Cuota de Resend usada < 10 correos.
- S10 Limpieza completa (sección 7) verificada.

## 9. Criterios de aborto y reversión
Abortar y ejecutar la sección 7 de inmediato si: la función devuelve 5xx repetidos; aparece tráfico fuera de alcance que no sea ignorado; un log contiene datos personales; se acerca el límite de la cuota diaria; o cualquier cambio en BD parece atribuible a la prueba. La reversión no necesita restaurar nada: la función no escribe, no hay migraciones ni DNS nuevos; basta la sección 7. Si por error se sobrescribió `RESEND_API_KEY`, restaurar la clave de envío anterior (Resend → API Keys) y volver a cargarla.

## 10. Endurecimiento posterior (opcional, antes de producción)
- **PROPUESTA (documentada, NO implementada): clave independiente `RESEND_API_KEY_RECEPCION` para el receptor productivo.** Motivo: `RESEND_API_KEY` es la clave de envío productiva (cotizaciones y recordatorios); el receptor solo necesita *leer* correos recibidos. Con una clave propia (a) una rotación o revocación de la clave de recepción no afecta los envíos, (b) se puede dar el mínimo permiso posible a cada una, (c) un secreto mal cargado no puede pisar el de envío. Cambio futuro mínimo: en `recibir-respuesta-pago/index.ts` leer `RESEND_API_KEY_RECEPCION` (sin caer a `RESEND_API_KEY` como respaldo, para no mezclar permisos), con su test estático equivalente al P10; el secreto del webhook ya tiene nombre propio (`RESEND_WEBHOOK_SECRET`). Hoy el código sigue leyendo `RESEND_API_KEY`: no se cambia hasta autorización expresa, y se decide junto con el despliegue productivo.
- La documentación de Resend consultada no indica si una clave de solo envío (*Sending access*, con restricción de dominio) puede leer correos recibidos. Después de la prueba, probar con una clave así y `consultar_recepcion.ps1`: si responde 401/403, la clave de recepción necesita permiso de lectura (en la prueba funcionó Full access).
- Rotar el *signing secret* y la clave tras cualquier exposición accidental.

## 11. Quién hace qué
| Daniel | Claude (solo con tu autorización) |
|---|---|
| Crear/desactivar/borrar el webhook y la clave en Resend; cargar y borrar secretos en Supabase; enviar los correos de prueba; ejecutar los `curl` de comprobación | Desplegar la función (solo si lo autoriza; sin secretos), comparar hashes del código desplegado, leer logs (solo lectura), interpretar resultados, actualizar la documentación |
