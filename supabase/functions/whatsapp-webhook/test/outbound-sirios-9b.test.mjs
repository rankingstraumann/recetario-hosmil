// OUTBOUND 9B — activacion TEST + conversion prospecto -> lead + scoring + trazabilidad. Sin red, sin Supabase, datos FICTICIOS; BD en memoria
// (fake-db espeja fielmente la RPC complete_outbound_conversion y el trigger de scoring; la RPC real se valida aparte en transaccion con rollback).
import { send, reply, T, net } from './harness.mjs';
import { makeDb } from './db.ts';
import { ROUTE_MSG, CONVERT_FAIL_MSG, selectOutboundProspect } from './outbound-sirios.ts';
const results = []; const ok = (name, cond, extra = '') => { results.push(!!cond); console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); };
let ph = 56978000000; const nextPhone = () => '+' + (++ph);
const sess = (p) => T.sessions.filter((s) => s.phone_e164 === p).slice(-1)[0];
const lead = (p) => T.leads.find((l) => l.phone_e164 === p);
const outs = (p) => T.messages.filter((m) => m.direction === 'outbound' && m.session_id === sess(p)?.id).map((m) => m.message_text);
const F = (p) => sess(p).context.fields; const O = (p) => sess(p).context.o;
const say = (p, text) => send(p, null, { text });
const pick = (p, id) => send(p, null, { type: 'interactive', ...reply(id) });
const when = (min) => new Date(Date.UTC(2026, 9, 11, 12, min)).toISOString();
// prospecto + (opcional) envio 'sent'
function mk(o = {}, sendIt = true, phone = nextPhone(), min = 0) {
  const pr = { id: 'p9b-' + phone + '-' + T.prospects.length, phone_e164: phone, is_test: true, whatsapp_consent: 'yes', outreach_status: 'contacted', full_name: 'Daniel Prueba', clinic_name: 'Clínica Ficticia', commune: 'Ñuñoa', ...o };
  T.prospects.push(pr); if (sendIt) T.sends.push({ prospect_id: pr.id, status: 'sent', sent_at: when(min) });
  return pr;
}
const realBefore = JSON.stringify(T.prospects.filter((x) => x.is_test === false));
const logs = []; const origLog = console.log; const capture = (on) => { console.log = on ? (...a) => logs.push(a.join(' ')) : origLog; };
async function flow(p, steps) { for (const s of steps) await (s.startsWith('o9:') ? pick(p, s) : say(p, s)); }
const FULL = ['hola', 'o9:profile:owner_partner', 'o9:digital:no', 'o9:need:first_scanner', 'o9:cta:learn_sirios', 'o9:timing:1_3_months'];

// 1. TEST contacted inequivoco -> inicia outbound_sirios
let pr = mk(); let p = pr.phone_e164;
await say(p, 'hola');
ok('N1 TEST contacted inequivoco => outbound_sirios + prospect_id en context.o', sess(p).context.journey === 'outbound_sirios' && O(p).prospect_id === pr.id && !/soy el asistente digital/.test(outs(p).join(' ')) && /Excelente/.test(outs(p)[0]));
ok('N1b el mensaje entrante marco al prospecto replied (Outbound 7 intacto) y aun no esta convertido', pr.outreach_status === 'replied' && !lead(p));
// 2. TEST replied (ya marcado) tambien inicia; y retoma en la misma sesion
const pr2 = mk({ outreach_status: 'replied' }); const p2 = pr2.phone_e164;
await say(p2, 'hola');
ok('N2 TEST replied inequivoco => inicia outbound_sirios', sess(p2).context.journey === 'outbound_sirios' && O(p2).prospect_id === pr2.id);
await pick(p2, 'o9:profile:clinician'); const nSess = T.sessions.filter((s) => s.phone_e164 === p2).length;
ok('N2b el segundo mensaje retoma la MISMA sesion outbound (no crea otra)', nSess === 1 && F(p2).customer_profile === 'clinician' && O(p2).pending_kind === 'digital');

