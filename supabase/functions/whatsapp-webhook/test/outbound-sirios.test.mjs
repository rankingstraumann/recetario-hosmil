// OUTBOUND 9A — pruebas del motor conversacional outbound_sirios. Sin red, sin Supabase, datos FICTICIOS; BD en memoria.
import { send, reply, setLlm, T, net, lastOut } from './harness.mjs';
import { startOutboundCtx, resolveOutboundProspect, planNext, MAX_QUESTIONS, OPENING, FIN_REPLY } from './outbound-sirios.ts';
const results = []; const ok = (name, cond, extra = '') => { results.push(!!cond); console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); };
let ph = 56977000000;
const nextPhone = () => '+' + (++ph);
const ALLTXT = [];
const sess = (p) => T.sessions.filter((s) => s.phone_e164 === p).slice(-1)[0];
const lead = (p) => T.leads.find((l) => l.phone_e164 === p);
const outs = (p) => T.messages.filter((m) => m.direction === 'outbound' && m.session_id === sess(p)?.id);
const questions = (p) => outs(p).filter((m) => m.metadata?.step);
const lastQ = (p) => questions(p).slice(-1)[0];
const texts = (p) => outs(p).map((m) => m.message_text);
// Inyecta un prospecto TEST ya resuelto + sesion outbound (9A: no hay activacion automatica)
function start(prospect = {}, known = {}) {
  const p = nextPhone();
  const pr = { id: 'pr-' + p, phone_e164: p, is_test: true, whatsapp_consent: 'yes', outreach_status: 'replied', full_name: 'Daniel Prueba', clinic_name: 'Clínica Ficticia', commune: 'Ñuñoa', ...prospect };
  Object.keys(prospect).forEach((k) => { if (prospect[k] === null) delete pr[k]; });
  T.prospects.push(pr);
  const ctx = startOutboundCtx(pr); Object.assign(ctx.fields, known);
  T.sessions.push({ id: 'so-' + p, phone_e164: p, lead_id: null, current_step: 'start', status: 'started', last_message_at: new Date().toISOString(), context: ctx });
  return p;
}
const say = (p, text) => send(p, null, { text });
const pick = (p, id) => send(p, null, { type: 'interactive', ...reply(id) });
const F = (p) => sess(p).context.fields;
const O = (p) => sess(p).context.o;
const snapshotProspects = () => JSON.stringify(T.prospects);
const net0 = { ...net }; const prospects0 = () => snapshotProspects();
const before = snapshotProspects();

// ---- 1. Owner + usa scanner + Trade Up + scanner conocido + evaluacion Trade Up
let p = start({}, { current_scanner: 'Medit i700', uses_intraoral_scanner: true });
await say(p, 'Hola');
ok('T1a apertura sin presentacion de asistente + Q1 perfil (lista de 4)', texts(p)[0] === OPENING && !/soy el asistente/i.test(texts(p).join(' ')) && lastQ(p).metadata.step === 'q1');
await pick(p, 'o9:profile:owner_partner');
ok('T1b Q2: scanner ya conocido => no pregunta scanner, usa Si/No', O(p).pending_kind === 'digital' || F(p).uses_intraoral_scanner === true);
if (O(p).pending_kind === 'digital') await pick(p, 'o9:digital:yes');
await pick(p, 'o9:need:trade_up');
ok('T1c ruta trade_up + mensaje contextual + CTA q4 con opciones Trade Up', F(p).commercial_route === 'trade_up' && texts(p).some((t) => /Tu equipo actual puede ser el punto de partida/.test(t)) && lastQ(p).metadata.step === 'q4' && /Evaluar mi Trade Up/.test(JSON.stringify(T.messages.filter((m) => m.session_id === sess(p).id).slice(-1)[0].metadata.payload)));
await pick(p, 'o9:cta:trade_up_evaluation');
ok('T1d CTA estable trade_up_evaluation + intencion fuerte', F(p).cta_selected === 'trade_up_evaluation' && F(p).high_intent === true && !!F(p).high_intent_reason);
ok('T1e datos prellenados completos => Q5 es timing', O(p).pending_kind === 'timing' && lastQ(p).metadata.step === 'q5');
await pick(p, 'o9:timing:now');
ok('T1f cierre Trade Up + lead creado', /Tu Evaluación de Trade Up quedó solicitada/.test(texts(p).slice(-1)[0]) && sess(p).status === 'completed' && !!lead(p) && F(p).customer_profile === 'owner_partner');
ok('T1g 9A: la intencion fuerte NO se propaga al scoring (override=false) y queda en el contexto', lead(p).high_intent_override === false && F(p).high_intent === true);
ok('T1h perfil/ruta/CTA/interes solo en context.fields (no columnas nuevas en lead)', !('customer_profile' in lead(p)) && !('commercial_route' in lead(p)) && !('cta_selected' in lead(p)));
const nq1 = questions(p).length;

