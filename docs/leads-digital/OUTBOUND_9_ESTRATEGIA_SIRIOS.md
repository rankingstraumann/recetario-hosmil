# OUTBOUND 9 — Estrategia SIRIOS / SIRIOS X3 (decisiones congeladas)

**Estado:** documento maestro funcional/comercial. **Fuente de verdad** para desarrollar Outbound 9. **No contiene código, migraciones ni despliegues.**
**Rama:** `leads-outbound-v1-preview`. **Alcance de este documento:** congelar decisiones comerciales y de UX antes de programar.

> Regla de contenido externo (CRÍTICA): todo texto visible al cliente se rige por la sección 1. Nada de lo interno aparece en plantillas, bot, PDF, UI pública ni respuestas.

---

## 1. Objetivo de negocio interno (NO visible al cliente)

Straumann Group Chile necesita aumentar fuertemente la generación de demanda y la venta de scanners **SIRIOS** y **SIRIOS X3**, con una necesidad interna de acelerar resultados durante Q4.

**JAMÁS se muestra al cliente:** Q4, metas comerciales internas, presión por cumplimiento ni ningún otro motivo interno.

**Externamente solo se habla de:**
- SIRIOS y SIRIOS X3
- mejora del flujo digital
- Trade Up
- condiciones comerciales especiales
- alternativas de crédito directo de **hasta 36 cuotas**
- «sujeto a evaluación comercial» cuando corresponda

## 2. Concepto de campaña

- **Concepto principal:** «DA EL SIGUIENTE PASO EN TU FLUJO DIGITAL»
- **Productos:** SIRIOS | SIRIOS X3
- **Propuesta:** «Conoce SIRIOS y SIRIOS X3, revisa las alternativas disponibles y accede a opciones de crédito directo de hasta 36 cuotas, sujeto a evaluación comercial.»
- **CTA paraguas:** «Pide tu Evaluación SIRIOS»
- **Complemento:** «Descubre qué alternativa puede ajustarse mejor a tu clínica y a tu flujo de trabajo.»
- La evaluación es una acción de **baja fricción**: no se obliga al cliente a decidir de inmediato que quiere comprar.

## 3. Imagen / creatividad inicial (solo documentación; no se crean imágenes)

- Se propone usar imagen al inicio de la futura campaña/plantilla.
- Preferencia: **fotografía OFICIAL** de SIRIOS/SIRIOS X3. **No** generar una representación artificial del scanner.
- Estilo: limpio/premium, poco texto.
- Concepto de pieza:

```
DA EL SIGUIENTE PASO EN TU FLUJO DIGITAL
SIRIOS | SIRIOS X3
Hasta 36 cuotas*
Pide tu Evaluación SIRIOS

*Crédito sujeto a evaluación comercial.
```

**Tres líneas creativas futuras (conceptuales):**

| Línea | Gancho |
|---|---|
| A. Financiamiento | «Hasta 36 cuotas» |
| B. Trade Up | «Tu scanner actual puede ser el punto de partida» |
| C. Tecnología / postgrado | Gancho aspiracional ligado a odontología digital y desarrollo profesional |

## 4. Principio del bot

Outbound 9 **no** es un formulario de 5 preguntas iguales para todos. Es un **funnel conversacional**:

```
Impacto → interés → identificación de perfil → identificación de necesidad
→ ruta comercial personalizada → CTA → Evaluación SIRIOS → Lead Digital
```

- **Máximo 5 preguntas**; no necesariamente existen las 5.
- Si ya conocemos un dato del prospecto (nombre, clínica, teléfono, comuna, etc.): **no se vuelve a preguntar**; se reutiliza cuando sea seguro hacerlo.

## 5. Perfiles de audiencia

Campo conceptual `customer_profile`:

| Valor | Texto visible |
|---|---|
| `owner_partner` | Soy dueño/a o socio/a de una clínica |
| `clinician` | Trabajo en una clínica o centro odontológico |
| `postgraduate` | Estoy en postgrado / formación clínica |
| `explorer` | Solo estoy conociendo alternativas |

**Importante:** el perfil postgrado **no** es automáticamente un lead de menor valor. Puede ser usuario futuro, influenciador, prescriptor, familiar de un propietario, miembro de una clínica o quien lleve la oportunidad al tomador de decisión.

## 6. Situación digital actual

- Pregunta base: «¿Actualmente trabajan con un escáner intraoral?» → Sí / No.
- Si responde **Sí**: «¿Cuál utilizan actualmente?»
- **Postgrado** (contexto adaptado): «¿En la clínica donde trabajas, estudias o tienes mayor cercanía utilizan actualmente un escáner intraoral?» → Sí / No / No estoy seguro.