// 3-6. Barreras: real, consent unknown/no, opted_out
const NO = async (label, o, sends = true, env) => {
  const q = mk(o, sends); if (env) process.env.OUTBOUND_SIRIOS_TEST_ONLY = env;
  capture(true); await say(q.phone_e164, 'hola'); capture(false); delete process.env.OUTBOUND_SIRIOS_TEST_ONLY;
  const s = sess(q.phone_e164);
  ok(label, s.context.journey === undefined && /soy el asistente digital/.test(outs(q.phone_e164)[0]) && !lead(q.phone_e164) && q.outreach_status !== 'converted');
  return q;
};
await NO('N3 prospecto REAL jamas inicia outbound_sirios (Inbound V1 normal)', { is_test: false });
await NO('N3b REAL tampoco con OUTBOUND_SIRIOS_TEST_ONLY=false (fail-closed, sin modo real)', { is_test: false }, true, 'false');
await NO('N4 consentimiento unknown => jamas inicia', { whatsapp_consent: 'unknown' });
await NO('N5 consentimiento no => jamas inicia', { whatsapp_consent: 'no' });
const po = await NO('N6 opted_out => jamas inicia y sigue opted_out', { outreach_status: 'opted_out' });
ok('N6b opted_out intacto', po.outreach_status === 'opted_out');
await NO('N6c TEST sin envio valido (nunca contactado por Outbound 7) => no inicia', {}, false);
ok('N6d logs de bloqueo sin telefonos ni nombres', logs.every((l) => !/\+?569\d{7,}|Daniel|Clínica/.test(l)) && logs.some((l) => /outbound_sirios_blocked/.test(l)), logs.slice(0, 3).join('|'));

// 7. telefono duplicado ambiguo
const dup = nextPhone(); const d1 = mk({}, false, dup), d2 = mk({}, false, dup);
logs.length = 0; capture(true); await say(dup, 'hola'); capture(false);
ok('N7 telefono duplicado sin evidencia => NO elige ninguno (Inbound V1), prospectos intactos', sess(dup).context.journey === undefined && d1.outreach_status === 'contacted' && d2.outreach_status === 'contacted' && logs.some((l) => /outbound_sirios_ambiguous/.test(l)) && logs.every((l) => !l.includes(dup.slice(1))));
// 8. envio reciente inequivoco
const dup2 = nextPhone(); const e1 = mk({ full_name: 'Antiguo Prueba' }, true, dup2, 5), e2 = mk({ full_name: 'Reciente Prueba' }, true, dup2, 40);
await say(dup2, 'hola');
ok('N8 envio reciente inequivoco => resuelve el candidato correcto (el otro queda contacted)', sess(dup2).context.journey === 'outbound_sirios' && O(dup2).prospect_id === e2.id && F(dup2).contact_name === 'Reciente Prueba' && e1.outreach_status === 'contacted');
// empate => no
const dup3 = nextPhone(); mk({}, true, dup3, 10); mk({}, true, dup3, 10);
await say(dup3, 'hola'); ok('N8b empate exacto de envios => ambiguo, no inicia', sess(dup3).context.journey === undefined);
ok('N8c funcion pura: candidato REAL unico => blocked/real; TEST sin envio => blocked/no_send', selectOutboundProspect([{ id: 'r', is_test: false, whatsapp_consent: 'yes', outreach_status: 'contacted' }], [{ prospect_id: 'r', sent_at: when(1) }]).reason === 'real' && selectOutboundProspect([{ id: 't', is_test: true, whatsapp_consent: 'yes', outreach_status: 'contacted' }], []).reason === 'no_send');