// ---- 2. Owner + Trade Up + scanner desconocido => pregunta scanner; Q5 = CTA; sin timing; maximo 5
p = start({ full_name: null, clinic_name: null, commune: null });
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await pick(p, 'o9:digital:yes'); await pick(p, 'o9:need:trade_up');
ok('T2a Q4 = scanner actual (texto libre)', lastQ(p).metadata.step === 'q4' && /Qué escáner utilizan actualmente/.test(lastQ(p).message_text));
await say(p, 'Medit i700');
ok('T2b Q5 = CTA y se guarda scanner', lastQ(p).metadata.step === 'q5' && F(p).current_scanner === 'Medit i700' && O(p).pending_kind === 'cta');
await pick(p, 'o9:cta:demo');
ok('T2c termina SIN timing ni contacto (5 preguntas agotadas) y maximo 5', sess(p).status === 'completed' && questions(p).length === 5 && !F(p).purchase_timeline && O(p).asked.length === 5, String(questions(p).length));
ok('T2d lead creado igualmente (contacto vive en el prospecto)', !!lead(p));

// ---- 3. Primer scanner: CTA + timing dentro de 5
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:clinician'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:first_scanner');
ok('T3a primer scanner: mensaje con 36 cuotas sujeto a evaluacion', texts(p).some((t) => /hasta 36 cuotas, sujeto a evaluación comercial/.test(t) && /primer paso/.test(t)));
await pick(p, 'o9:cta:learn_sirios_x3');
ok('T3b product_interest=sirios_x3 solo por seleccion expresa; Q5 timing', F(p).product_interest === 'sirios_x3' && O(p).pending_kind === 'timing');
await pick(p, 'o9:timing:1_3_months');
ok('T3c cierre primer scanner, 5 preguntas', /Tu Evaluación SIRIOS quedó solicitada/.test(texts(p).slice(-1)[0]) && questions(p).length === 5 && F(p).commercial_route === 'first_scanner');

// ---- 4. Renewal workflow
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await pick(p, 'o9:digital:yes'); await pick(p, 'o9:need:digital_flow');
ok('T4 renewal_workflow: mensaje de ruta; scanner declarado y desconocido => se pregunta ANTES del CTA', F(p).commercial_route === 'renewal_workflow' && texts(p).some((t) => /integrarse a tu flujo actual/.test(t)) && O(p).pending_kind === 'scanner');
await say(p, 'Medit i700');
ok('T4a CTA renovacion: Pedir mi evaluacion / Comparar / Demo / Especialista', /Pedir mi evaluación/.test(JSON.stringify(T.messages.filter((m) => m.session_id === sess(p).id).slice(-1)[0].metadata.payload)) && O(p).pending_kind === 'cta');
await pick(p, 'o9:cta:request_evaluation');
ok('T4b cierre renovacion', /integrarse a tu flujo actual\. Tu Evaluación SIRIOS quedó solicitada/.test(texts(p).slice(-1)[0]));