## 7. Rutas comerciales

Campo conceptual `commercial_route`: `trade_up`, `first_scanner`, `renewal_workflow`, `postgraduate_influencer`, `exploration`.

### 7.1 Trade Up
Mensaje: «Perfecto. Tu equipo actual puede ser el punto de partida. Podemos evaluar tu escáner y revisar una alternativa de Trade Up hacia SIRIOS o SIRIOS X3, junto con las condiciones comerciales y alternativas de financiamiento disponibles.»
CTAs: Evaluar mi Trade Up · Comparar SIRIOS / SIRIOS X3 · Agendar demostración · Hablar con un especialista.
CTA paraguas: «Pide tu evaluación de Trade Up y descubre qué alternativa puede mejorar tu flujo digital.»

### 7.2 Primer scanner
Mensaje: «Dar el primer paso hacia un flujo digital no tiene por qué ser complejo. Podemos ayudarte a evaluar si SIRIOS o SIRIOS X3 hace más sentido para tu clínica y revisar alternativas de crédito directo de hasta 36 cuotas, sujeto a evaluación comercial.»
CTAs: Comparar ambos · Conocer SIRIOS · Conocer SIRIOS X3 · Ver una demostración.
Cierre: «Solicita tu Evaluación SIRIOS y descubre cómo comenzar a digitalizar tu clínica.»

### 7.3 Renovación / mejora de flujo
Mensaje: «Podemos revisar cómo SIRIOS o SIRIOS X3 puede integrarse a tu flujo actual y qué alternativa hace más sentido para lo que quieres mejorar.»
Detectar: Agilizar mi flujo de trabajo · Renovar mi tecnología · Mejorar mi experiencia digital · Evaluar un equipo más completo.
CTA: «Pide tu evaluación comercial y da el siguiente paso en tu flujo digital.»

### 7.4 Postgrado / influenciador
Mensaje: «Si estás en postgrado o formación clínica, conocer distintas soluciones digitales puede ayudarte a entender mejor cómo integrar estas tecnologías a tu práctica. Podemos mostrarte SIRIOS y SIRIOS X3, comparar las alternativas y, si ves una oportunidad en tu clínica o entorno profesional, preparar una evaluación comercial para revisarla con quienes toman la decisión.»
CTAs: Quiero comparar SIRIOS / SIRIOS X3 · Quiero una demostración · Quiero conocer las opciones de financiamiento · Quiero compartir esta opción con mi clínica.
**No** se exige que el estudiante sea propietario ni comprador.

### 7.5 Exploración
No presionar la venta. Opciones: Comparar SIRIOS / SIRIOS X3 · Conocer la tecnología · Ver demostración · Hablar con especialista.

## 8. Interés de producto

Campo conceptual `product_interest`: `sirios`, `sirios_x3`, `compare`, `undecided`. **Sin migración todavía.**

## 9. Momento de compra

Pregunta: «¿En qué momento te gustaría avanzar?»
Opciones: Ahora / este mes · 1–3 meses · 3–6 meses · Más adelante · Solo estoy evaluando.
Esta información sigue alimentando el scoring.

## 10. Financiamiento

El crédito directo de **hasta 36 cuotas** es uno de los principales argumentos de campaña. **No se esconde al final.**

- Se usa **una vez** como gancho/beneficio, **eventualmente** como recordatorio cuando corresponda, y en el **cierre** si es comercialmente relevante.
- **No** se repite en cada mensaje.
- Cuando corresponda, siempre con las fórmulas «hasta 36 cuotas» y «sujeto a evaluación comercial».
- **Nunca** se promete aprobación automática.

## 11. Señales de alta intención (a analizar posteriormente para scoring)

Solicita cotización/propuesta · solicita demostración · solicita evaluación comercial · solicita Trade Up · quiere avanzar ahora/este mes · pregunta directamente por cuotas/financiamiento · pregunta «cuánto queda la cuota» · quiere hablar con especialista · quiere SIRIOS X3 · quiere comparar SIRIOS/X3 con intención de compra.

**No se modifica el scoring en esta etapa.**

## 12. Datos del cliente

- No se vuelven a pedir datos disponibles. Ejemplo (conocemos nombre + clínica + teléfono, falta comuna): «Perfecto, Daniel. Para conectar tu evaluación con el equipo adecuado, solo me falta tu comuna.»
- Si ya se conocen todos los campos: **no** se crea una Q5 artificial.
- Postgrado sin clínica propia: se permite seguir. Puede preguntarse «¿Hay alguna clínica, centro o institución con la que quieras evaluar esta oportunidad?», pero responder que no **no elimina el lead**.

## 13. Cierre / recompensa