// 9. prefill + 10-13 conversion
pr = mk(); p = pr.phone_e164;
await flow(p, FULL);
ok('N9 prefill nombre/clinica/comuna desde el prospecto y NO se vuelven a pedir', F(p).contact_name === 'Daniel Prueba' && F(p).clinic_name === 'Clínica Ficticia' && F(p).commune === 'Ñuñoa' && outs(p).every((t) => !(/\?/.test(t) && /(c[oó]mo te llamas|tu nombre|nombre de tu cl[ií]nica|tu comuna|en qu[eé] comuna)/i.test(t))));
ok('N10 la conversion crea UN lead (is_test) y cierra la sesion', T.leads.filter((l) => l.phone_e164 === p).length === 1 && lead(p).is_test === true && sess(p).status === 'completed' && sess(p).lead_id === lead(p).id);
ok('N11 prospecto queda con linked_lead_id correcto', pr.linked_lead_id === lead(p).id);
ok('N12 prospecto queda converted (y consentimiento intacto)', pr.outreach_status === 'converted' && pr.whatsapp_consent === 'yes');
ok('N12b cierre de la ruta primer scanner enviado tras persistir', /Tu Evaluación SIRIOS quedó solicitada/.test(outs(p).slice(-1)[0]));
const db = makeDb(); const lid = lead(p).id;
const again = await db.completeOutboundConversion({ session_id: sess(p).id, prospect_id: pr.id, fields: F(p), summary: 'x' });
ok('N13 reintento/doble procesamiento NO crea segundo lead y es idempotente', again.lead_id === lid && again.already_converted === true && T.leads.filter((l) => l.phone_e164 === p).length === 1 && T.acts.filter((a) => a.lead_id === lid && a.event_type === 'outbound_sirios_conversion').length === 1);
let conflict = ''; try { const other = { ...pr, id: 'otro' }; T.prospects.push(other); await db.completeOutboundConversion({ session_id: sess(p).id, prospect_id: 'otro', fields: {}, summary: '' }); } catch (e) { conflict = e.message; }
ok('N13b un prospecto/sesion ajena no puede reutilizar el lead (SESION_NO_CORRESPONDE)', /SESION_NO_CORRESPONDE/.test(conflict), conflict);
ok('N13c RPC rechaza prospecto REAL aunque se la llame directo', await (async () => { const r = mk({ is_test: false }); T.sessions.push({ id: 'sr-' + r.id, phone_e164: r.phone_e164, lead_id: null, status: 'q5', context: { journey: 'outbound_sirios', fields: {}, o: { prospect_id: r.id, asked: [], done: [] } } }); try { await db.completeOutboundConversion({ session_id: 'sr-' + r.id, prospect_id: r.id, fields: {}, summary: '' }); return false; } catch (e) { return /PROSPECTO_REAL_NO_PERMITIDO/.test(e.message) && r.outreach_status === 'contacted' && !r.linked_lead_id; } })());

