import { send, reply, btn, setLlm, handler, T, lastOut } from './harness.mjs';
const results = []; const ok = (name, cond, extra='') => { results.push(cond); console.log((cond?'PASS':'FAIL'), name, extra); };
const A = '+56900001001', B = '+56900001002', C = '+56900001003', D = '+56900001004', E = '+56900001005';
const lead = (p) => T.leads.find(l => l.phone_e164 === p);
// A HOT
await send(A, null, { text: 'Hola' });
await send(A, null, { type: 'interactive', ...btn('q1:yes') });
await send(A, null, { text: 'Medit i700' });
ok('A lead no existe antes de P2', !lead(A));
await send(A, null, { type: 'interactive', ...reply('q2:trade_up') });
ok('A lead creado tras P2', !!lead(A) && lead(A).need === 'trade_up' && lead(A).is_test === true, `score=${lead(A)?.score}`);
await send(A, null, { type: 'interactive', ...reply('q3:now') });
await send(A, null, { type: 'interactive', ...reply('q4:both') });
const rA = await send(A, null, { text: 'Juan Pérez, Clínica ABC, Providencia' });
ok('A HOT completado', lead(A).temperature === 'hot' && /Juan Pérez, Clínica ABC en Providencia\. Actualmente utiliza Medit i700 y está evaluando Trade Up de forma inmediata\. Solicita demo y propuesta comercial\./.test(lead(A).ai_summary), lead(A).ai_summary);
ok('A mensaje final HOT', /especialistas revise|uno de nuestros especialistas/.test(lastOut(A).slice(-1)[0]) && /Gracias, Juan/.test(lastOut(A).slice(-1)[0]));
ok('A mensajes enlazados al lead', T.messages.filter(m => m.session_id && T.sessions.find(s=>s.id===m.session_id).phone_e164===A).every(m => m.lead_id === lead(A).id));
ok('A sesión completada', T.sessions.find(s=>s.phone_e164===A).status === 'completed');
// B Tibio
await send(B, null, { text: 'hola' }); await send(B, null, { type: 'interactive', ...btn('q1:yes') }); await send(B, null, { text: 'Trios' });
await send(B, null, { type: 'interactive', ...reply('q2:digital_flow') }); await send(B, null, { type: 'interactive', ...reply('q3:3_6_months') }); await send(B, null, { type: 'interactive', ...reply('q4:demo') });
await send(B, null, { text: 'Dra Soto' }); // falta clínica y comuna
ok('B pregunta solo lo faltante', /Solo me falta el nombre de tu clínica y tu comuna/.test(lastOut(B).slice(-1)[0]), lastOut(B).slice(-1)[0]);
await send(B, null, { text: 'Clinica Sur, Maipú' });
ok('B Tibio', lead(B).temperature === 'warm', `score=${lead(B).score}`);
ok('B texto TIBIO', /Dejé registrada tu consulta y tus antecedentes/.test(lastOut(B).slice(-1)[0]));
// C Frío
await send(C, null, { text: 'hola' }); await send(C, null, { type: 'interactive', ...btn('q1:no') }); await send(C, null, { type: 'interactive', ...reply('q2:information_only') });
await send(C, null, { type: 'interactive', ...reply('q3:later') }); await send(C, null, { type: 'interactive', ...reply('q4:info') });
await send(C, null, { text: 'Pedro, Dental X, Ñuñoa' });
ok('C Frío', lead(C).temperature === 'cold' && /Gracias por contactarnos/.test(lastOut(C).slice(-1)[0]));
// D intención fuerte
await send(D, null, { text: 'Hola, quiero cotizar un SIRIOS y agendar una demo.' });
ok('D no crea lead antes de P2 pese a intención', !lead(D) && /Actualmente utilizas|scanner intraoral/.test(lastOut(D).slice(-1)[0]));
await send(D, null, { type: 'interactive', ...btn('q1:no') });
ok('D lead creado con override', lead(D)?.high_intent_override === true && lead(D).need === 'know_sirios', `score=${lead(D)?.score} temp=${lead(D)?.temperature}`);
ok('D al menos HOT', lead(D)?.temperature === 'hot');
// E libre
await send(E, null, { text: 'Tengo un Medit i700 y lo quiero cambiar dentro de un par de meses.' });
const sE = T.sessions.find(s=>s.phone_e164===E);
ok('E interpreta sin repreguntar', sE.context.fields.current_scanner === 'Medit i700' && sE.context.fields.need === 'renew' && sE.context.fields.purchase_timeline === '1_3_months' && sE.context.pending === 'q4', JSON.stringify(sE.context.fields)+' pending='+sE.context.pending);
ok('E lead creado ya (P1+P2 cubiertas)', !!lead(E));
// Seguridad
const nm = T.messages.length;
ok('firma inválida 401', (await send(A, null, { text: 'x', sigOverride: 'sha256=' + '0'.repeat(64) })).status === 401);
ok('sin firma 401', (await send(A, null, { text: 'x', sigOverride: '' })).status === 401);
ok('firma inválida no escribe', T.messages.length === nm);
const gv = async (tok) => (await handler(new Request('http://x/?hub.mode=subscribe&hub.verify_token='+tok+'&hub.challenge=abc123'))).status;
ok('verify token correcto 200', await gv('vt') === 200); ok('verify token incorrecto 403', await gv('mal') === 403);
const bodyBig = JSON.stringify({ object: 'whatsapp_business_account', pad: 'x'.repeat(300*1024) });
ok('payload grande 413', (await send(A, null, { raw: bodyBig })).status === 413);
const nm2 = T.messages.length;
const rp = await send(A, null, { text: 'hola', pn: 'OTRO' });
ok('phone_number_id distinto ignorado', rp.status === 200 && rp.body.ignored_phone_number === 1 && T.messages.length === nm2);
// Duplicado
const F = '+56900001006';
await send(F, null, { text: 'hola', id: 'wamid.DUP' }); const nmd = T.messages.length; const stp = JSON.stringify(T.sessions.find(s=>s.phone_e164===F).context);
const rd = await send(F, null, { text: 'hola', id: 'wamid.DUP' });
ok('duplicado: sin respuesta ni avance', rd.body.results[0] === 'duplicate' && T.messages.length === nmd && JSON.stringify(T.sessions.find(s=>s.phone_e164===F).context) === stp);
// audio / imagen
const G = '+56900001007';
const ra = await send(G, null, { type: 'audio', id: 'wamid.AUD' });
ok('audio: respuesta fija, sin romper', ra.body.results[0] === 'unsupported' && /solo mensajes de texto/.test(lastOut(G).slice(-1)[0]));
ok('imagen idem', (await send(G, null, { type: 'image' })).body.results[0] === 'unsupported');
// Fallo Anthropic
const H = '+56900001008';
setLlm(true);
await send(H, null, { text: 'hola' }); await send(H, null, { text: 'No' });
const sH = T.sessions.find(s=>s.phone_e164===H);
ok('fallo Anthropic: respaldo determinístico', sH.context.fields.uses_intraoral_scanner === false && sH.context.pending === 'q2', JSON.stringify(sH.context.fields));
setLlm(false);
// Fuera de flujo
await send(H, null, { text: '¿tienen despacho a regiones?' });
const lo = lastOut(H);
ok('fuera de flujo: respuesta breve + repregunta', lo.some(x=>/Con gusto un especialista/.test(x)) && /buscando principalmente/.test(lo.slice(-1)[0]), JSON.stringify(lo));
await send(H, null, { text: 'cuál es el precio y el descuento' });
ok('consulta de precio: no responde precio, deriva y repregunta', lastOut(H).some(x=>/Con gusto un especialista/.test(x)) && !/\$|\d{3}\.\d{3}/.test(lastOut(H).join(' ')));
// misma persona vuelve (ack, caso C)
const na = T.acts.length;
await send(A, null, { text: 'quiero cotizar ahora mismo' });
ok('Caso C: ack + actividad + sin nuevo lead', /Ya tenemos registrada/.test(lastOut(A).slice(-1)[0]) && T.leads.filter(l=>l.phone_e164===A).length === 1 && T.acts.slice(na).some(a=>a.event_type==='whatsapp_new_message'));
await send(A, null, { text: 'otra cosa' });
ok('Caso C: ack no se repite en 6h', lastOut(A).filter(x=>/Ya tenemos registrada/.test(x)).length === 1);
// won
const lw = lead(B); lw.status = 'won';
await send(B, null, { text: 'hola de nuevo' });
ok('Caso E won: actividad recontact, mismo lead', T.acts.some(a=>a.lead_id===lw.id && a.event_type==='whatsapp_recontact_after_won') && T.leads.filter(l=>l.phone_e164===B).length===1 && lead(B).status==='won');
// lost <30d y >=30d
const lc = lead(C); lc.status = 'lost'; lc.updated_at = new Date().toISOString();
await send(C, null, { text: 'hola' });
ok('Caso D lost<30d: mismo lead', T.leads.filter(l=>l.phone_e164===C).length===1 && T.sessions.filter(s=>s.phone_e164===C).length===1);
await send(C, null, { text: 'hola otra vez', headers: {'x-sim-now': new Date(Date.now()+31*864e5).toISOString()} });
ok('Caso D lost>=30d: sesión nueva (lead nuevo recién en P2)', T.sessions.filter(s=>s.phone_e164===C).length===2 && T.leads.filter(l=>l.phone_e164===C).length===1);
// 72h
const I = '+56900001009';
await send(I, null, { text: 'hola' }); await send(I, null, { type: 'interactive', ...btn('q1:no') }); await send(I, null, { type: 'interactive', ...reply('q2:know_sirios') });
const leadI = lead(I).id;
await send(I, null, { text: 'hola' }); // dentro de 72h => continúa
ok('Caso A <72h: misma sesión', T.sessions.filter(s=>s.phone_e164===I).length===1);
await send(I, null, { text: 'hola', headers: {'x-sim-now': new Date(Date.now()+73*36e5).toISOString()} });
const sI = T.sessions.filter(s=>s.phone_e164===I);
ok('Caso B >=72h: expira, nueva sesión, mismo lead, precarga', sI.length===2 && sI[0].status==='expired' && sI[1].lead_id===leadI && sI[1].context.fields.need==='know_sirios' && sI[1].context.pending==='q3', JSON.stringify(sI[1].context.pending));
ok('Caso B: solo pregunta lo faltante (P3)', /plazo/.test(lastOut(I).slice(-1)[0]));
// Saludo a mitad de flujo no avanza ni dispara fuera-de-flujo
const K = '+56900001011';
await send(K, null, { text: 'hola' }); await send(K, null, { type: 'interactive', ...btn('q1:no') }); await send(K, null, { type: 'interactive', ...reply('q2:renew') });
const pk = T.sessions.find(s=>s.phone_e164===K).context.pending;
await send(K, null, { text: 'Hola buenas tardes' });
ok('saludo mid-flow: no avanza, no OFFFLOW', T.sessions.find(s=>s.phone_e164===K).context.pending === pk && !lastOut(K).some(x=>/Con gusto un especialista/.test(x)) && /plazo/.test(lastOut(K).slice(-1)[0]));
// Fallo al enviar respuesta
const J = '+56900001010';
await send(J, null, { text: 'hola' }); await send(J, null, { type: 'interactive', ...btn('q1:no') });
const rj = await send(J, null, { type: 'interactive', ...reply('q2:renew'), headers: {'x-sim-fail-send':'1'} });
const lj = lead(J);
ok('fallo de envío: 200, error guardado, actividad, lead intacto', rj.status===200 && T.messages.some(m=>m.lead_id===lj.id && m.direction==='outbound' && m.metadata.error) && T.acts.some(a=>a.lead_id===lj.id && a.event_type==='whatsapp_send_failed'));
// OUTBOUND 7: respuesta entrante de un prospecto contactado -> replied + el bot existente sigue igual (mismo motor)
const PR = '+56900001020', PN = '+56900001021', PP = '+56900001022';
T.prospects.push({ id: 'p1', phone_e164: PR, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'p2', phone_e164: PN, outreach_status: 'pending', whatsapp_consent: 'yes' }, { id: 'p3', phone_e164: PP, outreach_status: 'opted_out', whatsapp_consent: 'no' });
const rr = await send(PR, null, { text: 'hola' });
ok('O7 respuesta de prospecto contactado -> replied', T.prospects[0].outreach_status === 'replied');
ok('O7 el bot existente responde igual (sesion + pregunta Q1), sin motor duplicado', rr.status === 200 && T.sessions.some(s => s.phone_e164 === PR) && lastOut(PR).length > 0);
await send(PN, null, { text: 'hola' }); await send(PP, null, { text: 'hola' });
ok('O7 pending y opted_out NO cambian por una respuesta entrante', T.prospects[1].outreach_status === 'pending' && T.prospects[2].outreach_status === 'opted_out');
ok('O7 consentimiento intacto', T.prospects.every(p => p.id === 'p3' ? p.whatsapp_consent === 'no' : p.whatsapp_consent === 'yes'));
// OUTBOUND 7 (correccion): resolucion CONSERVADORA — nunca marca varios prospectos por telefono compartido
import { pickReplyTarget } from './reply.ts';
const logs = []; const origLog = console.log; const cap = (...a) => { logs.push(a.join(' ')); }; console.log = cap;
const okR = (n, c) => { console.log = origLog; ok(n, c); console.log = cap; };
const at = (m) => new Date(Date.UTC(2026, 9, 11, 12, m)).toISOString();
const S1 = '+56900002001', S2 = '+56900002002', S3 = '+56900002003', S4 = '+56900002004', S5 = '+56900002005';
T.prospects.push(
  { id: 'a1', phone_e164: S1, outreach_status: 'contacted', whatsapp_consent: 'yes' },
  { id: 'b1', phone_e164: S2, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'b2', phone_e164: S2, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'b3', phone_e164: S2, outreach_status: 'pending', whatsapp_consent: 'yes' },
  { id: 'c1', phone_e164: S3, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'c2', phone_e164: S3, outreach_status: 'contacted', whatsapp_consent: 'yes' },
  { id: 'd1', phone_e164: S4, outreach_status: 'failed', whatsapp_consent: 'yes' }, { id: 'd2', phone_e164: S4, outreach_status: 'converted', whatsapp_consent: 'yes' }, { id: 'd3', phone_e164: S4, outreach_status: 'opted_out', whatsapp_consent: 'no' }, { id: 'd4', phone_e164: S4, outreach_status: 'pending', whatsapp_consent: 'yes' },
  { id: 'e1', phone_e164: S5, outreach_status: 'contacted', whatsapp_consent: 'yes' }, { id: 'e2', phone_e164: S5, outreach_status: 'contacted', whatsapp_consent: 'yes' });