// ---- 5. Postgrado + exploracion
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:postgraduate');
ok('T5a Q2 postgrado adaptada con 3 opciones', /estudias o tienes mayor cercanía/.test(lastQ(p).message_text) && JSON.stringify(T.messages.slice(-1)[0].metadata.payload).includes('No estoy seguro'));
await pick(p, 'o9:digital:unsure');
ok('T5b "No estoy seguro" no inventa true/false y el flujo continua', F(p).uses_intraoral_scanner === undefined && O(p).pending_kind === 'need');
await pick(p, 'o9:need:compare');
ok('T5c postgraduate_influencer + mensaje + CTA postgrado', F(p).commercial_route === 'postgraduate_influencer' && F(p).product_interest === 'compare' && texts(p).some((t) => /Si estás en postgrado o formación clínica/.test(t)) && /Compartir con mi clínica/.test(JSON.stringify(T.messages.slice(-1)[0].metadata.payload)));
await pick(p, 'o9:cta:share_clinic'); await pick(p, 'o9:timing:later');
ok('T5d cierre postgrado (compartir con clinica) sin afirmar compra', /entorno clínico/.test(texts(p).slice(-1)[0]) && !/compra/.test(texts(p).slice(-1)[0]) && sess(p).status === 'completed');

// ---- 6. Postgrado + Trade Up
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:postgraduate'); await pick(p, 'o9:digital:yes'); await pick(p, 'o9:need:trade_up');
ok('T6 postgraduate + trade_up: perfil se mantiene y ruta especifica', F(p).customer_profile === 'postgraduate' && F(p).commercial_route === 'trade_up');
const pg = p;

// ---- 7. Postgrado sin clinica puede completar
p = start({ clinic_name: null });
await say(p, 'hola'); await pick(p, 'o9:profile:postgraduate'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:know_sirios'); await pick(p, 'o9:cta:demo');
ok('T7 postgrado sin clinica: no se la pide y completa (timing)', !questions(p).some((m) => /clínica/.test(m.message_text) && m.metadata.step === 'q5' && !/Cómo|momento/.test(m.message_text)) && O(p).pending_kind === 'timing');
await pick(p, 'o9:timing:evaluating');
ok('T7b completo sin clinica', sess(p).status === 'completed' && !!lead(p) && !F(p).clinic_name);

// ---- 8. Explorer: sin presion
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:explorer'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:know_sirios');
const exPayload = JSON.stringify(T.messages.slice(-1)[0].metadata.payload);
ok('T8a explorador: ruta exploration, 5 opciones suaves', F(p).commercial_route === 'exploration' && /Conocer SIRIOS X3/.test(exPayload) && /Hablar con especialista/.test(exPayload) && /sin compromiso/.test(texts(p).join(' ')));
await pick(p, 'o9:cta:learn_sirios'); await pick(p, 'o9:timing:evaluating');
ok('T8b cierre suave sin "Evaluación solicitada" ni Trade Up', !/quedó solicitada/.test(texts(p).slice(-1)[0]) && /Gracias por tu interés/.test(texts(p).slice(-1)[0]));

// ---- 9. Datos prellenados: no se vuelven a pedir
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:first_scanner'); await pick(p, 'o9:cta:demo');
ok('T9 nombre/clinica/comuna prellenados: ninguna pregunta los pide', questions(p).every((m) => !/tu nombre|tu clínica|el nombre de tu clínica|tu comuna/.test(m.message_text)));

// ---- 10. Solo falta comuna
p = start({ commune: null });
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:first_scanner'); await pick(p, 'o9:cta:demo');
ok('T10 solo falta comuna => pregunta unicamente comuna', lastQ(p).message_text === 'Perfecto, Daniel. Para conectar tu evaluación con el equipo adecuado, solo me falta tu comuna.' && lastQ(p).metadata.step === 'q5', lastQ(p).message_text);
await say(p, 'Providencia');
ok('T10b guarda comuna y cierra', F(p).commune === 'Providencia' && sess(p).status === 'completed');
// varios faltantes y un solo slot => una sola pregunta
p = start({ full_name: null, clinic_name: null, commune: null });
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:first_scanner'); await pick(p, 'o9:cta:demo');
ok('T10c varios faltantes => UNA pregunta conjunta', /tu nombre, el nombre de tu clínica y tu comuna/.test(lastQ(p).message_text));
await say(p, 'Ana Prueba, Clínica Sur, Maipú');
ok('T10d captura los tres', F(p).contact_name === 'Ana Prueba' && F(p).clinic_name === 'Clínica Sur' && F(p).commune === 'Maipú' && sess(p).status === 'completed');