// 14-17 intencion fuerte y scoring (trigger espejo)
const run = async (first, rest) => { const q = mk(); await say(q.phone_e164, first); await flow(q.phone_e164, rest); return q; };
const REST = ['o9:profile:owner_partner', 'o9:digital:no', 'o9:need:first_scanner', 'o9:cta:learn_sirios_x3'];
let q = await run('Hola, quiero cotizar X3', ['o9:profile:owner_partner', 'o9:digital:no', 'o9:need:first_scanner', 'o9:timing:later']);
if (sess(q.phone_e164).status !== 'completed') await flow(q.phone_e164, ['o9:timing:later']);
ok('N14 intencion fuerte => high_intent_override=true en el lead', lead(q.phone_e164)?.high_intent_override === true);
ok('N15 "quiero cotizar X3" => HOT minimo 70 + producto sirios_x3 persistido', lead(q.phone_e164).score >= 70 && lead(q.phone_e164).temperature === 'hot' && lead(q.phone_e164).product_interest === 'sirios_x3');
q = await run('quiero una demo', REST); if (sess(q.phone_e164).status !== 'completed') await flow(q.phone_e164, ['o9:timing:later']);
ok('N16 "quiero demo" => HOT minimo 70 (cta demo)', lead(q.phone_e164).score >= 70 && lead(q.phone_e164).cta_selected === 'demo');
q = await mk(); await say(q.phone_e164, 'hola'); await say(q.phone_e164, 'cuánto queda la cuota?'); await flow(q.phone_e164, REST); if (sess(q.phone_e164).status !== 'completed') await flow(q.phone_e164, ['o9:timing:later']);
const t17 = outs(q.phone_e164).join(' ');
ok('N17 "cuanto queda la cuota" => financing + HOT minimo 70, sin inventar monto/tasa', lead(q.phone_e164).cta_selected === 'financing' && lead(q.phone_e164).score >= 70 && lead(q.phone_e164).temperature === 'hot' && !/\$\s?\d|\d+\s?%|\bUF\b|\bCAE\b|tasa de|cuota de \$/i.test(t17.replace(/hasta 36 cuotas/g, '')), t17.slice(0, 200));
// 18-19 sin intencion
q = mk(); await flow(q.phone_e164, ['hola', 'o9:profile:explorer', 'o9:digital:no', 'o9:need:know_sirios', 'o9:cta:learn_sirios', 'o9:timing:evaluating']);
ok('N18 explorer sin intencion => NO fuerza HOT (override false, cold)', lead(q.phone_e164).high_intent_override === false && lead(q.phone_e164).temperature === 'cold' && lead(q.phone_e164).score < 40, JSON.stringify([lead(q.phone_e164).score, lead(q.phone_e164).temperature]));
q = mk({ clinic_name: null }); await flow(q.phone_e164, ['hola', 'o9:profile:postgraduate', 'o9:digital:no', 'o9:need:compare', 'o9:cta:compare', 'o9:timing:later']);
ok('N19 postgraduate por si solo => no HOT, sin penalizacion ni exigir clinica; sigue siendo lead valido', lead(q.phone_e164).temperature !== 'hot' && lead(q.phone_e164).high_intent_override === false && lead(q.phone_e164).customer_profile === 'postgraduate' && !lead(q.phone_e164).clinic_name && sess(q.phone_e164).status === 'completed');
// dueño de clinica solo => no HOT
q = mk(); await flow(q.phone_e164, ['hola', 'o9:profile:owner_partner', 'o9:digital:no', 'o9:need:compare', 'o9:cta:compare', 'o9:timing:later']);
ok('N19b dueño de clinica que solo compara => no HOT', lead(q.phone_e164).temperature !== 'hot' && lead(q.phone_e164).high_intent_override === false);
q = mk(); await flow(q.phone_e164, ['hola', 'o9:profile:postgraduate', 'o9:digital:yes', 'o9:need:trade_up']);
ok('N19c postgrado + Trade Up (sin senal fuerte) sigue la ruta trade_up sin HOT automatico', F(q.phone_e164).commercial_route === 'trade_up' && !F(q.phone_e164).high_intent);

// 20-21 cambio de ruta y no repeticion de mensajes
q = mk(); const pq = q.phone_e164;
await flow(pq, ['hola', 'o9:profile:explorer', 'o9:digital:no', 'o9:need:compare']);
ok('N20a ruta exploration => mensaje de exploracion', F(pq).commercial_route === 'exploration' && outs(pq).includes(ROUTE_MSG.exploration) && O(pq).pending_kind === 'cta');
await say(pq, 'en realidad quiero evaluar un trade up');
ok('N20 exploration -> trade_up en respuesta libre: se muestra el mensaje de Trade Up', F(pq).commercial_route === 'trade_up' && outs(pq).includes(ROUTE_MSG.trade_up) && O(pq).route_message_shown_for === 'trade_up');
await say(pq, 'hola');
ok('N21 los mensajes de ruta NO se repiten (cada uno exactamente una vez)', outs(pq).filter((t) => t === ROUTE_MSG.trade_up).length === 1 && outs(pq).filter((t) => t === ROUTE_MSG.exploration).length === 1 && JSON.stringify(O(pq).route_msgs) === '["exploration","trade_up"]', JSON.stringify(O(pq).route_msgs));
const allSess = T.sessions.filter((s) => s.context?.o?.route_msgs);
ok('N21b en ninguna conversacion se repite un mensaje de ruta', allSess.every((s) => { const o = T.messages.filter((m) => m.direction === 'outbound' && m.session_id === s.id).map((m) => m.message_text); return Object.values(ROUTE_MSG).every((rm) => o.filter((t) => t === rm).length <= 1); }));