T.sends.push({ prospect_id: 'b2', status: 'sent', sent_at: at(10) }, { prospect_id: 'b1', status: 'failed', sent_at: at(30) }, { prospect_id: 'b3', status: 'sent', sent_at: at(40) },
  { prospect_id: 'e1', status: 'sent', sent_at: at(5) }, { prospect_id: 'e2', status: 'sent', sent_at: at(5) });
const st = (id) => T.prospects.find((p) => p.id === id).outreach_status;
await send(S1, null, { text: 'hola' });
okR('R1 1 candidato contacted -> solo ese pasa a replied', st('a1') === 'replied');
await send(S2, null, { text: 'hola' });
okR('R2 2 prospectos mismo telefono, solo b2 con envio sent -> cambia SOLO b2 (b1 contacted y b3 pending intactos)', st('b2') === 'replied' && st('b1') === 'contacted' && st('b3') === 'pending');
logs.length = 0;
await send(S3, null, { text: 'hola' });
okR('R3 2 candidatos sin evidencia de envio -> NINGUNO cambia', st('c1') === 'contacted' && st('c2') === 'contacted');
okR('R3b log tecnico prospect_replied_ambiguous (sin telefono ni nombre)', logs.some((l) => l.includes('prospect_replied_ambiguous')) && !logs.filter((l) => l.includes('prospect_replied_ambiguous')).some((l) => /5690000|a1|c1/.test(l)));
await send(S4, null, { text: 'hola' });
okR('R4 0 candidatos (failed/converted/opted_out/pending) -> ninguno cambia', st('d1') === 'failed' && st('d2') === 'converted' && st('d3') === 'opted_out' && st('d4') === 'pending');
logs.length = 0;
await send(S5, null, { text: 'hola' });
okR('R5 empate exacto de envios entre dos prospectos -> ambiguo, ninguno cambia', st('e1') === 'contacted' && st('e2') === 'contacted' && logs.some((l) => l.includes('prospect_replied_ambiguous')));
okR('R6 consentimiento intacto en todos', T.prospects.every((p) => (p.id === 'd3' || p.id === 'p3') ? p.whatsapp_consent === 'no' : p.whatsapp_consent === 'yes'));
const n = (r) => JSON.stringify(r);
okR('R7 pickReplyTarget puro: none / unico / mas reciente / sin evidencia / ids duplicados', n(pickReplyTarget([], [])) === '{"kind":"none"}' && pickReplyTarget(['x'], []).kind === 'one' && pickReplyTarget(['x', 'y'], [{ prospect_id: 'x', sent_at: at(1) }, { prospect_id: 'y', sent_at: at(9) }]).id === 'y' && pickReplyTarget(['x', 'y'], []).kind === 'ambiguous' && pickReplyTarget(['x', 'x'], []).kind === 'one' && pickReplyTarget(['x', 'y'], [{ prospect_id: 'z', sent_at: at(1) }]).kind === 'ambiguous');
console.log = origLog;
console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