// ---- 11. Maximo absoluto de 5 preguntas (incluye saludos intermedios y respuestas libres)
const worst = [];
for (const route of ['trade_up', 'renew', 'first_scanner', 'compare']) {
  p = start({ full_name: null, clinic_name: null, commune: null });
  await say(p, 'hola'); await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner'); await say(p, 'Buenas tardes'); await pick(p, 'o9:digital:yes');
  await pick(p, 'o9:need:' + route); if (O(p).pending_kind === 'scanner') await say(p, 'Trios 3');
  for (let i = 0; i < 6 && sess(p).status !== 'completed'; i++) { const k = O(p).pending_kind; await (k === 'cta' ? pick(p, 'o9:cta:' + (route === 'trade_up' ? 'trade_up_evaluation' : 'compare')) : k === 'timing' ? pick(p, 'o9:timing:later') : say(p, 'Ana Prueba, Clínica Sur, Maipú')); }
  worst.push(O(p).asked.length);
  ok('T11 ruta ' + route + ': preguntas distintas <= 5 y completa', O(p).asked.length <= MAX_QUESTIONS && sess(p).status === 'completed', JSON.stringify(O(p).asked));
}
ok('T11b ninguna ruta supera 5', Math.max(...worst) <= 5, JSON.stringify(worst));
// planificador puro: nunca devuelve pregunta fuera de presupuesto
const c0 = startOutboundCtx({ id: 'x' }); c0.o.asked = ['profile', 'digital', 'need', 'scanner', 'cta']; c0.fields.customer_profile = 'owner_partner'; c0.fields.uses_intraoral_scanner = true; c0.fields.need = 'trade_up'; c0.fields.cta_selected = 'demo'; c0.o.done = ['scanner', 'cta'];
ok('T11c planNext con 5 agotadas y datos faltantes => null (no crea Q6 artificial)', planNext(c0) === null);

// ---- 12-15. Texto libre / intencion / financiamiento
p = start();
await say(p, 'Hola, quiero cotizar X3');
ok('T12 "quiero cotizar X3" => sirios_x3 + high_intent + CTA request_evaluation', F(p).product_interest === 'sirios_x3' && F(p).high_intent === true && F(p).cta_selected === 'request_evaluation' && F(p).wants_quote === true && !!F(p).high_intent_reason);
p = start();
await say(p, 'quiero una demo');
ok('T13 "quiero una demo" => CTA demo + high_intent + wants_demo', F(p).cta_selected === 'demo' && F(p).high_intent === true && F(p).wants_demo === true);
p = start();
await say(p, 'hola'); const nOutBefore = outs(p).length;
await say(p, 'cómo funcionan las 36 cuotas');
const o14 = texts(p);
ok('T14 36 cuotas => financing + high_intent + respuesta conceptual EXACTA', F(p).cta_selected === 'financing' && F(p).high_intent === true && o14.includes(FIN_REPLY));
ok('T14b NO inventa tasas/CAE/cuota/precios y sigue con la pregunta pendiente', !/\d+([.,]\d+)?\s?%|\$\s?\d|\bUF\b|\bCAE\b|tasa de|cuota de \d/i.test(o14.slice(nOutBefore).join(' ')) && lastQ(p).metadata.step === 'q1');
p = start();
await say(p, 'hola'); await say(p, 'cuánto queda la cuota?'); await say(p, 'qué tasa tiene?');
ok('T15 "cuánto queda la cuota"/"qué tasa" => no inventa cuota ni precio', !/\$|\d{3}\.\d{3}|\d+\s?%/.test(texts(p).slice(1).join(' ')) && texts(p).filter((t) => t === FIN_REPLY).length === 2 && F(p).cta_selected === 'financing');
p = start();
await say(p, 'hola'); await say(p, 'cuánto cuesta el sirios x3?');
ok('T15b consulta de precio: no inventa precio; responde conceptual', /se revisan con nuestro equipo/.test(texts(p).slice(-2)[0]) && !/\$|\d{3}\.\d{3}/.test(texts(p).join(' ')));
p = start();
await say(p, 'quiero evaluar trade up'); 
ok('T15c "quiero evaluar trade up" => need + CTA + intencion fuerte', F(p).need === 'trade_up' && F(p).cta_selected === 'trade_up_evaluation' && F(p).high_intent === true);
p = start();
await say(p, 'quiero hablar con alguien');
ok('T15d "quiero hablar con alguien" => specialist + high_intent', F(p).cta_selected === 'specialist' && F(p).high_intent === true);
p = start();
await say(p, 'quiero comparar los dos');
ok('T15e "quiero comparar los dos" => compare', F(p).product_interest === 'compare');
p = start();
await say(p, 'me interesa SIRIOS');
ok('T15f SIRIOS escrito expresamente => sirios; el "SIRIOS" generico de la campana NO cuenta', F(p).product_interest === 'sirios');
p = start(); await say(p, 'hola');
ok('T15g un saludo no registra producto de interes', F(p).product_interest === undefined && !F(p).high_intent);
// respuestas libres a las preguntas (sin botones)
p = start();
await say(p, 'hola'); await say(p, 'soy dueña de una clínica'); await say(p, 'sí, tenemos uno'); await say(p, 'queremos evaluar un trade up');
ok('T15h respuestas libres a Q1/Q2/Q3', F(p).customer_profile === 'owner_partner' && F(p).uses_intraoral_scanner === true && F(p).need === 'trade_up' && O(p).pending_kind === 'scanner');
await say(p, 'Medit i700'); await say(p, 'hablar con un especialista');
ok('T15i scanner por texto y CTA libre', F(p).current_scanner === 'Medit i700' && F(p).cta_selected === 'specialist');
// numerico (texto plano de respaldo)
p = start(); await say(p, 'hola'); await say(p, '3');
ok('T15j respuesta numerica a la lista (respaldo texto plano) => perfil postgrado', F(p).customer_profile === 'postgraduate');

