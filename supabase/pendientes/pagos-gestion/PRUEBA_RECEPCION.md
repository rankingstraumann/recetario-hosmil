# Prueba aislada de recepción — `pedidos.recetariostra.cl` (NADA de esto está ejecutado ni desplegado)

Objetivo: comprobar con Resend real, **solo con correos ficticios**, (1) que se reciben mensajes en el subdominio, (2) qué devuelve `authentication` para remitentes Straumann, (3) que el webhook llega y su firma valida. No toca BD, estados, pagos, cotizaciones ni correos existentes.

## Evidencia Fase 0 (2026-10-15, aportada por Daniel)
Correo un buzón corporativo de Straumann → `prueba-001@pedidos.recetariostra.cl` recibido por Resend. Cabeceras vistas por Daniel (Amazon SES): SPF pass, DKIM pass (`header.i=@straumann.com`), DMARC pass (`header.from=straumann.com`); ruta M365 → Exclaimer → Proofpoint → SES.
**Falta** comprobar el objeto `authentication` de la API de Resend (es lo que lee el receptor; ver `consultar_recepcion.sh` / `.ps1`). Evidencia a favor, no sustituto.
Ojo: DMARC pass prueba el *dominio* (`straumann.com`), no a la persona: quien decide es la lista de remitentes individuales autorizados + rol.

## Fase 0 — Sin despliegue ni webhook (Daniel, 10 min)
1. Resend → Domains → `pedidos.recetariostra.cl`: confirmar **Receiving: Enabled** (MX verificado).
2. Desde su correo corporativo enviar a `prueba-001@pedidos.recetariostra.cl` un mensaje ficticio ("Prueba recepción 001"). Repetir desde otro buzón/dominio si dispone (p. ej. Gmail personal) para contrastar `authentication`.
3. Resend → Emails → Receiving: confirmar que aparece y anotar el `email_id`.
4. Consultar con el script seguro (pide la API key sin eco, no la guarda, no imprime cuerpo): PowerShell `.\consultar_recepcion.ps1 -EmailId <email_id>` o Bash `bash consultar_recepcion.sh <email_id>`. Compartir su salida completa (solo trae `authentication`, nombres de cabeceras y banderas). No usar `curl` pegando la clave en la línea de comandos.
   - Si responde 401/403: la API key actual (de solo envío) no puede leer correos recibidos → crear una con permiso de lectura.

## Fase 1 — Webhook + firma (requiere autorización explícita de Daniel)
1. Desplegar `recepcion-prueba-pago` (sin JWT; desde la raíz del repo, para que incluya `recibir-respuesta-pago/respuesta.ts`): `supabase functions deploy recepcion-prueba-pago --no-verify-jwt`.
2. Resend → Webhooks → Add Webhook: URL de la función, evento **solo** `email.received`. Copiar el *signing secret*.
3. Guardar secretos **Daniel, sin pasarlos por chat**: `supabase secrets set RESEND_WEBHOOK_SECRET=... RESEND_API_KEY=...` (la función ignora todo correo que no vaya a `prueba-*@pedidos…` o `reply+<token>@pedidos…`).
4. Escenarios (todos ficticios; anotar hora de cada envío):
   - A. `prueba-002@` desde su correo corporativo (repite la Fase 0 vía webhook).
   - B. Responder desde Outlook a un correo cuyo Reply-To sea `reply+<32 hex ficticios>@pedidos…`, con «Responder» y con «Responder a todos» (¿llega el token en `to`/`received_for`?).
   - C. Si puede: enviar desde los buzones compartidos reales de Customer Service y Finanzas (o desde la cuenta de una persona de cada área, avisándoles) para ver su `authentication`; son los remitentes reales del flujo.
   - D. Control externo (Gmail personal) a `prueba-003@`: debe llegar y reportarse; en producción lo frenaría la lista de remitentes autorizados, no DMARC.
   - E. Reintento: reenviar el mismo webhook desde Resend (Webhooks → evento → Resend) y comprobar firma/`skew_s`.
5. Leer los logs de la función (solo metadatos). Campos clave: `firma_valida`, `skew_s`, `secreto_con_prefijo_whsec`, `lectura`, `auth_spf/dkim/dmarc`, `veredicto_regla_actual`, `cabeceras_nombres`, `hilo_token_en_destino`.
6. **Cierre:** borrar el webhook en Resend, eliminar la función y los secretos de prueba.

## Cómo se interpreta el resultado
| Observación | Decisión |
|---|---|
| `dmarc=pass` para remitentes Straumann | La regla actual sirve tal cual. |
| `dmarc=gray/none` pero spf/dkim pass | NO se relaja por defecto (spf/dkim sin alineación se pueden falsificar). Se discute con evidencia: p. ej. pedir a TI publicar DMARC, o regla adicional demostrablemente alineada. Mientras tanto toda respuesta va a revisión manual y no cambia estados. |
| `lectura=sin_permiso_api_key` | Crear API key con lectura antes de activar. |
| `skew_s` alto con firma inválida | Se mide la tolerancia real del timestamp (el verificador usa 300 s). |
| `secreto_con_prefijo_whsec=false` y firma ok | El secreto se guardó sin prefijo; el verificador soporta ambos. |
| `tiene_authentication_results=true` | Solo informativo; la regla no depende de esa cabecera. |
| `hilo_token_en_destino=false` en «Responder a todos» | El cliente de correo ignora el Reply-To: ajustar instrucciones/diseño del asunto antes de activar. |

## Cuota
Cada correo recibido cuenta como uno contra la cuota de envío (plan Free: 100/día, 3.000/mes). La prueba consume < 10.