El cierre debe transmitir que completar la conversación produjo una acción. Se evita el cierre frío («Registramos tus antecedentes.»).

Ejemplo HOT: «Perfecto, Daniel. Ya tenemos lo necesario para evaluar tu caso. Vamos a revisar qué alternativa SIRIOS/SIRIOS X3 puede ajustarse mejor a tu situación, junto con las condiciones comerciales y opciones de financiamiento disponibles. Tu Evaluación SIRIOS quedó solicitada.»

El mensaje se adapta según la ruta comercial.

## 14. Métricas futuras

Prospectos contactados · tasa de respuesta · perfil · ruta comercial · producto de interés · CTA seleccionado · plazo · temperatura · evaluaciones solicitadas · demos · propuestas · leads convertidos · ventas (cuando exista integración futura).

Funnel esperado: `Prospectos → respondieron → (Trade Up / primer scanner / renovación / postgrado) → Evaluación SIRIOS → demo → propuesta → venta`.

## 15. Seguridad / estado actual

- Los **138 prospectos reales** permanecen intactos.
- Outbound 9 se desarrolla **primero SOLO con TEST**. No se habilita contacto real.
- `OUTBOUND_TEMPLATE_APPROVED=false` **no se cambia**.
- La plantilla Meta actual `trade_up_sirios_intro` sigue en revisión/aprobación y se usa para validación técnica.
- La futura creatividad con imagen se evaluará como **TEMPLATE V2**, después de validar técnicamente el primer envío controlado.

## 16. Compatibilidad con el sistema actual

Se mantiene conceptualmente: **HOT ≥ 70 · warm 40–69 · cold < 40**; una intención fuerte puede forzar mínimo 70. Outbound 9 reevaluará **posteriormente** si las nuevas señales requieren ajustes de scoring. No se implementa nada de esto ahora.

## 17. Principio final

Outbound 9 debe sentirse como **una experiencia de descubrimiento y evaluación de SIRIOS**, no como un formulario de calificación. El cliente debe entender rápidamente: (1) qué ofrecemos, (2) qué beneficio puede obtener, (3) por qué vale la pena responder, (4) cuál es el siguiente paso.

---

## Fuera de alcance de este documento (se decide al desarrollar)
Campos/migraciones (`customer_profile`, `commercial_route`, `product_interest`, plazo, CTA), cambios de scoring, plantilla V2 con imagen, creación de plantillas en Meta, y cualquier habilitación de contacto real. Cada uno requerirá su propio diagnóstico y autorización.

---

## OUTBOUND 9A — motor conversacional implementado, NO desplegado

**Estado:** implementado y probado localmente (69 pruebas del journey + 50 de Inbound/Outbound 7). **No desplegado, sin migración, sin envíos.** El journey no se activa solo: en 9A únicamente se inyecta en pruebas un prospecto TEST ya resuelto; la activación real es 9B.

**Arquitectura**
- Mismo `whatsapp-webhook` y mismo motor; **no hay un segundo bot**. El journey se distingue por `session.context.journey = 'outbound_sirios'`. Sin ese valor, el flujo es Inbound V1, sin cambios (50/50 de sus pruebas).
- `outbound-sirios.ts` (módulo nuevo, puro y determinístico: sin IA, sin red, sin I/O). `engine.ts` solo suma tipos (`journey`, estado `o`, campos `customer_profile`, `commercial_route`, `product_interest`, `cta_selected`). `index.ts` suma una rama que delega en `outboundTurn` y conserva el journey si la sesión expira (72 h).
- Sin migración: todo vive en `session.context` (`fields` + `o`). Reutiliza `q1`–`q5` (`q1b` queda solo para Inbound).
- Lead: se crea/actualiza solo al completar el journey, con los campos actuales (`uses_intraoral_scanner`, `current_scanner`, `need`, `purchase_timeline`, `wants_demo`, `wants_quote`, contacto). Los campos nuevos **no** se escriben en `digital_leads`. `high_intent` queda **solo en el contexto**: no se propaga a `high_intent_override`, así que el scoring no cambia (se reevalúa en 9B).

**Flujo (planificador determinístico, máximo 5 preguntas distintas)**
Apertura (no cuenta como pregunta; sin «soy el asistente digital»; 36 cuotas una vez) → `q1` perfil → `q2` situación digital → `q3` necesidad/ruta →
- ruta `trade_up`/`renewal_workflow` con escáner declarado y modelo desconocido: `q4` = escáner actual, `q5` = CTA (sin timing);
- resto: `q4` = CTA; `q5` = solo los datos de contacto faltantes (una sola pregunta) o, si no faltan, timing.
- Nunca se crea una pregunta artificial; si el presupuesto se agota, se cierra. Repetir la pregunta pendiente tras un saludo o una consulta no consume presupuesto.
- Datos del prospecto (nombre, clínica, comuna) se prellenan y no se piden de nuevo; postgrado no requiere clínica. «No estoy seguro» no inventa true/false.