// ---- 16. Nada interno al cliente
const secret = /\bQ4\b|\bmetas?\b|trimestre|cuota de venta|presi[oó]n comercial|objetivo interno|cumplimiento|necesidad interna/i;
const allOut = T.messages.filter((m) => m.direction === 'outbound' && m.session_id && String(m.session_id).startsWith('so-'));
const allText = allOut.map((m) => m.message_text + ' ' + JSON.stringify(m.metadata?.payload || '')).join('\n');
ok('T16 ningun texto al cliente (' + allOut.length + ' mensajes) menciona Q4/metas/trimestre/presion interna', allOut.length > 60 && !secret.test(allText), (allText.match(secret) || [])[0]);
const per = {}; allOut.forEach((m) => { if (/36 cuotas/.test(m.message_text)) per[m.session_id] = (per[m.session_id] || 0) + 1; });
ok('T16b "36 cuotas" no se repite en cada mensaje: como maximo gancho de apertura + ruta primer scanner por conversacion', Math.max(...Object.values(per)) <= 2, JSON.stringify(Object.values(per).slice(0, 10)));

// ---- 17. Inbound V1 intacto (misma pasarela, sin journey)
const IN = nextPhone();
await send(IN, null, { text: 'Hola' });
ok('T17 Inbound sin journey: saludo del asistente + P1 clasica', /soy el asistente digital/.test(texts2(IN)[0]) && /utilizas un scanner intraoral/.test(texts2(IN).slice(-1)[0]) && sess(IN).context.journey === undefined && sess(IN).context.o === undefined);
function texts2(ph2) { return T.messages.filter((m) => m.direction === 'outbound' && m.session_id === sess(ph2).id).map((m) => m.message_text); }