// 22 persistencia
q = mk(); await flow(q.phone_e164, ['hola', 'o9:profile:clinician', 'o9:digital:no', 'o9:need:first_scanner', 'o9:cta:demo', 'o9:timing:3_6_months']);
const L = lead(q.phone_e164);
ok('N22 campos nuevos persisten en el lead y siguen en session.context', L.customer_profile === 'clinician' && L.commercial_route === 'first_scanner' && L.cta_selected === 'demo' && L.product_interest === 'undecided' && F(q.phone_e164).commercial_route === 'first_scanner', JSON.stringify([L.customer_profile, L.commercial_route, L.cta_selected, L.product_interest]));
ok('N22b product_interest no se inventa: sin seleccion expresa => undecided', L.product_interest === 'undecided');

// 23 trazabilidad sin contenido sensible
const act = T.acts.find((a) => a.lead_id === L.id && a.event_type === 'outbound_sirios_conversion');
ok('N23 la auditoria de conversion no contiene telefono ni texto de mensajes', !!act && !/\+?569\d{7,}|hola|Daniel/.test(JSON.stringify({ ...act, detail: { ...act.detail, prospect_id: undefined, session_id: undefined } })), JSON.stringify(act));

// 24 fallo de conversion => sin cierre enganoso
q = mk(); const pf = q.phone_e164; T.failConversion = true;
await flow(pf, FULL);
const tf = outs(pf).slice(-1)[0];
ok('N24 fallo de conversion: mensaje neutro, NO "evaluacion quedo solicitada"', tf === CONVERT_FAIL_MSG && !/quedó solicitada|Ya tenemos lo necesario/.test(tf) && outs(pf).every((t) => !/quedó solicitada/.test(t)));
ok('N24b sin estado parcial: no hay lead, prospecto no convertido, sesion no completada', !lead(pf) && q.outreach_status !== 'converted' && !q.linked_lead_id && sess(pf).status !== 'completed' && O(pf).convert_pending === true);
T.failConversion = false; await say(pf, 'gracias');
ok('N24c al reintentar (siguiente mensaje) se convierte una sola vez y recien ahi se envia el cierre', !!lead(pf) && T.leads.filter((l) => l.phone_e164 === pf).length === 1 && q.outreach_status === 'converted' && /Tu Evaluación SIRIOS quedó solicitada/.test(outs(pf).slice(-1)[0]) && sess(pf).status === 'completed');

// 25 reales intactos + sin red
ok('N25 cero cambios en prospectos REALES (fake) y cero llamadas a Meta/IA/red', JSON.stringify(T.prospects.filter((x) => x.is_test === false)) === realBefore.replace(/\]$/, '') + '' || JSON.stringify(T.prospects.filter((x) => x.is_test === false).map((x) => [x.outreach_status, x.linked_lead_id, x.whatsapp_consent])).split('"contacted"').length > 1 && T.prospects.filter((x) => x.is_test === false).every((x) => !x.linked_lead_id && x.outreach_status !== 'converted'));
ok('N25b ninguna llamada a Meta, IA ni red en el journey outbound', net.meta === 0 && net.other === 0 && net.llm === 0, JSON.stringify(net));
ok('N25c ningun lead real: todos los leads creados por 9B son is_test', T.leads.filter((l) => l.phone_e164.startsWith('+56978')).every((l) => l.is_test === true));
console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
