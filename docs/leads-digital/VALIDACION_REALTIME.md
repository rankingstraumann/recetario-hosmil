# Leads Digital — Validación Realtime (preview)

Fecha: 2026-10-11 · Rama: `leads-digital-v1-preview` (sin merge a main)

## Resultado: PASS completo (INSERT y UPDATE sin recarga)

| Prueba | Evidencia | Resultado |
|---|---|---|
| Publicación | `digital_leads` en `supabase_realtime` (única tabla; `cotizaciones` no modificada) | PASS |
| Suscripción | `realtime.subscription`: entity `digital_leads`, filtros `{}`, rol `authenticated`, claims de Daniel | PASS |
| Canal | Consola: `crear canal. sesion=valida` → `Leads realtime status: SUBSCRIBED` | PASS |
| RLS | `is_lead_admin()` con la identidad de Daniel devuelve true y ve el lead | PASS |
| INSERT `PRUEBA REALTIME 2` (13:26:17 UTC) | Apareció en el dashboard sin F5 | PASS |
| UPDATE mismo lead (13:28:44 UTC): score 5→95, cold→HOT | Cambió en el dashboard sin F5 | PASS |

## Primer intento (PRUEBA REALTIME, 13:18:35 UTC): FAIL
El lead no apareció sin F5. No se reprodujo con una página cargada con el canal en SUBSCRIBED.
Causa más probable (no demostrada): la pestaña estaba abierta desde antes con un canal sin
suscripción activa (el registro de suscripción observado se creó 13:21:25, tras el refresco).
Sin cambios de código, RLS, GRANT ni publicación. Pendiente de vigilar: caída/expiración del
canal en sesiones largas (no se agregó polling ni reconexión; decisión de Daniel).

## Alcance
No se modificó RLS, GRANT, publicación de otras tablas ni Realtime de `cotizaciones`.
Logs temporales de diagnóstico (`[LeadsRT]`) retirados; `admin.html` vuelve al código de `7538455`.
Datos de prueba conservados hasta autorización de Daniel.