**Texto libre / intención (solo journey outbound):** producto (`sirios` solo si se escribe expresamente; `sirios_x3`; `compare`), demo, cotización/evaluación, Trade Up, especialista, «ahora/este mes» y financiamiento fijan `cta_selected` y `high_intent` con una razón fija (no se repite el texto del cliente).
**Financiamiento:** ante «cuotas», «tasa», «cuánto queda la cuota», etc. responde solo «Las condiciones dependen de la evaluación comercial de cada caso…», registra `cta_selected=financing` + `high_intent` y retoma la pregunta pendiente. No inventa tasas, CAE, cuotas, precios ni aprobación.
**Cierres:** listos en código por ruta (Trade Up, primer scanner, renovación, postgrado según CTA, exploración suave); inactivos en producción hasta 9B.
**Seguridad de teléfono:** `resolveOutboundProspect` reutiliza `pickReplyTarget` (reply.ts): solo asocia un prospecto si es inequívoco; ambiguo/ninguno ⇒ no se elige ninguno.

**Pendiente para 9B (no hecho):** activación real del journey desde el prospecto resuelto, reevaluación de scoring con las nuevas señales, plantilla V2, cualquier envío real.

## OUTBOUND 9B — activación TEST + conversión + scoring (preparado, NO desplegado, migración 016 NO aplicada)

**Estado:** código y SQL listos en `leads-outbound-v1-preview`. Migración 016 sin aplicar, Edge Function sin desplegar, `OUTBOUND_TEMPLATE_APPROVED=false`, sin envíos WhatsApp.

- **Activación (solo TEST):** al abrir una sesión nueva, `getOutboundSelection(phone)` busca prospectos `contacted/replied` con envío `sent` y los resuelve con `pickReplyTarget` (`selectOutboundProspect`). 0 candidatos → Inbound V1; 1 inequívoco y `is_test=true` + consentimiento `yes` → `outbound_sirios`; ambiguo → ninguno, sin tocar prospectos, log sin PII. Un prospecto real jamás inicia el journey. `OUTBOUND_SIRIOS_TEST_ONLY` es fail-closed: no existe modo real en 9B (aunque valga `false` solo se loguea).
- **Prefill:** `full_name→contact_name`, `clinic_name`, `commune`; `prospect_id` en `session.context.o.prospect_id`; no se vuelven a pedir.
- **Mensaje de ruta:** `o.route_msgs[]` / `route_message_shown_for`; cada mensaje de ruta se muestra una sola vez; un cambio de ruta (exploration→trade_up) muestra el de la nueva ruta.
- **Scoring:** `high_intent` → `high_intent_override=true` (el trigger garantiza ≥70). Umbrales HOT≥70 / WARM 40–69 / COLD<40. El perfil no puntúa por sí solo.
- **Persistencia:** `customer_profile`, `commercial_route`, `product_interest` (`undecided` sin selección expresa), `cta_selected` en `digital_leads` y en `session.context`.
- **Conversión atómica:** RPC `complete_outbound_conversion(session, prospect, fields, summary)` (016, solo `service_role`): bloquea prospecto y sesión, valida `is_test`, consentimiento, no opt-out, envío válido, sesión↔prospecto, crea o reutiliza el lead (`linked_lead_id`), persiste campos, aplica override, setea `linked_lead_id` + `converted`, registra actividad `outbound_sirios_conversion`. Idempotente: nunca dos leads por prospecto.
- **Cierre:** se envía solo tras persistir la conversión. Si falla la BD: mensaje neutro (`CONVERT_FAIL_MSG`), la sesión queda en `q5` con `convert_pending` y se reintenta en el siguiente mensaje.
- **Financiamiento:** "hasta 36 cuotas", "sujeto a evaluación comercial"; `cta_selected=financing`; sin tasa/CAE/monto inventados.
- **Historial (Outbound 8):** `get_prospect_timeline` muestra en la conversión perfil, ruta, interés, CTA, score, temperatura y estado (sin texto de mensajes).
- **Rollback:** `sql/leads-digital/999m_rollback_outbound_conversion_sirios.sql`.
- **Pruebas:** Inbound 50/50, 9A 69/69, 9B 45/45, importación 58/58, envío 19/19. La validación de la 016 contra la BD real no se pudo ejecutar (cancelada); el SQL está validado solo contra el espejo en `fake-db.ts` y debe validarse en transacción con rollback antes de aplicar.
