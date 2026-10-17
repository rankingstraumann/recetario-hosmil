# Prueba aislada de recepción — `pedidos.recetariostra.cl` (Fase 0 y pruebas con la función aislada EJECUTADAS el 2026-10-17; infraestructura temporal pendiente de cierre — ver PROCEDIMIENTO_PRUEBA_WEBHOOK.md §C)

Objetivo: comprobar con Resend real, **solo con correos ficticios**, (1) que se reciben mensajes en el subdominio, (2) qué devuelve `authentication` para remitentes Straumann, (3) que el webhook llega y su firma valida. No toca BD, estados, pagos, cotizaciones ni correos existentes.

## Evidencia Fase 0 — CERRADA (2026-10-15)
- Recepción: un correo desde un buzón corporativo de Straumann a `prueba-001@pedidos.recetariostra.cl` fue recibido por Resend (MX del subdominio operativo).
- Cabeceras vistas por Daniel (Amazon SES): SPF pass, DKIM pass (`header.i=@straumann.com`), DMARC pass (`header.from=straumann.com`); ruta M365 → Exclaimer → Proofpoint → SES.
- API de Resend (`GET /emails/receiving/{id}`, consultada con `consultar_recepcion.ps1`): **HTTP 200**, `authentication = {spf: pass, dkim: pass, dmarc: pass}`; regla actual → **VERIFICADO**. El correo trae texto, HTML y 6 adjuntos.
- Esa consulta se hizo con una clave de permiso *Full access* creada para la prueba (no consta en la documentación de Resend si una clave de solo envío puede leer correos recibidos; ver «Endurecimiento» en PROCEDIMIENTO_PRUEBA_WEBHOOK.md).
- Alcance de la evidencia: UN remitente corporativo (el de Daniel). Pendiente de comprobar: remitentes reales de Customer Service y Finanzas (escenario C) y el caso «Responder / Responder a todos» con Reply-To (escenario B).
- DMARC pass prueba el *dominio* (`straumann.com`), no a la persona: quien decide es la lista de remitentes individuales autorizados + rol.

## Evidencia Fases 1–3 con la función aislada (2026-10-17) — sin datos personales ni credenciales
| Prueba | Resultado |
|---|---|
| Despliegue de `recepcion-prueba-pago` (sin JWT) | v1 ACTIVE; las 7 funciones previas conservaron versión y hash. |
| GET a la función | HTTP 405 `metodo_no_permitido`. |
| POST sin firma | HTTP 401 `firma_invalida`. |
| Webhook real de Resend (evento `email.received` ficticio) | HTTP 200; `firma_valida=true`; `hilo_token_en_destino=true`; `lectura=ok`; `auth_spf/dkim/dmarc=pass`; `veredicto_regla_actual=verificado`. |
| Reply-To real desde Outlook, **Responder** (prueba «Reply-To 001») | La respuesta llegó a `reply+<token ficticio>@pedidos.recetariostra.cl`; HTTP 200; `firma_valida=true`; `hilo_token_en_destino=true`; `lectura=ok`; SPF/DKIM/DMARC `pass`; `skew_s=0`; cabeceras `In-Reply-To` y `References` presentes. |

Conclusión: con el Outlook corporativo probado, **Responder respeta Reply-To** y el token llega íntegro. La firma Svix valida con desfase 0 s y la lectura con la clave de prueba funciona.

**Pendiente (no probado):**
- **Responder a todos** en Outlook (con un segundo destinatario).
- Remitentes reales de Customer Service y Finanzas (valor de `authentication`, Reply-To en Responder/Responder a todos, buzones compartidos o listas de distribución).
- Otros clientes de correo (web, móvil, Gmail).
- Comparación byte a byte (SHA-256) del código desplegado con el local: no se pudo hacer desde el entorno de Claude; sin efecto práctico una vez eliminada la función.

## Fase 0 — Sin despliegue ni webhook (Daniel, 10 min)
1. Resend → Domains → `pedidos.recetariostra.cl`: confirmar **Receiving: Enabled** (MX verificado).
2. Desde su correo corporativo enviar a `prueba-001@pedidos.recetariostra.cl` un mensaje ficticio ("Prueba recepción 001"). Repetir desde otro buzón/dominio si dispone (p. ej. Gmail personal) para contrastar `authentication`.
3. Resend → Emails → Receiving: confirmar que aparece y anotar el `email_id`.
4. Consultar con el script seguro (pide la API key sin eco, no la guarda, no imprime cuerpo): PowerShell `.\consultar_recepcion.ps1 -EmailId <email_id>` o Bash `bash consultar_recepcion.sh <email_id>`. Compartir su salida completa (solo trae `authentication`, nombres de cabeceras y banderas). No usar `curl` pegando la clave en la línea de comandos.
   - Si responde 401/403: la API key actual (de solo envío) no puede leer correos recibidos → crear una con permiso de lectura.

## Fase 1 — Webhook + firma (requiere autorización explícita de Daniel)
Procedimiento completo, criterios de éxito y reversión: **PROCEDIMIENTO_PRUEBA_WEBHOOK.md**. Resumen: desplegar `recepcion-prueba-pago` (sin JWT) → crear UN webhook `email.received` → cargar secretos `PRUEBA_*` (nunca por chat) → escenarios A–E → leer logs → desactivar y borrar todo.

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