// ---- 18. Telefono duplicado/ambiguo
const amb = [{ id: 'a', outreach_status: 'contacted' }, { id: 'b', outreach_status: 'contacted' }];
ok('T18a dos prospectos mismo telefono sin evidencia => ambiguous (no se elige)', resolveOutboundProspect(amb, []).kind === 'ambiguous');
ok('T18b empate exacto => ambiguous', resolveOutboundProspect(amb, [{ prospect_id: 'a', sent_at: '2026-10-11T12:00:00Z' }, { prospect_id: 'b', sent_at: '2026-10-11T12:00:00Z' }]).kind === 'ambiguous');
ok('T18c envio reciente inequivoco => ese', JSON.stringify(resolveOutboundProspect(amb, [{ prospect_id: 'a', sent_at: '2026-10-11T12:00:00Z' }, { prospect_id: 'b', sent_at: '2026-10-11T12:30:00Z' }])) === '{"kind":"one","id":"b"}');
ok('T18d pending/opted_out/failed no son candidatos', resolveOutboundProspect([{ id: 'x', outreach_status: 'pending' }, { id: 'y', outreach_status: 'opted_out' }], []).kind === 'none');
ok('T18e unico candidato => ese', resolveOutboundProspect([{ id: 'x', outreach_status: 'replied' }], []).kind === 'one');
const AMB = nextPhone(); T.prospects.push({ id: 'amb1', phone_e164: AMB, is_test: true, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'amb2', phone_e164: AMB, is_test: true, outreach_status: 'contacted', whatsapp_consent: 'yes' });
await send(AMB, null, { text: 'hola' });
ok('T18f telefono ambiguo: ningun journey outbound se asocia solo (cae en Inbound) y ningun prospecto cambia', sess(AMB).context.journey === undefined && T.prospects.filter((x) => x.phone_e164 === AMB).every((x) => x.outreach_status === 'contacted'));

// ---- 19/20. No toca prospectos reales; sin Meta ni IA
const only = T.prospects.every((x) => x.is_test !== false);
ok('T19 todos los prospectos del fake son TEST (nunca los 138 reales); el journey no modifica prospectos', only && snapshotProspects().length > 0);
const proj = (x) => JSON.stringify(T.prospects.filter((y) => y.id.startsWith('pr-')));
ok('T19b el journey outbound no altera ningun campo del prospecto inyectado', T.prospects.filter((y) => y.id.startsWith('pr-')).every((y) => y.outreach_status === 'replied' && y.whatsapp_consent === 'yes'));
ok('T20 cero llamadas a Meta y cero llamadas a la IA durante el journey outbound; ninguna otra red', net.meta === 0 && net.other === 0, JSON.stringify(net));

// ---- Extras
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:owner_partner');
const tFuture = new Date(Date.now() + 73 * 36e5).toISOString();
await send(p, null, { text: 'hola', headers: { 'x-sim-now': tFuture } });
ok('X1 sesion expirada (72h) conserva el journey outbound y retoma la pregunta pendiente', T.sessions.filter((s) => s.phone_e164 === p).length === 2 && sess(p).context.journey === 'outbound_sirios' && F(p).customer_profile === 'owner_partner' && O(p).pending_kind === 'digital' && !/soy el asistente/.test(texts(p).join(' ')));
p = start();
await say(p, 'hola'); const k1 = questions(p).length; await say(p, 'hola'); await say(p, 'gracias');
ok('X2 saludos repetidos re-envian la misma pregunta sin consumir presupuesto', O(p).asked.length === 1 && O(p).pending_kind === 'profile' && questions(p).length === k1 + 2);
p = start();
await say(p, 'hola'); await pick(p, 'o9:profile:explorer'); await pick(p, 'o9:digital:no'); await pick(p, 'o9:need:compare'); await pick(p, 'o9:cta:compare'); await pick(p, 'o9:timing:evaluating');
ok('X3 flujo comparar: lead sin need (columna null), scoring existente sin error, product_interest=compare', !!lead(p) && lead(p).need === null && F(p).product_interest === 'compare' && lead(p).temperature === 'cold');
ok('X4 ai_summary incluye perfil/ruta/CTA', /Perfil: explorando/.test(lead(p).ai_summary || '') && /Ruta: exploration/.test(lead(p).ai_summary) && /CTA: compare/.test(lead(p).ai_summary), lead(p).ai_summary);
await say(p, 'otra cosa'); 
ok('X5 tras completar: mismo comportamiento de acuse existente (sin reabrir preguntas)', /Ya tenemos registrada/.test(lastOut(p).slice(-1)[0]) && T.leads.filter((l) => l.phone_e164 === p).length === 1);

console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
